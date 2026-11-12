import { beforeEach, describe, expect, it, vi } from "vitest";

const { calls, client, migrateMock } = vi.hoisted(() => {
  const calls: string[] = [];
  const client = {
    connect: vi.fn(async () => {
      calls.push("connect");
    }),
    query: vi.fn(async (text: string) => {
      calls.push(text.includes("unlock") ? "unlock" : "lock");
    }),
    end: vi.fn(async () => {
      calls.push("end");
    }),
  };
  const migrateMock = vi.fn(async () => {
    calls.push("migrate");
  });
  return { calls, client, migrateMock };
});

const { ClientMock } = vi.hoisted(() => ({ ClientMock: vi.fn() }));

vi.mock("pg", () => ({
  Client: vi.fn(function Client(config: unknown) {
    ClientMock(config);
    return client;
  }),
}));
vi.mock("drizzle-orm/node-postgres/migrator", () => ({ migrate: migrateMock }));
vi.mock("@/db/config", () => ({
  getPoolConfig: () => ({ connectionString: "postgres://test", query_timeout: 10000 }),
  createEntraTokenProvider: () => async () => "token",
}));

import { MIGRATION_LOCK_ID, runMigrations } from "@/db/migrate";

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
});

describe("runMigrations", () => {
  it("holds an advisory lock around the migration", async () => {
    await runMigrations({ migrationsFolder: "/m" });
    expect(calls).toEqual(["connect", "lock", "migrate", "unlock", "end"]);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("pg_advisory_lock"), [
      MIGRATION_LOCK_ID,
    ]);
    expect(migrateMock).toHaveBeenCalledWith(expect.anything(), { migrationsFolder: "/m" });
  });

  it("releases the lock and closes the connection when a migration fails", async () => {
    migrateMock.mockRejectedValueOnce(new Error("bad sql"));
    await expect(runMigrations({ migrationsFolder: "/m" })).rejects.toThrow("bad sql");
    expect(calls).toEqual(["connect", "lock", "unlock", "end"]);
  });

  it("defaults to the drizzle folder in the working directory", async () => {
    await runMigrations();
    expect(migrateMock).toHaveBeenCalledWith(expect.anything(), {
      migrationsFolder: `${process.cwd()}/drizzle`,
    });
  });

  it("lets migrations and the lock wait run past the app's query timeout", async () => {
    await runMigrations({ migrationsFolder: "/m" });
    expect(ClientMock).toHaveBeenCalledWith({ connectionString: "postgres://test" });
  });
});
