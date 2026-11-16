import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChatEvent, ChatStreamError, readChatStream } from "@/lib/chat-protocol";

const { emailMock, streamMock, parseMock, passagesMock, quotaMock } = vi.hoisted(() => ({
  emailMock: vi.fn(),
  quotaMock: vi.fn(),
  streamMock: vi.fn(),
  parseMock: vi.fn(),
  passagesMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUserEmail: emailMock }));
vi.mock("@/db/rate-limit", () => ({
  CHAT_RATE_LIMITS: { perMinute: 10, perDay: 100 },
  consumeChatQuota: quotaMock,
}));
vi.mock("@/lib/chat/passages", () => ({ getPassageProvider: () => passagesMock }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = { messages: { stream: streamMock } };
    messages = { parse: parseMock };
  },
}));

import { POST } from "@/app/api/chat/route";
import { OFF_TOPIC_ANSWER } from "@/lib/chat/topic-check";

const PASSAGE = {
  id: "p1",
  sectionPath: ["Training Budget"],
  text: "Each employee has an annual training budget.",
  documentTitle: "Handbook",
  url: "https://example.test/handbook",
  lastUpdated: "2026-10-01",
};

function claudeSays(chunks: string[], failAfter?: Error) {
  streamMock.mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {
      for (const text of chunks) {
        yield { type: "content_block_delta", delta: { type: "text_delta", text } };
      }
      if (failAfter) throw failAfter;
    },
    finalMessage: async () => ({ stop_reason: "end_turn" }),
  }));
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function events(res: Response): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  if (!res.body) throw new Error("no body");
  for await (const event of readChatStream(res.body)) out.push(event);
  return out;
}

beforeEach(() => {
  emailMock.mockResolvedValue("a@ingagepartners.com");
  passagesMock.mockResolvedValue([PASSAGE]);
  quotaMock.mockResolvedValue({ allowed: true });
  parseMock.mockResolvedValue({ stop_reason: "end_turn", parsed_output: { topic: "handbook" } });
});

afterEach(() => {
  vi.restoreAllMocks();
  passagesMock.mockReset();
  parseMock.mockReset();
  quotaMock.mockReset();
  emailMock.mockReset();
  streamMock.mockReset();
});

