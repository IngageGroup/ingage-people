import type { Candidate } from "@/knowledge/retrieve";
import type { RerankResult } from "@/knowledge/voyage";
import type { Passage } from "@/lib/chat/passages";

export interface SelectConfig {
  /** Passages Claude gets. */
  topK: number;
  /** Rerank score a passage needs; if none reach it, the answer is "I don't know". */
  minScore: number;
}

/** Initial values; the threshold gets tuned on the eval set (#17). */
export const SELECT_CONFIG: SelectConfig = { topK: 5, minScore: 0.5 };

export interface SelectOptions {
  retrieve: (question: string) => Promise<Candidate[]>;
  rerank: (question: string, documents: string[], topK: number) => Promise<RerankResult[]>;
  config?: SelectConfig;
}

/** What the reranker reads: where the chunk sits in the document, then its text. */
function rerankText(candidate: Candidate): string {
  const context = [candidate.documentTitle, ...candidate.sectionPath].filter(Boolean).join(" > ");
  return `${context}\n\n${candidate.text}`;
}

function toPassage(candidate: Candidate, index: number): Passage {
  return {
    id: `p${index + 1}`,
    sectionPath: candidate.sectionPath,
    text: candidate.text,
    documentTitle: candidate.documentTitle,
    url: candidate.url,
    ...(candidate.page === null ? {} : { page: candidate.page }),
    lastUpdated: candidate.documentUpdatedAt.toISOString().slice(0, 10),
  };
}

/**
 * Picks the passages Claude answers from: retrieve candidates, re-rank them, and keep the top
 * k that reach the score threshold, numbered p1…. Returns none when nothing is relevant enough,
 * so the caller answers "I don't know" without calling Claude. Reranker failures propagate:
 * answering from unranked chunks would skip the relevance check.
 */
export async function selectPassages(question: string, options: SelectOptions): Promise<Passage[]> {
  const { retrieve, rerank, config = SELECT_CONFIG } = options;
  const candidates = await retrieve(question);
  if (candidates.length === 0) return [];

  const ranked = await rerank(question, candidates.map(rerankText), config.topK);
  return ranked
    .slice(0, config.topK)
    .filter((result) => result.score >= config.minScore)
    .map((result) => candidates[result.index])
    .filter((candidate): candidate is Candidate => candidate !== undefined)
    .map(toPassage);
}
