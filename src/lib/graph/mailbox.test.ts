import { describe, expect, it, vi } from "vitest";
import { GRAPH_BASE } from "@/lib/graph/client";
import { mailboxTimeZone } from "@/lib/graph/mailbox";

function fetchReturning(value: unknown) {
  return vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ value }), { status: 200 }),
  );
}

describe("mailboxTimeZone", () => {
  it("reads the user's Outlook time zone setting", async () => {
    const fetchFn = fetchReturning("Eastern Standard Time");
    await mailboxTimeZone("tok", fetchFn);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(`${GRAPH_BASE}/me/mailboxSettings/timeZone`);
  });

  it("turns a Windows zone name into its IANA name", async () => {
    expect(await mailboxTimeZone("tok", fetchReturning("Eastern Standard Time"))).toBe(
      "America/New_York",
    );
    expect(await mailboxTimeZone("tok", fetchReturning("US Eastern Standard Time"))).toBe(
      "America/Indianapolis",
    );
  });

  it("keeps a zone that is already an IANA name", async () => {
    expect(await mailboxTimeZone("tok", fetchReturning("America/Chicago"))).toBe("America/Chicago");
  });

  it("returns null for a zone it can't use", async () => {
    expect(await mailboxTimeZone("tok", fetchReturning("Mars Standard Time"))).toBeNull();
    expect(await mailboxTimeZone("tok", fetchReturning(""))).toBeNull();
    expect(await mailboxTimeZone("tok", fetchReturning(undefined))).toBeNull();
  });
});
