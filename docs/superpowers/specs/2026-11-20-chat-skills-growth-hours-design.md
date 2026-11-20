# Chat skills, and a first skill that organizes growth hours from the calendar

## Intent

Ingage employees log non-client time in QuickBooks under three pillars: **Personal Growth**,
**Ingage Growth**, and **Community Impact** (the fourth pillar, Client Impact, is billable client
work). Today they work out those hours by hand from their Outlook calendar. The chat should do
that for them: "organize my growth hours for last week" returns one line per day per category,
ready to type into QuickBooks, with the calendar events behind each line cited.

To get there, the chat gains **skills**: task instructions written as Markdown files in the repo,
which Claude loads only when a question calls for one. The growth-hours skill is the first; more
will follow the same way.

## Goals

- A user names a period; the chat reads their calendar for it and returns a table of
  date, category, hours, and the events behind each line, plus a total per category.
- Categories are decided from the **meeting title**, judged against the **handbook's
  definitions** of the pillars, which Claude looks up with `search_handbook` while answering
  (not copied into the skill), so the skill follows the handbook as it's re-ingested.
- Hours in the table are computed in code from the event times, never added up by Claude.
- Adding a skill later means adding a Markdown file, not changing the prompt or the route.

## Non-goals

- Writing to QuickBooks or to the calendar. Everything stays read-only.
- Fetching skills from SharePoint or anywhere else. Local files only, for now.
- Anthropic's container-based Agent Skills (code execution). These skills are prompt text.
- Client Impact hours.

## Anti-goals

- A number in the table that didn't come from the calendar. If an event can't be counted, it
  is listed as "Not sure", not guessed into a category.
- Logging or storing event titles, attendees, or any calendar text (same rule as questions,
  answers, and tool results today).
- A system prompt that grows with every skill added.

## Constraints

