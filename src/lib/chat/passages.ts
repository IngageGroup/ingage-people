import { retrieve } from "@/knowledge/retrieve";
import { selectPassages } from "@/knowledge/select";
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_RERANK_MODEL,
  embedQuery,
  rerank,
  type VoyageOptions,
} from "@/knowledge/voyage";

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

/** Finds the passages that may answer a question; none means "I don't know". */
export type PassageProvider = (question: string) => Promise<Passage[]>;

/** The only topic until the onboarding docs arrive (#20) and the topic check routes (#12). */
export const CHAT_TOPIC = "handbook";

/** Someone is waiting: fail within seconds instead of retrying like the ingest job. */
const INTERACTIVE_LIMITS = { maxAttempts: 2, timeoutMs: 8000 };

function voyageOptions(model: string): VoyageOptions {
  const apiKey = process.env["VOYAGE_API_KEY"]?.trim();
  if (!apiKey) throw new Error("VOYAGE_API_KEY is not set");
  return { apiKey, model, ...INTERACTIVE_LIMITS };
}

/**
 * Passages from the knowledge store: hybrid search over the handbook, re-ranked by Voyage,
 * cut to those above the relevance threshold. Throws if Voyage or the database fails, so the
 * route reports an error instead of answering without the relevance check.
 */
export function getPassageProvider(): PassageProvider {
  return async (question) => {
    const embedModel = process.env["VOYAGE_EMBED_MODEL"]?.trim() || DEFAULT_EMBED_MODEL;
    const rerankModel = process.env["VOYAGE_RERANK_MODEL"]?.trim() || DEFAULT_RERANK_MODEL;
    const embedOptions = voyageOptions(embedModel);
    const rerankOptions = voyageOptions(rerankModel);
    return selectPassages(question, {
      retrieve: (q) =>
        retrieve(q, { topic: CHAT_TOPIC, embedQuery: (text) => embedQuery(text, embedOptions) }),
      rerank: (q, documents, topK) => rerank(q, documents, { ...rerankOptions, topK }),
    });
  };
}
