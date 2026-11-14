import { describe, expect, it } from "vitest";
import { type ChatEvent, ChatStreamError, encodeChatEvent, readChatStream } from "@/lib/chat-protocol";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of readChatStream(streamOf(chunks))) events.push(event);
  return events;
}

const citation = {
  id: "p1",
  sectionPath: ["Benefits", "Training Budget"],
  quote: "Each employee has an annual training budget.",
  documentTitle: "Ingage Employee Handbook",
  url: "https://example.sharepoint.com/handbook.pdf#page=12",
  page: 12,
};
const done: ChatEvent = {
  type: "done",
  outcome: "answered",
  sources: [{ title: "Ingage Employee Handbook", lastUpdated: "2026-10-01" }],
};

describe("readChatStream", () => {
  it("yields deltas, citations and done in order", async () => {
    const events = await collect([
      encodeChatEvent({ type: "delta", text: "You get " }),
      encodeChatEvent({ type: "delta", text: "a budget." }),
      encodeChatEvent({ type: "citation", citation }),
      encodeChatEvent(done),
    ]);
    expect(events.map((e) => e.type)).toEqual(["delta", "delta", "citation", "done"]);
  });

  it("reassembles lines split across chunks", async () => {
    const line = encodeChatEvent({ type: "delta", text: "Hello" }) + encodeChatEvent(done);
    const events = await collect([line.slice(0, 7), line.slice(7, 30), line.slice(30)]);
    expect(events[0]).toEqual({ type: "delta", text: "Hello" });
    expect(events[1]?.type).toBe("done");
  });

  it("accepts a final line without a trailing newline", async () => {
    const events = await collect([JSON.stringify(done)]);
    expect(events).toEqual([done]);
  });

  it("throws the server's message and correlation id on an error event", async () => {
    const stream = streamOf([
      encodeChatEvent({ type: "delta", text: "Partial" }),
      encodeChatEvent({ type: "error", error: "Upstream failed", correlationId: "abc12345" }),
    ]);
    const seen: ChatEvent[] = [];
    const error = await (async () => {
      try {
        for await (const event of readChatStream(stream)) seen.push(event);
      } catch (err) {
        return err;
      }
    })();
    expect(seen).toHaveLength(1);
    expect(error).toBeInstanceOf(ChatStreamError);
    expect(error).toMatchObject({ message: "Upstream failed", correlationId: "abc12345" });
  });

  it("throws when the stream ends without done", async () => {
    await expect(collect([encodeChatEvent({ type: "delta", text: "Cut" })])).rejects.toThrow(
      "The answer was cut off. Try again.",
    );
  });

  it("throws on malformed JSON", async () => {
    await expect(collect(["not json\n"])).rejects.toThrow("The server sent a malformed response.");
  });

  it("throws on an unknown event type", async () => {
    await expect(collect(['{"type":"surprise"}\n'])).rejects.toThrow(
      "The server sent an unexpected response.",
    );
  });

  it("rejects a citation without a valid URL", async () => {
    const bad = JSON.stringify({ type: "citation", citation: { ...citation, url: "nope" } });
    await expect(collect([`${bad}\n`])).rejects.toThrow("The server sent an unexpected response.");
  });

  it("ignores blank lines", async () => {
    const events = await collect(["\n\n", encodeChatEvent(done)]);
    expect(events).toEqual([done]);
  });
});
