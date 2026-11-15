import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  EMBEDDING_DIMENSIONS,
  knowledgeChunks,
  knowledgeSources,
  knowledgeVersions,
} from "@/db/schema";

export { EMBEDDING_DIMENSIONS };

/** Rows per chunk insert, well under Postgres's 65,535 bind-parameter limit. */
const INSERT_BATCH = 200;

export interface SourceInfo {
  id: string;
  topic: string;
  kind: string;
  audience: string;
}

export interface NewChunk {
  text: string;
  sectionPath: string[];
  page?: number;
  url: string;
  embedding: number[];
}

export interface ActiveVersion {
  id: string;
  changeMarker: string;
  documentUpdatedAt: Date;
}

interface Ingest {
  source: SourceInfo;
  changeMarker: string;
  documentUpdatedAt: Date;
  chunks: NewChunk[];
}

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function checkChunks({ source, chunks }: Ingest): void {
  if (chunks.length === 0) throw new Error(`No chunks to store for source ${source.id}`);
  chunks.forEach((chunk, i) => {
    if (chunk.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Source ${source.id}: chunk ${i} has ${chunk.embedding.length} embedding dimensions; ` +
          `expected ${EMBEDDING_DIMENSIONS}`,
      );
    }
  });
}

/** Creates the source row, or updates it from the config, and returns its active version. */
async function upsertSource(tx: Tx, source: SourceInfo): Promise<string | null> {
  const { topic, kind, audience } = source;
  const [row] = await tx
    .insert(knowledgeSources)
    .values(source)
    .onConflictDoUpdate({ target: knowledgeSources.id, set: { topic, kind, audience } })
    .returning({ activeVersionId: knowledgeSources.activeVersionId });
  return row?.activeVersionId ?? null;
}

async function insertChunks(tx: Tx, versionId: string, chunks: NewChunk[]): Promise<void> {
  for (let start = 0; start < chunks.length; start += INSERT_BATCH) {
    const rows = chunks.slice(start, start + INSERT_BATCH).map((chunk, i) => ({
      versionId,
      position: start + i,
      text: chunk.text,
      sectionPath: chunk.sectionPath,
      page: chunk.page ?? null,
      url: chunk.url,
      embedding: chunk.embedding,
    }));
    await tx.insert(knowledgeChunks).values(rows);
  }
}

async function swapIn(ingest: Ingest): Promise<string> {
  return getDb().transaction(async (tx) => {
    const previousId = await upsertSource(tx, ingest.source);
    const [version] = await tx
      .insert(knowledgeVersions)
      .values({
        sourceId: ingest.source.id,
        changeMarker: ingest.changeMarker,
        documentUpdatedAt: ingest.documentUpdatedAt,
        status: "active",
      })
      .returning({ id: knowledgeVersions.id });
    if (!version) throw new Error("Insert into knowledge_versions returned no row");

    await insertChunks(tx, version.id, ingest.chunks);
    await tx
      .update(knowledgeSources)
      .set({ activeVersionId: version.id })
      .where(eq(knowledgeSources.id, ingest.source.id));
    if (previousId) {
      await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.versionId, previousId));
      await tx
        .update(knowledgeVersions)
        .set({ status: "replaced" })
        .where(eq(knowledgeVersions.id, previousId));
    }
    return version.id;
  });
}

/** Records a failed ingest so it shows up next to the successful ones. */
async function recordFailure(ingest: Ingest): Promise<void> {
  await getDb().transaction(async (tx) => {
    await upsertSource(tx, ingest.source);
    await tx.insert(knowledgeVersions).values({
      sourceId: ingest.source.id,
      changeMarker: ingest.changeMarker,
      documentUpdatedAt: ingest.documentUpdatedAt,
      status: "failed",
    });
  });
}

/**
 * Stores a new version of a source and makes it active in one transaction: its chunks are
 * written, the source switches to it, and the previous version's chunks are deleted. Readers
 * see either the old version or the new one, never a mix. If anything fails, the previous
 * version stays active, a "failed" version is recorded, and the error is rethrown.
 */
export async function replaceSourceContent(ingest: Ingest): Promise<{ versionId: string }> {
  checkChunks(ingest);
  try {
    return { versionId: await swapIn(ingest) };
  } catch (err) {
    await recordFailure(ingest).catch((recordErr: unknown) => {
      console.error(
        `[db/knowledge] recording failed ingest of ${ingest.source.id} failed`,
        recordErr,
      );
    });
    throw err;
  }
}

/** The version answers currently come from, or null if the source was never ingested. */
export async function getActiveVersion(sourceId: string): Promise<ActiveVersion | null> {
  const [row] = await getDb()
    .select({
      id: knowledgeVersions.id,
      changeMarker: knowledgeVersions.changeMarker,
      documentUpdatedAt: knowledgeVersions.documentUpdatedAt,
    })
    .from(knowledgeSources)
    .innerJoin(knowledgeVersions, eq(knowledgeVersions.id, knowledgeSources.activeVersionId))
    .where(eq(knowledgeSources.id, sourceId));
  return row ?? null;
}
