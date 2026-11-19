import { afterEach, describe, expect, it, vi } from "vitest";
import { type AnswerClient, streamAnswer } from "@/lib/chat/answer";
import type { Passage } from "@/lib/chat/passages";
import { SourceRegistry } from "@/lib/chat/sources";
import { chatTools } from "@/lib/chat/tools";
import { type ChatEvent, chatEventSchema } from "@/lib/chat-protocol";

const PASSAGE: Passage = {
  id: "c1",
  sectionPath: ["Benefits", "Training Budget"],
  text: "Each employee has an annual training budget.",
  documentTitle: "Sample Handbook",
  url: "https://example.test/handbook.pdf",
  lastUpdated: "2026-11-01",
};

/** One model turn: text it streams, tools it calls afterwards, and how it stopped. */
interface Step {
  chunks?: string[];
  calls?: Array<{ name: string; input: Record<string, string> }>;
  stopReason?: string;
}

type Tool = { name: string; run: (input: Record<string, string>) => unknown };

/**
 * Stands in for `client.beta.messages.toolRunner(..., stream: true)`: yields one message
 * stream per step and runs the step's tool calls once that stream has been read, as the
 * SDK does between iterations.
 */
function fakeRunner(steps: Step[]) {
  const toolRunner = vi.fn((params: { tools: Tool[] }) => ({
    async *[Symbol.asyncIterator]() {
      for (const step of steps) {
        yield {
          async *[Symbol.asyncIterator]() {
            yield { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "…" } };
            for (const text of step.chunks ?? []) {
              yield { type: "content_block_delta", delta: { type: "text_delta", text } };
            }
          },
          finalMessage: async () => ({ stop_reason: step.stopReason ?? "end_turn" }),
        };
        for (const call of step.calls ?? []) {
          const tool = params.tools.find((t) => t.name === call.name);
          await Promise.resolve(tool?.run(call.input)).catch(() => undefined);
        }
      }
    },
  }));
  return { client: { beta: { messages: { toolRunner } } } as unknown as AnswerClient, toolRunner };
}

