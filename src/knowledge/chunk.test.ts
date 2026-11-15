import { describe, expect, it } from "vitest";
import { chunkDocument } from "@/knowledge/chunk";
import type { ParsedDocument } from "@/knowledge/document";

const LIMITS = { maxChars: 100, overlapChars: 20 };

function doc(...sections: ParsedDocument["sections"]): ParsedDocument {
  return { title: "Handbook", sections };
}

const sentences = (n: number) =>
  Array.from({ length: n }, (_, i) => `Sentence number ${i + 1} is here.`).join(" ");

describe("chunkDocument", () => {
  it("keeps a short section as one chunk with its heading path and page", () => {
    const chunks = chunkDocument(
      doc({ headingPath: ["Benefits", "Training"], text: "Budget text.", page: 3 }),
      LIMITS,
    );
    expect(chunks).toEqual([
      { text: "Budget text.", sectionPath: ["Benefits", "Training"], page: 3 },
    ]);
  });

  it("never merges sections, so each chunk cites one heading", () => {
    const chunks = chunkDocument(
      doc({ headingPath: ["A"], text: "One." }, { headingPath: ["B"], text: "Two." }),
      LIMITS,
    );
    expect(chunks.map((c) => c.sectionPath)).toEqual([["A"], ["B"]]);
  });

  it("splits a long section into chunks no longer than the cap", () => {
    const chunks = chunkDocument(doc({ headingPath: ["A"], text: sentences(12) }), LIMITS);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(LIMITS.maxChars);
      expect(chunk.sectionPath).toEqual(["A"]);
    }
  });

  it("starts each later chunk with the end of the one before", () => {
    const text = Array.from({ length: 40 }, (_, i) => `W${i}a w${i}b fact.`).join(" ");
    const chunks = chunkDocument(doc({ headingPath: ["A"], text }), LIMITS);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const previousWords = new Set((chunks[i - 1]?.text ?? "").split(" "));
      const firstWord = (chunks[i]?.text ?? "").split(" ")[0] ?? "";
      expect(previousWords).toContain(firstWord);
    }
  });

  it("loses no text when splitting", () => {
    const text = sentences(12);
    const chunks = chunkDocument(doc({ headingPath: ["A"], text }), LIMITS);
    const words = new Set(chunks.flatMap((c) => c.text.split(/\s+/)));
    for (const word of text.split(/\s+/)) expect(words).toContain(word);
  });

  it("prefers paragraph breaks over sentence breaks", () => {
    const first = "First paragraph sentence one. First paragraph sentence two.";
    const second = "Second paragraph is short.";
    const chunks = chunkDocument(doc({ headingPath: ["A"], text: `${first}\n\n${second}` }), {
      maxChars: 70,
      overlapChars: 0,
    });
    expect(chunks.map((c) => c.text)).toEqual([first, second]);
  });

  it("cuts a single word longer than the cap", () => {
    const chunks = chunkDocument(doc({ headingPath: ["A"], text: "x".repeat(250) }), {
      maxChars: 100,
      overlapChars: 0,
    });
    expect(chunks.map((c) => c.text.length)).toEqual([100, 100, 50]);
  });

  it("returns nothing for empty or blank sections", () => {
    expect(chunkDocument(doc(), LIMITS)).toEqual([]);
    expect(chunkDocument(doc({ headingPath: ["A"], text: "  \n\n " }), LIMITS)).toEqual([]);
  });

  it("keeps a table that fits under the cap in one chunk, without overlap text in it", () => {
    const table =
      "| Title | PTO |\n| --- | --- |\n| Apprentice | 3 weeks |\n| Director | 5 weeks |";
    const text = `${sentences(3)}\n\n${table}\n\n${sentences(3)}`;
    const chunks = chunkDocument(doc({ headingPath: ["PTO"], text }), LIMITS);

    expect(chunks.some((c) => c.text === table)).toBe(true);
  });

  it("splits a long table between rows and repeats the header in each piece", () => {
    const rows = Array.from({ length: 8 }, (_, i) => `| Benefit ${i} | Eligible ${i} |`);
    const table = ["| Benefit | Salaried |", "| --- | --- |", ...rows].join("\n");
    const chunks = chunkDocument(doc({ headingPath: ["Benefits"], text: table }), LIMITS);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(LIMITS.maxChars);
      expect(chunk.text.startsWith("| Benefit | Salaried |\n| --- | --- |\n")).toBe(true);
    }
    const chunkRows = chunks.flatMap((c) => c.text.split("\n").slice(2));
    expect(chunkRows).toEqual(rows);
  });

  it("rejects an overlap that isn't smaller than the cap", () => {
    expect(() => chunkDocument(doc(), { maxChars: 50, overlapChars: 50 })).toThrow(
      "overlapChars (50) must be smaller than maxChars (50)",
    );
  });
});
