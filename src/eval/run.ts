import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { getPool } from "@/db";
import { type EvalCase, parseCases } from "@/eval/cases";
import { judgeAnswer } from "@/eval/judge";
import { M365_FIXTURE_TOKEN, m365FixtureFetch } from "@/eval/m365-fixtures";
import {
  type CaseResult,
  type Summary,
  type SweepRow,
  summarize,
  thresholdSweep,
} from "@/eval/metrics";
import type { Candidate } from "@/knowledge/retrieve";
import { SELECT_CONFIG, selectPassages } from "@/knowledge/select";
import type { RerankResult } from "@/knowledge/voyage";
import { streamAnswer } from "@/lib/chat/answer";
import { chatClient } from "@/lib/chat/anthropic";
import { chatSearch } from "@/lib/chat/passages";
import { chatSkills } from "@/lib/chat/skills";
import { SourceRegistry } from "@/lib/chat/sources";
import { type ChatToolDeps, chatTools } from "@/lib/chat/tools";
import { checkTopic, OFF_TOPIC, offTopicAnswer } from "@/lib/chat/topic-check";
import { searchTopics } from "@/lib/chat-topics";
import { GraphTokenError } from "@/lib/graph-token";

const THRESHOLDS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
const CONCURRENCY = 4;

/** Graph access for the chat's tools: the made-up fixtures in M365 mode, none otherwise. */
function graphAccess(m365: boolean): Pick<ChatToolDeps, "graphToken" | "fetchFn"> {
  return m365
    ? { graphToken: async () => M365_FIXTURE_TOKEN, fetchFn: m365FixtureFetch }
    : { graphToken: () => Promise.reject(new GraphTokenError("unavailable", "eval")) };
}

/** Runs one case through the same steps as /api/chat, keeping what each step returned. */
async function runCase(evalCase: EvalCase, m365: boolean): Promise<CaseResult> {
  const client = chatClient();
  const request = { question: evalCase.question, history: [] };
  const topic = await checkTopic({ ...request, client }).catch(() => null);

  // Search runs for every case so the threshold sweep sees off-topic questions too.
  const search = chatSearch(searchTopics(topic), {});
  let candidates: Candidate[] = [];
  let ranked: RerankResult[] = [];
  const passages = await selectPassages(evalCase.question, {
    retrieve: async (q) => {
      candidates = await search.retrieve(q);
      return candidates;
    },
    rerank: async (q, documents, topK) => {
      ranked = await search.rerank(q, documents, topK);
      return ranked;
    },
  });

  let outcome: CaseResult["outcome"] = "off-topic";
  let answer = offTopicAnswer();
  const citedQuotes: string[] = [];
  if (topic !== OFF_TOPIC) {
    answer = "";
    outcome = "error";
    // The agent's handbook search returns the passages selected above, so the answer and the
    // retrieval metrics see the same passages.
    const registry = new SourceRegistry();
    const tools = chatTools({
      registry,
      passages: async () => passages,
      handbookTopics: searchTopics(topic),
      ...graphAccess(m365),
      timeZone: "UTC",
      skills: chatSkills(),
    });
    for await (const event of streamAnswer({ ...request, tools, registry, client })) {
      if (event.type === "delta") answer += event.text;
      if (event.type === "citation") citedQuotes.push(event.citation.quote);
      if (event.type === "done") outcome = event.outcome;
    }
  }
  // Microsoft 365 answers are judged against the sources they cited, from the fixtures.
  const judgedPassages = m365 ? citedQuotes : passages.map((p) => p.text);
  const judge =
    outcome === "answered"
      ? await judgeAnswer({ evalCase, answer, passages: judgedPassages, client })
      : undefined;

  return {
    case: evalCase,
    topic,
    candidates: candidates.map((c) => c.sectionPath),
    ranked: ranked.map((r) => ({
      sectionPath: candidates[r.index]?.sectionPath ?? [],
      score: r.score,
    })),
    selected: passages.map((p) => p.sectionPath),
    outcome,
    answer,
    judge,
  };
}

