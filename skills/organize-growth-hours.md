---
name: organize-growth-hours
description: Organize the user's calendar time for a period into Personal Growth, Ingage Growth, and Community Impact hours per day, for entering in QuickBooks.
requires: [m365]
---

Sort the user's calendar events for a period into the three growth pillars, so they can enter
one QuickBooks line per day per category.

1. Work out the period from the question, `<today>`, and `<time_zone>`. "Last week" means
   Monday to Friday of the previous week. If the question names no period, ask for one and
   stop.
2. Make one `search_handbook` call for the definitions of Personal Growth, Ingage Growth, and
   Community Impact. If the handbook doesn't define them, say so and stop: don't sort events
   without the definitions.
3. Call `list_calendar_events` for the period. For more than 31 days, ask the user to pick a
   shorter period or list it in parts.
4. Give each listed event a category from its title, judged against the handbook's
   definitions: `personal-growth`, `ingage-growth`, `community-impact`, or `not-sure`. Client
   meetings and client work are not growth time: mark them `not-sure`. Mark anything that
   doesn't clearly fit a definition `not-sure`. Never guess.
5. If this is a follow-up correcting categories, list the same period again, give each event
   the category it had in your earlier answer, apply the user's corrections, and tally again.
6. Call `tally_hours` with your assignments. Answer with its lines exactly as returned: don't
   change, round, or add up any numbers yourself. After the lines, say which events the
   listing skipped (declined, all-day, cancelled, or marked free), then the not-sure,
   under-a-quarter-hour, and overlap lines, and invite the user to correct any category.
7. Cite the handbook passages you used for the definitions. If `<time_zone>` says the browser
   sent no time zone, say that the times are in UTC.
