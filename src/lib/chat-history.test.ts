import { describe, expect, it } from "vitest";
import { buildHistory } from "@/lib/chat-history";
import { CHAT_HISTORY_MAX_TURNS, CHAT_TURN_TEXT_MAX, chatRequestSchema } from "@/lib/validation";

describe("buildHistory", () => {
  it("returns no turns for a new chat", () => {
    expect(buildHistory([])).toEqual([]);
  });

  it("alternates user and assistant turns, oldest first", () => {
    expect(
      buildHistory([
        { question: "Q1", answer: "A1" },
        { question: "Q2", answer: "A2" },
      ]),
    ).toEqual([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
      { role: "assistant", content: "A2" },
    ]);
  });

  it("keeps only the most recent turns", () => {
    const exchanges = Array.from({ length: 10 }, (_, i) => ({
      question: `Q${i}`,
      answer: `A${i}`,
    }));
    const history = buildHistory(exchanges);
    expect(history).toHaveLength(CHAT_HISTORY_MAX_TURNS);
    expect(history.at(-1)).toEqual({ role: "assistant", content: "A9" });
    expect(history[0]?.role).toBe("user");
  });

  it("truncates long turns so the request stays valid", () => {
    const long = "x".repeat(CHAT_TURN_TEXT_MAX + 50);
    const history = buildHistory([{ question: long, answer: long }]);
    expect(history.every((turn) => turn.content.length === CHAT_TURN_TEXT_MAX)).toBe(true);
    expect(chatRequestSchema.safeParse({ question: "next", history }).success).toBe(true);
  });
});
