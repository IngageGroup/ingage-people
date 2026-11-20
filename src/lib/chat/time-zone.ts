import type { FetchFn } from "@/lib/graph/client";
import { mailboxTimeZone } from "@/lib/graph/mailbox";
import { GraphTokenError } from "@/lib/graph-token";
import { describeError } from "@/lib/safe-error";

export interface ResolvedTimeZone {
  timeZone: string;
  /** False when neither Outlook nor the browser gave a zone and `timeZone` is UTC. */
  known: boolean;
}

async function outlookZone(
  graphToken: () => Promise<string>,
  fetchFn?: FetchFn,
): Promise<string | null> {
  try {
    return await mailboxTimeZone(await graphToken(), fetchFn);
  } catch (err) {
    if (!(err instanceof GraphTokenError && err.reason === "unavailable")) {
      console.error(`[time-zone] mailbox settings failed: ${describeError(err)}`);
    }
    return null;
  }
}

/**
 * The zone for today's date and calendar times: the user's Outlook setting when the
 * Microsoft 365 tools are on, then the browser's, then UTC. A failed Outlook read never
 * fails the question.
 */
export async function resolveTimeZone(args: {
  browserZone?: string | undefined;
  m365: boolean;
  graphToken: () => Promise<string>;
  fetchFn?: FetchFn;
}): Promise<ResolvedTimeZone> {
  const outlook = args.m365 ? await outlookZone(args.graphToken, args.fetchFn) : null;
  const zone = outlook ?? args.browserZone;
  return zone ? { timeZone: zone, known: true } : { timeZone: "UTC", known: false };
}
