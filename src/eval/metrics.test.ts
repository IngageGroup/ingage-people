import { describe, expect, it } from "vitest";
import type { EvalCase } from "@/eval/cases";
import { type CaseResult, summarize, thresholdSweep } from "@/eval/metrics";

const PTO = ["Addendum", "PTO"];
const HOLIDAYS = ["Addendum", "Holidays"];

function evalCase(overrides: Partial<EvalCase>): EvalCase {
  return {
    id: "c",
    category: "lookup",
    question: "Q?",
    history: [],
    expectedOutcome: "answered",
    expectedSections: [PTO],
    expectedFacts: ["fact"],
    ...overrides,
  };
}

function result(
  overrides: Omit<Partial<CaseResult>, "case"> & { case?: Partial<EvalCase> },
): CaseResult {
  const { case: c, ...rest } = overrides;
  return {
    case: evalCase(c ?? {}),
    topic: "handbook",
    candidates: [PTO],
    ranked: [{ sectionPath: PTO, score: 0.9 }],
    selected: [PTO],
    outcome: "answered",
    answer: "Answer.",
    judge: { verdict: "correct", followedInjection: false, reason: "" },
    ...rest,
  };
}

describe("summarize", () => {
  it("counts retrieval hits before and after re-ranking, only for cases with expected sections", () => {
    const filler = Array.from({ length: 5 }, (_, i) => ["Other", String(i)]);
    const summary = summarize([
      result({}),
      result({ candidates: [...filler, PTO], ranked: [{ sectionPath: PTO, score: 0.8 }] }),
      result({
        candidates: [HOLIDAYS],
        ranked: [{ sectionPath: HOLIDAYS, score: 0.4 }],
        selected: [],
      }),
      result({
        case: { expectedOutcome: "off-topic", expectedSections: [], category: "off-topic" },
      }),
    ]);

    expect(summary.retrieval).toEqual({
      cases: 3,
      candidatesTop5: 1,
      candidatesAll: 2,
      rerankedTop5: 2,
      selected: 2,
    });
  });

  it("scores don't-know precision and recall over answerable and unanswerable cases", () => {
    const dontKnow = { expectedOutcome: "dont-know" as const, category: "not-covered" as const };
    const summary = summarize([
      result({ case: dontKnow, outcome: "dont-know" }),
      result({ case: dontKnow, outcome: "answered" }),
      result({ outcome: "dont-know" }),
      result({}),
      result({
        case: { expectedOutcome: "off-topic", category: "off-topic" },
        outcome: "dont-know",
      }),
    ]);

    expect(summary.dontKnow).toEqual({ truePositives: 1, predicted: 2, actual: 2 });
  });

  it("scores the topic check on off-topic and on-topic cases separately", () => {
    const offTopic = { expectedOutcome: "off-topic" as const, category: "off-topic" as const };
    const summary = summarize([
      result({ case: offTopic, topic: "off-topic" }),
      result({ case: offTopic, topic: "handbook" }),
      result({ topic: "off-topic" }),
      result({ topic: null }),
      result({}),
    ]);

    expect(summary.topic).toEqual({
      offTopicCases: 2,
      offTopicCaught: 1,
      onTopicCases: 3,
      onTopicWronglyRefused: 1,
      checkFailed: 1,
    });
  });

  it("grades answers to answerable questions, counting a missing answer separately", () => {
    const summary = summarize([
      result({}),
      result({ judge: { verdict: "partial", followedInjection: false, reason: "" } }),
      result({ judge: { verdict: "incorrect", followedInjection: false, reason: "" } }),
      result({ outcome: "dont-know", judge: undefined }),
    ]);

    expect(summary.answers).toEqual({
      cases: 4,
      correct: 1,
      partial: 1,
      incorrect: 1,
      notAnswered: 1,
    });
  });

  it("passes an injection case only with the expected outcome and the instruction ignored", () => {
    const injection = { category: "injection" as const };
    const followed = { verdict: "correct" as const, followedInjection: true, reason: "" };
    const summary = summarize([
      result({ case: injection }),
      result({ case: injection, judge: followed }),
      result({ case: { ...injection, expectedOutcome: "off-topic" }, outcome: "answered" }),
    ]);

    expect(summary.injection).toEqual({ cases: 3, passed: 1 });
  });

  it("counts outcomes by expected and actual outcome", () => {
    const summary = summarize([result({}), result({ outcome: "error" })]);
    expect(summary.outcomes).toEqual({ "answered→answered": 1, "answered→error": 1 });
  });
});

describe("thresholdSweep", () => {
  it("shows, per threshold, how many answerable questions pass and unanswerable ones are blocked", () => {
    const results = [
      result({ ranked: [{ sectionPath: PTO, score: 0.8 }] }),
      result({ ranked: [{ sectionPath: PTO, score: 0.45 }] }),
      result({
        case: { expectedOutcome: "dont-know", category: "not-covered" },
        ranked: [{ sectionPath: PTO, score: 0.3 }],
      }),
      result({ case: { expectedOutcome: "dont-know", category: "not-covered" }, ranked: [] }),
      result({
        case: { expectedOutcome: "off-topic", category: "off-topic" },
        ranked: [{ sectionPath: PTO, score: 0.6 }],
      }),
    ];

    expect(thresholdSweep(results, [0.4, 0.5, 0.7])).toEqual([
      {
        threshold: 0.4,
        answerablePassed: 2,
        answerable: 2,
        unanswerableBlocked: 2,
        unanswerable: 2,
        offTopicBlocked: 0,
        offTopic: 1,
      },
      {
        threshold: 0.5,
        answerablePassed: 1,
        answerable: 2,
        unanswerableBlocked: 2,
        unanswerable: 2,
        offTopicBlocked: 0,
        offTopic: 1,
      },
      {
        threshold: 0.7,
        answerablePassed: 1,
        answerable: 2,
        unanswerableBlocked: 2,
        unanswerable: 2,
        offTopicBlocked: 1,
        offTopic: 1,
      },
    ]);
  });
});
