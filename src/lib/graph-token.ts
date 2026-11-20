import { headers } from "next/headers";
import { getToken } from "next-auth/jwt";
import { isAuthBypassed } from "@/lib/e2e-bypass";
import { SafeError } from "@/lib/safe-error";

/**
 * Scopes requested at sign-in: the OpenID basics, `offline_access` for a refresh token, and
 * the delegated read-only Graph permissions the tenant consented to (issue #32).
 */
export const GRAPH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Files.Read.All",
  "Sites.Read.All",
  "Mail.Read",
  "Calendars.Read",
  "Chat.Read",
  "ChannelMessage.Read.All",
  "Team.ReadBasic.All",
];

/** Tokens are refreshed this long before they expire, so a slow request can still use one. */
export const REFRESH_MARGIN_SECONDS = 5 * 60;

const REFRESH_TIMEOUT_MS = 10_000;
const SECURE_SESSION_COOKIE = "__Secure-authjs.session-token";

/** The signed-in user's Graph tokens, kept only in the encrypted session cookie. */
export interface GraphTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix time in seconds. */
  expiresAt: number;
}

export type GraphTokenFailure = "unavailable" | "signed-out" | "refresh-failed";

/** Why there's no Graph token for this request. The message never holds a token. */
export class GraphTokenError extends SafeError {
  override name = "GraphTokenError";

  constructor(
    readonly reason: GraphTokenFailure,
    message: string,
  ) {
    super(message);
  }
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

interface SignInAccount {
  access_token?: string | undefined;
  refresh_token?: string | undefined;
  expires_at?: number | undefined;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Graph tokens from the Entra sign-in response. Fails sign-in if any is missing. */
export function graphTokensFromAccount(account: SignInAccount): GraphTokens {
  const { access_token, refresh_token, expires_at } = account;
  if (!access_token || !refresh_token || !expires_at) {
    throw new GraphTokenError(
      "signed-out",
      "Entra sign-in returned no Graph access token, refresh token, or expiry; " +
        "check that the app requests offline_access",
    );
  }
  return { accessToken: access_token, refreshToken: refresh_token, expiresAt: expires_at };
}

function tokenEndpoint(): string {
  const tenant = process.env["AZURE_AD_TENANT_ID"];
  if (!tenant) throw new SafeError("AZURE_AD_TENANT_ID is not set; can't refresh Graph token");
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

async function entraErrorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : "unknown";
  } catch {
    return "unreadable body";
  }
}

/** Exchanges a refresh token for new Graph tokens at the Entra token endpoint. */
export async function refreshGraphTokens(
  refreshToken: string,
  fetchFn: FetchFn = fetch,
): Promise<GraphTokens> {
  const response = await fetchFn(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env["AZURE_AD_CLIENT_ID"] ?? "",
      client_secret: process.env["AZURE_AD_CLIENT_SECRET"] ?? "",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: GRAPH_SCOPES.join(" "),
    }),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const code = await entraErrorCode(response);
    throw new GraphTokenError(
      "refresh-failed",
      `Graph token refresh failed: status=${response.status} error=${code}`,
    );
  }
  const body = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
    throw new GraphTokenError("refresh-failed", "Graph token refresh returned no access token");
  }
  return {
    accessToken: body.access_token,
    // Entra usually rotates the refresh token; keep the old one if it doesn't.
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : refreshToken,
    expiresAt: nowSeconds() + body.expires_in,
  };
}

/** The tokens unchanged while the access token has the margin left, otherwise refreshed. */
export async function freshGraphTokens(
  tokens: GraphTokens,
  fetchFn: FetchFn = fetch,
): Promise<GraphTokens> {
  if (tokens.expiresAt - REFRESH_MARGIN_SECONDS > nowSeconds()) return tokens;
  return refreshGraphTokens(tokens.refreshToken, fetchFn);
}

/**
 * The signed-in user's Graph access token, for server code only. Never send it to the
 * browser or log it.
 *
 * It reads the session cookie the request arrived with. The proxy refreshes an expiring
 * token and sets the new cookie on the response, but this request still carries the old
 * one, so an expiring token is refreshed here too (not saved; the proxy's copy is).
 *
 * @throws GraphTokenError `unavailable` under the auth bypass, `signed-out` without a
 *   session token, `refresh-failed` when Entra won't refresh it.
 */
export async function getGraphAccessToken(fetchFn: FetchFn = fetch): Promise<string> {
  if (isAuthBypassed()) {
    throw new GraphTokenError("unavailable", "Microsoft 365 isn't available under the auth bypass");
  }
  const secret = process.env["AUTH_SECRET"];
  if (!secret) throw new SafeError("AUTH_SECRET is not set; can't read the session cookie");
  const requestHeaders = await headers();
  const secureCookie = (requestHeaders.get("cookie") ?? "").includes(SECURE_SESSION_COOKIE);
  const jwt = await getToken({ req: { headers: requestHeaders }, secret, secureCookie });
  if (!jwt?.graph) {
    throw new GraphTokenError("signed-out", "No Graph token in the session; sign in again");
  }
  const tokens = await freshGraphTokens(jwt.graph, fetchFn);
  return tokens.accessToken;
}
