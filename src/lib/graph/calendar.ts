import { type FetchFn, GRAPH_BASE, graphJson } from "@/lib/graph/client";

/** A calendar event as the chat's calendar tool returns it, in the user's time zone. */
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

export const CALENDAR_MAX_DAYS = 31;
export const CALENDAR_MAX_EVENTS = 200;
const TITLE_MAX = 80;
const DAY_MS = 86_400_000;
const SELECT = "subject,start,end,isAllDay,isCancelled,showAs,responseStatus,organizer,categories";

/** Dates are inclusive, YYYY-MM-DD, in `timeZone` (IANA). */
export interface CalendarRange {
  start: string;
  end: string;
  timeZone: string;
}

export interface CalendarListing {
  events: CalendarEvent[];
  skipped: { cancelled: number; declined: number; allDay: number; free: number };
}

/** A problem with the requested period; the message is safe to show Claude. */
export class CalendarRangeError extends Error {
  override name = "CalendarRangeError";
}

interface GraphDateTime {
  dateTime?: string;
}

interface GraphEvent {
  id?: string;
  subject?: string;
  start?: GraphDateTime;
  end?: GraphDateTime;
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  responseStatus?: { response?: string };
  organizer?: { emailAddress?: { name?: string } };
  categories?: string[];
}

interface GraphPage {
  value?: GraphEvent[];
  "@odata.nextLink"?: string;
}

function dateMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function rangeDays(range: CalendarRange): number {
  const days = (dateMs(range.end) - dateMs(range.start)) / DAY_MS + 1;
  if (days < 1) throw new CalendarRangeError("The start date is after the end date.");
  return days;
}

/** Minutes the zone is ahead of UTC at `instant` (negative west of Greenwich). */
function offsetMinutes(timeZone: string, instant: number): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? "");
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/** The UTC instant of local midnight starting `date` in `timeZone`. */
function localMidnight(date: string, timeZone: string): string {
  const wall = dateMs(date);
  let instant = wall - offsetMinutes(timeZone, wall) * 60_000;
  instant = wall - offsetMinutes(timeZone, instant) * 60_000;
  return new Date(instant).toISOString();
}

function nextDate(date: string): string {
  return new Date(dateMs(date) + DAY_MS).toISOString().slice(0, 10);
}

/** Graph's local `dateTime` (no offset) read as wall-clock time. */
function wallMs(dateTime: string): number {
  return Date.parse(`${dateTime.slice(0, 19)}Z`);
}

function toEvent(event: GraphEvent): CalendarEvent {
  const start = event.start?.dateTime ?? "";
  const end = event.end?.dateTime ?? "";
  return {
    graphId: event.id ?? "",
    title: (event.subject?.trim() || "(no title)").slice(0, TITLE_MAX),
    date: start.slice(0, 10),
    start: start.slice(11, 16),
    end: end.slice(11, 16),
    hours: (wallMs(end) - wallMs(start)) / 3_600_000,
    organizer: event.organizer?.emailAddress?.name ?? "",
    categories: event.categories ?? [],
  };
}

function skipReason(event: GraphEvent): keyof CalendarListing["skipped"] | null {
  if (event.isCancelled) return "cancelled";
  if (event.responseStatus?.response === "declined") return "declined";
  if (event.isAllDay) return "allDay";
  if (event.showAs === "free") return "free";
  return null;
}

/**
 * The user's calendar events for the period, in their time zone, without cancelled,
 * declined, all-day, or free events (counted in `skipped`).
 */
export async function listCalendarEvents(
  range: CalendarRange,
  token: string,
  fetchFn?: FetchFn,
): Promise<CalendarListing> {
  const query = new URLSearchParams({
    startDateTime: localMidnight(range.start, range.timeZone),
    endDateTime: localMidnight(nextDate(range.end), range.timeZone),
    $select: SELECT,
    $top: "100",
    $orderby: "start/dateTime",
  });
  const options = {
    token,
    headers: { Prefer: `outlook.timezone="${range.timeZone}"` },
    ...(fetchFn ? { fetchFn } : {}),
  };
  const listing: CalendarListing = {
    events: [],
    skipped: { cancelled: 0, declined: 0, allDay: 0, free: 0 },
  };
  let path: string | undefined = `/me/calendarView?${query}`;
  while (path) {
    const page: GraphPage = await graphJson<GraphPage>(path, options);
    for (const event of page.value ?? []) {
      const reason = skipReason(event);
      if (reason) listing.skipped[reason] += 1;
      else listing.events.push(toEvent(event));
    }
    if (listing.events.length > CALENDAR_MAX_EVENTS) {
      throw new CalendarRangeError(
        `More than ${CALENDAR_MAX_EVENTS} events in that period; ask for a shorter one.`,
      );
    }
    const next = page["@odata.nextLink"];
    path = next?.startsWith(GRAPH_BASE) ? next.slice(GRAPH_BASE.length) : undefined;
  }
  return listing;
}
