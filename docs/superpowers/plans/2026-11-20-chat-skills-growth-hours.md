# Chat Skills and Growth Hours Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The chat loads Markdown skills on demand, and its first skill turns the user's calendar
for a period into per-day, per-category growth hours to enter in QuickBooks.

**Architecture:** Skill files in `skills/` are listed by name and description in the answer
system prompt; a `load_skill` tool returns one skill's instructions. Two new tools serve the
growth-hours skill: `list_calendar_events` (Graph `calendarView`, filtered and registered as
`c1…` ids) and `tally_hours` (sums registered event hours in code). Today's date and the
browser's time zone go in the user message.

**Tech Stack:** Next.js 16, TypeScript strict, Anthropic SDK tool runner (`betaZodTool`), Zod,
Microsoft Graph, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-20-chat-skills-growth-hours-design.md`

**Base branch:** `calendar-read-scope` (PR #57, adds `Calendars.Read`). Work on
`chat-skills-design`, which is rebased on it.

## Global Constraints

- Read-only Graph access; delegated `Calendars.Read`. No writes anywhere.
- Calendar tool, tally tool, and the growth-hours skill exist only when `M365_TOOLS=enabled`.
- Never log event titles, organizers, attendees, skill text, questions, or answers. Tool
  failures log `describeError` only.
- The answer system prompt must be byte-stable for a given skill list.
- Categories: `personal-growth` (Personal Growth), `ingage-growth` (Ingage Growth),
  `community-impact` (Community Impact), plus `not-sure`.
- Range at most 31 days (inclusive); at most 200 kept events; tool result never truncated.
- Hours: each day/category line rounded to the nearest 0.25; totals are sums of rounded lines.
- `MAX_ITERATIONS` = 10.
- Exact dependency versions only; no new dependency unless a task says so (none does).
- Absolute `@/` imports; colocated `*.test.ts`; 100-char lines; Biome clean.

## Plan-level calls (not in the spec)

- **Answer format:** the chat renders answers as plain text (`whitespace-pre-wrap` in
  `ChatPanel`), so `tally_hours` returns one plain line per entry, not a Markdown table. No
  Markdown renderer is added. The spec is updated to match.
- **Skill validation timing:** skills are parsed on first use and cached; a unit test parses the
  repo's real `skills/` folder so a bad skill fails CI instead of production startup.
- **History length:** `CHAT_TURN_TEXT_MAX` goes from 4000 to 8000 so a month's hours answer
  survives in history for corrections.
- **Events are not citations:** calendar events are registered for `tally_hours` but get no
  citation, so a stray `[c3]` is stripped and ignored.
- **Sample handbook:** `docs/dev/sample-handbook.md` gains made-up definitions of the three
  pillars so local runs and the eval can ground. Check that the real handbook defines them
  (RC Connect, *Employee Handbooks/Revision Collective and Ingage_ Handbook_2026.pdf*) before
  relying on the skill in dev.

## Review Focus

1. **`UTC` time zone:** `Intl.supportedValuesOf("timeZone")` may not list `"UTC"`; a browser
   reporting `UTC` must be accepted, not rejected with 400. Test in Task 6.
2. **Day boundaries in the user's zone:** a 23:30-00:30 event or a DST-change day must land on
   the right local date with the right duration. Tests in Task 2.
3. **Same events listed twice** (corrections re-list the period): the second listing must reuse
   the first ids, not double the hours or the "Not sure" list. Test in Task 1.
4. **Short events rounding to 0:** a 5-minute event must not produce a "0 h" line or vanish
   silently. Test in Task 3.
5. **Graph paging:** `@odata.nextLink` is an absolute URL; following it must not double the base
   or drop `Prefer`. Test in Task 2.

---

### Task 1: Calendar events in the source registry

**Files:**
- Modify: `src/lib/chat/sources.ts`
- Test: `src/lib/chat/sources.test.ts`

**Interfaces:**
- Consumes: `CalendarEvent` from Task 2 (define the type here first in
  `src/lib/graph/calendar.ts` with no functions if Task 2 isn't done; Task 2 owns the file).
- Produces:
  - `export type RegisteredEvent = CalendarEvent & { id: string }`
  - `SourceRegistry.addEvents(events: CalendarEvent[]): RegisteredEvent[]`
  - `SourceRegistry.events(): RegisteredEvent[]` (every event registered this answer, in
    registration order)

`CalendarEvent` (in `src/lib/graph/calendar.ts`):

```ts
export interface CalendarEvent {
  graphId: string;
  title: string;
  /** Local date in the user's zone, YYYY-MM-DD. */
  date: string;
  /** Local times, HH:MM. */
  start: string;
  end: string;
  /** Unrounded duration in hours. */
  hours: number;
  organizer: string;
  categories: string[];
}
```

- [ ] **Step 1: Write failing tests** in `sources.test.ts`:
  - `addEvents` returns ids `c1`, `c2` in order.
  - Adding an event whose `graphId` was already added returns the existing id and doesn't grow
    `events()`.
  - `citation("c1")` is `undefined` (events are not citations).
  - `c` ids don't disturb `p`/`f`/`m`/`t` numbering.
- [ ] **Step 2:** `pnpm vitest run src/lib/chat/sources.test.ts`. Expected: FAIL (`addEvents` is
  not a function).
- [ ] **Step 3:** Add `"c"` to `IdPrefix` and `counts`; store events in a `Map<graphId,
  RegisteredEvent>`.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit: `Register calendar events with c ids`.

### Task 2: Read the calendar from Graph

**Files:**
- Create: `src/lib/graph/calendar.ts`
- Test: `src/lib/graph/calendar.test.ts`

**Interfaces:**
- Consumes: `graphJson`, `GRAPH_BASE`, `FetchFn` from `@/lib/graph/client`.
- Produces:

```ts
export const CALENDAR_MAX_DAYS = 31;
export const CALENDAR_MAX_EVENTS = 200;
export interface CalendarRange { start: string; end: string; timeZone: string } // dates inclusive
export interface CalendarListing {
  events: CalendarEvent[];
  skipped: { cancelled: number; declined: number; allDay: number; free: number };
}
export class CalendarRangeError extends Error {} // message safe to show Claude
export function rangeDays(range: CalendarRange): number;
export async function listCalendarEvents(
  range: CalendarRange, token: string, fetchFn?: FetchFn,
): Promise<CalendarListing>;
```

- [ ] **Step 1: Write failing tests** with a fake `fetchFn`:
  - Request path is `/me/calendarView` with `startDateTime`/`endDateTime` as UTC instants of
    local midnight: `America/New_York`, 2026-11-03..2026-11-04 →
    `startDateTime=2026-11-03T05:00:00.000Z`, `endDateTime=2026-11-05T05:00:00.000Z`.
  - Header `Prefer: outlook.timezone="America/New_York"` on every page; `$select` is exactly
    `subject,start,end,isAllDay,isCancelled,showAs,responseStatus,organizer,categories`;
    `$top=100`; `$orderby=start/dateTime`.
  - Follows `@odata.nextLink` (absolute URL starting with `GRAPH_BASE`) until absent.
  - Skips and counts: `isCancelled`, `responseStatus.response === "declined"`, `isAllDay`,
    `showAs === "free"`.
  - Maps `start.dateTime` `"2026-11-03T09:00:00.0000000"` / end `"...T10:30:00.0000000"` to
    `date "2026-11-03"`, `start "09:00"`, `end "10:30"`, `hours 1.5`.
  - 23:30-00:30 event: `date` is the start day, `hours 1`.
  - Empty subject becomes `"(no title)"`; titles over 80 chars are cut to 80.
  - More than 200 kept events throws `CalendarRangeError` with
    `"More than 200 events in that period; ask for a shorter one."`
  - `rangeDays({start:"2026-11-01", end:"2026-12-01", ...})` is 31; start after end throws
    `CalendarRangeError("The start date is after the end date.")`.
- [ ] **Step 2:** `pnpm vitest run src/lib/graph/calendar.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement. Local midnight → UTC: find the zone's offset at that date with
  `Intl.DateTimeFormat(..., { timeZone, timeZoneName: "longOffset" })`, so DST days are right.
  Hours come from parsing the local `dateTime` strings as naive times (both in the same zone).
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit: `Read calendar events from Graph`.

