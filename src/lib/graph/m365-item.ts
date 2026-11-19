import { type FetchFn, graphJson } from "@/lib/graph/client";

/** Longest text one tool result carries, so a single read can't fill the context. */
export const TOOL_TEXT_MAX = 20_000;

const CUT_NOTE = "\n[cut: the rest of this item is not shown]";

export type M365Kind = "file" | "mail" | "teams";

/** A file, mail, or Teams thread as the chat's tools return it. */
export interface M365Item {
  kind: M365Kind;
  /** What the matching read tool takes to open this item. */
  ref: string;
  title: string;
  /** Where it lives, outermost first; becomes the citation's section path. Never empty. */
  location: string[];
  url: string;
  /** ISO date-time. */
  lastModified: string;
  text: string;
}

export function capText(text: string): string {
  return text.length > TOOL_TEXT_MAX ? text.slice(0, TOOL_TEXT_MAX) + CUT_NOTE : text;
}

/** Search hit text without Graph's `<c0>` highlight tags; `<ddd/>` becomes an ellipsis. */
export function plainSummary(summary: unknown): string {
  if (typeof summary !== "string") return "";
  return summary
    .replace(/<\/?c0>/g, "")
    .replace(/\s*<ddd\/>/g, " …")
    .trim();
}

export interface SearchHit<Resource> {
  hitId?: string;
  summary?: string;
  resource?: Resource;
}

interface SearchResponse<Resource> {
  value?: Array<{ hitsContainers?: Array<{ hits?: Array<SearchHit<Resource>> }> }>;
}

/**
 * Runs one Microsoft Search query as the signed-in user. The query goes in the POST body,
 * never the URL, because request URLs end up in telemetry.
 */
export async function graphSearch<Resource>(args: {
  entityType: "driveItem" | "message" | "chatMessage";
  query: string;
  token: string;
  fields?: string[];
  fetchFn?: FetchFn | undefined;
}): Promise<Array<SearchHit<Resource>>> {
  const request = {
    entityTypes: [args.entityType],
    query: { queryString: args.query },
    from: 0,
    size: 10,
    ...(args.fields ? { fields: args.fields } : {}),
  };
  const body = await graphJson<SearchResponse<Resource>>("/search/query", {
    token: args.token,
    method: "POST",
    body: { requests: [request] },
    ...(args.fetchFn ? { fetchFn: args.fetchFn } : {}),
  });
  return body.value?.[0]?.hitsContainers?.[0]?.hits ?? [];
}
