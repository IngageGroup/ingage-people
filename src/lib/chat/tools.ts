import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { z } from "zod";
import { calendarTools } from "@/lib/chat/calendar-tools";
import type { PassageProvider } from "@/lib/chat/passages";
import type { Skill } from "@/lib/chat/skills";
import { renderItems, renderPassages, type SourceRegistry } from "@/lib/chat/sources";
import { guarded } from "@/lib/chat/tool-guard";
import type { FetchFn } from "@/lib/graph/client";
import { readFile, searchFiles } from "@/lib/graph/files";
import type { M365Item } from "@/lib/graph/m365-item";
import { readMail, searchMail } from "@/lib/graph/mail";
import { readTeamsThread, searchTeams } from "@/lib/graph/teams";

export interface ChatToolDeps {
  registry: SourceRegistry;
  passages: PassageProvider;
  /** Knowledge topics `search_handbook` searches. */
  handbookTopics: string[];
  /** The signed-in user's Graph token; called only when a Microsoft 365 tool runs. */
  graphToken: () => Promise<string>;
  fetchFn?: FetchFn;
  /** IANA zone for calendar times. */
  timeZone: string;
  /** Skills `load_skill` can return; the tool is left out when there are none. */
  skills: Skill[];
}

const queryInput = z.object({
  query: z.string().min(1).max(500).describe("Search words, as the user might phrase them."),
});
const refInput = z.object({
  ref: z.string().min(1).max(500).describe("The ref attribute of an item from a search result."),
});

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

function skillTool(skills: Skill[]) {
  const names = skills.map((skill) => skill.name).join(", ");
  return betaZodTool({
    name: "load_skill",
    description: `Load the instructions for a skill by name. Available: ${names}.`,
    inputSchema: z.object({ name: z.string().min(1).max(64) }),
    run: async ({ name }) => {
      const skill = skills.find((s) => s.name === name);
      if (!skill) throw new ToolError(`No skill named ${name}. Available: ${names}`);
      return skill.body;
    },
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
 * The chat's tools: `search_handbook` always, `load_skill` when skills are offered, and the
 * read-only Microsoft 365 and calendar tools when `M365_TOOLS=enabled` (dev only until the
 * retention decision in #2).
 */
export function chatTools(deps: ChatToolDeps) {
  const m365 = process.env["M365_TOOLS"] === "enabled";
  return [
    handbookTool(deps),
    ...(deps.skills.length ? [skillTool(deps.skills)] : []),
    ...(m365 ? [...m365Tools(deps), ...calendarTools(deps)] : []),
  ];
}