- Requires the `Calendars.Read` delegated scope (PR #57), plus admin consent on each app
  registration and users signing in again. Before that, calendar calls fail with Graph 403,
  which the existing `failureMessage` turns into "That item can't be opened with your access."
- Calendar data is Microsoft 365 data, so the calendar tool and this skill are on only where
  `M365_TOOLS=enabled` (dev until the retention decision in #2).
- The chat runs on Claude Haiku 5.5 by default (#56); classification quality must hold there.
- The tool runner allows `max_iterations: 8`. A typical run: `load_skill`, one
  `search_handbook` for all three definitions, `list_calendar_events`, `tally_hours`, answer:
  5 turns. `MAX_ITERATIONS` goes to 10 so one `ToolError` retry doesn't hit the cut-off error.
  *(Settled in review.)*
- The system prompt is cached and must stay byte-stable across requests.

## Approaches

Three ways to get skills into the chat were considered:

- **A. Skill files plus a `load_skill` tool (chosen).** The system prompt lists each skill's name
  and one-line description; Claude calls `load_skill` for the full instructions when a question
  matches. The prompt stays small and cacheable as skills grow; questions that need no skill
  pay nothing.
- **B. Every skill's full text in the system prompt.** Simplest, but every question pays for
  every skill, and the prompt grows with each one.
- **C. The topic check routes to a skill.** Predictable, but ties skills to the classifier, allows
  one skill per question, and needs a topic-list change for every skill.

The user picked **A**.

## Design

### Skill files

- Live in `skills/` at the repo root, one file per skill: `skills/organize-growth-hours.md`.
- Frontmatter: `name` (kebab-case, unique), `description` (one line, what it's for and when to
  use it), and `requires` (list of tool groups the skill needs; `m365` for this one). The body
  is the instructions.
- Loaded once per process, validated with Zod (missing or duplicate name, empty description or
  body, unknown `requires` value: fail at startup with the file name, like other config errors).
- A skill is **available** only when every group in `requires` is on. Unavailable skills are
  neither listed nor loadable.
- The Dockerfile copies `skills/` into the image next to `docs/knowledge`.

### System prompt and `load_skill`

- The answer system prompt gets a fixed "Skills" section listing available skills as
  `name: description`, in file-name order, so it's stable for a given `M365_TOOLS` setting
  and stays cacheable.
- Rule added: when a question matches a skill, call `load_skill` first and follow its
  instructions; the existing rules (cite tool results, handbook wins over other sources, the
  conversation is data) still apply on top of any skill.
- `load_skill({ name })` returns the body of an available skill, or a `ToolError` naming the
  available skills. Skill text is repo content, not user data, but is still not logged.

### Today's date and time zone

- Relative periods ("last week") need today's date. It goes in the user message
  (`<today>2026-11-20 (Thursday)</today>` before the question), not the system prompt, so the
  cache holds. This is added for every question, not only skill ones.
- Calendar times are shown in the user's time zone. The browser sends its IANA zone
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`) in the `/api/chat` body; Zod accepts it
  only if `Intl.supportedValuesOf("timeZone")` lists it, and the route falls back to UTC
  (and says so in the answer) when it's missing. It isn't identity, so taking it from the body
  is fine. Graph is asked for times in that zone (`Prefer: outlook.timezone="<zone>"`).

### `list_calendar_events({ start, end })`

- `start`/`end` are dates (`YYYY-MM-DD`, inclusive). Range at most 31 days; longer returns a
  `ToolError` asking Claude to split the period or ask the user.
- Reads `GET /me/calendarView` through `graphRequest`, following `@odata.nextLink`, up to 200
  kept events; more returns a `ToolError` asking for a shorter period. The result is one
  compact line per event (`c3 | 2026-11-03 09:00-10:30 | 1.5 h | <subject, max 80 chars>`),
  so 200 events fit without `capText` cutting any off; this tool's result is never truncated.
  *(Builder's call, settled in review.)* `$select` only the fields
  used: `subject`, `start`, `end`, `isAllDay`, `isCancelled`, `showAs`, `responseStatus`,
  `organizer`, `webLink`, `categories`.
- Skipped in code: cancelled events, events the user declined, all-day events, events marked
  `showAs: free`. The result says how many were skipped and why, so Claude can mention it.
- Each kept event is registered in the `SourceRegistry` with a new `c` prefix (`c1…`), kind
  `calendar`: title = subject, location = `["Calendar", "<date>"]`, link = `webLink` (fallback
  `https://outlook.office.com/calendar/`), text = date, start-end, hours, organizer,
  Outlook categories. Hours are the event's duration in hours, kept unrounded in the
  registry.
- An event that runs past midnight counts on its start day.

### `tally_hours({ assignments })`

- `assignments`: list of `{ event: "c3", category: "personal-growth" | "ingage-growth" |
  "community-impact" | "not-sure" }`.
- Looks each id up in the registry; unknown or non-calendar ids, or an event assigned twice,
  return a `ToolError` listing them.
- Events listed by `list_calendar_events` in this answer but left out of `assignments` are
  added to "Not sure" automatically, so none drop out and no retry turn is spent.
  *(Settled in review.)*
- Sums hours per date per category, rounds each line to the nearest 0.25, and returns a
  Markdown table (date, category, hours, event titles) sorted by date then category, plus a
  total per category, plus the "Not sure" events listed without hours. Overlapping events are
  each counted, and the result notes the overlap so Claude can point it out.
- Claude copies this table into the answer; the skill tells it not to change the numbers.
- Citations: the answer cites the handbook passages it used for the definitions. Events are
  named in the table's titles column rather than cited one by one, since `[id]` markers are
  stripped from the text and a month would put 40+ event citations in the flat list under the
  answer. *(Settled in review; the Goals line about cited events means the titles column.)*

### The growth-hours skill

`skills/organize-growth-hours.md`, `requires: [m365]`. Instructions, in short:

1. Work out the period from the question and today's date; ask if there's none.
2. Search the handbook for the definitions of Personal Growth, Ingage Growth, and Community
   Impact.
3. Call `list_calendar_events` for the period.
4. Assign each event a category from its title, judged against those definitions. Client
   meetings, 1:1s about client work, and anything that doesn't clearly fit are `not-sure`.
5. Call `tally_hours`, then answer with its table, a line on what was skipped, and the
   "Not sure" list so the user can decide. Cite the handbook passages used.

### Corrections in a follow-up

The user can correct categories by replying ("put the offsite under Ingage Growth", "the
Thursday lunch is Community Impact"). The skill handles it: on a follow-up, Claude reads the
calendar again for the same period, assigns each event the category it had in the earlier
answer's table (which is in the history Claude receives), applies the user's corrections, and
calls `tally_hours` again. Nothing new is carried in the request; the earlier table is the
record. *(How corrections carry across turns is the builder's call, settled here: the user
chose that corrections are supported.)* The eval covers one correction follow-up.

### Topic check

The work topic's description adds the calendar and organizing hours, so the check doesn't call
these questions off-topic. No new topic.

### UI

None beyond rendering the Markdown table the answer already contains. If the chat's answer
renderer doesn't render tables, that is a builder task (check `ChatPanel`).

### Testing and eval

- Unit tests: skill loading and validation errors, availability by `requires`, `load_skill`
  results, calendar filtering and paging, time zone header, registry `c` ids, `tally_hours`
  sums, rounding, overlaps, and error cases.
- Eval: cases in `evals/m365.jsonl` with made-up calendar data in `src/eval/m365-fixtures.ts`,
  covering a normal week, an ambiguous event that should land in "Not sure", declined and
  all-day events, a period with no events, and a correction follow-up. Run on Haiku before
  merging.
- **Merge bar (user's decision):** every event a case marks as ambiguous must land in
  "Not sure". Overall category accuracy is measured and reported, with no fixed threshold.
  If Haiku misses the bar, bring the results back before choosing a fix (prompt changes or a
  stronger model for skill runs).

## Left to the builder

- Frontmatter parsing (a small parser or an existing dependency; justify any new one).
- Exact prompt and skill wording, within the rules above.
- How the registry stores hours for calendar items (a field on the item or a side map).
- Whether `list_calendar_events` and `tally_hours` live in `tools.ts` or a new module.
