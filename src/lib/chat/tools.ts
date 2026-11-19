import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { z } from "zod";
import type { PassageProvider } from "@/lib/chat/passages";
import { renderItems, renderPassages, type SourceRegistry } from "@/lib/chat/sources";
import { type FetchFn, GraphError } from "@/lib/graph/client";
import { readFile, searchFiles } from "@/lib/graph/files";
import type { M365Item } from "@/lib/graph/m365-item";
import { readMail, searchMail } from "@/lib/graph/mail";
import { readTeamsThread, searchTeams } from "@/lib/graph/teams";
import { GraphTokenError } from "@/lib/graph-token";
import { describeError } from "@/lib/safe-error";

export interface ChatToolDeps {
  registry: SourceRegistry;
  passages: PassageProvider;
  /** Knowledge topics `search_handbook` searches. */
  handbookTopics: string[];
  /** The signed-in user's Graph token; called only when a Microsoft 365 tool runs. */
  graphToken: () => Promise<string>;
  fetchFn?: FetchFn;
}

const queryInput = z.object({
  query: z.string().min(1).max(500).describe("Search words, as the user might phrase them."),
});
const refInput = z.object({
  ref: z.string().min(1).max(500).describe("The ref attribute of an item from a search result."),
});

/** What Claude is told when a tool fails; never Graph's or the database's own message. */
function failureMessage(err: unknown): string {
  if (err instanceof GraphTokenError) {
    return err.reason === "unavailable"
      ? "Microsoft 365 isn't available in this session."
      : "Microsoft 365 sign-in has expired; ask the user to sign in again.";
  }
  if (err instanceof GraphError) {
    if (err.failure === "forbidden" || err.failure === "not-found") {
      return "That item can't be opened with your access.";
    }
    if (err.failure === "throttled" || err.failure === "unavailable") {
      return "Microsoft 365 is busy; try again shortly.";
    }
  }
  return "The search failed; try again.";
}

/** Runs a tool body; failures are logged without content and returned to Claude as errors. */
async function guarded(name: string, body: () => Promise<string>): Promise<string> {
  try {
    return await body();
  } catch (err) {
    if (!(err instanceof GraphTokenError && err.reason === "unavailable")) {
      console.error(`[chat-tools] ${name} failed: ${describeError(err)}`);
    }
    throw new ToolError(failureMessage(err));
  }
}

function itemsResult(registry: SourceRegistry, items: M365Item[], none: string): string {
  return items.length ? renderItems(registry.addItems(items)) : none;
}

function handbookTool(deps: ChatToolDeps) {
  return betaZodTool({
    name: "search_handbook",
    description:
      "Search the Ingage Employee Handbook and other approved Ingage knowledge (policies, benefits, PTO, training budget, reviews, onboarding). Use it for every question about Ingage policy. Returns passages with ids to cite.",
    inputSchema: queryInput,
    run: ({ query }) =>
      guarded("search_handbook", async () => {
        const passages = await deps.passages(query, deps.handbookTopics);
        if (!passages.length) return "No handbook passages matched.";
        return renderPassages(deps.registry.addPassages(passages));
      }),
  });
}

type M365Search = (query: string, token: string, fetchFn?: FetchFn) => Promise<M365Item[]>;
type M365Read = (ref: string, token: string, fetchFn?: FetchFn) => Promise<M365Item>;

function m365Tools(deps: ChatToolDeps) {
  const search = (name: string, description: string, fn: M365Search, none: string) =>
    betaZodTool({
      name,
      description,
      inputSchema: queryInput,
      run: ({ query }) =>
        guarded(name, async () =>
          itemsResult(deps.registry, await fn(query, await deps.graphToken(), deps.fetchFn), none),
        ),
    });
  const read = (name: string, description: string, fn: M365Read) =>
    betaZodTool({
      name,
      description,
      inputSchema: refInput,
      run: ({ ref }) =>
        guarded(name, async () =>
          itemsResult(deps.registry, [await fn(ref, await deps.graphToken(), deps.fetchFn)], ""),
        ),
    });
  return [
    search(
      "search_files",
      "Search files the user can open in OneDrive and SharePoint. Returns names, links, and snippets; use read_file for the full text.",
      searchFiles,
      "No files matched.",
    ),
    read("read_file", "Read the full text of a file from search_files.", readFile),
    search(
      "search_mail",
      "Search the user's own mailbox. Returns subjects, senders, dates, and snippets; use read_mail for the whole message.",
      searchMail,
      "No mail matched.",
    ),
    read("read_mail", "Read one message from search_mail.", readMail),
    search(
      "search_teams",
      "Search the user's Teams chats and the channel messages they can see. Returns snippets; use read_teams_thread for the conversation.",
      searchTeams,
      "No Teams messages matched.",
    ),
    read(
      "read_teams_thread",
      "Read the chat or channel thread around a message from search_teams.",
      readTeamsThread,
    ),
  ];
}

/**
 * The chat's tools: `search_handbook` always, and the read-only Microsoft 365 tools when
 * `M365_TOOLS=enabled` (dev only until the retention decision in #2).
 */
export function chatTools(deps: ChatToolDeps) {
  const m365 = process.env["M365_TOOLS"] === "enabled" ? m365Tools(deps) : [];
  return [handbookTool(deps), ...m365];
}
