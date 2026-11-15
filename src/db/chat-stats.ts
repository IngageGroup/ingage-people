import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { chatCitationCounts, chatOutcomeCounts } from "@/db/schema";
import type { ChatOutcome } from "@/lib/chat-protocol";

export interface ChatOutcomeRecord {
  /** Topic-check result: a topic id, "off-topic", or "unclassified". */
  topic: string;
  outcome: ChatOutcome | "error";
  /** Heading paths of the passages the answer cited. */
  citedSections: string[][];
}

/**
 * Adds one answer to today's (UTC) counters: its topic and outcome, and each section it cited
 * once. Nothing about the question, the answer, or the person is stored.
 */
export async function recordChatOutcome(
  record: ChatOutcomeRecord,
  { now = new Date() }: { now?: Date } = {},
): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const sections = [...new Set(record.citedSections.map((path) => path.join(" > ")))];
  await getDb().transaction(async (tx) => {
    await tx
      .insert(chatOutcomeCounts)
      .values({ day, topic: record.topic, outcome: record.outcome, count: 1 })
      .onConflictDoUpdate({
        target: [chatOutcomeCounts.day, chatOutcomeCounts.topic, chatOutcomeCounts.outcome],
        set: { count: sql`${chatOutcomeCounts.count} + 1` },
      });
    if (sections.length === 0) return;
    await tx
      .insert(chatCitationCounts)
      .values(sections.map((section) => ({ day, topic: record.topic, section, count: 1 })))
      .onConflictDoUpdate({
        target: [chatCitationCounts.day, chatCitationCounts.topic, chatCitationCounts.section],
        set: { count: sql`${chatCitationCounts.count} + 1` },
      });
  });
}
