import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { E2E_USER_EMAIL, isAuthBypassed } from "@/lib/e2e-bypass";

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
    }),
  ],
  pages: {
    signIn: "/auth/signin",
  },
  callbacks: {
    signIn({ profile }) {
      return isAllowedEmail(profile?.email || profile?.preferred_username);
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
