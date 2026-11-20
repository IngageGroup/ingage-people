import { z } from "zod";

export const CHAT_QUESTION_MAX = 1000;
/** Earlier turns the client sends for follow-ups. The server keeps nothing. */
export const CHAT_HISTORY_MAX_TURNS = 6;
/** Long enough for a month of growth-hours lines, so corrections still see them. */
export const CHAT_TURN_TEXT_MAX = 8000;

const chatTurnSchema = z.object({
  role: z.enum(["user", "assistant"], { error: "Turn role must be user or assistant" }),
  content: z
    .string({ error: "Turn content must be text" })
    .max(CHAT_TURN_TEXT_MAX, `Each earlier turn must be ${CHAT_TURN_TEXT_MAX} characters or fewer`),
});

/** `Intl.supportedValuesOf` doesn't always list "UTC", which browsers can report. */
function isTimeZone(zone: string): boolean {
  return zone === "UTC" || Intl.supportedValuesOf("timeZone").includes(zone);
}

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
  /** The browser's IANA time zone, for calendar times and today's date. Not identity. */
  timeZone: z
    .string({ error: "Time zone must be text" })
    .max(64, "Unknown time zone")
    .refine(isTimeZone, "Unknown time zone")
    .optional(),
});

export type ChatTurn = z.infer<typeof chatTurnSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
