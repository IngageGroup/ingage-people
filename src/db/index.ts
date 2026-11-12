import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createEntraTokenProvider, getPoolConfig } from "@/db/config";
import * as schema from "@/db/schema";

let pool: Pool | undefined;
let db: NodePgDatabase<typeof schema> | undefined;

/** Shared pool, created on first use so importing this module never connects. */
export function getPool(): Pool {
  if (!pool) {
    const tokenProvider = createEntraTokenProvider(process.env["AZURE_CLIENT_ID"]);
    pool = new Pool(getPoolConfig(process.env, tokenProvider));
    // Without a listener, an idle client dropped by the server crashes the process.
    pool.on("error", (err) => console.error("[db] idle client error", err));
  }
  return pool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  db ??= drizzle(getPool(), { schema });
  return db;
}

/** Resolves when the database answers a trivial query; rejects otherwise. */
export async function pingDb(): Promise<void> {
  await getDb().execute(sql`select 1`);
}