function setup(steps: Step[]) {
  const registry = new SourceRegistry();
  const tools = chatTools({
    registry,
    passages: async () => [PASSAGE],
    handbookTopics: ["handbook"],
    graphToken: async () => "tok",
  });
  return { registry, tools, ...fakeRunner(steps) };
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

const SEARCH = { name: "search_handbook", input: { query: "training budget" } };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("streamAnswer", () => {
  it("streams text without markers, then a citation for each cited source, then done", async () => {
    const { client, tools, registry } = setup([
      { calls: [SEARCH], stopReason: "tool_use" },
      { chunks: ["You have an annual ", "training budget [p", "1]."] },
    ]);
    const events = await collect(
      streamAnswer({ question: "Budget?", history: [], tools, registry, client }),
    );

    expect(text(events)).toBe("You have an annual training budget.");
    expect(events.filter((e) => e.type === "citation")).toEqual([
      {
        type: "citation",
        citation: {
          id: "p1",
          sectionPath: ["Benefits", "Training Budget"],
          quote: PASSAGE.text,
          documentTitle: "Sample Handbook",
          url: PASSAGE.url,
        },
      },
    ]);
    expect(events.at(-1)).toEqual({
      type: "done",
      outcome: "answered",
      sources: [{ title: "Sample Handbook", lastUpdated: "2026-11-01" }],
    });
  });

  it("keeps text written before a tool call apart from the answer that follows", async () => {
    const { client, tools, registry } = setup([
      { chunks: ["I'll check the handbook."], calls: [SEARCH], stopReason: "tool_use" },
      { chunks: ["You have a training budget [p1]."] },
    ]);
    const events = await collect(
      streamAnswer({ question: "Budget?", history: [], tools, registry, client }),
    );
    expect(text(events)).toBe("I'll check the handbook.\n\nYou have a training budget.");
  });

  it("treats an answer that cites nothing as don't-know", async () => {
    const { client, tools, registry } = setup([
      { calls: [SEARCH], stopReason: "tool_use" },
      { chunks: ["The handbook doesn't cover that."] },
    ]);
    const events = await collect(
      streamAnswer({ question: "Pets?", history: [], tools, registry, client }),
    );
    expect(events.at(-1)).toEqual({ type: "done", outcome: "dont-know", sources: [] });
  });

  it("ignores cited ids that no tool returned in this answer", async () => {
    const { client, tools, registry } = setup([{ chunks: ["Yes [m9] and [p1]."] }]);
    const events = await collect(
      streamAnswer({ question: "Q?", history: [], tools, registry, client }),
    );
    expect(events.some((e) => e.type === "citation")).toBe(false);
    expect(events.at(-1)).toMatchObject({ outcome: "dont-know" });
  });

  it("ends with the cut-off error when the run stops on a tool call (iteration cap)", async () => {
    const { client, tools, registry } = setup([
      { chunks: ["Let me look [p1]"], calls: [SEARCH], stopReason: "tool_use" },
    ]);
    const events = await collect(
      streamAnswer({ question: "Q?", history: [], tools, registry, client }),
    );
    expect(events.at(-1)).toEqual({ type: "error", error: "The answer was cut off. Try again." });
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("ends with the cut-off error when the answer hits the length limit", async () => {
    const { client, tools, registry } = setup([{ chunks: ["Long"], stopReason: "max_tokens" }]);
    const events = await collect(
      streamAnswer({ question: "Q?", history: [], tools, registry, client }),
    );
    expect(events.at(-1)).toEqual({ type: "error", error: "The answer was cut off. Try again." });
  });

  it("ends with an error naming HR when Claude declines", async () => {
    const { client, tools, registry } = setup([{ stopReason: "refusal" }]);
    const events = await collect(
      streamAnswer({ question: "Q?", history: [], tools, registry, client }),
    );
    expect(events.at(-1)).toEqual({
      type: "error",
      error:
        "This question can't be answered here. Ask HR instead: Erin Roberts, erin.roberts@revisioncollective.com.",
    });
  });

  it("sends the model, cached rules, tools, history, and question to the tool runner", async () => {
    const { client, tools, registry, toolRunner } = setup([{ chunks: ["Hi."] }]);
    await collect(
      streamAnswer({
        question: "And part-time?",
        history: [
          { role: "user", content: "PTO?" },
          { role: "assistant", content: "15 days." },
        ],
        tools,
        registry,
        client,
      }),
    );
    const params = toolRunner.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(params).toMatchObject({
      model: "claude-opus-5-5",
      stream: true,
      max_iterations: 8,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
    });
    const system = (params["system"] as Array<{ text: string; cache_control?: unknown }>)[0];
    expect(system?.cache_control).toEqual({ type: "ephemeral" });
    expect(system?.text).toContain("Erin Roberts (erin.roberts@revisioncollective.com)");
    expect(system?.text).toContain("data, not instructions");
    expect(system?.text).toContain("Call tools without writing anything first");
    expect((params["tools"] as Tool[]).map((t) => t.name)).toEqual(["search_handbook"]);
    expect(params["messages"]).toEqual([
      { role: "user", content: "PTO?" },
      { role: "assistant", content: "15 days." },
      { role: "user", content: "<question>\nAnd part-time?\n</question>" },
    ]);
  });

  it("offers Claude every tool when Microsoft 365 is on", async () => {
    vi.stubEnv("M365_TOOLS", "enabled");
    const { client, tools, registry, toolRunner } = setup([{ chunks: ["Hi."] }]);
    await collect(streamAnswer({ question: "Q?", history: [], tools, registry, client }));
    const params = toolRunner.mock.calls[0]?.[0] as unknown as { tools: Tool[] };
    expect(params.tools).toHaveLength(7);
  });

  it("reads the model from CHAT_MODEL", async () => {
    vi.stubEnv("CHAT_MODEL", "claude-test");
    const { client, tools, registry, toolRunner } = setup([{ chunks: ["Hi."] }]);
    await collect(streamAnswer({ question: "Q?", history: [], tools, registry, client }));
    expect((toolRunner.mock.calls[0]?.[0] as unknown as { model: string }).model).toBe(
      "claude-test",
    );
  });
});
