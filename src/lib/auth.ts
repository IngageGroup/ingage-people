import NextAuth from "next-auth";
import type { JWT } from "next-auth/jwt";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { E2E_USER_EMAIL, isAuthBypassed } from "@/lib/e2e-bypass";
import {
  GRAPH_SCOPES,
  GraphTokenError,
  graphTokenFromAccount,
  needsRefresh,
  readGraphToken,
  refreshGraphToken,
} from "@/lib/graph-token";

export const DEFAULT_ALLOWED_EMAIL_DOMAIN = "ingagepartners.com";

/**
 * Whether an email may sign in. ALLOWED_EMAIL_DOMAIN defaults to ingagepartners.com when
 * unset or empty, so a missing variable never opens sign-in to the whole tenant; set it to
 * `*` to allow any account in the tenant. Comparison is case-insensitive — Entra can return
 * mixed-case emails and UPNs.
 */
export function isAllowedEmail(candidate: unknown): boolean {
  if (typeof candidate !== "string" || !candidate.trim()) return false;
  const configured = (process.env["ALLOWED_EMAIL_DOMAIN"] ?? "").trim().toLowerCase();
  const domain = configured || DEFAULT_ALLOWED_EMAIL_DOMAIN;
  if (domain === "*") return true;
  return candidate.trim().toLowerCase().endsWith(`@${domain}`);
}

/**
 * Keeps the user's Graph tokens on the encrypted JWT and refreshes them near expiry. Returning
 * null ends the session (Auth.js clears the cookie), so the user signs in again: after a failed
 * refresh, and for sessions created before Graph tokens were stored.
 */
async function keepGraphToken(
  token: JWT,
  account: Parameters<typeof graphTokenFromAccount>[0] | null | undefined,
): Promise<JWT | null> {
  if (account) return { ...token, graph: graphTokenFromAccount(account) };

  const graph = readGraphToken(token["graph"]);
  if (!graph) return null;
  if (!needsRefresh(graph)) return token;

  try {
    return { ...token, graph: await refreshGraphToken(graph.refreshToken) };
  } catch (error) {
    const detail = error instanceof GraphTokenError ? error.message : "unexpected error";
    console.warn(`[auth] ending session: ${detail}`);
    return null;
  }
}

export const { handlers, auth } = NextAuth({
  // The app always runs behind a trusted reverse proxy (Azure Container Apps
  // ingress in production, the Next dev server locally), so trust the forwarded
  // host. Setting this in code rather than via AUTH_TRUST_HOST keeps the auth
  // gate from silently failing open if the env var is ever missing.
  trustHost: true,
  providers: [
    MicrosoftEntraID({
      clientId: process.env["AZURE_AD_CLIENT_ID"] ?? "",
      clientSecret: process.env["AZURE_AD_CLIENT_SECRET"] ?? "",
      issuer: `https://login.microsoftonline.com/${process.env["AZURE_AD_TENANT_ID"]}/v2.0`,
      authorization: { params: { scope: GRAPH_SCOPES.join(" ") } },
    }),
  ],
  pages: {
    signIn: "/auth/signin",
  },
  callbacks: {
    signIn({ profile, account }) {
      if (!isAllowedEmail(profile?.email || profile?.preferred_username)) return false;
      return account ? graphTokenFromAccount(account) !== null : false;
    },
    jwt({ token, account }) {
      return keepGraphToken(token, account);
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
});

/** Email of the signed-in user, the fixed test identity under auth bypass, or null. */
export async function getCurrentUserEmail(): Promise<string | null> {
  if (isAuthBypassed()) return E2E_USER_EMAIL;
  const session = await auth();
  return session?.user?.email ?? null;
}
