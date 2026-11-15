import { headers } from "next/headers";
import { getToken } from "next-auth/jwt";
import { isAuthBypassed } from "@/lib/e2e-bypass";

/**
 * Delegated, read-only Microsoft Graph permissions requested at sign-in. The app registration
 * lists the same permissions with admin consent (README section 8.7).
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
  "Chat.Read",
  "ChannelMessage.Read.All",
  "Team.ReadBasic.All",
] as const;

/** The signed-in user's Graph tokens, kept only in the encrypted session cookie. */
export interface GraphTokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds. */
  expiresAt: number;
}

/**
 * - `unavailable`: no Microsoft 365 under the auth bypass.
 * - `signed-out`: no session, or a session from before Graph tokens were stored.
 * - `refresh-failed`: Entra refused the refresh token or couldn't be reached.
 */
export type GraphTokenFailure = "unavailable" | "signed-out" | "refresh-failed";

export class GraphTokenError extends Error {
  readonly reason: GraphTokenFailure;

  constructor(reason: GraphTokenFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GraphTokenError";
    this.reason = reason;
  }
}

const REFRESH_MARGIN_SECONDS = 60;
const SESSION_COOKIE = "authjs.session-token";

interface AccountTokens {
  access_token?: string | undefined;
  refresh_token?: string | undefined;
  expires_at?: number | undefined;
}

/** The Graph tokens from the sign-in account, or null when any part is missing. */
export function graphTokenFromAccount(account: AccountTokens): GraphTokenSet | null {
  const { access_token, refresh_token, expires_at } = account;
  if (!access_token || !refresh_token || typeof expires_at !== "number") return null;
  return { accessToken: access_token, refreshToken: refresh_token, expiresAt: expires_at };
}

/** The Graph token set stored on the session JWT, or null when it's absent or malformed. */
export function readGraphToken(value: unknown): GraphTokenSet | null {
  if (typeof value !== "object" || value === null) return null;
  const { accessToken, refreshToken, expiresAt } = value as Record<string, unknown>;
  if (typeof accessToken !== "string" || !accessToken) return null;
  if (typeof refreshToken !== "string" || !refreshToken) return null;
  if (typeof expiresAt !== "number") return null;
  return { accessToken, refreshToken, expiresAt };
}

/** Whether the access token expires within the next minute (or already has). */
export function needsRefresh(token: GraphTokenSet): boolean {
  return token.expiresAt - Date.now() / 1000 <= REFRESH_MARGIN_SECONDS;
}

interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

/**
 * Exchanges a refresh token for a new access token. Entra may rotate the refresh token;
 * when it doesn't send one, the old one stays valid.
 */
export async function refreshGraphToken(refreshToken: string): Promise<GraphTokenSet> {
  const tenantId = process.env["AZURE_AD_TENANT_ID"];
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: process.env["AZURE_AD_CLIENT_ID"] ?? "",
    client_secret: process.env["AZURE_AD_CLIENT_SECRET"] ?? "",
    scope: GRAPH_SCOPES.join(" "),
  });

  let response: Response;
  try {
    response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (cause) {
    throw new GraphTokenError("refresh-failed", "Graph token refresh: Entra unreachable", {
      cause,
    });
  }

  const json = (await response.json().catch(() => ({}))) as TokenEndpointResponse;
  if (!response.ok || !json.access_token || typeof json.expires_in !== "number") {
    throw new GraphTokenError(
      "refresh-failed",
      `Graph token refresh failed (${response.status} ${json.error ?? "no access token"})`,
    );
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + json.expires_in,
  };
}

/**
 * The signed-in user's Graph access token, for server code only. It's read from the
 * encrypted session cookie and never included in the session the browser sees. An expired
 * token is refreshed here for this request; the auth gate persists a refreshed one.
 */
export async function getGraphAccessToken(): Promise<string> {
  if (isAuthBypassed()) {
    throw new GraphTokenError("unavailable", "Microsoft 365 isn't available under the auth bypass");
  }

  const secret = process.env["AUTH_SECRET"];
  if (!secret) {
    throw new Error("AUTH_SECRET is not set; it's needed to read the session's Graph token");
  }

  const requestHeaders = await headers();
  const secureCookie = (requestHeaders.get("cookie") ?? "").includes(`__Secure-${SESSION_COOKIE}`);
  const session = await getToken({ req: { headers: requestHeaders }, secret, secureCookie });

  const graph = readGraphToken(session?.["graph"]);
  if (!graph) {
    throw new GraphTokenError("signed-out", "No Microsoft Graph token in the session");
  }
  if (!needsRefresh(graph)) return graph.accessToken;
  return (await refreshGraphToken(graph.refreshToken)).accessToken;
}
