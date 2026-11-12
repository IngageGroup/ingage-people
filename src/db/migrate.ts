import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { createEntraTokenProvider, getPoolConfig } from "@/db/config";

/** Arbitrary constant shared by every replica so only one migrates at a time. */
export const MIGRATION_LOCK_ID = 7_310_442_215;

/**
 * Applies pending SQL migrations from `drizzle/` under a Postgres advisory lock.
 * Replicas starting together wait for the lock instead of racing.
 *
 * @throws The migration error, after the lock is released and the connection closed.
 */
export async function runMigrations(options: { migrationsFolder?: string } = {}): Promise<void> {
  const migrationsFolder = options.migrationsFolder ?? path.join(process.cwd(), "drizzle");
  const tokenProvider = createEntraTokenProvider(process.env["AZURE_CLIENT_ID"]);
  // No query timeout here: waiting for another replica's lock or a long migration is expected.
  const { query_timeout: _appQueryTimeout, ...config } = getPoolConfig(process.env, tokenProvider);
  const client = new Client(config);

  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    try {
      await migrate(drizzle(client), { migrationsFolder });
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    }
  } finally {
    await client.end();
  }
}
