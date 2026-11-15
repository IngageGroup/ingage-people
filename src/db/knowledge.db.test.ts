import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb, getPool } from "@/db";
import {
  EMBEDDING_DIMENSIONS,
  getActiveVersion,
  type NewChunk,
  replaceSourceContent,
} from "@/db/knowledge";
import { knowledgeChunks, knowledgeSources, knowledgeVersions } from "@/db/schema";

const created: string[] = [];

function testSource() {
  const id = `test-${randomUUID()}`;
  created.push(id);
  return { id, topic: "handbook", kind: "local-file", audience: "everyone" } as const;
}

function chunk(text: string, sectionPath: string[], overrides: Partial<NewChunk> = {}): NewChunk {
  return {
    text,
    sectionPath,
    url: "file:///handbook.pdf",
    embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0)),
    ...overrides,
  };
}

async function chunksOf(versionId: string) {
  return getDb()
    .select({ text: knowledgeChunks.text })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.versionId, versionId));
}

async function statusOf(versionId: string) {
  const [row] = await getDb()
    .select({ status: knowledgeVersions.status })
    .from(knowledgeVersions)
    .where(eq(knowledgeVersions.id, versionId));
  return row?.status;
}

afterEach(async () => {
  for (const id of created.splice(0)) {
    await getDb().delete(knowledgeSources).where(eq(knowledgeSources.id, id));
  }
});

afterAll(async () => {
  await getPool().end();
});

const UPDATED = new Date("2026-10-01T00:00:00Z");

describe("replaceSourceContent", () => {
  it("makes the first ingest the source's active version", async () => {
    const source = testSource();
    const { versionId } = await replaceSourceContent({
      source,
      title: "Handbook",
      changeMarker: "etag-1",
      documentUpdatedAt: UPDATED,
      chunks: [chunk("Request PTO two weeks ahead.", ["Time Off", "Paid Time Off"], { page: 4 })],
    });

    expect(await getActiveVersion(source.id)).toEqual({
      id: versionId,
      title: "Handbook",
      changeMarker: "etag-1",
      documentUpdatedAt: UPDATED,
    });
    expect(await chunksOf(versionId)).toEqual([{ text: "Request PTO two weeks ahead." }]);
    expect(await statusOf(versionId)).toBe("active");
  });

  it("replaces the previous version and deletes its chunks", async () => {
    const source = testSource();
    const first = await replaceSourceContent({
      source,
      title: "Handbook",
      changeMarker: "etag-1",
      documentUpdatedAt: UPDATED,
      chunks: [chunk("Old text.", ["Old"])],
    });
    const second = await replaceSourceContent({
      source,
      title: "Handbook",
      changeMarker: "etag-2",
      documentUpdatedAt: UPDATED,
      chunks: [chunk("New text.", ["New"]), chunk("More new text.", ["New", "More"])],
    });

    expect((await getActiveVersion(source.id))?.id).toBe(second.versionId);
    expect(await chunksOf(first.versionId)).toEqual([]);
    expect(await chunksOf(second.versionId)).toHaveLength(2);
    expect(await statusOf(first.versionId)).toBe("replaced");
  });

  it("keeps the previous version when writing the new one fails", async () => {
    const source = testSource();
    const first = await replaceSourceContent({
      source,
      title: "Handbook",
      changeMarker: "etag-1",
      documentUpdatedAt: UPDATED,
      chunks: [chunk("Old text.", ["Old"])],
    });
    const notANumber = Array.from({ length: EMBEDDING_DIMENSIONS }, () => Number.NaN);

    await expect(
      replaceSourceContent({
        source,
        title: "Handbook",
        changeMarker: "etag-2",
        documentUpdatedAt: UPDATED,
        chunks: [chunk("Good.", ["New"]), chunk("Bad.", ["New"], { embedding: notANumber })],
      }),
    ).rejects.toThrow();

    expect((await getActiveVersion(source.id))?.id).toBe(first.versionId);
    expect(await chunksOf(first.versionId)).toEqual([{ text: "Old text." }]);
    const versions = await getDb()
      .select({ status: knowledgeVersions.status })
      .from(knowledgeVersions)
      .where(eq(knowledgeVersions.sourceId, source.id));
    expect(versions.map((v) => v.status).sort()).toEqual(["active", "failed"]);
    const [{ count } = { count: -1 }] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(knowledgeChunks)
      .innerJoin(knowledgeVersions, eq(knowledgeVersions.id, knowledgeChunks.versionId))
      .where(eq(knowledgeVersions.sourceId, source.id));
    expect(count).toBe(1);
  });

  it("rejects embeddings of the wrong size before touching the database", async () => {
    const source = testSource();
    await expect(
      replaceSourceContent({
        source,
        title: "Handbook",
        changeMarker: "etag-1",
        documentUpdatedAt: UPDATED,
        chunks: [chunk("Text.", ["A"], { embedding: [0.1, 0.2] })],
      }),
    ).rejects.toThrow(`chunk 0 has 2 embedding dimensions; expected ${EMBEDDING_DIMENSIONS}`);
    expect(await getActiveVersion(source.id)).toBeNull();
  });

  it("rejects an ingest with no chunks", async () => {
    const source = testSource();
    await expect(
      replaceSourceContent({
        source,
        title: "Handbook",
        changeMarker: "etag-1",
        documentUpdatedAt: UPDATED,
        chunks: [],
      }),
    ).rejects.toThrow(`No chunks to store for source ${source.id}`);
  });

  it("indexes section headings and text for keyword search", async () => {
    const source = testSource();
    const { versionId } = await replaceSourceContent({
      source,
      title: "Handbook",
      changeMarker: "etag-1",
      documentUpdatedAt: UPDATED,
      chunks: [chunk("Spend needs approval.", ["Learning", "Training Budget"])],
    });

    const matches = await getDb()
      .select({ text: knowledgeChunks.text })
      .from(knowledgeChunks)
      .where(
        sql`${knowledgeChunks.versionId} = ${versionId}
          and ${knowledgeChunks.search} @@ plainto_tsquery('english', 'training budgets approved')`,
      );
    expect(matches).toEqual([{ text: "Spend needs approval." }]);
  });
});

describe("getActiveVersion", () => {
  it("returns null for a source that was never ingested", async () => {
    expect(await getActiveVersion(`test-${randomUUID()}`)).toBeNull();
  });
});
