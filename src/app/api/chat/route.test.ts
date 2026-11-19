import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChatEvent, ChatStreamError, readChatStream } from "@/lib/chat-protocol";

const { emailMock, toolRunnerMock, parseMock, passagesMock, quotaMock, recordMock } = vi.hoisted(
  () => ({
    emailMock: vi.fn(),
    recordMock: vi.fn(),
    quotaMock: vi.fn(),
    toolRunnerMock: vi.fn(),
    parseMock: vi.fn(),
    passagesMock: vi.fn(),
  }),
);

vi.mock("@/lib/auth", () => ({ getCurrentUserEmail: emailMock }));
vi.mock("@/db/rate-limit", () => ({
  CHAT_RATE_LIMITS: { perMinute: 10, perDay: 100 },
  consumeChatQuota: quotaMock,
}));
vi.mock("@/db/chat-stats", () => ({ recordChatOutcome: recordMock }));
vi.mock("@/lib/chat/passages", () => ({ getPassageProvider: () => passagesMock }));
vi.mock("@/lib/graph-token", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getGraphAccessToken: async () => M365_FIXTURE_TOKEN,
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = { messages: { toolRunner: toolRunnerMock } };
    messages = { parse: parseMock };
  },
}));

import { POST } from "@/app/api/chat/route";
import { M365_FIXTURE_TOKEN, m365FixtureFetch } from "@/eval/m365-fixtures";
import { offTopicAnswer } from "@/lib/chat/topic-check";

const PASSAGE = {
  id: "p1",
  sectionPath: ["Training Budget"],
  text: "Each employee has an annual training budget.",
  documentTitle: "Handbook",
  url: "https://example.test/handbook",
  lastUpdated: "2026-10-01",
};

type Tool = { name: string; run: (input: Record<string, string>) => unknown };

/**
 * Claude searches the handbook for the question, then streams `chunks` (optionally failing
 * after them). Stands in for the SDK tool runner, which runs tools between turns.
 */
