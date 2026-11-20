import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCases } from "@/eval/cases";

const answered = {
  id: "pto-apprentice",
  category: "amount",
  question: "How much PTO does an apprentice get?",
  expectedOutcome: "answered",
  expectedSections: [["Ingage Addendum", "Holidays, Vacation & Leave", "Paid Time Off (PTO)"]],
  expectedFacts: ["3 weeks per calendar year"],
};

const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n");

describe("parseCases", () => {
  it("keeps earlier turns for follow-up cases", () => {
    const history = [
      { role: "user", content: "Organize my growth hours for last week." },
      {
        role: "assistant",
        content: "2026-11-10 (Tue) | Personal Growth | 1.5 h | AWS study group",
      },
    ];
    const [c] = parseCases(jsonl({ ...answered, history }));
    expect(c?.history).toEqual(history);
  });

  it("defaults history to empty", () => {
    expect(parseCases(jsonl(answered))[0]?.history).toEqual([]);
  });

  it("reads one case per line and skips blank lines", () => {
    const cases = parseCases(`${jsonl(answered)}\n\n`);
    expect(cases).toEqual([{ ...answered, history: [] }]);
  });

  it("defaults sections and facts for cases that shouldn't be answered", () => {
    const [offTopic] = parseCases(
      jsonl({
        id: "france",
        category: "off-topic",
        question: "Capital of France?",
        expectedOutcome: "off-topic",
      }),
    );
    expect(offTopic).toMatchObject({ expectedSections: [], expectedFacts: [] });
  });

  it("requires sections and facts on cases that should be answered", () => {
    expect(() => parseCases(jsonl({ ...answered, expectedSections: [] }))).toThrow(
      "line 1: an answered case needs expectedSections and expectedFacts",
    );
  });

  it("names the line of an invalid case", () => {
    expect(() => parseCases(jsonl(answered, { ...answered, id: "x", category: "guess" }))).toThrow(
      /^line 2: /,
    );
    expect(() => parseCases(`${jsonl(answered)}\n{not json`)).toThrow(/^line 2: /);
  });

  it("rejects duplicate ids", () => {
    expect(() => parseCases(jsonl(answered, answered))).toThrow(
      'line 2: duplicate id "pto-apprentice"',
    );
  });

  it("accepts the committed handbook eval set", () => {
    const file = path.join(process.cwd(), "evals/handbook.jsonl");
    const cases = parseCases(readFileSync(file, "utf8"));
    expect(cases.length).toBeGreaterThanOrEqual(40);
    const categories = new Set(cases.map((c) => c.category));
    expect([...categories].sort()).toEqual([
      "amount",
      "injection",
      "lookup",
      "not-covered",
      "off-topic",
      "paraphrase",
      "situational",
    ]);
  });

  it("accepts the committed Microsoft 365 eval set", () => {
    const file = path.join(process.cwd(), "evals/m365.jsonl");
    const cases = parseCases(readFileSync(file, "utf8"));
    expect(cases.map((c) => c.expectedOutcome).sort()).toEqual([
      "answered",
      "answered",
      "answered",
      "answered",
      "answered",
      "answered",
      "dont-know",
      "off-topic",
    ]);
    expect(cases.filter((c) => c.history.length).map((c) => c.id)).toEqual([
      "m365-growth-hours-correction",
    ]);
    expect(cases.some((c) => c.category === "m365")).toBe(true);
    expect(cases.some((c) => c.category === "injection")).toBe(true);
  });
});
