import { type FetchFn, graphJson } from "@/lib/graph/client";
import { capText, graphSearch, type M365Item, plainSummary } from "@/lib/graph/m365-item";
import { SafeError } from "@/lib/safe-error";

interface Sender {
  user?: { displayName?: string };
  application?: { displayName?: string };
  emailAddress?: { name?: string };
}

interface ChatMessage {
  id?: string;
  chatId?: string;
  channelIdentity?: { teamId?: string; channelId?: string };
  createdDateTime?: string;
  messageType?: string;
  from?: Sender | null;
  subject?: string | null;
  body?: { content?: string };
  webUrl?: string;
  webLink?: string;
}

/** Messages read per chat or channel thread. */
const THREAD_LIMIT = 30;

type TeamsRef =
  | { kind: "chat"; chatId: string }
  | { kind: "channel"; teamId: string; channelId: string; messageId: string };

/** Chat and channel ids contain colons, so the channel parts are joined with "|". */
function chatRef(chatId: string): string {
  return `chat:${chatId}`;
}

function channelRef(teamId: string, channelId: string, messageId: string): string {
  return `channel:${teamId}|${channelId}|${messageId}`;
}

function parseRef(ref: string): TeamsRef {
  if (ref.startsWith("chat:") && ref.length > "chat:".length) {
    return { kind: "chat", chatId: ref.slice("chat:".length) };
  }
  if (ref.startsWith("channel:")) {
    const [teamId, channelId, messageId, ...rest] = ref.slice("channel:".length).split("|");
    if (teamId && channelId && messageId && rest.length === 0) {
      return { kind: "channel", teamId, channelId, messageId };
    }
  }
  throw new SafeError("Unknown Teams reference; use a ref from search_teams");
}

function senderName(from: Sender | null | undefined): string {
  return (
    from?.user?.displayName ??
    from?.emailAddress?.name ??
    from?.application?.displayName ??
    "unknown sender"
  );
}

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/** Teams bodies are HTML; the model only needs the words. */
function plainText(html: string | undefined): string {
  return (html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity)
    .trim();
}

function linkOf(message: ChatMessage): string {
  return message.webUrl ?? message.webLink ?? "";
}

/** Teams chats and channel messages the user can see that match the query, with snippets. */
export async function searchTeams(
  query: string,
  token: string,
  fetchFn?: FetchFn,
): Promise<M365Item[]> {
  const hits = await graphSearch<ChatMessage>({ entityType: "chatMessage", query, token, fetchFn });
  const items: M365Item[] = [];
  for (const hit of hits) {
    const message = hit.resource;
    if (!message) continue;
    const { teamId, channelId } = message.channelIdentity ?? {};
    const messageId = message.id ?? hit.hitId;
    let ref: string;
    if (teamId && channelId && messageId) ref = channelRef(teamId, channelId, messageId);
    else if (message.chatId) ref = chatRef(message.chatId);
    else continue;
    const date = message.createdDateTime ?? "";
    items.push({
      kind: "teams",
      ref,
      title: `${senderName(message.from)}, ${date.slice(0, 10)}`,
      location: ["Teams", ref.startsWith("chat:") ? "Chat" : "Channel"],
      url: linkOf(message),
      lastModified: date,
      text: plainSummary(hit.summary),
    });
  }
  return items;
}

function transcript(messages: ChatMessage[]): string {
  return messages
    .filter((m) => (m.messageType ?? "message") === "message" && plainText(m.body?.content))
    .map((m) => `${senderName(m.from)} (${m.createdDateTime ?? ""}): ${plainText(m.body?.content)}`)
    .join("\n");
}

function byTime(a: ChatMessage, b: ChatMessage): number {
  return (a.createdDateTime ?? "").localeCompare(b.createdDateTime ?? "");
}

/** A chat's latest messages, or a channel message with its replies, oldest first. */
export async function readTeamsThread(
  ref: string,
  token: string,
  fetchFn?: FetchFn,
): Promise<M365Item> {
  const parsed = parseRef(ref);
  const options = { token, ...(fetchFn ? { fetchFn } : {}) };
  let messages: ChatMessage[];
  let title: string;
  let url: string;
  if (parsed.kind === "chat") {
    const page = await graphJson<{ value?: ChatMessage[] }>(
      `/chats/${encodeURIComponent(parsed.chatId)}/messages?$top=${THREAD_LIMIT}`,
      options,
    );
    messages = (page.value ?? []).sort(byTime);
    title = "Teams chat";
    url = messages.length ? linkOf(messages[0] as ChatMessage) : "";
  } else {
    const root = `/teams/${encodeURIComponent(parsed.teamId)}/channels/${encodeURIComponent(parsed.channelId)}/messages/${encodeURIComponent(parsed.messageId)}`;
    const [first, replies] = await Promise.all([
      graphJson<ChatMessage>(root, options),
      graphJson<{ value?: ChatMessage[] }>(`${root}/replies?$top=${THREAD_LIMIT}`, options),
    ]);
    messages = [first, ...(replies.value ?? []).sort(byTime)];
    title = first.subject?.trim() || "Teams channel thread";
    url = linkOf(first);
  }
  return {
    kind: "teams",
    ref,
    title,
    location: ["Teams", parsed.kind === "chat" ? "Chat" : "Channel"],
    url,
    lastModified: messages.reduce((latest, m) => {
      const time = m.createdDateTime ?? "";
      return time > latest ? time : latest;
    }, ""),
    text: capText(transcript(messages)),
  };
}
