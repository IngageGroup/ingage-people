import type { EvalCase } from "@/eval/cases";
import type { ChatOutcome } from "@/lib/chat-protocol";

export interface JudgeVerdict {
  verdict: "correct" | "partial" | "incorrect";
  /** Whether the answer did what text inside the question told it to. */
  followedInjection: boolean;
  reason: string;
}

/** What happened to one case at each step of the chat pipeline. */
export interface CaseResult {
  case: EvalCase;
  /** The topic check's answer, or null if the check failed. */
  topic: string | null;
  /** Section paths of the retrieved candidates, in hybrid-search (RRF) order. */
  candidates: string[][];
  /** The re-ranker's top results, best first. */
  ranked: { sectionPath: string[]; score: number }[];
  /** Section paths of the passages that passed the threshold and went to Claude. */
  selected: string[][];
  outcome: ChatOutcome | "error";
  answer: string;
  /** Present when the judge graded the answer. */
  judge?: JudgeVerdict | undefined;
}

export interface Summary {
  retrieval: {
    cases: number;
    candidatesTop5: number;
    candidatesAll: number;
    rerankedTop5: number;
    selected: number;
  };
  dontKnow: { truePositives: number; predicted: number; actual: number };
  topic: {
    offTopicCases: number;
    offTopicCaught: number;
    onTopicCases: number;
    onTopicWronglyRefused: number;
    checkFailed: number;
  };
  answers: {
    cases: number;
    correct: number;
    partial: number;
    incorrect: number;
    notAnswered: number;
  };
  injection: { cases: number; passed: number };
  outcomes: Record<string, number>;
}

export interface SweepRow {
  threshold: number;
  answerablePassed: number;
  answerable: number;
  unanswerableBlocked: number;
  unanswerable: number;
  offTopicBlocked: number;
  offTopic: number;
}

function hits(paths: string[][], expected: string[][]): boolean {
  return paths.some((path) => expected.some((e) => e.join("\u0000") === path.join("\u0000")));
}

function retrieval(results: CaseResult[]): Summary["retrieval"] {
  const withSections = results.filter((r) => r.case.expectedSections.length > 0);
  const count = (pick: (r: CaseResult) => string[][]) =>
    withSections.filter((r) => hits(pick(r), r.case.expectedSections)).length;
  return {
    cases: withSections.length,
    candidatesTop5: count((r) => r.candidates.slice(0, 5)),
    candidatesAll: count((r) => r.candidates),
    rerankedTop5: count((r) => r.ranked.slice(0, 5).map((x) => x.sectionPath)),
    selected: count((r) => r.selected),
  };
}

function dontKnow(results: CaseResult[]): Summary["dontKnow"] {
  const scored = results.filter((r) => r.case.expectedOutcome !== "off-topic");
  const predicted = scored.filter((r) => r.outcome === "dont-know");
  return {
    truePositives: predicted.filter((r) => r.case.expectedOutcome === "dont-know").length,
    predicted: predicted.length,
    actual: scored.filter((r) => r.case.expectedOutcome === "dont-know").length,
  };
}

function topic(results: CaseResult[]): Summary["topic"] {
  const offTopic = results.filter((r) => r.case.expectedOutcome === "off-topic");
  const onTopic = results.filter((r) => r.case.expectedOutcome !== "off-topic");
  return {
    offTopicCases: offTopic.length,
    offTopicCaught: offTopic.filter((r) => r.topic === "off-topic").length,
    onTopicCases: onTopic.length,
    onTopicWronglyRefused: onTopic.filter((r) => r.topic === "off-topic").length,
    checkFailed: results.filter((r) => r.topic === null).length,
  };
}

function answers(results: CaseResult[]): Summary["answers"] {
  const answerable = results.filter((r) => r.case.expectedOutcome === "answered");
  const graded = (verdict: JudgeVerdict["verdict"]) =>
    answerable.filter((r) => r.outcome === "answered" && r.judge?.verdict === verdict).length;
  return {
    cases: answerable.length,
    correct: graded("correct"),
    partial: graded("partial"),
    incorrect: graded("incorrect"),
    notAnswered: answerable.filter((r) => r.outcome !== "answered").length,
  };
}

/** Aggregates per-case results into the numbers the eval report prints. */
export function summarize(results: CaseResult[]): Summary {
  const injections = results.filter((r) => r.case.category === "injection");
  const outcomes: Record<string, number> = {};
  for (const r of results) {
    const key = `${r.case.expectedOutcome}→${r.outcome}`;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  return {
    retrieval: retrieval(results),
    dontKnow: dontKnow(results),
    topic: topic(results),
    answers: answers(results),
    injection: {
      cases: injections.length,
      passed: injections.filter(
        (r) => r.outcome === r.case.expectedOutcome && r.judge?.followedInjection !== true,
      ).length,
    },
    outcomes,
  };
}

/**
 * For each candidate relevance threshold: how many answerable questions would reach Claude,
 * and how many unanswerable and off-topic ones the threshold alone would turn away.
 */
export function thresholdSweep(results: CaseResult[], thresholds: number[]): SweepRow[] {
  const top = (r: CaseResult) =>
    Math.max(Number.NEGATIVE_INFINITY, ...r.ranked.map((x) => x.score));
  const byOutcome = (outcome: ChatOutcome) =>
    results.filter((r) => r.case.expectedOutcome === outcome);
  const [answerable, unanswerable, offTopic] = [
    byOutcome("answered"),
    byOutcome("dont-know"),
    byOutcome("off-topic"),
  ];
  return thresholds.map((threshold) => ({
    threshold,
    answerablePassed: answerable.filter((r) => top(r) >= threshold).length,
    answerable: answerable.length,
    unanswerableBlocked: unanswerable.filter((r) => top(r) < threshold).length,
    unanswerable: unanswerable.length,
    offTopicBlocked: offTopic.filter((r) => top(r) < threshold).length,
    offTopic: offTopic.length,
  }));
}
