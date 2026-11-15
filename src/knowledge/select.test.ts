import { describe, expect, it, vi } from "vitest";
import type { Candidate } from "@/knowledge/retrieve";
import { type SelectOptions, selectPassages } from "@/knowledge/select";

function candidate(n: number, overrides: Partial<Candidate> = {}): Candidate {
  return {
    chunkId: `c${n}`,
    text: `Text ${n}.`,
    sectionPath: ["Section", `Part ${n}`],
    page: null,
    url: "https://example.test/handbook.pdf",
    documentTitle: "Handbook",
    documentUpdatedAt: new Date("2026-10-01T12:00:00Z"),
    score: 1 / n,
    ...overrides,
  };
}

function setup(candidates: Candidate[], scores: number[] | Error) {
  const retrieve = vi.fn(async () => candidates);
  const rerank = vi.fn(async (_q: string, documents: string[], _topK: number) => {
    if (scores instanceof Error) throw scores;
    return documents
      .map((_, index) => ({ index, score: scores[index] ?? 0 }))
      .sort((a, b) => b.score - a.score);
  });
  const options: SelectOptions = { retrieve, rerank, config: { topK: 2, minScore: 0.5 } };
  return { retrieve, rerank, options };
}

describe("selectPassages", () => {
  it("orders passages by rerank score and numbers them p1…", async () => {
    const { options } = setup([candidate(1), candidate(2), candidate(3)], [0.6, 0.9, 0.1]);
    const passages = await selectPassages("Q?", options);

    expect(passages.map((p) => [p.id, p.text])).toEqual([
      ["p1", "Text 2."],
      ["p2", "Text 1."],
    ]);
  });

  it("keeps only the top k", async () => {
    const { options } = setup([candidate(1), candidate(2), candidate(3)], [0.9, 0.8, 0.7]);
    expect(await selectPassages("Q?", options)).toHaveLength(2);
  });

  it("asks the reranker for the top k, with heading context on each document", async () => {
    const { rerank, options } = setup([candidate(1)], [0.9]);
    await selectPassages("How do I request PTO?", options);
    expect(rerank).toHaveBeenCalledWith(
      "How do I request PTO?",
      ["Handbook > Section > Part 1\n\nText 1."],
      2,
    );
  });

  it("returns no passages when the best score is below the threshold", async () => {
    const { options } = setup([candidate(1), candidate(2)], [0.49, 0.3]);
    expect(await selectPassages("Q?", options)).toEqual([]);
  });

  it("drops passages below the threshold but keeps the ones above it", async () => {
    const { options } = setup([candidate(1), candidate(2)], [0.9, 0.2]);
    expect((await selectPassages("Q?", options)).map((p) => p.text)).toEqual(["Text 1."]);
  });

  it("doesn't call the reranker when nothing was retrieved", async () => {
    const { rerank, options } = setup([], [0.9]);
    expect(await selectPassages("Q?", options)).toEqual([]);
    expect(rerank).not.toHaveBeenCalled();
  });

  it("fails when the reranker fails, rather than answering from unranked chunks", async () => {
    const { options } = setup([candidate(1)], new Error("Voyage rerank failed: HTTP 503"));
    await expect(selectPassages("Q?", options)).rejects.toThrow("Voyage rerank failed");
  });

  it("maps citation fields, keeping a page only when there is one", async () => {
    const { options } = setup(
      [candidate(1, { page: 7, url: "https://example.test/handbook.pdf#page=7" }), candidate(2)],
      [0.9, 0.8],
    );
    const [withPage, withoutPage] = await selectPassages("Q?", options);

    expect(withPage).toEqual({
      id: "p1",
      sectionPath: ["Section", "Part 1"],
      text: "Text 1.",
      documentTitle: "Handbook",
      url: "https://example.test/handbook.pdf#page=7",
      page: 7,
      lastUpdated: "2026-10-01",
    });
    expect(withoutPage).not.toHaveProperty("page");
  });
});
