import { z } from "zod";
import { EMBEDDING_DIMENSIONS } from "@/db/schema";

export const DEFAULT_EMBED_MODEL = "voyage-4";
const EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";
/** Inputs per request; far below Voyage's 1,000-input and 320K-token limits for 2,000-char chunks. */
export const EMBED_BATCH_SIZE = 128;
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;

const responseSchema = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })),
});

export interface EmbedOptions {
  apiKey: string;
  model: string;
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

async function post(texts: string[], options: EmbedOptions): Promise<unknown> {
  const { fetchFn = fetch, sleep = wait } = options;
  const request: RequestInit = {
    method: "POST",
    headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      input: texts,
      model: options.model,
      input_type: "document",
      output_dimension: EMBEDDING_DIMENSIONS,
    }),
  };

  let lastFailure = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response | null = null;
    try {
      response = await fetchFn(EMBEDDINGS_URL, request);
    } catch (err) {
      lastFailure = err instanceof Error ? err.message : String(err);
    }
    if (response?.ok) return response.json();
    if (response) {
      lastFailure = `HTTP ${response.status} ${(await response.text()).slice(0, 300)}`;
      if (!retryable(response.status)) throw new Error(`Voyage embeddings failed: ${lastFailure}`);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(delayFor(response, attempt));
  }
  throw new Error(`Voyage embeddings failed after ${MAX_ATTEMPTS} attempts: ${lastFailure}`);
}

/**
 * Embeds texts for storage (Voyage `input_type: "document"`), in batches, retrying rate limits,
 * server errors, and network failures with backoff. Returns one vector per text, in order.
 */
export async function embedDocuments(texts: string[], options: EmbedOptions): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
    const { data } = responseSchema.parse(await post(batch, options));
    if (data.length !== batch.length) {
      throw new Error(`Voyage returned ${data.length} embeddings for ${batch.length} inputs`);
    }
    const ordered = [...data].sort((a, b) => a.index - b.index);
    vectors.push(...ordered.map((item) => item.embedding));
  }
  return vectors;
}
