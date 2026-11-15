import { describe, expect, it } from "vitest";
import { AZURE_MONITOR_OPTIONS } from "@/lib/telemetry";

describe("AZURE_MONITOR_OPTIONS", () => {
  const options = AZURE_MONITOR_OPTIONS.instrumentationOptions ?? {};

  it("never records Postgres parameter values, which hold questions and chunk text", () => {
    expect(options.postgreSql).toMatchObject({ enabled: true, enhancedDatabaseReporting: false });
  });

  it("doesn't collect console output or logger records", () => {
    expect(options.console?.enabled).toBe(false);
    expect(options.bunyan?.enabled).toBe(false);
    expect(options.winston?.enabled).toBe(false);
  });

  it("doesn't capture HTTP headers or bodies", () => {
    expect(options.http).toEqual({ enabled: true });
  });
});