### Task 3: Tally hours

**Files:**
- Create: `src/lib/chat/tally.ts`
- Test: `src/lib/chat/tally.test.ts`

**Interfaces:**
- Consumes: `RegisteredEvent` (Task 1).
- Produces:

```ts
export const GROWTH_CATEGORIES = ["personal-growth", "ingage-growth", "community-impact"] as const;
export type GrowthCategory = (typeof GROWTH_CATEGORIES)[number];
export type Assignment = { event: string; category: GrowthCategory | "not-sure" };
export class TallyError extends Error {} // message safe to show Claude
export interface TallyLine { date: string; category: GrowthCategory; hours: number; titles: string[] }
export interface Tally {
  lines: TallyLine[];
  totals: Record<GrowthCategory, number>;
  notSure: RegisteredEvent[];
  underQuarterHour: RegisteredEvent[];
  overlaps: Array<{ date: string; titles: [string, string] }>;
}
export function tallyHours(events: RegisteredEvent[], assignments: Assignment[]): Tally;
export function renderTally(tally: Tally): string;
```

- [ ] **Step 1: Write failing tests:**
  - Two personal-growth events on 2026-11-03 (1.5 h, 0.8 h) → one line, `hours 2.25`
    (2.3 rounded to nearest 0.25), titles in time order.
  - Lines sorted by date, then category in `GROWTH_CATEGORIES` order.
  - `totals` equal the sum of the rounded lines.
  - Registered events missing from `assignments` appear in `notSure`.
  - Unknown id `c99` → `TallyError("Unknown event ids: c99")`; same id twice →
    `TallyError("Assigned more than once: c2")`.
  - A 5-minute event alone in its line → no line; event listed in `underQuarterHour`.
  - Events overlapping in time on the same date (any category) appear in `overlaps`.
  - `renderTally` exact output for one line, totals, one not-sure event:

