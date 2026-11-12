import { DefaultAzureCredential } from "@azure/identity";
import type { PoolConfig } from "pg";

const ENTRA_POSTGRES_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";
const CONNECTION_TIMEOUT_MS = 5000;
const QUERY_TIMEOUT_MS = 10_000;
// keepAlive detects half-open connections; query_timeout bounds a query on one that slips through.
const COMMON = {
  connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  query_timeout: QUERY_TIMEOUT_MS,
  keepAlive: true,
} as const;
const AZURE_VARS = ["PGHOST", "PGDATABASE", "PGUSER"] as const;

/**
 * Connection settings for node-postgres.
 *
 * Local and CI use DATABASE_URL (password auth). In Azure, PGHOST/PGDATABASE/PGUSER
 * are set and the password is an Entra access token. `pg` calls the password
 * function for every new connection, so expired tokens are never reused.
 *
 * @throws Error naming the missing variables when neither mode is configured.
 */
export function getPoolConfig(
  env: Record<string, string | undefined>,
  getToken: () => Promise<string>,
): PoolConfig {
  const url = env["DATABASE_URL"];
  if (url) {
    return { connectionString: url, ...COMMON };
  }

  const missing = AZURE_VARS.filter((name) => !env[name]);
  if (missing.length === AZURE_VARS.length) {
    throw new Error(
      "Database is not configured: set DATABASE_URL (local/CI) or PGHOST, PGDATABASE and " +
        "PGUSER (Azure, Entra token auth). See .env.local.example.",
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `Database is partly configured for Azure: missing ${missing.join(", ")}. ` +
        "Set all of PGHOST, PGDATABASE and PGUSER.",
    );
  }

  return {
    host: env["PGHOST"],
    database: env["PGDATABASE"],
    user: env["PGUSER"],
    port: 5432,
    ssl: true,
    ...COMMON,
    password: getToken,
  };
}

/**
 * Fetches an Entra access token for Azure Database for PostgreSQL on every call. The
 * credential caches and refreshes tokens itself.
 *
 * @param clientId Client ID of the user-assigned managed identity (AZURE_CLIENT_ID).
 */
export function createEntraTokenProvider(clientId: string | undefined): () => Promise<string> {
  let credential: DefaultAzureCredential | undefined;
  return async () => {
    // Created on first use so DATABASE_URL mode never touches Azure identity.
    credential ??= new DefaultAzureCredential(
      clientId ? { managedIdentityClientId: clientId } : {},
    );
    const token = await credential.getToken(ENTRA_POSTGRES_SCOPE);
    return token.token;
  };
}
