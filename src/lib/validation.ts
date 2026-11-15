import { z } from "zod";

export const CHAT_QUESTION_MAX = 1000;
/** Earlier turns the client sends for follow-ups. The server keeps nothing. */
export const CHAT_HISTORY_MAX_TURNS = 6;
export const CHAT_TURN_TEXT_MAX = 4000;

const chatTurnSchema = z.object({
  role: z.enum(["user", "assistant"], { error: "Turn role must be user or assistant" }),
  content: z
    .string({ error: "Turn content must be text" })
    .max(CHAT_TURN_TEXT_MAX, `Each earlier turn must be ${CHAT_TURN_TEXT_MAX} characters or fewer`),
});

export const chatRequestSchema = z.object({
  question: z
    .string({ error: "Question must be text" })
    .trim()
    .min(1, "Question is required")
    .max(CHAT_QUESTION_MAX, `Question must be ${CHAT_QUESTION_MAX} characters or fewer`),
  history: z
    .array(chatTurnSchema)
    .max(CHAT_HISTORY_MAX_TURNS, `Send at most ${CHAT_HISTORY_MAX_TURNS} earlier turns`)
    .default([]),
});

export type ChatTurn = z.infer<typeof chatTurnSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
