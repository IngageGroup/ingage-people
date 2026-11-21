import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { TallyError } from "@/lib/chat/tally";
import { CalendarRangeError } from "@/lib/graph/calendar";
import { GraphError } from "@/lib/graph/client";
import { GraphTokenError } from "@/lib/graph-token";
import { describeError } from "@/lib/safe-error";

/** What Claude is told when a tool fails; never Graph's or the database's own message. */
function failureMessage(err: unknown): string {
  if (err instanceof GraphTokenError) {
    return err.reason === "unavailable"
      ? "Microsoft 365 isn't available in this session."
      : "Microsoft 365 sign-in has expired; ask the user to sign in again.";
  }
  if (err instanceof GraphError) {
    if (err.failure === "forbidden" || err.failure === "not-found") {
      return "That item can't be opened with your access.";
    }
    if (err.failure === "throttled" || err.failure === "unavailable") {
      return "Microsoft 365 is busy; try again shortly.";
    }
  }
  return "The search failed; try again.";
}

/**
 * Runs a tool body; failures are logged without content and returned to Claude as errors.
 * Errors meant for Claude (a `ToolError`, or a calendar range or tally problem) pass through
 * with their own message and aren't logged.
 */
export async function guarded(name: string, body: () => Promise<string>): Promise<string> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof ToolError) throw err;
    if (err instanceof CalendarRangeError || err instanceof TallyError) {
      throw new ToolError(err.message);
    }
    if (!(err instanceof GraphTokenError && err.reason === "unavailable")) {
      console.error(`[chat-tools] ${name} failed: ${describeError(err)}`);
    }
    throw new ToolError(failureMessage(err));
  }
}
