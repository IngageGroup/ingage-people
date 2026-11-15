import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb, getPool } from "@/db";
import { consumeChatQuota } from "@/db/rate-limit";
import { chatUsage } from "@/db/schema";

const LIMITS = { perMinute: 2, perDay: 3 };
const T0 = new Date("2026-11-15T14:30:10Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const MINUTE = 60_000;

function newUser(): string {
  return `test-${randomUUID()}@example.com`;
}

async function consume(user: string, now: Date) {
  return consumeChatQuota(user, { now, limits: LIMITS });
}

afterEach(async () => {
  await getDb().delete(chatUsage).where(like(chatUsage.userEmail, "test-%@example.com"));
});

afterAll(async () => {
  await getPool().end();
});

describe("consumeChatQuota", () => {
  it("allows requests under both limits", async () => {
    const user = newUser();
    expect(await consume(user, T0)).toEqual({ allowed: true });
    expect(await consume(user, at(1000))).toEqual({ allowed: true });
  });

  it("refuses the request over the per-minute limit until the next minute", async () => {
    const user = newUser();
    await consume(user, T0);
    await consume(user, at(1000));

    expect(await consume(user, at(2000))).toEqual({
      allowed: false,
      limit: "minute",
      retryAfterSeconds: 48,
    });
    expect(await consume(user, at(MINUTE))).toEqual({ allowed: true });
  });

  it("refuses the request over the per-day limit until the next UTC day", async () => {
    const user = newUser();
    await consume(user, T0);
    await consume(user, at(MINUTE));
    await consume(user, at(2 * MINUTE));

    const refused = await consume(user, at(3 * MINUTE));
    expect(refused).toMatchObject({ allowed: false, limit: "day" });
    expect(refused.allowed === false && refused.retryAfterSeconds).toBe(
      (Date.parse("2026-11-16T00:00:00Z") - at(3 * MINUTE).getTime()) / 1000,
    );
    expect(await consume(user, new Date("2026-11-16T00:00:01Z"))).toEqual({ allowed: true });
  });

  it("doesn't count refused requests", async () => {
    const user = newUser();
    await consume(user, T0);
    await consume(user, at(1000));
    await consume(user, at(2000));
    await consume(user, at(3000));

    expect(await consume(user, at(MINUTE))).toEqual({ allowed: true });
    expect(await consume(user, at(2 * MINUTE))).toMatchObject({ allowed: false, limit: "day" });
  });

  it("counts each user separately, ignoring email case", async () => {
    const user = newUser();
    await consume(user, T0);
    await consume(user.toUpperCase(), at(1000));
    expect(await consume(user, at(2000))).toMatchObject({ allowed: false });
    expect(await consume(newUser(), at(2000))).toEqual({ allowed: true });
  });

  it("stores no more than counters, and drops this user's old ones", async () => {
    const user = newUser();
    await consume(user, new Date("2026-11-10T09:00:00Z"));
    await consume(user, T0);

    const rows = await getDb().select().from(chatUsage).where(eq(chatUsage.userEmail, user));
    expect(rows.map((r) => Object.keys(r).sort())).toEqual([
      ["count", "userEmail", "window", "windowStart"],
      ["count", "userEmail", "window", "windowStart"],
    ]);
    expect(rows.every((r) => r.windowStart >= new Date("2026-11-15T00:00:00Z"))).toBe(true);
  });
});
