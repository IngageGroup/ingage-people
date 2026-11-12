import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAuthBypassed } from "@/lib/e2e-bypass";

const PUBLIC_PATHS = [
  "/auth/signin",
  "/api/auth",
  "/api/health",
  "/_next",
  "/favicon.ico",
  "/icon.svg",
  "/assets/logos",
];

/**
 * Public paths match on whole segments: `/api/auth` covers `/api/auth/session`
 * but not `/api/authors`.
 */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * A request is authenticated only when it carries a resolved session with a user.
 *
 * On internal failure (UntrustedHost, MissingSecret, ...) Auth.js does not throw
 * or return null — it sets req.auth to a truthy error object such as
 * `{ message: "There was a problem with the server configuration." }`. Treating
 * that as a session is what served protected pages unauthenticated, so the gate
 * checks for a user rather than mere truthiness and fails closed on errors.
 */
export function isAuthenticated(authState: unknown): boolean {
  return Boolean((authState as { user?: unknown } | null | undefined)?.user);
}

/** Pure gate decision given the resolved auth state for a request. */
export function decideAccess(opts: {
  authed: boolean;
  pathname: string;
  url: string;
  bypass: boolean;
}): NextResponse {
  if (opts.bypass) return NextResponse.next();
  if (isPublicPath(opts.pathname)) return NextResponse.next();
  if (!opts.authed) {
    if (opts.pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const signInUrl = new URL("/auth/signin", opts.url);
    signInUrl.searchParams.set("callbackUrl", opts.url);
    return NextResponse.redirect(signInUrl);
  }
  return NextResponse.next();
}

type GateRequest = { auth?: unknown };
export type AuthWrapper = (
  callback: (req: GateRequest) => NextResponse,
) => (req: NextRequest, ev: NextFetchEvent) => Promise<Response | undefined> | Response | undefined;

/**
 * Builds the auth gate. The provided wrapper (Auth.js `auth`) resolves the
 * session and invokes our decision callback. Any thrown error denies the request
 * so the gate fails closed.
 */
export function createGate(
  authWrapper: AuthWrapper,
): (req: NextRequest, ev: NextFetchEvent) => Promise<Response> {
  return async (req, ev) => {
    const deny = () =>
      decideAccess({
        authed: false,
        pathname: req.nextUrl.pathname,
        url: req.url,
        bypass: isAuthBypassed(),
      });
    try {
      const run = authWrapper((authReq) =>
        decideAccess({
          authed: isAuthenticated(authReq.auth),
          pathname: req.nextUrl.pathname,
          url: req.url,
          bypass: isAuthBypassed(),
        }),
      );
      return (await run(req, ev)) ?? deny();
    } catch (error) {
      console.error("[proxy] auth resolution threw; failing closed", error);
      return deny();
    }
  };
}

// next-auth's auth() wrapper signature does not line up with AuthWrapper, so
// bridge it here. It is the documented way to populate req.auth in middleware.
export default createGate(auth as unknown as AuthWrapper);

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
