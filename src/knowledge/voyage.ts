import { z } from "zod";
import { EMBEDDING_DIMENSIONS } from "@/db/schema";

export const DEFAULT_EMBED_MODEL = "voyage-4";
export const DEFAULT_RERANK_MODEL = "rerank-3";
const API = "https://api.voyageai.com/v1";
/** Inputs per request; far below Voyage's 1,000-input and 320K-token limits for 2,000-char chunks. */
export const EMBED_BATCH_SIZE = 128;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const BASE_DELAY_MS = 1000;

const embeddingsSchema = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })),
});
const rerankSchema = z.object({
  data: z.array(z.object({ index: z.number().int(), relevance_score: z.number() })),
});

export interface VoyageOptions {
  apiKey: string;
  model: string;
  /** Tries per request, counting the first. Default 5; interactive callers use fewer. */
  maxAttempts?: number;
  /** Per-attempt timeout. Default 30 s. */
  timeoutMs?: number;
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function delayFor(response: Response | null, attempt: number): number {
  const retryAfter = Number(response?.headers.get("retry-after"));
  return retryAfter > 0 ? retryAfter * 1000 : BASE_DELAY_MS * 2 ** (attempt - 1);
}

/**
 * POSTs to a Voyage endpoint, retrying rate limits, server errors, timeouts, and network
 * failures with backoff (honouring Retry-After). Other client errors fail at once.
 */
async function post(
  operation: string,
  path: string,
  body: object,
  options: VoyageOptions,
): Promise<unknown> {
  const { fetchFn = fetch, sleep = wait } = options;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastFailure = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response | null = null;
    try {
      response = await fetchFn(`${API}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastFailure = err instanceof Error ? err.message : String(err);
    }
    if (response?.ok) return response.json();
    if (response) {
      lastFailure = `HTTP ${response.status} ${(await response.text()).slice(0, 300)}`;
      if (!retryable(response.status)) throw new Error(`${operation} failed: ${lastFailure}`);
    }
    if (attempt < maxAttempts) await sleep(delayFor(response, attempt));
  }
  throw new Error(`${operation} failed after ${maxAttempts} attempts: ${lastFailure}`);
}

type InputType = "document" | "query";

async function embed(texts: string[], inputType: InputType, options: VoyageOptions) {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
    const body = {
      input: batch,
      model: options.model,
      input_type: inputType,
      output_dimension: EMBEDDING_DIMENSIONS,
    };
    const { data } = embeddingsSchema.parse(
      await post("Voyage embeddings", "/embeddings", body, options),
    );
    if (data.length !== batch.length) {
      throw new Error(`Voyage returned ${data.length} embeddings for ${batch.length} inputs`);
    }
    const ordered = [...data].sort((a, b) => a.index - b.index);
    vectors.push(...ordered.map((item) => item.embedding));
  }
  return vectors;
}

/**
 * Embeds texts for storage (Voyage `input_type: "document"`), in batches, retrying rate limits,
 * server errors, and network failures with backoff. Returns one vector per text, in order.
 */
export function embedDocuments(texts: string[], options: VoyageOptions): Promise<number[][]> {
  return embed(texts, "document", options);
}

/** Embeds a question for search (Voyage `input_type: "query"`), with the same retries. */
export async function embedQuery(question: string, options: VoyageOptions): Promise<number[]> {
  const [vector] = await embed([question], "query", options);
  if (!vector) throw new Error("Voyage returned no embedding for the question");
  return vector;
}

export interface RerankResult {
  /** Position of the document in the input list. */
  index: number;
  /** Voyage relevance score; higher is more relevant. */
  score: number;
}

/** Scores documents against the query with a Voyage reranker. Best first. */
export async function rerank(
  query: string,
  documents: string[],
  options: VoyageOptions & { topK: number },
): Promise<RerankResult[]> {
  if (documents.length === 0) return [];
  const body = { query, documents, model: options.model, top_k: options.topK };
  const { data } = rerankSchema.parse(await post("Voyage rerank", "/rerank", body, options));
  return data
    .map((item) => ({ index: item.index, score: item.relevance_score }))
    .sort((a, b) => b.score - a.score);
}
