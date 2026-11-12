import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ pingDb: vi.fn() }));

import { pingDb } from "@/db";
import { GET } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/health", () => {
  it("returns ok when the database answers", async () => {
    vi.mocked(pingDb).mockResolvedValue();
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 503 and logs when the database is unreachable", async () => {
    vi.mocked(pingDb).mockRejectedValue(new Error("timeout"));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "unavailable" });
    expect(console.error).toHaveBeenCalled();
  });

  it("returns 503 when the database never answers", async () => {
    vi.useFakeTimers();
    vi.mocked(pingDb).mockReturnValue(new Promise(() => {}));
    const pending = GET();
    await vi.advanceTimersByTimeAsync(5000);
    const res = await pending;
    vi.useRealTimers();
    expect(res.status).toBe(503);
  });
});