```text
2026-11-03 (Tue) | Personal Growth | 2.25 h | AWS study group; Tech talk
Totals: Personal Growth 2.25 h, Ingage Growth 0 h, Community Impact 0 h
Not sure: Team offsite planning (2026-11-05, 09:00-12:00, 3 h)
```

  (Lines for `underQuarterHour` and `overlaps` follow the same pattern:
  `Under a quarter hour, not counted: <title> (<date>)` and
  `Overlap on <date>: <title> and <title>`; omit sections that are empty.)
- [ ] **Step 2:** `pnpm vitest run src/lib/chat/tally.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Round with `Math.round(hours * 4) / 4`.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit: `Tally growth hours per day and category`.

### Task 4: Skill files

**Files:**
- Create: `src/lib/chat/skills.ts`, `skills/organize-growth-hours.md`
- Modify: `Dockerfile` (copy `skills/` next to `docs/knowledge`)
- Test: `src/lib/chat/skills.test.ts`

**Interfaces:**
- Produces:

```ts
export type ToolGroup = "m365";
export interface Skill { name: string; description: string; requires: ToolGroup[]; body: string }
export function parseSkill(fileName: string, text: string): Skill; // Error messages start `${fileName}: `
export function loadSkills(dir?: string): Skill[]; // default `${process.cwd()}/skills`, sorted by file name
export function chatSkills(): Skill[]; // loadSkills() cached, filtered by m365Enabled()
```

Frontmatter format (no YAML dependency; one `key: value` per line between `---` lines;
`requires` is `[a, b]` or `[]`):

```markdown
---
name: organize-growth-hours
description: Organize the user's calendar time for a period into Personal Growth, Ingage Growth, and Community Impact hours per day, for entering in QuickBooks.
requires: [m365]
---
```

- [ ] **Step 1: Write failing tests:**
  - Parses name, description, requires, and body (text after the closing `---`, trimmed).
  - Errors: no frontmatter; missing/empty `name` or `description`; name not kebab-case;
    unknown `requires` value; empty body. Each message starts with the file name.
  - `loadSkills` on a temp dir with two files: sorted by file name; duplicate names throw
    `"Duplicate skill name: <name> (a.md, b.md)"`; non-`.md` files ignored.
  - `chatSkills()` with `M365_TOOLS` unset omits `requires: [m365]` skills; with `enabled`
    includes them.
  - **Repo skills parse:** `loadSkills()` on the real `skills/` folder returns
    `organize-growth-hours` with `requires: ["m365"]`.
- [ ] **Step 2:** `pnpm vitest run src/lib/chat/skills.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `skills.ts`. Write `skills/organize-growth-hours.md` with the
  frontmatter above and these instructions (wording is yours, content is fixed):
  1. Work out the period from the question, `<today>`, and `<time_zone>`; if there's none,
     ask for one and stop.
  2. One `search_handbook` call for the definitions of Personal Growth, Ingage Growth, and
     Community Impact. If none are found, say so and stop; don't categorize without them.
  3. `list_calendar_events` for the period (split periods over 31 days, or ask).
  4. Assign each event a category from its title against those definitions. Client meetings
     and anything that doesn't clearly fit are `not-sure`. Never guess.
  5. On a follow-up correcting categories: list the same period again, keep each event's
     category from the earlier answer, apply the user's corrections, tally again.
  6. Call `tally_hours`; answer with its lines unchanged, then what was skipped (from the
     listing), the not-sure, under-a-quarter-hour, and overlap lines, and a sentence inviting
     corrections. Cite the handbook passages used. If times are in UTC because the browser
     sent no zone, say so.
