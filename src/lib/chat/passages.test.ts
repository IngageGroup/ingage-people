import { afterEach, describe, expect, it, vi } from "vitest";

const { retrieveMock, embedQueryMock, rerankMock } = vi.hoisted(() => ({
  retrieveMock: vi.fn(),
  embedQueryMock: vi.fn(),
  rerankMock: vi.fn(),
}));

vi.mock("@/knowledge/retrieve", () => ({ retrieve: retrieveMock }));
vi.mock("@/knowledge/voyage", () => ({
  DEFAULT_EMBED_MODEL: "voyage-4",
  DEFAULT_RERANK_MODEL: "rerank-3",
  embedQuery: embedQueryMock,
  rerank: rerankMock,
}));

import { getPassageProvider } from "@/lib/chat/passages";

const CANDIDATE = {
  chunkId: "c1",
  text: "Request PTO two weeks ahead.",
  sectionPath: ["Time Off"],
  page: null,
  url: "https://example.test/handbook",
  documentTitle: "Handbook",
  documentUpdatedAt: new Date("2026-10-01T00:00:00Z"),
  score: 0.03,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("getPassageProvider", () => {
  it("searches the handbook and re-ranks with Voyage, failing fast for a waiting user", async () => {
    vi.stubEnv("VOYAGE_API_KEY", "key");
    vi.stubEnv("VOYAGE_RERANK_MODEL", "rerank-test");
    retrieveMock.mockImplementation(async (question: string, options) => {
      await options.embedQuery(question);
      return [CANDIDATE];
    });
    rerankMock.mockResolvedValue([{ index: 0, score: 0.9 }]);

    const passages = await getPassageProvider()("How do I request PTO?");

    expect(passages.map((p) => p.text)).toEqual(["Request PTO two weeks ahead."]);
    expect(retrieveMock).toHaveBeenCalledWith(
      "How do I request PTO?",
      expect.objectContaining({ topic: "handbook" }),
    );
    expect(embedQueryMock).toHaveBeenCalledWith("How do I request PTO?", {
      apiKey: "key",
      model: "voyage-4",
      maxAttempts: 2,
      timeoutMs: 8000,
    });
    expect(rerankMock).toHaveBeenCalledWith(
      "How do I request PTO?",
      [expect.stringContaining("Request PTO")],
      expect.objectContaining({ model: "rerank-test", maxAttempts: 2, topK: 5 }),
    );
  });

  it("fails clearly without a Voyage key", async () => {
    vi.stubEnv("VOYAGE_API_KEY", "");
    await expect(getPassageProvider()("Q?")).rejects.toThrow("VOYAGE_API_KEY is not set");
    expect(retrieveMock).not.toHaveBeenCalled();
  });
});
