import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTimeZone } from "@/lib/chat/time-zone";
import { GraphTokenError } from "@/lib/graph-token";

function outlookSays(value: string, status = 200) {
  return vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(status === 200 ? { value } : {}), { status }),
  );
}

const token = async () => "tok";

afterEach(() => vi.restoreAllMocks());

describe("resolveTimeZone", () => {
  it("prefers the user's Outlook time zone over the browser's", async () => {
    const zone = await resolveTimeZone({
      browserZone: "America/Chicago",
      m365: true,
      graphToken: token,
      fetchFn: outlookSays("Eastern Standard Time"),
    });
    expect(zone).toEqual({ timeZone: "America/New_York", known: true });
  });

  it("uses the browser's zone when Outlook has none it can use", async () => {
    const zone = await resolveTimeZone({
      browserZone: "America/Chicago",
      m365: true,
      graphToken: token,
      fetchFn: outlookSays("Mars Standard Time"),
    });
    expect(zone).toEqual({ timeZone: "America/Chicago", known: true });
  });

  it("uses the browser's zone, logging only the error type, when Outlook can't be read", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const zone = await resolveTimeZone({
      browserZone: "America/Chicago",
      m365: true,
      graphToken: token,
      fetchFn: outlookSays("", 403),
    });
    expect(zone).toEqual({ timeZone: "America/Chicago", known: true });
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[time-zone\] mailbox settings failed: GraphError/),
    );
  });

  it("doesn't log when Microsoft 365 isn't available in this session", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const zone = await resolveTimeZone({
      browserZone: "America/Chicago",
      m365: true,
      graphToken: () => Promise.reject(new GraphTokenError("unavailable", "bypass")),
    });
    expect(zone).toEqual({ timeZone: "America/Chicago", known: true });
    expect(log).not.toHaveBeenCalled();
  });

  it("doesn't call Graph when the Microsoft 365 tools are off", async () => {
    const fetchFn = outlookSays("Eastern Standard Time");
    const zone = await resolveTimeZone({
      browserZone: "America/Chicago",
      m365: false,
      graphToken: token,
      fetchFn,
    });
    expect(zone).toEqual({ timeZone: "America/Chicago", known: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("falls back to UTC when neither Outlook nor the browser gives a zone", async () => {
    const zone = await resolveTimeZone({ m365: false, graphToken: token });
    expect(zone).toEqual({ timeZone: "UTC", known: false });
  });
});