- [ ] **Step 4:** Run the test. Expected: PASS. Add
  `COPY --from=builder --chown=nextjs:nodejs /app/skills ./skills` after the `docs/knowledge`
  line in `Dockerfile`.
- [ ] **Step 5:** Commit: `Load chat skills from Markdown files`.

### Task 5: Tools: `load_skill`, `list_calendar_events`, `tally_hours`

**Files:**
- Modify: `src/lib/chat/tools.ts`
- Create: `src/lib/chat/calendar-tools.ts` (the two calendar tools)
- Test: `src/lib/chat/tools.test.ts`, `src/lib/chat/calendar-tools.test.ts`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: `ChatToolDeps` gains `timeZone: string` and `skills: Skill[]`.
  `chatTools(deps)` returns `[search_handbook, load_skill (only if deps.skills non-empty),
  ...m365 tools, list_calendar_events, tally_hours]`, the last two only with `M365_TOOLS`.

Tool inputs:
- `load_skill`: `{ name: string }` (1-64 chars).
- `list_calendar_events`: `{ start: string; end: string }`, both `/^\d{4}-\d{2}-\d{2}$/`.
- `tally_hours`: `{ assignments: Array<{ event: string; category: enum }> }`, at most 200.

- [ ] **Step 1: Write failing tests:**
  - `load_skill` returns the skill body; an unknown name → `ToolError` listing available names
    (`"No skill named x. Available: organize-growth-hours"`).
  - `list_calendar_events` over 31 days → `ToolError("Ask for 31 days or fewer at a time.")`
    without calling Graph.
  - `list_calendar_events` passes `deps.timeZone`, registers events, and returns one line per
    event `c1 | 2026-11-03 09:00-10:30 | 1.5 h | AWS study group`, then
    `Skipped: 1 declined, 1 all-day, 0 cancelled, 0 marked free.`; no events →
    `"No events in that period."` plus the skipped line.
  - `CalendarRangeError` and `TallyError` reach Claude with their own message (not the generic
    "The search failed; try again.") and are not logged.
  - `tally_hours` returns `renderTally` output over `registry.events()`.
  - Event titles are escaped like other Microsoft 365 text (`<` → `&lt;`).
  - Tool list order and gating as in Produces.
- [ ] **Step 2:** `pnpm vitest run src/lib/chat/tools.test.ts src/lib/chat/calendar-tools.test.ts`.
  Expected: FAIL.
- [ ] **Step 3:** Implement. In `guarded`, rethrow `ToolError` unchanged; map
  `CalendarRangeError`/`TallyError` to `ToolError(err.message)` without logging.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `Add skill and calendar tools to the chat`.

### Task 6: Prompt, date, time zone, request

**Files:**
- Modify: `src/lib/chat/answer.ts`, `src/lib/validation.ts`, `src/app/api/chat/route.ts`,
  `src/app/ChatPanel.tsx`, `src/lib/chat-topics.ts`
- Test: `src/lib/chat/answer.test.ts`, `src/lib/validation.test.ts`,
  `src/app/api/chat/route.test.ts`, `src/lib/chat-history.test.ts`

**Interfaces:**
- Consumes: `Skill`, `chatSkills()` (Task 4); `ChatToolDeps` (Task 5).
- Produces:
  - `streamAnswer(args)` gains `today: string` (e.g. `"2026-11-20 (Friday)"`),
    `timeZone: string`, `timeZoneFromBrowser: boolean`, `skills: Skill[]`.
  - `export function systemPrompt(skills: Skill[]): string` in `answer.ts`.
  - `export function todayIn(timeZone: string, now: Date): string` in `answer.ts`.
  - `chatRequestSchema` gains optional `timeZone`.

