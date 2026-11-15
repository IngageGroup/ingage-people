import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChatEvent, ChatStreamError, readChatStream } from "@/lib/chat-protocol";

const { emailMock, streamMock, passagesMock } = vi.hoisted(() => ({
  emailMock: vi.fn(),
  streamMock: vi.fn(),
  passagesMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUserEmail: emailMock }));
vi.mock("@/lib/chat/passages", () => ({ getPassageProvider: () => passagesMock }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = { messages: { stream: streamMock } };
  },
}));

import { POST } from "@/app/api/chat/route";

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
});

afterEach(() => {
  vi.restoreAllMocks();
  passagesMock.mockReset();
  emailMock.mockReset();
  streamMock.mockReset();
});

describe("POST /api/chat", () => {
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
    claudeSays(["Partial "], new Error("overloaded"));

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
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    passagesMock.mockRejectedValue(new Error("Voyage rerank failed: HTTP 503"));

    const res = await POST(post({ question: "Budget?" }));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; correlationId: string };
    expect(body.error).toBe("Could not search the handbook");
    expect(body.correlationId).toMatch(/^[0-9a-f]{8}$/);
  });
});
