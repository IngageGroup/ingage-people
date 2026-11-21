import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatSkills, loadSkills, parseSkill } from "@/lib/chat/skills";

function skillText(fields: string, body = "Do the thing.") {
  return `---\n${fields}\n---\n\n${body}\n`;
}

const VALID = skillText("name: sample-skill\ndescription: Does a sample thing.\nrequires: [m365]");

describe("parseSkill", () => {
  it("reads name, description, requires, and body", () => {
    expect(parseSkill("sample.md", VALID)).toEqual({
      name: "sample-skill",
      description: "Does a sample thing.",
      requires: ["m365"],
      body: "Do the thing.",
    });
  });

  it("accepts an empty requires list", () => {
    const text = skillText("name: plain\ndescription: Plain.\nrequires: []");
    expect(parseSkill("plain.md", text).requires).toEqual([]);
  });

  it.each([
    ["no frontmatter", "Just text."],
    ["missing name", skillText("description: D.\nrequires: []")],
    ["empty description", skillText("name: x\ndescription:\nrequires: []")],
    ["name not kebab-case", skillText("name: Not Kebab\ndescription: D.\nrequires: []")],
    ["unknown requires", skillText("name: x\ndescription: D.\nrequires: [email]")],
    ["empty body", skillText("name: x\ndescription: D.\nrequires: []", "")],
  ])("rejects %s with the file name in the message", (_case, text) => {
    expect(() => parseSkill("bad.md", text)).toThrow(/^bad\.md: /);
  });
});

describe("loadSkills", () => {
  function dirWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "skills-"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  }

  it("loads .md files sorted by file name and ignores others", () => {
    const dir = dirWith({
      "b.md": skillText("name: second\ndescription: B.\nrequires: []"),
      "a.md": skillText("name: first\ndescription: A.\nrequires: []"),
      "notes.txt": "ignored",
    });
    expect(loadSkills(dir).map((s) => s.name)).toEqual(["first", "second"]);
  });

  it("rejects duplicate names", () => {
    const dir = dirWith({
      "a.md": skillText("name: same\ndescription: A.\nrequires: []"),
      "b.md": skillText("name: same\ndescription: B.\nrequires: []"),
    });
    expect(() => loadSkills(dir)).toThrow("Duplicate skill name: same (a.md, b.md)");
  });

  it("parses the repo's own skills", () => {
    const skills = loadSkills();
    expect(skills.find((s) => s.name === "organize-growth-hours")?.requires).toEqual(["m365"]);
  });
});

describe("chatSkills", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("leaves out Microsoft 365 skills when the tools are off", () => {
    vi.stubEnv("M365_TOOLS", "");
    expect(chatSkills().some((s) => s.requires.includes("m365"))).toBe(false);
  });

  it("includes them when the tools are on", () => {
    vi.stubEnv("M365_TOOLS", "enabled");
    expect(chatSkills().map((s) => s.name)).toContain("organize-growth-hours");
  });
});
