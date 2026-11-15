import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { chatUsage } from "@/db/schema";

export interface ChatRateLimits {
  perMinute: number;
  perDay: number;
}

/** Generous for someone reading the handbook, low enough to cap a runaway script's cost. */
export const CHAT_RATE_LIMITS: ChatRateLimits = { perMinute: 10, perDay: 100 };

export type QuotaResult =
  | { allowed: true }
  | { allowed: false; limit: "minute" | "day"; retryAfterSeconds: number };

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Old counters are kept this long, then deleted on the user's next question. */
const RETENTION_MS = 2 * DAY_MS;

/** Thrown inside the transaction to undo the increments of a refused request. */
class OverLimit extends Error {
  constructor(readonly result: QuotaResult) {
    super("over limit");
  }
}

function floorTo(now: Date, unitMs: number): Date {
  return new Date(Math.floor(now.getTime() / unitMs) * unitMs);
}

function secondsUntil(now: Date, end: Date): number {
  return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 1000));
}

/**
 * Counts one chat question for the user if it's within both limits. A refused question
 * isn't counted, so waiting out the per-minute limit doesn't use up the day. Days are UTC.
 */
export async function consumeChatQuota(
  email: string,
  { now = new Date(), limits = CHAT_RATE_LIMITS }: { now?: Date; limits?: ChatRateLimits } = {},
): Promise<QuotaResult> {
  const userEmail = email.toLowerCase();
  const minuteStart = floorTo(now, MINUTE_MS);
  const dayStart = floorTo(now, DAY_MS);

  try {
    await getDb().transaction(async (tx) => {
      const counts = await tx
        .insert(chatUsage)
        .values([
          { userEmail, window: "minute", windowStart: minuteStart, count: 1 },
          { userEmail, window: "day", windowStart: dayStart, count: 1 },
        ])
        .onConflictDoUpdate({
          target: [chatUsage.userEmail, chatUsage.window, chatUsage.windowStart],
          set: { count: sql`${chatUsage.count} + 1` },
        })
        .returning({ window: chatUsage.window, count: chatUsage.count });
      const countFor = (window: string) => counts.find((c) => c.window === window)?.count ?? 0;

      if (countFor("minute") > limits.perMinute) {
        const end = new Date(minuteStart.getTime() + MINUTE_MS);
        throw new OverLimit({
          allowed: false,
          limit: "minute",
          retryAfterSeconds: secondsUntil(now, end),
        });
      }
      if (countFor("day") > limits.perDay) {
        const end = new Date(dayStart.getTime() + DAY_MS);
        throw new OverLimit({
          allowed: false,
          limit: "day",
          retryAfterSeconds: secondsUntil(now, end),
        });
      }
      await tx
        .delete(chatUsage)
        .where(
          and(
            eq(chatUsage.userEmail, userEmail),
            lt(chatUsage.windowStart, new Date(now.getTime() - RETENTION_MS)),
          ),
        );
    });
  } catch (err) {
    if (err instanceof OverLimit) return err.result;
    throw err;
  }
  return { allowed: true };
}
