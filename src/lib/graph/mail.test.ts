import { describe, expect, it, vi } from "vitest";
import { GRAPH_BASE } from "@/lib/graph/client";
import { readMail, searchMail } from "@/lib/graph/mail";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fetchReturning(body: unknown, status = 200) {
  return vi.fn(async (_url: string, _init: RequestInit) => json(body, status));
}

describe("searchMail", () => {
  const hit = {
    hitId: "msg-1",
    summary: "about the <c0>deadline</c0>",
    resource: {
      subject: "Deadline",
      from: { emailAddress: { name: "Jane Doe", address: "jane@client.com" } },
      receivedDateTime: "2026-11-17T09:30:00Z",
    },
  };

  it("maps hits to mail items with the sender in the location", async () => {
    const fetchFn = fetchReturning({ value: [{ hitsContainers: [{ hits: [hit] }] }] });
    const [item] = await searchMail("deadline", "tok", fetchFn);
    expect(item).toMatchObject({
      kind: "mail",
      ref: "msg-1",
      title: "Deadline",
      location: ["Mail", "From Jane Doe"],
      lastModified: "2026-11-17T09:30:00Z",
      text: "about the deadline",
    });
  });

  it("links to the message in Outlook when the hit has no webLink", async () => {
    const fetchFn = fetchReturning({ value: [{ hitsContainers: [{ hits: [hit] }] }] });
    const [item] = await searchMail("deadline", "tok", fetchFn);
    expect(item?.url).toBe("https://outlook.office.com/mail/deeplink/read/msg-1");
  });

  it("uses the hit's webLink when Graph returns one", async () => {
    const withLink = {
      ...hit,
      resource: { ...hit.resource, webLink: "https://outlook.office365.com/owa/?ItemID=x" },
    };
    const fetchFn = fetchReturning({ value: [{ hitsContainers: [{ hits: [withLink] }] }] });
    const [item] = await searchMail("deadline", "tok", fetchFn);
    expect(item?.url).toBe("https://outlook.office365.com/owa/?ItemID=x");
  });

  it("sends the query only in the POST body", async () => {
    const fetchFn = fetchReturning({ value: [{ hitsContainers: [{}] }] });
    await searchMail("salary review", "tok", fetchFn);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${GRAPH_BASE}/search/query`);
    const request = JSON.parse(String(init.body)).requests[0];
    expect(request.entityTypes).toEqual(["message"]);
    expect(request.query.queryString).toBe("salary review");
  });
});

describe("readMail", () => {
  const message = {
    id: "msg-1",
    subject: "Deadline",
    from: { emailAddress: { name: "Jane Doe", address: "jane@client.com" } },
    toRecipients: [{ emailAddress: { name: "Phil", address: "phil@ingagepartners.com" } }],
    receivedDateTime: "2026-11-17T09:30:00Z",
    body: { contentType: "text", content: "The deadline is Friday." },
    webLink: "https://outlook.office365.com/owa/?ItemID=msg-1",
  };

  it("asks for a text body and returns sender, recipients, date, and body", async () => {
    const fetchFn = fetchReturning(message);
    const item = await readMail("msg-1", "tok", fetchFn);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith(`${GRAPH_BASE}/me/messages/msg-1?`)).toBe(true);
    expect(new Headers(init.headers).get("prefer")).toBe('outlook.body-content-type="text"');
    expect(item).toMatchObject({ kind: "mail", ref: "msg-1", url: message.webLink });
    expect(item.text).toBe(
      "From: Jane Doe <jane@client.com>\nTo: Phil <phil@ingagepartners.com>\nDate: 2026-11-17T09:30:00Z\n\nThe deadline is Friday.",
    );
  });

  it("escapes the message id in the path", async () => {
    const fetchFn = fetchReturning(message);
    await readMail("AAMk/abc=", "tok", fetchFn);
    const [url] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith(`${GRAPH_BASE}/me/messages/AAMk%2Fabc%3D?`)).toBe(true);
  });

  it("throws not-found for a missing message", async () => {
    await expect(readMail("gone", "tok", fetchReturning({}, 404))).rejects.toMatchObject({
      failure: "not-found",
    });
  });
});
