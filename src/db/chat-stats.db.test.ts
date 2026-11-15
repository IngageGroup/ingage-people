import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb, getPool } from "@/db";
import { recordChatOutcome } from "@/db/chat-stats";
import { chatCitationCounts, chatOutcomeCounts } from "@/db/schema";

const NOW = new Date("2026-11-15T23:30:00Z");
const PTO = ["Ingage Addendum", "Holidays, Vacation & Leave", "Paid Time Off (PTO)"];
const HOLIDAYS = ["Ingage Addendum", "Holidays, Vacation & Leave", "Holidays"];

let topic = "";

async function outcomes() {
  const rows = await getDb()
    .select()
    .from(chatOutcomeCounts)
    .where(like(chatOutcomeCounts.topic, topic));
  return rows
    .map((r) => ({ day: r.day, outcome: r.outcome, count: r.count }))
    .sort((a, b) => `${a.day}${a.outcome}`.localeCompare(`${b.day}${b.outcome}`));
}

async function citations() {
  const rows = await getDb()
    .select()
    .from(chatCitationCounts)
    .where(like(chatCitationCounts.topic, topic));
  return rows
    .map((r) => ({ section: r.section, count: r.count }))
    .sort((a, b) => a.section.localeCompare(b.section));
}

afterEach(async () => {
  await getDb().delete(chatOutcomeCounts).where(like(chatOutcomeCounts.topic, "test-%"));
  await getDb().delete(chatCitationCounts).where(like(chatCitationCounts.topic, "test-%"));
  topic = "";
});

afterAll(async () => {
  await getPool().end();
});

function newTopic(): string {
  topic = `test-${randomUUID()}`;
  return topic;
}

describe("recordChatOutcome", () => {
  it("counts outcomes per topic per UTC day", async () => {
    const t = newTopic();
    await recordChatOutcome({ topic: t, outcome: "answered", citedSections: [] }, { now: NOW });
    await recordChatOutcome({ topic: t, outcome: "answered", citedSections: [] }, { now: NOW });
    await recordChatOutcome({ topic: t, outcome: "dont-know", citedSections: [] }, { now: NOW });
    await recordChatOutcome(
      { topic: t, outcome: "dont-know", citedSections: [] },
      { now: new Date("2026-11-16T00:00:01Z") },
    );

    expect(await outcomes()).toEqual([
      { day: "2026-11-15", outcome: "answered", count: 2 },
      { day: "2026-11-15", outcome: "dont-know", count: 1 },
      { day: "2026-11-16", outcome: "dont-know", count: 1 },
    ]);
  });

  it("counts each cited section once per answer", async () => {
    const t = newTopic();
    await recordChatOutcome(
      { topic: t, outcome: "answered", citedSections: [PTO, PTO, HOLIDAYS] },
      { now: NOW },
    );
    await recordChatOutcome({ topic: t, outcome: "answered", citedSections: [PTO] }, { now: NOW });

    expect(await citations()).toEqual([
      { section: "Ingage Addendum > Holidays, Vacation & Leave > Holidays", count: 1 },
      { section: "Ingage Addendum > Holidays, Vacation & Leave > Paid Time Off (PTO)", count: 2 },
    ]);
  });

  it("stores only counters: day, topic, outcome or section, and count", async () => {
    const t = newTopic();
    await recordChatOutcome({ topic: t, outcome: "answered", citedSections: [PTO] }, { now: NOW });
    const [outcome] = await getDb()
      .select()
      .from(chatOutcomeCounts)
      .where(like(chatOutcomeCounts.topic, t));
    const [citation] = await getDb()
      .select()
      .from(chatCitationCounts)
      .where(like(chatCitationCounts.topic, t));
    expect(Object.keys(outcome ?? {}).sort()).toEqual(["count", "day", "outcome", "topic"]);
    expect(Object.keys(citation ?? {}).sort()).toEqual(["count", "day", "section", "topic"]);
  });
});
