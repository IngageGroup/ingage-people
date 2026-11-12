import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db/migrate", () => ({ runMigrations: vi.fn() }));
vi.mock("@azure/monitor-opentelemetry", () => ({ useAzureMonitor: vi.fn() }));

import { useAzureMonitor } from "@azure/monitor-opentelemetry";
import { runMigrations } from "@/db/migrate";
import { startNodeServer } from "@/instrumentation-node";

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("startNodeServer", () => {
  it("runs migrations in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await startNodeServer();
    expect(runMigrations).toHaveBeenCalledOnce();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("skips migrations outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await startNodeServer();
    expect(runMigrations).not.toHaveBeenCalled();
  });

  it("exits non-zero with a clear log line when migrations fail", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(runMigrations).mockRejectedValue(new Error("auth failed"));
    await startNodeServer();
    expect(console.error).toHaveBeenCalledWith("[migrate] failed; exiting", expect.any(Error));
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("enables Azure Monitor only when a connection string is set", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "");
    await startNodeServer();
    expect(useAzureMonitor).not.toHaveBeenCalled();

    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "InstrumentationKey=00000000");
    await startNodeServer();
    expect(useAzureMonitor).toHaveBeenCalledOnce();
  });
});
