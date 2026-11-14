import { describe, expect, it } from "vitest";
import {
  CHAT_HISTORY_MAX_TURNS,
  CHAT_QUESTION_MAX,
  chatRequestSchema,
  createNoteSchema,
} from "@/lib/validation";

function firstError(input: unknown): string | undefined {
  const result = createNoteSchema.safeParse(input);
  return result.success ? undefined : result.error.issues[0]?.message;
}

describe("createNoteSchema", () => {
  it("requires a title", () => {
    expect(firstError({ title: "" })).toBe("Title is required");
  });

  it("treats a whitespace-only title as empty", () => {
    expect(firstError({ title: "   " })).toBe("Title is required");
  });

  it("rejects titles over 200 characters", () => {
    expect(firstError({ title: "a".repeat(201) })).toBe("Title must be 200 characters or fewer");
  });

  it("accepts a 200-character title", () => {
    expect(createNoteSchema.parse({ title: "a".repeat(200) }).title).toHaveLength(200);
  });

  it("trims the title", () => {
    expect(createNoteSchema.parse({ title: "  hi  " }).title).toBe("hi");
  });

  it("measures the length after trimming", () => {
    expect(createNoteSchema.parse({ title: ` ${"a".repeat(200)} ` }).title).toHaveLength(200);
  });

  it("rejects non-string and missing titles", () => {
    expect(firstError({ title: 123 })).toBeDefined();
    expect(firstError({ title: null })).toBeDefined();
    expect(firstError({})).toBeDefined();
    expect(firstError(null)).toBeDefined();
  });

  it("drops created_by from the body", () => {
    const parsed = createNoteSchema.parse({ title: "x", created_by: "evil@x.com" });
    expect(parsed).toEqual({ title: "x" });
  });
});

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
