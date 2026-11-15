import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPassageProvider, parsePassagesMarkdown, rankPassages } from "@/lib/chat/passages";

const SAMPLE = `# Sample Handbook

Intro text before any section is ignored.

## Benefits

### Training Budget

Each employee has an annual training budget for courses and conferences.

### Paid Time Off

Request PTO in the HR system at least two weeks ahead.

## Reviews

Performance reviews happen twice a year.
`;

const SOURCE = { url: "file:///tmp/sample.md", lastUpdated: "2026-11-01" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parsePassagesMarkdown", () => {
  it("makes one passage per section, with the heading path and document title", () => {
    const passages = parsePassagesMarkdown(SAMPLE, SOURCE);
    expect(passages.map((p) => p.sectionPath)).toEqual([
      ["Benefits", "Training Budget"],
      ["Benefits", "Paid Time Off"],
      ["Reviews"],
    ]);
    expect(passages[0]).toMatchObject({
      text: "Each employee has an annual training budget for courses and conferences.",
      documentTitle: "Sample Handbook",
      url: "file:///tmp/sample.md",
      lastUpdated: "2026-11-01",
    });
  });

  it("skips headings with no text under them", () => {
    expect(
      parsePassagesMarkdown(SAMPLE, SOURCE).some(
        (p) => p.sectionPath.length === 1 && p.sectionPath[0] === "Benefits",
      ),
    ).toBe(false);
  });

  it("returns nothing for a file without sections", () => {
    expect(parsePassagesMarkdown("# Title\n\nJust text.", SOURCE)).toEqual([]);
  });
});

describe("rankPassages", () => {
  const passages = parsePassagesMarkdown(SAMPLE, SOURCE);

  it("keeps passages that share words with the question, best match first, numbered p1…", () => {
    const ranked = rankPassages(passages, "How much is my annual training budget?", 5);
    expect(ranked[0]).toMatchObject({ id: "p1", sectionPath: ["Benefits", "Training Budget"] });
    expect(ranked.map((p) => p.id)).toEqual(ranked.map((_, i) => `p${i + 1}`));
  });

  it("matches regardless of case and punctuation", () => {
    expect(rankPassages(passages, "PTO?", 5).map((p) => p.sectionPath.at(-1))).toEqual([
      "Paid Time Off",
    ]);
  });

  it("returns nothing when no passage shares a meaningful word", () => {
    expect(rankPassages(passages, "What is the history of space travel?", 5)).toEqual([]);
  });

  it("returns at most the limit", () => {
    expect(rankPassages(passages, "employee budget PTO reviews", 2)).toHaveLength(2);
  });
});

describe("getPassageProvider", () => {
  function writeSample(): string {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "passages-")), "handbook.md");
    writeFileSync(file, SAMPLE);
    return file;
  }

  it("returns no passages when no dev file is configured", async () => {
    vi.stubEnv("CHAT_DEV_PASSAGES_FILE", "");
    expect(await getPassageProvider()("training budget")).toEqual([]);
  });

  it("reads ranked passages from the dev file", async () => {
    vi.stubEnv("CHAT_DEV_PASSAGES_FILE", writeSample());
    const passages = await getPassageProvider()("training budget");
    expect(passages[0]?.sectionPath).toEqual(["Benefits", "Training Budget"]);
    expect(passages[0]?.url).toMatch(/^file:\/\/.*handbook\.md$/);
  });

  it("ignores the dev file in production", async () => {
    vi.stubEnv("CHAT_DEV_PASSAGES_FILE", writeSample());
    vi.stubEnv("NODE_ENV", "production");
    expect(await getPassageProvider()("training budget")).toEqual([]);
  });

  it("fails with the path when the dev file is missing", async () => {
    vi.stubEnv("CHAT_DEV_PASSAGES_FILE", "/nonexistent/handbook.md");
    await expect(getPassageProvider()("training budget")).rejects.toThrow(
      /CHAT_DEV_PASSAGES_FILE.*\/nonexistent\/handbook\.md/,
    );
  });
});
