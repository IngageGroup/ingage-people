import { type ChunkHit, keywordSearch, vectorSearch } from "@/db/search";
import { reciprocalRankFusion } from "@/knowledge/rrf";

/** Tuned with the eval set (#17). */
export const RETRIEVAL_CONFIG = {
  keywordCandidates: 30,
  vectorCandidates: 30,
  /** Reciprocal rank fusion constant; 60 is the usual default. */
  rrfK: 60,
};

export interface Candidate extends ChunkHit {
  /** Fused rank score; only meaningful for ordering. */
  score: number;
}

export interface RetrieveOptions {
  topic: string;
  /** Embeds the question for search (Voyage `input_type: "query"`). */
  embedQuery: (question: string) => Promise<number[]>;
  config?: typeof RETRIEVAL_CONFIG;
}

/**
 * First stage of answering: keyword and vector search over the topic's active chunks, in
 * parallel, merged by reciprocal rank fusion. Each chunk appears once, best first.
 */
export async function retrieve(question: string, options: RetrieveOptions): Promise<Candidate[]> {
  const { topic, embedQuery, config = RETRIEVAL_CONFIG } = options;
  const [keyword, vector] = await Promise.all([
    keywordSearch(question, { topic, limit: config.keywordCandidates }),
    embedQuery(question).then((embedding) =>
      vectorSearch(embedding, { topic, limit: config.vectorCandidates }),
    ),
  ]);
  const withIds = (hits: ChunkHit[]) => hits.map((hit) => ({ ...hit, id: hit.chunkId }));
  return reciprocalRankFusion([withIds(keyword), withIds(vector)], config.rrfK).map(
    ({ item: { id: _id, ...hit }, score }) => ({ ...hit, score }),
  );
}
