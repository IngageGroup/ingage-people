import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarTools } from "@/lib/chat/calendar-tools";
import { SourceRegistry } from "@/lib/chat/sources";

function graphEvent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    subject: "AWS study group",
    start: { dateTime: "2026-11-03T09:00:00.0000000" },
    end: { dateTime: "2026-11-03T10:30:00.0000000" },
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    responseStatus: { response: "accepted" },
    organizer: { emailAddress: { name: "Jane Doe" } },
    categories: [],
    ...overrides,
  };
}

function setup(events: unknown[] = [graphEvent("e1")]) {
  const registry = new SourceRegistry();
  const fetchFn = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ value: events }), { status: 200 }),
  );
  const tools = calendarTools({
    registry,
    timeZone: "America/New_York",
    graphToken: async () => "user-token",
    fetchFn,
  });
  const run = (name: string, input: unknown) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return Promise.resolve((tool.run as (args: unknown) => unknown)(input));
  };
  return { registry, fetchFn, tools, run };
}

afterEach(() => vi.restoreAllMocks());

describe("list_calendar_events", () => {
  it("lists one line per event in the user's time zone", async () => {
    const { run, fetchFn, registry } = setup([
      graphEvent("e1"),
      graphEvent("d", { responseStatus: { response: "declined" } }),
      graphEvent("a", { isAllDay: true }),
    ]);
    const result = await run("list_calendar_events", { start: "2026-11-03", end: "2026-11-07" });
    expect(result).toBe(
      [
        "c1 | 2026-11-03 09:00-10:30 | 1.5 h | AWS study group",
        "Skipped: 1 declined, 1 all-day, 0 cancelled, 0 marked free.",
      ].join("\n"),
    );
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("prefer")).toBe('outlook.timezone="America/New_York"');
    expect(registry.events().map((e) => e.id)).toEqual(["c1"]);
  });

  it("adds the event's Outlook categories when it has any", async () => {
    const { run } = setup([graphEvent("e1", { categories: ["Learning", "Training"] })]);
    const result = await run("list_calendar_events", { start: "2026-11-03", end: "2026-11-03" });
    expect(result).toContain(
      "c1 | 2026-11-03 09:00-10:30 | 1.5 h | AWS study group | Outlook categories: Learning, Training",
    );
  });

  it("escapes event titles like other Microsoft 365 text", async () => {
    const { run } = setup([graphEvent("e1", { subject: "<b>Sync</b> & plan" })]);
    const result = await run("list_calendar_events", { start: "2026-11-03", end: "2026-11-03" });
    expect(result).toContain("&lt;b&gt;Sync&lt;/b&gt; &amp; plan");
  });

  it("says when the period has no events", async () => {
    const { run } = setup([]);
    const result = await run("list_calendar_events", { start: "2026-11-03", end: "2026-11-03" });
    expect(result).toBe(
      "No events in that period.\nSkipped: 0 declined, 0 all-day, 0 cancelled, 0 marked free.",
    );
  });

  it("refuses more than 31 days without calling Graph", async () => {
    const { run, fetchFn } = setup();
    const error = await run("list_calendar_events", { start: "2026-11-01", end: "2026-12-02" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).content).toBe("Ask for 31 days or fewer at a time.");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns range errors to Claude as they are, without logging", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = setup();
    const error = await run("list_calendar_events", { start: "2026-11-05", end: "2026-11-03" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect((error as ToolError).content).toBe("The start date is after the end date.");
    expect(log).not.toHaveBeenCalled();
  });
});

describe("tally_hours", () => {
  it("tallies the events listed in this answer", async () => {
    const { run } = setup();
    await run("list_calendar_events", { start: "2026-11-03", end: "2026-11-03" });
    const result = await run("tally_hours", {
      assignments: [{ event: "c1", category: "personal-growth" }],
    });
    expect(result).toContain("2026-11-03 (Tue) | Personal Growth | 1.5 h | AWS study group");
  });

  it("returns tally errors to Claude as they are, without logging", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = setup();
    const error = await run("tally_hours", {
      assignments: [{ event: "c9", category: "ingage-growth" }],
    })
      .then(() => null)
      .catch((e: unknown) => e);
    expect((error as ToolError).content).toBe("Unknown event ids: c9");
    expect(log).not.toHaveBeenCalled();
  });
});
