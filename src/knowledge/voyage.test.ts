import { describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIMENSIONS } from "@/db/schema";
import { EMBED_BATCH_SIZE, embedDocuments } from "@/knowledge/voyage";

const vectorFor = (n: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, () => n);

function ok(texts: string[]): Response {
  // Out of order on purpose: results are matched by index.
  const data = texts.map((t, index) => ({ index, embedding: vectorFor(t.length) })).reverse();
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function requestBody(fetchFn: ReturnType<typeof vi.fn>, call: number) {
  const init = fetchFn.mock.calls[call]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function setup(responses: Array<Response | Error | ((texts: string[]) => Response)>) {
  const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
    const next = responses.shift() ?? ok;
    if (next instanceof Error) throw next;
    if (next instanceof Response) return next;
    const body = JSON.parse(String(init.body)) as { input: string[] };
    return next(body.input);
  });
  const sleep = vi.fn(async (_ms: number) => undefined);
  const options = { apiKey: "key", model: "voyage-test", fetchFn, sleep };
  return { fetchFn, sleep, options };
}

describe("embedDocuments", () => {
  it("embeds as documents with the model and dimension, keeping input order", async () => {
    const { fetchFn, options } = setup([ok]);
    const vectors = await embedDocuments(["a", "bbb"], options);

    expect(vectors).toEqual([vectorFor(1), vectorFor(3)]);
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://api.voyageai.com/v1/embeddings");
    expect(requestBody(fetchFn, 0)).toEqual({
      input: ["a", "bbb"],
      model: "voyage-test",
      input_type: "document",
      output_dimension: EMBEDDING_DIMENSIONS,
    });
    const headers = (fetchFn.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer key");
  });

  it("sends large inputs in batches", async () => {
    const { fetchFn, options } = setup([ok, ok]);
    const texts = Array.from({ length: EMBED_BATCH_SIZE + 1 }, (_, i) => `t${i}`);
    const vectors = await embedDocuments(texts, options);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect((requestBody(fetchFn, 1)["input"] as string[]).length).toBe(1);
    expect(vectors).toHaveLength(EMBED_BATCH_SIZE + 1);
  });

  it("retries on 429 and 5xx, honouring Retry-After", async () => {
    const { fetchFn, sleep, options } = setup([
      new Response("slow down", { status: 429, headers: { "retry-after": "3" } }),
      new Response("oops", { status: 503 }),
      ok,
    ]);
    expect(await embedDocuments(["a"], options)).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([3000, 2000]);
  });

  it("retries network errors", async () => {
    const { fetchFn, options } = setup([new TypeError("fetch failed"), ok]);
    expect(await embedDocuments(["a"], options)).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("gives up after the last attempt with the status and body", async () => {
    const failures = Array.from({ length: 5 }, () => new Response("overloaded", { status: 500 }));
    const { fetchFn, options } = setup(failures);
    await expect(embedDocuments(["a"], options)).rejects.toThrow(
      "Voyage embeddings failed after 5 attempts: HTTP 500 overloaded",
    );
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it("doesn't retry other client errors", async () => {
    const { fetchFn, options } = setup([new Response("bad key", { status: 401 })]);
    await expect(embedDocuments(["a"], options)).rejects.toThrow(
      "Voyage embeddings failed: HTTP 401 bad key",
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects a response with the wrong number of embeddings", async () => {
    const { options } = setup([() => new Response(JSON.stringify({ data: [] }))]);
    await expect(embedDocuments(["a"], options)).rejects.toThrow(
      "Voyage returned 0 embeddings for 1 inputs",
    );
  });

  it("makes no request for no input", async () => {
    const { fetchFn, options } = setup([]);
    expect(await embedDocuments([], options)).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
