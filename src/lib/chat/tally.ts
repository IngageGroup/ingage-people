import type { RegisteredEvent } from "@/lib/chat/sources";

export const GROWTH_CATEGORIES = ["personal-growth", "ingage-growth", "community-impact"] as const;
export type GrowthCategory = (typeof GROWTH_CATEGORIES)[number];
export type Assignment = { event: string; category: GrowthCategory | "not-sure" };

const LABEL: Record<GrowthCategory, string> = {
  "personal-growth": "Personal Growth",
  "ingage-growth": "Ingage Growth",
  "community-impact": "Community Impact",
};

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });

/** A problem with the assignments; the message is safe to show Claude. */
export class TallyError extends Error {
  override name = "TallyError";
}

export interface TallyLine {
  date: string;
  category: GrowthCategory;
  hours: number;
  titles: string[];
}

export interface Tally {
  lines: TallyLine[];
  totals: Record<GrowthCategory, number>;
  notSure: RegisteredEvent[];
  underQuarterHour: RegisteredEvent[];
  overlaps: Array<{ date: string; titles: [string, string] }>;
}

function quarterHours(hours: number): number {
  return Math.round(hours * 4) / 4;
}

function byTime(a: RegisteredEvent, b: RegisteredEvent): number {
  return `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`);
}

function checkAssignments(events: RegisteredEvent[], assignments: Assignment[]): void {
  const known = new Set(events.map((e) => e.id));
  const unknown = assignments.map((a) => a.event).filter((id) => !known.has(id));
  if (unknown.length) throw new TallyError(`Unknown event ids: ${unknown.join(", ")}`);
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const { event } of assignments) {
    if (seen.has(event)) twice.add(event);
    seen.add(event);
  }
  if (twice.size) throw new TallyError(`Assigned more than once: ${[...twice].join(", ")}`);
}

function minutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function overlapsOf(events: RegisteredEvent[]): Tally["overlaps"] {
  const sorted = [...events].sort(byTime);
  const found: Tally["overlaps"] = [];
  for (const [i, a] of sorted.entries()) {
    const aEnd = minutes(a.start) + a.hours * 60;
    for (const b of sorted.slice(i + 1)) {
      if (b.date === a.date && minutes(b.start) < aEnd) {
        found.push({ date: a.date, titles: [a.title, b.title] });
      }
    }
  }
  return found;
}

/**
 * Hours per day per category from the events this answer listed. Every listed event the
 * assignments leave out is "not sure", so none drop out of the result.
 */
export function tallyHours(events: RegisteredEvent[], assignments: Assignment[]): Tally {
  checkAssignments(events, assignments);
  const categoryOf = new Map(assignments.map((a) => [a.event, a.category]));
  const groups = new Map<
    string,
    { date: string; category: GrowthCategory; events: RegisteredEvent[] }
  >();
  const notSure: RegisteredEvent[] = [];
  for (const event of [...events].sort(byTime)) {
    const category = categoryOf.get(event.id) ?? "not-sure";
    if (category === "not-sure") {
      notSure.push(event);
      continue;
    }
    const key = `${event.date} ${GROWTH_CATEGORIES.indexOf(category)}`;
    const group = groups.get(key) ?? { date: event.date, category, events: [] };
    group.events.push(event);
    groups.set(key, group);
  }

  const lines: TallyLine[] = [];
  const underQuarterHour: RegisteredEvent[] = [];
  const totals: Record<GrowthCategory, number> = {
    "personal-growth": 0,
    "ingage-growth": 0,
    "community-impact": 0,
  };
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    if (!group) continue;
    const hours = quarterHours(group.events.reduce((sum, e) => sum + e.hours, 0));
    if (hours === 0) {
      underQuarterHour.push(...group.events);
      continue;
    }
    lines.push({
      date: group.date,
      category: group.category,
      hours,
      titles: group.events.map((e) => e.title),
    });
    totals[group.category] += hours;
  }
  const assigned = events.filter((e) => categoryOf.has(e.id));
  return { lines, totals, notSure, underQuarterHour, overlaps: overlapsOf(assigned) };
}

function weekday(date: string): string {
  return WEEKDAY.format(new Date(`${date}T00:00:00Z`));
}

/** The tally as plain lines the chat shows as is: one per QuickBooks entry, then the rest. */
export function renderTally(tally: Tally): string {
  const out = tally.lines.map(
    (l) =>
      `${l.date} (${weekday(l.date)}) | ${LABEL[l.category]} | ${l.hours} h | ${l.titles.join("; ")}`,
  );
  const totals = GROWTH_CATEGORIES.map((c) => `${LABEL[c]} ${tally.totals[c]} h`).join(", ");
  out.push(`Totals: ${totals}`);
  for (const e of tally.notSure) {
    out.push(`Not sure: ${e.title} (${e.date}, ${e.start}-${e.end}, ${quarterHours(e.hours)} h)`);
  }
  for (const e of tally.underQuarterHour) {
    out.push(`Under a quarter hour, not counted: ${e.title} (${e.date})`);
  }
  for (const o of tally.overlaps) {
    out.push(`Overlap on ${o.date}: ${o.titles[0]} and ${o.titles[1]}`);
  }
  return out.join("\n");
}
