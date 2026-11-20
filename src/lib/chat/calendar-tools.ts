import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { z } from "zod";
import { escapeText, type RegisteredEvent, type SourceRegistry } from "@/lib/chat/sources";
import { GROWTH_CATEGORIES, renderTally, tallyHours } from "@/lib/chat/tally";
import { guarded } from "@/lib/chat/tool-guard";
import {
  CALENDAR_MAX_DAYS,
  CALENDAR_MAX_EVENTS,
  type CalendarListing,
  listCalendarEvents,
  rangeDays,
} from "@/lib/graph/calendar";
import type { FetchFn } from "@/lib/graph/client";

export interface CalendarToolDeps {
  registry: SourceRegistry;
  /** IANA zone the user's calendar is read in. */
  timeZone: string;
  graphToken: () => Promise<string>;
  fetchFn?: FetchFn;
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const rangeInput = z.object({
  start: date.describe("First day of the period, YYYY-MM-DD, in the user's time zone."),
  end: date.describe("Last day of the period (inclusive), YYYY-MM-DD."),
});

const tallyInput = z.object({
  assignments: z
    .array(
      z.object({
        event: z
          .string()
          .min(1)
          .max(10)
          .describe("An event id from list_calendar_events, e.g. c3."),
        category: z.enum([...GROWTH_CATEGORIES, "not-sure"]),
      }),
    )
    .max(CALENDAR_MAX_EVENTS),
});

function hoursText(hours: number): string {
  return `${Number(hours.toFixed(2))} h`;
}

function eventLine(event: RegisteredEvent): string {
  const parts = [
    event.id,
    `${event.date} ${event.start}-${event.end}`,
    hoursText(event.hours),
    escapeText(event.title),
  ];
  if (event.categories.length) {
    parts.push(`Outlook categories: ${escapeText(event.categories.join(", "))}`);
  }
  return parts.join(" | ");
}

function skippedLine({ skipped }: CalendarListing): string {
  return `Skipped: ${skipped.declined} declined, ${skipped.allDay} all-day, ${skipped.cancelled} cancelled, ${skipped.free} marked free.`;
}

/** `list_calendar_events` and `tally_hours`, for the growth-hours skill. */
export function calendarTools(deps: CalendarToolDeps) {
  return [
    betaZodTool({
      name: "list_calendar_events",
      description:
        "List the user's own calendar events for a period of up to 31 days, in their time zone, without declined, cancelled, all-day, or free events. Returns one line per event with an id for tally_hours.",
      inputSchema: rangeInput,
      run: ({ start, end }) =>
        guarded("list_calendar_events", async () => {
          const range = { start, end, timeZone: deps.timeZone };
          if (rangeDays(range) > CALENDAR_MAX_DAYS) {
            throw new ToolError(`Ask for ${CALENDAR_MAX_DAYS} days or fewer at a time.`);
          }
          const listing = await listCalendarEvents(range, await deps.graphToken(), deps.fetchFn);
          const events = deps.registry.addEvents(listing.events);
          const lines = events.length ? events.map(eventLine) : ["No events in that period."];
          return [...lines, skippedLine(listing)].join("\n");
        }),
    }),
    betaZodTool({
      name: "tally_hours",
      description:
        "Add up hours per day per category for the events list_calendar_events returned in this answer. Pass a category for each event; events left out count as not sure. Returns the lines to show the user unchanged.",
      inputSchema: tallyInput,
      run: ({ assignments }) =>
        guarded("tally_hours", async () =>
          renderTally(tallyHours(deps.registry.events(), assignments)),
        ),
    }),
  ];
}
