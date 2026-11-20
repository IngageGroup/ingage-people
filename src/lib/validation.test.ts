import { describe, expect, it } from "vitest";
import {
  CHAT_HISTORY_MAX_TURNS,
  CHAT_QUESTION_MAX,
  CHAT_TURN_TEXT_MAX,
  chatRequestSchema,
} from "@/lib/validation";

describe("chatRequestSchema", () => {
  function chatError(input: unknown): string | undefined {
    const result = chatRequestSchema.safeParse(input);
    return result.success ? undefined : result.error.issues[0]?.message;
  }

  it("accepts a question and defaults history to empty", () => {
    expect(chatRequestSchema.parse({ question: "  How much PTO do I get?  " })).toEqual({
      question: "How much PTO do I get?",
      history: [],
    });
  });

  it("accepts IANA time zones and UTC", () => {
    expect(chatRequestSchema.parse({ question: "Q", timeZone: "America/New_York" }).timeZone).toBe(
      "America/New_York",
    );
    expect(chatRequestSchema.parse({ question: "Q", timeZone: "UTC" }).timeZone).toBe("UTC");
  });

  it("rejects an unknown time zone", () => {
    expect(chatError({ question: "Q", timeZone: "Mars/Base" })).toBe("Unknown time zone");
  });

  it("leaves time zone unset when the browser sends none", () => {
    expect(chatRequestSchema.parse({ question: "Q" }).timeZone).toBeUndefined();
  });

  it("allows earlier answers long enough to hold a month of hours", () => {
    expect(CHAT_TURN_TEXT_MAX).toBe(8000);
  });

  it("requires a non-blank question", () => {
    expect(chatError({ question: "   " })).toBe("Question is required");
  });

  it("caps the question length", () => {
    expect(chatError({ question: "a".repeat(CHAT_QUESTION_MAX + 1) })).toBe(
      `Question must be ${CHAT_QUESTION_MAX} characters or fewer`,
    );
  });

  it("caps the number of earlier turns", () => {
    const history = Array.from({ length: CHAT_HISTORY_MAX_TURNS + 1 }, () => ({
      role: "user",
      content: "hi",
    }));
    expect(chatError({ question: "q", history })).toBe(
      `Send at most ${CHAT_HISTORY_MAX_TURNS} earlier turns`,
    );
  });

  it("rejects unknown turn roles", () => {
    expect(chatError({ question: "q", history: [{ role: "system", content: "x" }] })).toBe(
      "Turn role must be user or assistant",
    );
  });
});
