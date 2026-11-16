import { and, asc, cosineDistance, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { knowledgeChunks, knowledgeSources, knowledgeVersions } from "@/db/schema";

/** A chunk from a source's active version, with what a citation needs. */
export interface ChunkHit {
  chunkId: string;
  text: string;
  sectionPath: string[];
  page: number | null;
  url: string;
  documentTitle: string;
  documentUpdatedAt: Date;
}

export interface SearchScope {
  /** Only chunks from sources in these topics. */
  topics: string[];
  limit: number;
}

const hitColumns = {
  chunkId: knowledgeChunks.id,
  text: knowledgeChunks.text,
  sectionPath: knowledgeChunks.sectionPath,
  page: knowledgeChunks.page,
  url: knowledgeChunks.url,
  documentTitle: knowledgeVersions.title,
  documentUpdatedAt: knowledgeVersions.documentUpdatedAt,
};

/**
 * Keyword search: Postgres full-text (`websearch_to_tsquery`, ranked by `ts_rank_cd`) over
 * headings and text. The only place keyword ranking lives, so it can become BM25 later.
 */
export async function keywordSearch(question: string, scope: SearchScope): Promise<ChunkHit[]> {
  const query = sql`websearch_to_tsquery('english', ${question})`;
  const rank = sql<number>`ts_rank_cd(${knowledgeChunks.search}, ${query})`;
  const rows = await getDb()
    .select({ ...hitColumns, rank })
    .from(knowledgeChunks)
    .innerJoin(knowledgeVersions, eq(knowledgeVersions.id, knowledgeChunks.versionId))
    .innerJoin(knowledgeSources, eq(knowledgeSources.activeVersionId, knowledgeChunks.versionId))
    .where(
      and(
        inArray(knowledgeSources.topic, scope.topics),
        sql`${knowledgeChunks.search} @@ ${query}`,
      ),
    )
    .orderBy(desc(rank))
    .limit(scope.limit);
  return rows.map(({ rank: _rank, ...hit }) => hit);
}

/** Vector search: nearest chunks by cosine distance to the question's embedding. */
export async function vectorSearch(embedding: number[], scope: SearchScope): Promise<ChunkHit[]> {
  const distance = cosineDistance(knowledgeChunks.embedding, embedding);
  return getDb().transaction(async (tx) => {
    // Without this, HNSW returns its ef_search nearest chunks before the topic filter runs,
    // which can leave fewer than `limit` (or none) for a small topic.
    await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`);
    const rows = await tx
      .select({ ...hitColumns, distance })
      .from(knowledgeChunks)
      .innerJoin(knowledgeVersions, eq(knowledgeVersions.id, knowledgeChunks.versionId))
      .innerJoin(knowledgeSources, eq(knowledgeSources.activeVersionId, knowledgeChunks.versionId))
      .where(inArray(knowledgeSources.topic, scope.topics))
      .orderBy(asc(distance))
      .limit(scope.limit);
    return rows.map(({ distance: _distance, ...hit }) => hit);
  });
}
