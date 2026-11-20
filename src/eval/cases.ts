import { z } from "zod";
import { chatOutcomeSchema } from "@/lib/chat-protocol";
import { CHAT_QUESTION_MAX, chatRequestSchema } from "@/lib/validation";

export const CASE_CATEGORIES = [
  "lookup",
  "amount",
  "paraphrase",
  "situational",
  "not-covered",
  "off-topic",
  "injection",
  "m365",
] as const;

const caseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/, "id must be lowercase letters, digits, and dashes"),
    category: z.enum(CASE_CATEGORIES),
    question: z.string().min(1).max(CHAT_QUESTION_MAX),
    /** Earlier turns for a follow-up case, as the chat would send them. */
    history: chatRequestSchema.shape.history,
    expectedOutcome: chatOutcomeSchema,
    /** Heading paths that hold the answer; a retrieved chunk from any of them is a hit. */
    expectedSections: z.array(z.array(z.string()).min(1)).default([]),
    /** What a correct answer must say, in plain words, for the judge. */
    expectedFacts: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type EvalCase = z.infer<typeof caseSchema>;

function parseLine(line: string, number: number): EvalCase {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    throw new Error(`line ${number}: not valid JSON`);
  }
  const parsed = caseSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`line ${number}: ${issue?.path.join(".") || "case"}: ${issue?.message}`);
  }
  const c = parsed.data;
  if (c.expectedOutcome === "answered" && (!c.expectedSections.length || !c.expectedFacts.length)) {
    throw new Error(`line ${number}: an answered case needs expectedSections and expectedFacts`);
  }
  return c;
}

/** Parses an eval set: one JSON case per line. Errors name the line. */
export function parseCases(jsonl: string): EvalCase[] {
  const cases: EvalCase[] = [];
  const ids = new Set<string>();
  jsonl.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    const c = parseLine(line, i + 1);
    if (ids.has(c.id)) throw new Error(`line ${i + 1}: duplicate id "${c.id}"`);
    ids.add(c.id);
    cases.push(c);
  });
  return cases;
}
