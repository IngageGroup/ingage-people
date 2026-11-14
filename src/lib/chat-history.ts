import { CHAT_HISTORY_MAX_TURNS, CHAT_TURN_TEXT_MAX, type ChatTurn } from "@/lib/validation";

/** A finished exchange the client may send back for follow-up questions. */
export type CompletedExchange = { question: string; answer: string };

/**
 * The earlier turns sent with a new question: the most recent completed exchanges, oldest
 * first, within the request schema's turn and length limits. Exchanges that failed or
 * produced no answer text are left out by the caller.
 */
export function buildHistory(exchanges: CompletedExchange[]): ChatTurn[] {
  const turns = exchanges.flatMap<ChatTurn>(({ question, answer }) => [
    { role: "user", content: question.slice(0, CHAT_TURN_TEXT_MAX) },
    { role: "assistant", content: answer.slice(0, CHAT_TURN_TEXT_MAX) },
  ]);
  return turns.slice(-CHAT_HISTORY_MAX_TURNS);
}