async function runAll(cases: EvalCase[], m365: boolean): Promise<CaseResult[]> {
  const results: CaseResult[] = new Array(cases.length);
  let next = 0;
  async function worker() {
    while (next < cases.length) {
      const i = next++;
      const evalCase = cases[i];
      if (!evalCase) continue;
      results[i] = await runCase(evalCase, m365);
      process.stderr.write(".");
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stderr.write("\n");
  return results;
}

const pct = (n: number, of: number) =>
  of === 0 ? "n/a" : `${n}/${of} (${Math.round((100 * n) / of)}%)`;

/** Handbook retrieval numbers; meaningless for Microsoft 365 cases, whose answers aren't there. */
function printRetrieval(r: Summary["retrieval"]): void {
  console.log("Retrieval (expected section found)");
  console.log(`  hybrid search top 5:   ${pct(r.candidatesTop5, r.cases)}`);
  console.log(`  hybrid search, all:    ${pct(r.candidatesAll, r.cases)}`);
  console.log(`  re-ranked top ${SELECT_CONFIG.topK}:      ${pct(r.rerankedTop5, r.cases)}`);
  console.log(
    `  sent to Claude:        ${pct(r.selected, r.cases)} (threshold ${SELECT_CONFIG.minScore})`,
  );
}

function printSummary(s: Summary, m365: boolean): void {
  const { dontKnow: d, topic: t, answers: a } = s;
  if (m365) console.log("Retrieval: not measured (Microsoft 365 answers aren't in the handbook)");
  else printRetrieval(s.retrieval);
  console.log("Answers to answerable questions (judged)");
  console.log(
    `  correct ${pct(a.correct, a.cases)}, partial ${a.partial}, incorrect ${a.incorrect}, not answered ${a.notAnswered}`,
  );
  console.log("Don't know");
  console.log(
    `  precision ${pct(d.truePositives, d.predicted)}, recall ${pct(d.truePositives, d.actual)}`,
  );
  console.log("Topic check");
  console.log(
    `  off-topic caught ${pct(t.offTopicCaught, t.offTopicCases)}, on-topic wrongly refused ${pct(t.onTopicWronglyRefused, t.onTopicCases)}, failed ${t.checkFailed}`,
  );
  console.log(`Prompt injection: passed ${pct(s.injection.passed, s.injection.cases)}`);
  console.log(`Outcomes (expected→actual): ${JSON.stringify(s.outcomes)}`);
}

function printSweep(rows: SweepRow[]): void {
  console.log("\nThreshold sweep (top re-rank score must reach the threshold)");
  console.log("  threshold  answerable passed  not-covered blocked  off-topic blocked");
  for (const row of rows) {
    const cells = [
      row.threshold.toFixed(2).padEnd(9),
      pct(row.answerablePassed, row.answerable).padEnd(18),
      pct(row.unanswerableBlocked, row.unanswerable).padEnd(19),
      pct(row.offTopicBlocked, row.offTopic),
    ];
    console.log(`  ${cells.join("  ")}`);
  }
}

function printMargins(results: CaseResult[]): void {
  const tops = (outcome: string) =>
    results
      .filter((r) => r.case.expectedOutcome === outcome)
      .map((r) => r.ranked[0]?.score ?? 0)
      .sort((a, b) => a - b);
  const answerable = tops("answered");
  const unanswerable = [...tops("dont-know"), ...tops("off-topic")];
  const fmt = (n: number | undefined) => (n === undefined ? "-" : n.toFixed(3));
  console.log(
    `  lowest answerable top score ${fmt(answerable[0])}; highest not-covered/off-topic top score ${fmt(unanswerable.at(-1))}`,
  );
}

function printMisses(results: CaseResult[]): void {
  const misses = results.filter(
    (r) =>
      r.outcome !== r.case.expectedOutcome ||
      (r.judge && r.judge.verdict !== "correct") ||
      r.judge?.followedInjection,
  );
  if (misses.length === 0) return;
  console.log("\nCases to look at");
  for (const r of misses) {
    const top = r.ranked[0]?.score.toFixed(2) ?? "-";
    const verdict = r.judge ? ` ${r.judge.verdict}: ${r.judge.reason}` : "";
    console.log(
      `  ${r.case.id}: ${r.case.expectedOutcome}→${r.outcome}, top score ${top}.${verdict}`,
    );
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cases: { type: "string", default: "evals/handbook.jsonl" },
      only: { type: "string" },
    },
  });
  const file = path.resolve(values.cases);
  let cases = parseCases(await readFile(file, "utf8"));
  if (values.only) {
    const ids = new Set(values.only.split(","));
    cases = cases.filter((c) => ids.has(c.id));
  }
  // A file with Microsoft 365 cases runs with the Microsoft 365 tools on, against fixtures.
  const m365 = cases.some((c) => c.category === "m365");
  if (m365) process.env["M365_TOOLS"] = "enabled";
  console.log(
    `Running ${cases.length} cases from ${path.relative(process.cwd(), file)}${m365 ? " (Microsoft 365 tools on, fixture data)" : ""}`,
  );
  const results = await runAll(cases, m365);
  printSummary(summarize(results), m365);
  if (!m365) {
    printSweep(thresholdSweep(results, THRESHOLDS));
    printMargins(results);
  }
  printMisses(results);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