function claudeSays(chunks: string[], failAfter?: Error) {
  toolRunnerMock.mockImplementation(
    (params: { tools: Tool[]; messages: Array<{ content: string }> }) => ({
      async *[Symbol.asyncIterator]() {
        const search = params.tools.find((t) => t.name === "search_handbook");
        const question = params.messages
          .at(-1)
          ?.content.replace(/<\/?question>/g, "")
          .trim();
        await Promise.resolve(search?.run({ query: question ?? "" })).catch(() => undefined);
        yield {
          async *[Symbol.asyncIterator]() {
            for (const text of chunks) {
              yield { type: "content_block_delta", delta: { type: "text_delta", text } };
            }
            if (failAfter) throw failAfter;
          },
          finalMessage: async () => ({ stop_reason: "end_turn" }),
        };
      },
    }),
  );
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
  recordMock.mockResolvedValue(undefined);
  parseMock.mockResolvedValue({ stop_reason: "end_turn", parsed_output: { topic: "handbook" } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  passagesMock.mockReset();
  parseMock.mockReset();
  quotaMock.mockReset();
  recordMock.mockReset();
  emailMock.mockReset();
  toolRunnerMock.mockReset();
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
    expect(toolRunnerMock).not.toHaveBeenCalled();
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

  it("answers don't-know when no passage is relevant enough", async () => {
    passagesMock.mockResolvedValue([]);
    claudeSays(["The handbook doesn't cover that."]);
    const all = await events(await POST(post({ question: "Dogs at the office?" })));
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

  it("turns a failed search into a tool error for Claude, logged without the question", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    passagesMock.mockRejectedValue(
      Object.assign(new Error("invalid input: my private budget question"), { status: 422 }),
    );
    claudeSays(["I couldn't search the handbook just now."]);

    const res = await POST(post({ question: "my private budget question" }));
    const all = await events(res);

    expect(res.status).toBe(200);
    expect(all.at(-1)).toMatchObject({ type: "done", outcome: "dont-know" });
    const log = logged.mock.calls.flat().map(String).join(" ");
    expect(log).toContain("[chat-tools] search_handbook failed: Error status=422");
    expect(log).not.toContain("private");
  });

  it("politely refuses an off-topic question without searching or answering", async () => {
    parseMock.mockResolvedValue({ stop_reason: "end_turn", parsed_output: { topic: "off-topic" } });

    const all = await events(await POST(post({ question: "What's the capital of France?" })));

    expect(all).toEqual([
      { type: "delta", text: offTopicAnswer() },
      { type: "done", outcome: "off-topic", sources: [] },
    ]);
    expect(passagesMock).not.toHaveBeenCalled();
    expect(toolRunnerMock).not.toHaveBeenCalled();
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

  describe("outcome counts", () => {
    it("records the topic, outcome, and cited sections of an answer", async () => {
      claudeSays(["You have an annual training budget [p1]."]);
      await events(await POST(post({ question: "Budget?" })));
      expect(recordMock).toHaveBeenCalledWith({
        topic: "handbook",
        outcome: "answered",
        citedSections: [["Training Budget"]],
      });
    });

    it("counts handbook sections only, never Microsoft 365 senders or folders", async () => {
      vi.stubEnv("M365_TOOLS", "enabled");
      vi.stubGlobal("fetch", m365FixtureFetch);
      toolRunnerMock.mockImplementation((params: { tools: Tool[] }) => ({
        async *[Symbol.asyncIterator]() {
          const run = (name: string) => params.tools.find((t) => t.name === name)?.run;
          await run("search_handbook")?.({ query: "training budget" });
          await run("search_mail")?.({ query: "training spend cap" });
          yield {
            async *[Symbol.asyncIterator]() {
              const text = "Your budget is set [p1], and Sam capped Q1 at $4,000 [m1].";
              yield { type: "content_block_delta", delta: { type: "text_delta", text } };
            },
            finalMessage: async () => ({ stop_reason: "end_turn" }),
          };
        },
      }));
      const all = await events(await POST(post({ question: "Budget?" })));
      expect(all.filter((e) => e.type === "citation")).toHaveLength(2);
      expect(recordMock).toHaveBeenCalledWith({
        topic: "handbook",
        outcome: "answered",
        citedSections: [["Training Budget"]],
      });
    });

    it("records off-topic questions", async () => {
      parseMock.mockResolvedValue({
        stop_reason: "end_turn",
        parsed_output: { topic: "off-topic" },
      });
      await events(await POST(post({ question: "Capital of France?" })));
      expect(recordMock).toHaveBeenCalledWith({
        topic: "off-topic",
        outcome: "off-topic",
        citedSections: [],
      });
    });

    it("records don't-know answers, and the topic as unclassified when the check failed", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      parseMock.mockRejectedValue(new Error("overloaded"));
      passagesMock.mockResolvedValue([]);
      claudeSays(["The handbook doesn't cover that."]);
      await events(await POST(post({ question: "Dogs at the office?" })));
      expect(recordMock).toHaveBeenCalledWith({
        topic: "unclassified",
        outcome: "dont-know",
        citedSections: [],
      });
    });

    it("records a failed answer as an error", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      claudeSays(["Partial "], new Error("overloaded"));
      await expect(events(await POST(post({ question: "Budget?" })))).rejects.toThrow(
        ChatStreamError,
      );
      expect(recordMock).toHaveBeenCalledWith({
        topic: "handbook",
        outcome: "error",
        citedSections: [],
      });
    });

    it("records a failed search as don't-know", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      passagesMock.mockRejectedValue(new Error("db down"));
      claudeSays(["I couldn't search the handbook just now."]);
      await events(await POST(post({ question: "Budget?" })));
      expect(recordMock).toHaveBeenCalledWith({
        topic: "handbook",
        outcome: "dont-know",
        citedSections: [],
      });
    });

    it("still answers when the count can't be saved, and logs it without the question", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      recordMock.mockRejectedValue(Object.assign(new Error("db down: Budget?"), { code: "57P01" }));
      claudeSays(["You have an annual training budget [p1]."]);

      const out = await events(await POST(post({ question: "Budget?" })));

      expect(out.at(-1)).toMatchObject({ type: "done", outcome: "answered" });
      const log = logged.mock.calls.flat().map(String).join(" ");
      expect(log).toMatch(/record outcome failed: Error code=57P01/);
      expect(log).not.toContain("Budget?");
    });

    it("records nothing for requests turned away before the pipeline", async () => {
      quotaMock.mockResolvedValue({ allowed: false, limit: "minute", retryAfterSeconds: 5 });
      await POST(post({ question: "Budget?" }));
      await POST(post({ question: "" }));
      expect(recordMock).not.toHaveBeenCalled();
    });
  });
});
