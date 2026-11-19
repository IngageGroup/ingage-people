import { type FetchFn, graphJson } from "@/lib/graph/client";
import { capText, graphSearch, type M365Item, plainSummary } from "@/lib/graph/m365-item";

interface EmailAddress {
  emailAddress?: { name?: string; address?: string };
}

interface Message {
  id?: string;
  subject?: string;
  from?: EmailAddress;
  toRecipients?: EmailAddress[];
  receivedDateTime?: string;
  body?: { content?: string };
  webLink?: string;
}

const SEARCH_FIELDS = ["subject", "from", "receivedDateTime", "webLink", "bodyPreview"];

/** Search hits carry no webLink by default; this opens the message in Outlook on the web. */
function outlookLink(id: string): string {
  return `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(id)}`;
}

function person(address: EmailAddress | undefined): string {
  const name = address?.emailAddress?.name ?? "";
  const email = address?.emailAddress?.address;
  return email ? `${name} <${email}>`.trim() : name || "unknown sender";
}

function toItem(message: Message, id: string, text: string): M365Item {
  return {
    kind: "mail",
    ref: id,
    title: message.subject?.trim() || "(no subject)",
    location: ["Mail", `From ${message.from?.emailAddress?.name ?? "unknown sender"}`],
    url: message.webLink ?? outlookLink(id),
    lastModified: message.receivedDateTime ?? "",
    text,
  };
}

/** The user's mail that matches the query, newest first, with snippets. */
export async function searchMail(
  query: string,
  token: string,
  fetchFn?: FetchFn,
): Promise<M365Item[]> {
  const hits = await graphSearch<Message>({
    entityType: "message",
    query,
    token,
    fields: SEARCH_FIELDS,
    fetchFn,
  });
  const items: M365Item[] = [];
  for (const hit of hits) {
    const id = hit.resource?.id ?? hit.hitId;
    if (!hit.resource || !id) continue;
    items.push(toItem(hit.resource, id, plainSummary(hit.summary)));
  }
  return items;
}

/** One message from the user's mailbox: sender, recipients, date, and the body as text. */
export async function readMail(ref: string, token: string, fetchFn?: FetchFn): Promise<M365Item> {
  const select = "subject,from,toRecipients,receivedDateTime,body,webLink";
  const message = await graphJson<Message>(
    `/me/messages/${encodeURIComponent(ref)}?$select=${select}`,
    {
      token,
      headers: { Prefer: 'outlook.body-content-type="text"' },
      ...(fetchFn ? { fetchFn } : {}),
    },
  );
  const header = [
    `From: ${person(message.from)}`,
    `To: ${(message.toRecipients ?? []).map(person).join(", ")}`,
    `Date: ${message.receivedDateTime ?? ""}`,
  ].join("\n");
  return toItem(message, ref, capText(`${header}\n\n${message.body?.content ?? ""}`));
}
