import { afterEach, describe, expect, it, vi } from "vitest";
import { checkTopic, offTopicAnswer, type TopicClient } from "@/lib/chat/topic-check";

function fakeClient(result: { topic: string } | null, stopReason = "end_turn") {
  const parse = vi.fn(async (_params: Record<string, unknown>) => ({
    stop_reason: stopReason,
    parsed_output: result,
  }));
  return { client: { messages: { parse } } as unknown as TopicClient, parse };
}

function sentText(parse: ReturnType<typeof fakeClient>["parse"]): string {
  const params = parse.mock.calls[0]?.[0] as { messages: { content: string }[] };
  return params.messages.map((m) => m.content).join("\n");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("checkTopic", () => {
  it("returns the topic for a handbook question", async () => {
    const { client } = fakeClient({ topic: "handbook" });
    expect(await checkTopic({ question: "How do I request PTO?", history: [], client })).toBe(
      "handbook",
    );
  });

  it("returns off-topic for anything else", async () => {
    const { client } = fakeClient({ topic: "off-topic" });
    expect(await checkTopic({ question: "Capital of France?", history: [], client })).toBe(
      "off-topic",
    );
  });

  it("sends the last two earlier turns so follow-ups keep their topic", async () => {
    const { client, parse } = fakeClient({ topic: "handbook" });
    await checkTopic({
      question: "What about part-time?",
      history: [
        { role: "user", content: "Oldest question" },
        { role: "assistant", content: "Oldest answer" },
        { role: "user", content: "How much PTO do I get?" },
        { role: "assistant", content: "Full-time employees get 20 days." },
      ],
      client,
    });

    const sent = sentText(parse);
    expect(sent).toContain("How much PTO do I get?");
    expect(sent).toContain("Full-time employees get 20 days.");
    expect(sent).toContain("What about part-time?");
    expect(sent).not.toContain("Oldest");
  });

  it("treats a declined classification as off-topic", async () => {
    const { client } = fakeClient(null, "refusal");
    expect(await checkTopic({ question: "Q?", history: [], client })).toBe("off-topic");
  });

  it("fails when the answer can't be parsed", async () => {
    const { client } = fakeClient(null, "max_tokens");
    await expect(checkTopic({ question: "Q?", history: [], client })).rejects.toThrow(
      "Topic check returned no classification (stop reason max_tokens)",
    );
  });

  it("lets API errors through for the caller to handle", async () => {
    const parse = vi.fn(async () => {
      throw new Error("overloaded");
    });
    const client = { messages: { parse } } as unknown as TopicClient;
    await expect(checkTopic({ question: "Q?", history: [], client })).rejects.toThrow("overloaded");
  });

  it("uses a small fast model with structured output and no thinking", async () => {
    const { client, parse } = fakeClient({ topic: "handbook" });
    await checkTopic({ question: "Q?", history: [], client });
    const params = parse.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(params["model"]).toBe("claude-haiku-5-5");
    expect(params["thinking"]).toEqual({ type: "disabled" });
    expect(params["output_config"]).toMatchObject({
      effort: "low",
      format: { type: "json_schema" },
    });
    expect(String(params["system"])).toContain("handbook");
  });

  it("reads the model from CHAT_TOPIC_MODEL", async () => {
    vi.stubEnv("CHAT_TOPIC_MODEL", "claude-test");
    const { client, parse } = fakeClient({ topic: "handbook" });
    await checkTopic({ question: "Q?", history: [], client });
    expect((parse.mock.calls[0]?.[0] as Record<string, unknown>)["model"]).toBe("claude-test");
  });
});

describe("offTopicAnswer", () => {
  it("lists what the chat can help with", () => {
    expect(offTopicAnswer()).toContain("Employee Handbook");
    expect(offTopicAnswer()).not.toContain("Your work");
  });

  it("includes the work topic when Microsoft 365 tools are on", () => {
    vi.stubEnv("M365_TOOLS", "enabled");
    expect(offTopicAnswer()).toContain("Your work");
  });
});

describe("checkTopic with Microsoft 365 tools on", () => {
  it("can classify a question as the work topic", async () => {
    vi.stubEnv("M365_TOOLS", "enabled");
    const { client, parse } = fakeClient({ topic: "work" });
    expect(await checkTopic({ question: "What did Acme say?", history: [], client })).toBe("work");
    const params = parse.mock.calls[0]?.[0] as { system: string };
    expect(params.system).toContain("- work: Your work:");
    expect(params.system).toContain(
      "Writing tasks (poems, jokes, drafts, rewrites) are off-topic even when they're about the user's own files, mail, or messages.",
    );
  });

  it("leaves the work topic out of the prompt while the tools are off", async () => {
    const { client, parse } = fakeClient({ topic: "handbook" });
    await checkTopic({ question: "Q?", history: [], client });
    expect((parse.mock.calls[0]?.[0] as { system: string }).system).not.toContain("- work:");
  });
});