describe("POST /api/chat", () => {
  it("searches the topic the topic check picked", async () => {
    claudeSays(["You have an annual training budget [p1]."]);
    await events(await POST(post({ question: "Budget?" })));
    expect(passagesMock).toHaveBeenCalledWith("Budget?", ["handbook"]);
  });

  it("returns 401 when signed out", async () => {
    emailMock.mockResolvedValue(null);
    const res = await POST(post({ question: "Budget?" }));
    expect(res.status).toBe(401);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a body that isn't JSON", async () => {
    const res = await POST(post("not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Request body must be JSON" });
  });

  it("returns 400 with the first validation message", async () => {
    const res = await POST(post({ question: "   " }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Question is required" });
  });

  it("streams an answer with citations as NDJSON", async () => {
    claudeSays(["You have an annual training budget [p1]."]);
    const res = await POST(post({ question: "What is my training budget?" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const all = await events(res);
    expect(
      all
        .filter((e) => e.type === "delta")
        .map((e) => e.text)
        .join(""),
    ).toBe("You have an annual training budget.");
    expect(all.find((e) => e.type === "citation")).toMatchObject({
      citation: { id: "p1", sectionPath: ["Training Budget"] },
    });
    expect(all.at(-1)).toMatchObject({ type: "done", outcome: "answered" });
  });

  it("answers don't-know without calling Claude when no passage is relevant enough", async () => {
    passagesMock.mockResolvedValue([]);
    const all = await events(await POST(post({ question: "History of space travel?" })));
    expect(streamMock).not.toHaveBeenCalled();
    expect(all.at(-1)).toEqual({ type: "done", outcome: "dont-know", sources: [] });
  });

  it("ends the stream with an error and a reference when Claude fails, without logging the question", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    claudeSays(
      ["Partial "],
      new Error("overloaded while reading: What is my secret training budget?"),
    );

    const res = await POST(post({ question: "What is my secret training budget?" }));
    const error = await events(res).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChatStreamError);
    expect((error as ChatStreamError).message).toBe("Could not get an answer. Try again.");
    expect((error as ChatStreamError).correlationId).toMatch(/^[0-9a-f]{8}$/);
    const log = logged.mock.calls.flat().map(String).join(" ");
    expect(log).toContain("[api/chat ");
    expect(log).not.toContain("secret training budget");
  });

  it("returns 500 with a reference when search or re-ranking fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    passagesMock.mockRejectedValue(
      Object.assign(new Error("invalid input: my private budget question"), { status: 422 }),
    );

    const res = await POST(post({ question: "my private budget question" }));

    const log = logged.mock.calls.flat().map(String).join(" ");
    expect(log).toMatch(/\[api\/chat [0-9a-f]{8}\] retrieve passages failed: Error status=422/);
    expect(log).not.toContain("private");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; correlationId: string };
    expect(body.error).toBe("Could not search the handbook");
    expect(body.correlationId).toMatch(/^[0-9a-f]{8}$/);
  });

  it("politely refuses an off-topic question without searching or answering", async () => {
    parseMock.mockResolvedValue({ stop_reason: "end_turn", parsed_output: { topic: "off-topic" } });

    const all = await events(await POST(post({ question: "What's the capital of France?" })));

    expect(all).toEqual([
      { type: "delta", text: OFF_TOPIC_ANSWER },
      { type: "done", outcome: "off-topic", sources: [] },
    ]);
    expect(passagesMock).not.toHaveBeenCalled();
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("falls back to searching when the topic check fails, without logging the question", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    parseMock.mockRejectedValue(new Error("overloaded: What is my secret budget?"));
    claudeSays(["You have an annual training budget [p1]."]);

    const all = await events(await POST(post({ question: "What is my secret budget?" })));

    expect(passagesMock).toHaveBeenCalledWith("What is my secret budget?", ["handbook"]);
    expect(all.at(-1)).toMatchObject({ type: "done", outcome: "answered" });
    const log = logged.mock.calls.flat().map(String).join(" ");
    expect(log).toMatch(/\[api\/chat [0-9a-f]{8}\] topic check failed/);
    expect(log).not.toContain("secret budget");
  });

  it("counts the question against the signed-in user's quota", async () => {
    claudeSays(["You have an annual training budget [p1]."]);
    await events(await POST(post({ question: "Budget?" })));
    expect(quotaMock).toHaveBeenCalledWith("a@ingagepartners.com");
  });

  it("returns 429 with Retry-After over the per-minute limit, before any model call", async () => {
    quotaMock.mockResolvedValue({ allowed: false, limit: "minute", retryAfterSeconds: 42 });

    const res = await POST(post({ question: "Budget?" }));

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(await res.json()).toEqual({
      error: "You've asked 10 questions in the last minute. Try again in 42 seconds.",
    });
    expect(parseMock).not.toHaveBeenCalled();
    expect(passagesMock).not.toHaveBeenCalled();
  });

  it("returns 429 over the per-day limit", async () => {
    quotaMock.mockResolvedValue({ allowed: false, limit: "day", retryAfterSeconds: 3600 });

    const res = await POST(post({ question: "Budget?" }));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "You've reached today's limit of 100 questions. Try again tomorrow.",
    });
  });

  it("rejects oversize input with 400 without using up the quota", async () => {
    const res = await POST(post({ question: "x".repeat(1001) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Question must be 1000 characters or fewer" });

    const turns = Array.from({ length: 7 }, () => ({ role: "user", content: "hi" }));
    expect((await POST(post({ question: "Q?", history: turns }))).status).toBe(400);
    expect(quotaMock).not.toHaveBeenCalled();
  });

  it("returns 500 with a reference when the quota can't be checked", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    quotaMock.mockRejectedValue(Object.assign(new Error("db down"), { code: "57P01" }));

    const res = await POST(post({ question: "Budget?" }));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; correlationId: string };
    expect(body.error).toBe("Could not check your question limit");
    expect(logged.mock.calls.flat().join(" ")).toMatch(
      /check question limit failed: Error code=57P01/,
    );
  });
});
