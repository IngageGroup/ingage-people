import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, getPool } from "@/db";
import { type NewChunk, replaceSourceContent } from "@/db/knowledge";
import { EMBEDDING_DIMENSIONS, knowledgeSources } from "@/db/schema";
import { keywordSearch } from "@/db/search";
import { retrieve } from "@/knowledge/retrieve";

/** A unit vector along one axis, so similarity is exact and readable. */
function axis(n: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === n ? 1 : 0));
}

const PTO = "Request paid time off in the HR system two weeks ahead.";
const RETIREMENT = "Ingage matches 401k contributions up to four percent of salary.";
const TRAINING = "Each employee has an annual training budget for courses.";
const OTHER_TOPIC = "Clone the repo and run pnpm install to set up the 401k project.";

// Unique topics keep these fixtures apart from anything else in the local database.
const topic = `test-handbook-${randomUUID()}`;
const otherTopic = `test-onboarding-${randomUUID()}`;
const sourceIds = [`test-${randomUUID()}`, `test-${randomUUID()}`];

function chunk(text: string, sectionPath: string[], vector: number): NewChunk {
  return { text, sectionPath, url: "file:///handbook.md", embedding: axis(vector) };
}

const questionVectors: Record<string, number[]> = {
  "How many vacation days can I take?": axis(0),
  "What is the 401k match?": axis(2),
  "Does the company help with retirement savings?": axis(1),
};
const embedQuery = vi.fn(async (question: string) => questionVectors[question] ?? axis(99));

beforeAll(async () => {
  await replaceSourceContent({
    source: { id: sourceIds[0] ?? "", topic, kind: "local-file", audience: "everyone" },
    title: "Handbook",
    changeMarker: "m1",
    documentUpdatedAt: new Date("2026-10-01T00:00:00Z"),
    chunks: [
      chunk(PTO, ["Time Off", "Paid Time Off"], 0),
      chunk(RETIREMENT, ["Benefits", "Retirement"], 1),
      chunk(TRAINING, ["Learning", "Training Budget"], 2),
    ],
  });
  await replaceSourceContent({
    source: { id: sourceIds[1] ?? "", topic: otherTopic, kind: "local-file", audience: "everyone" },
    title: "Onboarding",
    changeMarker: "m1",
    documentUpdatedAt: new Date("2026-10-01T00:00:00Z"),
    chunks: [chunk(OTHER_TOPIC, ["Setup"], 2)],
  });
});

afterAll(async () => {
  await getDb().delete(knowledgeSources).where(inArray(knowledgeSources.id, sourceIds));
  await getPool().end();
});

const texts = (candidates: { text: string }[]) => candidates.map((c) => c.text);

describe("keywordSearch", () => {
  it("finds an exact term like 401k", async () => {
    expect(texts(await keywordSearch("401k", { topic, limit: 30 }))).toEqual([RETIREMENT]);
  });

  it("matches section headings as well as text", async () => {
    expect(texts(await keywordSearch("paid time off", { topic, limit: 30 }))).toEqual([PTO]);
  });

  it("returns nothing for a question with only stop words", async () => {
    expect(await keywordSearch("what is the", { topic, limit: 30 })).toEqual([]);
  });

  it("accepts search syntax without failing", async () => {
    expect(texts(await keywordSearch('"training budget" -pto', { topic, limit: 30 }))).toEqual([
      TRAINING,
    ]);
  });
});

describe("retrieve", () => {
  it("finds a paraphrased question through vector search", async () => {
    const candidates = await retrieve("How many vacation days can I take?", { topic, embedQuery });
    expect(candidates[0]).toMatchObject({
      text: PTO,
      sectionPath: ["Time Off", "Paid Time Off"],
      documentTitle: "Handbook",
      url: "file:///handbook.md",
      page: null,
    });
  });

  it("finds an exact term through keyword search even when vectors point elsewhere", async () => {
    const candidates = await retrieve("What is the 401k match?", { topic, embedQuery });
    expect(texts(candidates)).toContain(RETIREMENT);
  });

  it("ranks a chunk found by both searches first and lists it once", async () => {
    const candidates = await retrieve("Does the company help with retirement savings?", {
      topic,
      embedQuery,
    });
    expect(candidates[0]?.text).toBe(RETIREMENT);
    const ids = candidates.map((c) => c.chunkId);
    expect(new Set(ids).size).toBe(ids.length);
    const scores = candidates.map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("only returns chunks from the requested topic", async () => {
    const candidates = await retrieve("What is the 401k match?", { topic, embedQuery });
    expect(texts(candidates)).not.toContain(OTHER_TOPIC);
  });

  it("only returns chunks from each source's active version", async () => {
    await replaceSourceContent({
      source: {
        id: sourceIds[1] ?? "",
        topic: otherTopic,
        kind: "local-file",
        audience: "everyone",
      },
      title: "Onboarding",
      changeMarker: "m2",
      documentUpdatedAt: new Date("2026-10-02T00:00:00Z"),
      chunks: [chunk("Run the setup script.", ["Setup"], 2)],
    });
    const candidates = await retrieve("setup", { topic: otherTopic, embedQuery });
    expect(texts(candidates)).toEqual(["Run the setup script."]);
  });
});
