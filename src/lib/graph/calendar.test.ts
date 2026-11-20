import { describe, expect, it, vi } from "vitest";
import { CalendarRangeError, listCalendarEvents, rangeDays } from "@/lib/graph/calendar";
import { GRAPH_BASE } from "@/lib/graph/client";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

type GraphEvent = Record<string, unknown>;

function graphEvent(id: string, overrides: GraphEvent = {}): GraphEvent {
  return {
    id,
    subject: "AWS study group",
    start: { dateTime: "2026-11-03T09:00:00.0000000", timeZone: "America/New_York" },
    end: { dateTime: "2026-11-03T10:30:00.0000000", timeZone: "America/New_York" },
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    responseStatus: { response: "accepted" },
    organizer: { emailAddress: { name: "Jane Doe", address: "jane@example.test" } },
    categories: [],
    ...overrides,
  };
}

function fetchPages(...pages: unknown[]) {
  let call = 0;
  return vi.fn(async (_url: string, _init: RequestInit) => json(pages[call++]));
}

const RANGE = { start: "2026-11-03", end: "2026-11-04", timeZone: "America/New_York" };

describe("listCalendarEvents", () => {
  it("asks for the user's local days as UTC instants", async () => {
    const fetchFn = fetchPages({ value: [] });
    await listCalendarEvents(RANGE, "tok", fetchFn);
    const url = new URL(fetchFn.mock.calls[0]?.[0] ?? "");
    expect(url.pathname).toBe("/v1.0/me/calendarView");
    expect(url.searchParams.get("startDateTime")).toBe("2026-11-03T05:00:00.000Z");
    expect(url.searchParams.get("endDateTime")).toBe("2026-11-05T05:00:00.000Z");
    expect(url.searchParams.get("$select")).toBe(
      "subject,start,end,isAllDay,isCancelled,showAs,responseStatus,organizer,categories",
    );
    expect(url.searchParams.get("$top")).toBe("100");
    expect(url.searchParams.get("$orderby")).toBe("start/dateTime");
  });

  it("uses the offset in force on the start day across a DST change", async () => {
    const fetchFn = fetchPages({ value: [] });
    await listCalendarEvents(
      { start: "2026-10-31", end: "2026-11-01", timeZone: "America/New_York" },
      "tok",
      fetchFn,
    );
    const url = new URL(fetchFn.mock.calls[0]?.[0] ?? "");
    expect(url.searchParams.get("startDateTime")).toBe("2026-10-31T04:00:00.000Z");
    expect(url.searchParams.get("endDateTime")).toBe("2026-11-02T05:00:00.000Z");
  });

  it("follows nextLink and sends the time zone on every page", async () => {
    const next = `${GRAPH_BASE}/me/calendarView?$skiptoken=abc`;
    const fetchFn = fetchPages(
      { value: [graphEvent("e1")], "@odata.nextLink": next },
      { value: [graphEvent("e2")] },
    );
    const listing = await listCalendarEvents(RANGE, "tok", fetchFn);
    expect(listing.events.map((e) => e.graphId)).toEqual(["e1", "e2"]);
    expect(fetchFn.mock.calls[1]?.[0]).toBe(next);
    for (const [, init] of fetchFn.mock.calls) {
      expect(new Headers(init.headers).get("prefer")).toBe('outlook.timezone="America/New_York"');
    }
  });

  it("maps local times to date, start, end, and hours", async () => {
    const fetchFn = fetchPages({ value: [graphEvent("e1", { categories: ["Learning"] })] });
    const { events } = await listCalendarEvents(RANGE, "tok", fetchFn);
    expect(events[0]).toEqual({
      graphId: "e1",
      title: "AWS study group",
      date: "2026-11-03",
      start: "09:00",
      end: "10:30",
      hours: 1.5,
      organizer: "Jane Doe",
      categories: ["Learning"],
    });
  });

  it("counts an event past midnight on its start day", async () => {
    const late = graphEvent("e1", {
      start: { dateTime: "2026-11-03T23:30:00.0000000" },
      end: { dateTime: "2026-11-04T00:30:00.0000000" },
    });
    const { events } = await listCalendarEvents(RANGE, "tok", fetchPages({ value: [late] }));
    expect(events[0]).toMatchObject({ date: "2026-11-03", start: "23:30", end: "00:30", hours: 1 });
  });

  it("leaves out events that start before the period", async () => {
    const early = graphEvent("early", {
      start: { dateTime: "2026-11-02T23:00:00.0000000" },
      end: { dateTime: "2026-11-03T01:00:00.0000000" },
    });
    const { events } = await listCalendarEvents(
      RANGE,
      "tok",
      fetchPages({ value: [early, graphEvent("e1")] }),
    );
    expect(events.map((e) => e.graphId)).toEqual(["e1"]);
  });

  it("skips and counts cancelled, declined, all-day, and free events", async () => {
    const fetchFn = fetchPages({
      value: [
        graphEvent("keep"),
        graphEvent("c", { isCancelled: true }),
        graphEvent("d", { responseStatus: { response: "declined" } }),
        graphEvent("a", { isAllDay: true }),
        graphEvent("f", { showAs: "free" }),
      ],
    });
    const listing = await listCalendarEvents(RANGE, "tok", fetchFn);
    expect(listing.events.map((e) => e.graphId)).toEqual(["keep"]);
    expect(listing.skipped).toEqual({ cancelled: 1, declined: 1, allDay: 1, free: 1 });
  });

  it("names untitled events and shortens long titles to 80 characters", async () => {
    const fetchFn = fetchPages({
      value: [graphEvent("e1", { subject: "" }), graphEvent("e2", { subject: "x".repeat(120) })],
    });
    const { events } = await listCalendarEvents(RANGE, "tok", fetchFn);
    expect(events[0]?.title).toBe("(no title)");
    expect(events[1]?.title).toHaveLength(80);
  });

  it("refuses more than 200 kept events", async () => {
    const many = Array.from({ length: 201 }, (_, i) => graphEvent(`e${i}`));
    const fetchFn = fetchPages({ value: many });
    await expect(listCalendarEvents(RANGE, "tok", fetchFn)).rejects.toThrow(
      new CalendarRangeError("More than 200 events in that period; ask for a shorter one."),
    );
  });
});

describe("rangeDays", () => {
  it("counts both ends", () => {
    expect(rangeDays({ start: "2026-11-01", end: "2026-12-01", timeZone: "UTC" })).toBe(31);
    expect(rangeDays({ start: "2026-11-03", end: "2026-11-03", timeZone: "UTC" })).toBe(1);
  });

  it("rejects a start after the end", () => {
    expect(() => rangeDays({ start: "2026-11-05", end: "2026-11-03", timeZone: "UTC" })).toThrow(
      new CalendarRangeError("The start date is after the end date."),
    );
  });
});
