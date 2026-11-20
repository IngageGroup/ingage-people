import { describe, expect, it } from "vitest";
import { M365_FIXTURE_TOKEN, m365FixtureFetch } from "@/eval/m365-fixtures";
import { listCalendarEvents } from "@/lib/graph/calendar";
import { readMail, searchMail } from "@/lib/graph/mail";
import { readTeamsThread, searchTeams } from "@/lib/graph/teams";

describe("m365FixtureFetch", () => {
  const week = { start: "2026-11-09", end: "2026-11-13", timeZone: "America/New_York" };

  it("serves the fixture calendar week, skipping declined, all-day, and cancelled events", async () => {
    const listing = await listCalendarEvents(week, M365_FIXTURE_TOKEN, m365FixtureFetch);
    expect(listing.events.map((e) => `${e.date} ${e.title} ${e.hours}`)).toEqual([
      "2026-11-10 Acme sprint review 1",
      "2026-11-10 AWS study group 1.5",
      "2026-11-11 Lunch and learn: testing 1",
      "2026-11-12 Onboarding Experience Team 1",
      "2026-11-12 Team offsite planning 3",
      "2026-11-13 Food bank volunteering 3",
    ]);
    expect(listing.skipped).toEqual({ cancelled: 1, declined: 1, allDay: 1, free: 0 });
  });

  it("has no events in other weeks", async () => {
    const other = { ...week, start: "2026-11-16", end: "2026-11-20" };
    const listing = await listCalendarEvents(other, M365_FIXTURE_TOKEN, m365FixtureFetch);
    expect(listing.events).toEqual([]);
  });

  it("finds the Acme deadline chat and reads it", async () => {
    const [hit] = await searchTeams("Acme go-live deadline", M365_FIXTURE_TOKEN, m365FixtureFetch);
    expect(hit?.ref).toBe("chat:19:acme-fixture@thread.v2");
    const thread = await readTeamsThread(hit?.ref ?? "", M365_FIXTURE_TOKEN, m365FixtureFetch);
    expect(thread.text).toContain("December 12");
  });

  it("finds and reads the budget mail", async () => {
    const hits = await searchMail("training spend cap", M365_FIXTURE_TOKEN, m365FixtureFetch);
    expect(hits.map((h) => h.title)).toContain("Q1 training budget");
    const mail = await readMail("msg-budget", M365_FIXTURE_TOKEN, m365FixtureFetch);
    expect(mail.text).toContain("$4,000");
  });

  it("returns no hits for words no fixture contains", async () => {
    expect(await searchTeams("Globex invoice", M365_FIXTURE_TOKEN, m365FixtureFetch)).toEqual([]);
  });

  it("answers 404 for an item that doesn't exist", async () => {
    await expect(readMail("nope", M365_FIXTURE_TOKEN, m365FixtureFetch)).rejects.toMatchObject({
      failure: "not-found",
    });
  });

  it("refuses any token but the fixture token", async () => {
    await expect(searchMail("budget", "real-user-token", m365FixtureFetch)).rejects.toMatchObject({
      failure: "unauthorized",
    });
  });
});
