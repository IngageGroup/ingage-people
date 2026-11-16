import { retrieve } from "@/knowledge/retrieve";
import { type SelectOptions, selectPassages } from "@/knowledge/select";
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_RERANK_MODEL,
  embedQuery,
  rerank,
  type VoyageOptions,
} from "@/knowledge/voyage";
import { SafeError } from "@/lib/safe-error";

/** A section of a source document that an answer may quote and cite. */
export interface Passage {
  /** Id Claude cites, e.g. "p1". Unique within one request. */
  id: string;
  sectionPath: string[];
  text: string;
  documentTitle: string;
  url: string;
  page?: number;
  /** ISO date of the source version. */
  lastUpdated: string;
}

/** Finds the passages in these topics that may answer a question; none means "I don't know". */
export type PassageProvider = (question: string, topics: string[]) => Promise<Passage[]>;

/** Someone is waiting: fail within seconds instead of retrying like the ingest job. */
const INTERACTIVE_LIMITS = { maxAttempts: 2, timeoutMs: 8000 };

function voyageOptions(model: string, limits: Partial<VoyageOptions>): VoyageOptions {
  const apiKey = process.env["VOYAGE_API_KEY"]?.trim();
  if (!apiKey) throw new SafeError("VOYAGE_API_KEY is not set");
  return { apiKey, model, ...limits };
}

/**
 * The search steps behind the chat: hybrid retrieval over the topics' sources and Voyage
 * re-ranking, with models from the environment. The eval uses these directly to see each step.
 */
export function chatSearch(
  topics: string[],
  limits: Partial<VoyageOptions> = INTERACTIVE_LIMITS,
): SelectOptions {
  const embedModel = process.env["VOYAGE_EMBED_MODEL"]?.trim() || DEFAULT_EMBED_MODEL;
  const rerankModel = process.env["VOYAGE_RERANK_MODEL"]?.trim() || DEFAULT_RERANK_MODEL;
  const embedOptions = voyageOptions(embedModel, limits);
  const rerankOptions = voyageOptions(rerankModel, limits);
  return {
    retrieve: (q) => retrieve(q, { topics, embedQuery: (text) => embedQuery(text, embedOptions) }),
    rerank: (q, documents, topK) => rerank(q, documents, { ...rerankOptions, topK }),
  };
}

/**
 * Passages from the knowledge store: hybrid search over the topics, re-ranked by Voyage,
 * cut to those above the relevance threshold. Throws if Voyage or the database fails, so the
 * route reports an error instead of answering without the relevance check.
 */
export function getPassageProvider(): PassageProvider {
  return async (question, topics) => selectPassages(question, chatSearch(topics));
}
