import { describe, expect, it } from "vitest";
import type { RegisteredEvent } from "@/lib/chat/sources";
import { renderTally, TallyError, tallyHours } from "@/lib/chat/tally";

function event(
  id: string,
  title: string,
  date: string,
  start: string,
  end: string,
  hours: number,
): RegisteredEvent {
  return { id, graphId: `g-${id}`, title, date, start, end, hours, organizer: "", categories: [] };
}

const aws = event("c1", "AWS study group", "2026-11-03", "09:00", "10:30", 1.5);
const talk = event("c2", "Tech talk", "2026-11-03", "11:00", "11:48", 0.8);
const foodBank = event("c3", "Food bank volunteering", "2026-11-02", "13:00", "16:00", 3);
const onboarding = event("c4", "Onboarding Experience Team", "2026-11-03", "14:00", "15:00", 1);
const offsite = event("c5", "Team offsite planning", "2026-11-05", "09:00", "12:00", 3);

describe("tallyHours", () => {
  it("sums one day's category into a line rounded to a quarter hour", () => {
    const tally = tallyHours(
      [talk, aws],
      [
        { event: "c2", category: "personal-growth" },
        { event: "c1", category: "personal-growth" },
      ],
    );
    expect(tally.lines).toEqual([
      {
        date: "2026-11-03",
        category: "personal-growth",
        hours: 2.25,
        titles: ["AWS study group", "Tech talk"],
      },
    ]);
  });

  it("sorts lines by date, then category", () => {
    const tally = tallyHours(
      [aws, foodBank, onboarding],
      [
        { event: "c4", category: "ingage-growth" },
        { event: "c1", category: "personal-growth" },
        { event: "c3", category: "community-impact" },
      ],
    );
    expect(tally.lines.map((l) => `${l.date} ${l.category}`)).toEqual([
      "2026-11-02 community-impact",
      "2026-11-03 personal-growth",
      "2026-11-03 ingage-growth",
    ]);
  });

  it("totals the rounded lines", () => {
    const tally = tallyHours(
      [aws, talk, foodBank],
      [
        { event: "c1", category: "personal-growth" },
        { event: "c2", category: "personal-growth" },
        { event: "c3", category: "community-impact" },
      ],
    );
    expect(tally.totals).toEqual({
      "personal-growth": 2.25,
      "ingage-growth": 0,
      "community-impact": 3,
    });
  });

  it("puts not-sure and unassigned events under not sure", () => {
    const tally = tallyHours(
      [aws, offsite, foodBank],
      [
        { event: "c1", category: "personal-growth" },
        { event: "c5", category: "not-sure" },
      ],
    );
    expect(tally.notSure.map((e) => e.id)).toEqual(["c3", "c5"]);
  });

  it("rejects unknown ids", () => {
    expect(() => tallyHours([aws], [{ event: "c99", category: "personal-growth" }])).toThrow(
      new TallyError("Unknown event ids: c99"),
    );
  });

  it("rejects an event assigned twice", () => {
    expect(() =>
      tallyHours(
        [aws, talk],
        [
          { event: "c2", category: "personal-growth" },
          { event: "c2", category: "ingage-growth" },
        ],
      ),
    ).toThrow(new TallyError("Assigned more than once: c2"));
  });

  it("lists a line that rounds to zero instead of showing 0 h", () => {
    const brief = event("c6", "Quick sync", "2026-11-04", "10:00", "10:05", 5 / 60);
    const tally = tallyHours([brief], [{ event: "c6", category: "ingage-growth" }]);
    expect(tally.lines).toEqual([]);
    expect(tally.underQuarterHour.map((e) => e.id)).toEqual(["c6"]);
  });

  it("notes events that overlap on the same date", () => {
    const clash = event("c7", "Lunch and learn", "2026-11-03", "10:00", "11:00", 1);
    const tally = tallyHours(
      [aws, clash],
      [
        { event: "c1", category: "personal-growth" },
        { event: "c7", category: "ingage-growth" },
      ],
    );
    expect(tally.overlaps).toEqual([
      { date: "2026-11-03", titles: ["AWS study group", "Lunch and learn"] },
    ]);
  });
});

describe("renderTally", () => {
  it("prints lines, totals, and not-sure events", () => {
    const tally = tallyHours(
      [aws, talk, offsite],
      [
        { event: "c1", category: "personal-growth" },
        { event: "c2", category: "personal-growth" },
        { event: "c5", category: "not-sure" },
      ],
    );
    expect(renderTally(tally)).toBe(
      [
        "2026-11-03 (Tue) | Personal Growth | 2.25 h | AWS study group; Tech talk",
        "Totals: Personal Growth 2.25 h, Ingage Growth 0 h, Community Impact 0 h",
        "Not sure: Team offsite planning (2026-11-05, 09:00-12:00, 3 h)",
      ].join("\n"),
    );
  });

  it("prints under-a-quarter-hour and overlap lines when there are any", () => {
    const brief = event("c6", "Quick sync", "2026-11-04", "10:00", "10:05", 5 / 60);
    const clash = event("c7", "Lunch and learn", "2026-11-03", "10:00", "11:00", 1);
    const text = renderTally(
      tallyHours(
        [aws, clash, brief],
        [
          { event: "c1", category: "personal-growth" },
          { event: "c7", category: "personal-growth" },
          { event: "c6", category: "ingage-growth" },
        ],
      ),
    );
    expect(text).toContain("Under a quarter hour, not counted: Quick sync (2026-11-04)");
    expect(text).toContain("Overlap on 2026-11-03: AWS study group and Lunch and learn");
  });
});
