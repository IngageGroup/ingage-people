import { describe, expect, it } from "vitest";
import { parseMarkdown } from "@/knowledge/markdown";

describe("parseMarkdown", () => {
  it("uses the # heading as the title and nests ## to ###### headings", () => {
    const doc = parseMarkdown(
      "# Handbook\n\nIntro.\n\n## Benefits\n\n### Training\n\nBudget text.\n\n#### Approval\n\nAsk your coach.\n\n## Reviews\n\nTwice a year.\n",
    );
    expect(doc.title).toBe("Handbook");
    expect(doc.sections).toEqual([
      { headingPath: [], text: "Intro." },
      { headingPath: ["Benefits", "Training"], text: "Budget text." },
      { headingPath: ["Benefits", "Training", "Approval"], text: "Ask your coach." },
      { headingPath: ["Reviews"], text: "Twice a year." },
    ]);
  });

  it("skips headings with no text under them", () => {
    const doc = parseMarkdown("# T\n\n## Empty\n\n## Full\n\nText.");
    expect(doc.sections.map((s) => s.headingPath)).toEqual([["Full"]]);
  });

  it("doesn't treat # lines inside code fences as headings", () => {
    const doc = parseMarkdown("# T\n\n## Setup\n\n```sh\n# install\npnpm install\n```\n");
    expect(doc.sections).toEqual([
      { headingPath: ["Setup"], text: "```sh\n# install\npnpm install\n```" },
    ]);
  });

  it("returns no title and no sections for empty input", () => {
    expect(parseMarkdown("")).toEqual({ title: "", sections: [] });
  });
});
