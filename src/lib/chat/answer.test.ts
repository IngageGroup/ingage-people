import { afterEach, describe, expect, it, vi } from "vitest";
import { type AnswerClient, NO_PASSAGES_ANSWER, streamAnswer } from "@/lib/chat/answer";
import type { Passage } from "@/lib/chat/passages";
import { type ChatEvent, chatEventSchema } from "@/lib/chat-protocol";

const PASSAGES: Passage[] = [
  {
    id: "p1",
    sectionPath: ["Benefits", "Training Budget"],
    text: "Each employee has an annual training budget.",
    documentTitle: "Sample Handbook",
    url: "file:///tmp/handbook.md",
    lastUpdated: "2026-11-01",
  },
  {
    id: "p2",
    sectionPath: ["Benefits", "Paid Time Off"],
    text: "Request PTO two weeks ahead.",
    documentTitle: "Sample Handbook",
    url: "file:///tmp/handbook.md",
    lastUpdated: "2026-11-01",
  },
];

type StreamEvent = { type: string; delta?: { type: string; text?: string; thinking?: string } };

function fakeClient(chunks: string[], stopReason = "end_turn") {
  const events: StreamEvent[] = [
    { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
    ...chunks.map((text) => ({ type: "content_block_delta", delta: { type: "text_delta", text } })),
  ];
  const stream = vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    finalMessage: async () => ({ stop_reason: stopReason }),
  }));
  return { client: { beta: { messages: { stream } } } as unknown as AnswerClient, stream };
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of events) {
    expect(chatEventSchema.safeParse(event).success).toBe(true);
    out.push(event);
  }
  return out;
}

const text = (events: ChatEvent[]) =>
  events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("streamAnswer", () => {
  it("answers don't-know without calling Claude when there are no passages", async () => {
    const { client, stream } = fakeClient([]);
    const events = await collect(
      streamAnswer({ question: "Q?", history: [], passages: [], client }),
    );

    expect(stream).not.toHaveBeenCalled();
    expect(text(events)).toBe(NO_PASSAGES_ANSWER);
    expect(events.at(-1)).toEqual({ type: "done", outcome: "dont-know", sources: [] });
  });

  it("streams the answer without markers, then citations, then done", async () => {
    const { client } = fakeClient(["You have an annual training ", "budget [p1]."]);
    const events = await collect(
      streamAnswer({ question: "Budget?", history: [], passages: PASSAGES, client }),
    );

    expect(text(events)).toBe("You have an annual training budget.");
    const citations = events.filter((e) => e.type === "citation");
    expect(citations).toEqual([
      {
        type: "citation",
        citation: {
          id: "p1",
          sectionPath: ["Benefits", "Training Budget"],
          quote: "Each employee has an annual training budget.",
          documentTitle: "Sample Handbook",
          url: "file:///tmp/handbook.md",
        },
      },
    ]);
    expect(events.at(-1)).toEqual({
      type: "done",
      outcome: "answered",
      sources: [{ title: "Sample Handbook", lastUpdated: "2026-11-01" }],
    });
  });

  it("treats an answer that cites nothing as don't-know", async () => {
    const { client } = fakeClient(["The handbook doesn't cover that. Ask HR."]);
    const events = await collect(
      streamAnswer({ question: "Q?", history: [], passages: PASSAGES, client }),
    );
    expect(events.some((e) => e.type === "citation")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done", outcome: "dont-know", sources: [] });
  });

  it("ignores cited ids that weren't provided", async () => {
    const { client } = fakeClient(["Yes [p9]."]);
    const events = await collect(
      streamAnswer({ question: "Q?", history: [], passages: PASSAGES, client }),
    );
    expect(events.at(-1)).toMatchObject({ outcome: "dont-know" });
  });

  it("ends with an error when Claude declines", async () => {
    const { client } = fakeClient(["Partial"], "refusal");
    const events = await collect(
      streamAnswer({ question: "Q?", history: [], passages: PASSAGES, client }),
    );
    expect(events.at(-1)).toEqual({
      type: "error",
      error: "This question can't be answered here. Ask HR instead.",
    });
  });

  it("ends with an error when the answer hits the length limit", async () => {
    const { client } = fakeClient(["Long [p1]"], "max_tokens");
    const events = await collect(
      streamAnswer({ question: "Q?", history: [], passages: PASSAGES, client }),
    );
    expect(events.at(-1)).toEqual({ type: "error", error: "The answer was cut off. Try again." });
  });

  it("sends the model, cached rules, history, and the passages with their ids", async () => {
    vi.stubEnv("CHAT_MODEL", "claude-test-model");
    const { client, stream } = fakeClient(["Ok [p2]."]);
    await collect(
      streamAnswer({
        question: "How do I request PTO?",
        history: [
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
        ],
        passages: PASSAGES,
        client,
      }),
    );

    const params = (stream.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(params["model"]).toBe("claude-test-model");
    expect(params["fallbacks"]).toBe("default");
    expect(params["system"]).toEqual([
      expect.objectContaining({ type: "text", cache_control: { type: "ephemeral" } }),
    ]);
    const messages = params["messages"] as { role: string; content: string }[];
    expect(messages.slice(0, 2)).toEqual([
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
    ]);
    const last = messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toContain('<passage id="p2"');
    expect(last?.content).toContain("Request PTO two weeks ahead.");
    expect(last?.content).toContain("How do I request PTO?");
  });

  it("defaults to Claude Opus 5.5", async () => {
    vi.stubEnv("CHAT_MODEL", "");
    const { client, stream } = fakeClient(["Ok [p1]."]);
    await collect(streamAnswer({ question: "Q?", history: [], passages: PASSAGES, client }));
    const params = (stream.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(params["model"]).toBe("claude-opus-5-5");
  });
});