- [ ] **Step 1: Write failing tests:**
  - `systemPrompt([])` has no Skills section; with a skill it contains
    `"- organize-growth-hours: <description>"` and the rule to call `load_skill` first;
    identical input gives identical output.
  - Last user message is `<today>2026-11-20 (Friday)</today>\n<time_zone>America/New_York</time_zone>\n<question>\n…\n</question>`;
    without a browser zone the tag reads `UTC (the browser sent no time zone)`.
  - `todayIn("America/New_York", new Date("2026-11-21T03:00:00Z"))` is `"2026-11-20 (Friday)"`.
  - Runner gets `max_iterations: 10`.
  - Schema: `"America/New_York"` and `"UTC"` accepted; `"Mars/Base"` → 400 with
    `"Unknown time zone"`; missing is fine.
  - Route passes `timeZone` (or `"UTC"`, `timeZoneFromBrowser: false`) to tools and answer.
  - `CHAT_TURN_TEXT_MAX` is 8000 (existing history tests keep passing against the constant).
- [ ] **Step 2:** Run those test files. Expected: FAIL.
- [ ] **Step 3:** Implement. System prompt rules to add: call `load_skill` first when a question
  matches a skill and follow it; the existing rules still apply; mention the calendar tools
  among the Microsoft 365 tools. `ChatPanel` sends
  `timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone`. The work topic description
  becomes `"your clients, projects, files, mail, Teams messages, and calendar, including organizing your growth hours."`
- [ ] **Step 4:** Run the tests, then `pnpm test` and `pnpm typecheck`. Expected: PASS, no errors.
- [ ] **Step 5:** Commit: `Send date, time zone, and skills to the chat answer`.

### Task 7: Eval cases, sample handbook, docs

**Files:**
- Modify: `src/eval/cases.ts`, `src/eval/run.ts`, `src/eval/m365-fixtures.ts`,
  `evals/m365.jsonl`, `docs/dev/sample-handbook.md`, `CLAUDE.md`, `README.md`,
  `docs/superpowers/specs/2026-11-20-chat-skills-growth-hours-design.md`
- Test: `src/eval/cases.test.ts`, `src/eval/m365-fixtures.test.ts` (create if absent)

- [ ] **Step 1: Write failing tests:**
  - A case may carry `history` (same shape as `ChatTurn[]`, at most `CHAT_HISTORY_MAX_TURNS`).
  - `m365FixtureFetch` answers `/me/calendarView` for 2026-11-09..2026-11-13 with the fixture
    week below and an empty list for other weeks.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Fixture week (`America/New_York`): AWS study group (Tue 1.5 h),
  Lunch and learn: testing (Wed 1 h), Onboarding Experience Team (Thu 1 h), Food bank
  volunteering (Fri 3 h), Acme sprint review (Tue 1 h, client), Team offsite planning (Thu
  3 h, ambiguous), one declined, one all-day PTO, one cancelled. Eval runs use
  `today "2026-11-20 (Friday)"`, `timeZone "America/New_York"`, and the case's `history`.
  Add cases: last week's hours (facts: each pillar line and total; Acme sprint review and Team
  offsite planning under Not sure); a week with no events (`dont-know`-free answer saying none
  found); a correction follow-up moving Team offsite planning to Ingage Growth (history holds
  the first answer). Add a "Growth Pillars" section to the sample handbook with made-up
  definitions of the three pillars (marked as invented, like the rest of the file).
  Update CLAUDE.md (skills, calendar tools, tally) and README (skills folder, sign-in again
  after `Calendars.Read`). In the spec, replace "Markdown table" with the plain-line format
  from Task 3.
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck`, `pnpm lint`. Expected: PASS, clean.
- [ ] **Step 5:** Commit: `Add growth-hours eval cases and docs`.
- [ ] **Step 6 (manual, costs money; ask first):** ingest the sample handbook, then
  `M365_TOOLS=enabled pnpm eval --cases evals/m365.jsonl`. Merge bar: both ambiguous events
  land in Not sure in every case; report category accuracy.
