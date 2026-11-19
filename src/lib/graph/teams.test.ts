import { describe, expect, it, vi } from "vitest";
import { GRAPH_BASE } from "@/lib/graph/client";
import { readTeamsThread, searchTeams } from "@/lib/graph/teams";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function router(routes: Record<string, unknown>) {
  return vi.fn(async (url: string, _init: RequestInit) => {
    if (url in routes) return json(routes[url]);
    throw new Error(`unexpected request ${url}`);
  });
}

const from = (name: string) => ({ user: { displayName: name }, emailAddress: { name } });

describe("searchTeams", () => {
  const chatHit = {
    hitId: "h1",
    summary: "the <c0>deadline</c0> is Friday",
    resource: {
      id: "1700",
      chatId: "19:abc@thread.v2",
      channelIdentity: {},
      createdDateTime: "2026-11-17T10:00:00Z",
      from: { emailAddress: { name: "Jane Doe" } },
      webLink: "https://teams.microsoft.com/l/message/19:abc/1700",
    },
  };
  const channelHit = {
    hitId: "h2",
    summary: "release notes",
    resource: {
      id: "m1",
      channelIdentity: { teamId: "t1", channelId: "ch1" },
      createdDateTime: "2026-11-16T10:00:00Z",
      from: { emailAddress: { name: "Sam" } },
      webUrl: "https://teams.microsoft.com/l/message/ch1/m1",
    },
  };

  it("maps chat and channel hits to Teams items with their refs and links", async () => {
    const fetchFn = router({
      [`${GRAPH_BASE}/search/query`]: {
        value: [{ hitsContainers: [{ hits: [chatHit, channelHit] }] }],
      },
    });
    const [chat, channel] = await searchTeams("deadline", "tok", fetchFn);
    expect(chat).toMatchObject({
      kind: "teams",
      ref: "chat:19:abc@thread.v2",
      location: ["Teams", "Chat"],
      url: "https://teams.microsoft.com/l/message/19:abc/1700",
      text: "the deadline is Friday",
    });
    expect(chat?.title).toContain("Jane Doe");
    expect(channel).toMatchObject({
      ref: "channel:t1|ch1|m1",
      location: ["Teams", "Channel"],
      url: "https://teams.microsoft.com/l/message/ch1/m1",
    });
  });

  it("sends the query only in the POST body", async () => {
    const fetchFn = router({ [`${GRAPH_BASE}/search/query`]: { value: [] } });
    await searchTeams("offsite plans", "tok", fetchFn);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${GRAPH_BASE}/search/query`);
    const request = JSON.parse(String(init.body)).requests[0];
    expect(request).toMatchObject({
      entityTypes: ["chatMessage"],
      query: { queryString: "offsite plans" },
    });
  });
});

describe("readTeamsThread", () => {
  it("reads a chat oldest first with HTML removed", async () => {
    const fetchFn = router({
      [`${GRAPH_BASE}/chats/19%3Aabc%40thread.v2/messages?$top=30`]: {
        value: [
          {
            id: "2",
            createdDateTime: "2026-11-17T10:05:00Z",
            from: from("Phil"),
            body: { content: "<p>Thanks, noted.</p>" },
            webUrl: "https://teams/2",
          },
          {
            id: "1",
            createdDateTime: "2026-11-17T10:00:00Z",
            from: from("Jane Doe"),
            body: { content: "<p>The deadline is <b>Friday</b>.</p>" },
            webUrl: "https://teams/1",
          },
        ],
      },
    });
    const item = await readTeamsThread("chat:19:abc@thread.v2", "tok", fetchFn);
    expect(item.text).toBe(
      "Jane Doe (2026-11-17T10:00:00Z): The deadline is Friday.\nPhil (2026-11-17T10:05:00Z): Thanks, noted.",
    );
    expect(item).toMatchObject({
      kind: "teams",
      ref: "chat:19:abc@thread.v2",
      url: "https://teams/1",
      lastModified: "2026-11-17T10:05:00Z",
    });
  });

  it("reads a channel thread as the root message and its replies", async () => {
    const root = `${GRAPH_BASE}/teams/t1/channels/ch1/messages/m1`;
    const fetchFn = router({
      [root]: {
        id: "m1",
        createdDateTime: "2026-11-16T10:00:00Z",
        from: from("Sam"),
        subject: "Release",
        body: { content: "Shipping Monday" },
        webUrl: "https://teams/m1",
      },
      [`${root}/replies?$top=30`]: {
        value: [
          {
            id: "r1",
            createdDateTime: "2026-11-16T11:00:00Z",
            from: from("Ana"),
            body: { content: "OK" },
          },
        ],
      },
    });
    const item = await readTeamsThread("channel:t1|ch1|m1", "tok", fetchFn);
    expect(item.text).toBe(
      "Sam (2026-11-16T10:00:00Z): Shipping Monday\nAna (2026-11-16T11:00:00Z): OK",
    );
    expect(item).toMatchObject({
      url: "https://teams/m1",
      location: ["Teams", "Channel"],
      title: "Release",
    });
  });

  it("rejects an unknown ref without calling Graph", async () => {
    const fetchFn = router({});
    await expect(readTeamsThread("bogus", "tok", fetchFn)).rejects.toThrow(
      /Unknown Teams reference/,
    );
    await expect(readTeamsThread("channel:t1|ch1", "tok", fetchFn)).rejects.toThrow(
      /Unknown Teams reference/,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("throws forbidden when the user can't open the chat", async () => {
    const fetchFn = vi.fn(async () => json({ error: { code: "Forbidden" } }, 403));
    await expect(readTeamsThread("chat:c1", "tok", fetchFn)).rejects.toMatchObject({
      failure: "forbidden",
    });
  });
});
