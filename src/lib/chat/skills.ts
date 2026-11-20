import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { m365Enabled } from "@/lib/chat-topics";

/** Tool sets a skill can depend on; a skill is offered only when all of them are on. */
export type ToolGroup = "m365";

export interface Skill {
  name: string;
  description: string;
  requires: ToolGroup[];
  body: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

const fieldsSchema = z.object({
  name: z
    .string({ error: "name is required" })
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "name must be kebab-case"),
  description: z.string({ error: "description is required" }).min(1, "description is empty"),
  requires: z.array(z.enum(["m365"], { error: "requires lists an unknown tool group" })),
});

/** `key: value` lines; `[a, b]` values become lists. */
function readFields(block: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const line of block.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    const list = /^\[(.*)\]$/.exec(value);
    fields[key] = list
      ? (list[1] ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : value;
  }
  return fields;
}

/** Parses one skill file; errors start with the file name so a bad skill is easy to find. */
export function parseSkill(fileName: string, text: string): Skill {
  const match = FRONTMATTER.exec(text.replaceAll("\r\n", "\n"));
  if (!match) throw new Error(`${fileName}: missing --- frontmatter ---`);
  const parsed = fieldsSchema.safeParse(readFields(match[1] ?? ""));
  if (!parsed.success) {
    throw new Error(`${fileName}: ${parsed.error.issues[0]?.message ?? "invalid frontmatter"}`);
  }
  const body = (match[2] ?? "").trim();
  if (!body) throw new Error(`${fileName}: the skill has no instructions`);
  return { ...parsed.data, body };
}

/** Every skill in `dir` (default `skills/` in the working directory), by file name. */
export function loadSkills(dir = join(process.cwd(), "skills")): Skill[] {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort();
  const fileOf = new Map<string, string>();
  return files.map((file) => {
    const skill = parseSkill(file, readFileSync(join(dir, file), "utf8"));
    const earlier = fileOf.get(skill.name);
    if (earlier) throw new Error(`Duplicate skill name: ${skill.name} (${earlier}, ${file})`);
    fileOf.set(skill.name, file);
    return skill;
  });
}

let cached: Skill[] | undefined;

/** The skills the chat offers here: loaded once, filtered by the tools that are on. */
export function chatSkills(): Skill[] {
  cached ??= loadSkills();
  const m365 = m365Enabled();
  return cached.filter((skill) => skill.requires.every((group) => group !== "m365" || m365));
}
