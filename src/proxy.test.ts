import type { NextFetchEvent, NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Importing the middleware module must not boot real NextAuth.
vi.mock("@/lib/auth", () => ({
  auth: (handler: unknown) => handler,
}));

import type { AuthWrapper } from "@/proxy";
import { createGate, decideAccess, isAuthenticated, isPublicPath } from "@/proxy";

function fakeReq(pathname: string): NextRequest {
  return { nextUrl: { pathname }, url: `https://app.test${pathname}` } as unknown as NextRequest;
}
const fakeEvent = {} as NextFetchEvent;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["E2E_AUTH_BYPASS"];
});

describe("isPublicPath", () => {
  it("treats sign-in and the auth API as public", () => {
    expect(isPublicPath("/auth/signin")).toBe(true);
    expect(isPublicPath("/api/auth/session")).toBe(true);
    expect(isPublicPath("/_next/static/chunk.js")).toBe(true);
  });

  it("serves the brand logos to signed-out visitors for the sign-in page", () => {
    expect(isPublicPath("/assets/logos/ingage-logo-orange-blue.png")).toBe(true);
    expect(isPublicPath("/assets/other.png")).toBe(false);
  });

  it("leaves the health check public for Container Apps probes", () => {
    expect(isPublicPath("/api/health")).toBe(true);
  });

  it("matches public paths on whole segments only", () => {
    expect(isPublicPath("/api/authors")).toBe(false);
    expect(isPublicPath("/api/healthz")).toBe(false);
    expect(isPublicPath("/auth/signin-other")).toBe(false);
    expect(isPublicPath("/assets/logosx/x.png")).toBe(false);
  });

  it("treats the root page as protected", () => {
    expect(isPublicPath("/")).toBe(false);
  });

  it("treats app pages and data APIs as protected", () => {
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/api/chat")).toBe(false);
  });
});

describe("decideAccess", () => {
  it("redirects an unauthenticated page request to sign-in", () => {
    const res = decideAccess({
      authed: false,
      pathname: "/settings",
      url: "https://app.test/settings",
      bypass: false,
    });
    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/signin");
    expect(location).toContain("callbackUrl=");
  });

  it("returns 401 for an unauthenticated API request", () => {
    const res = decideAccess({
      authed: false,
      pathname: "/api/chat",
      url: "https://app.test/api/chat",
      bypass: false,
    });
    expect(res.status).toBe(401);
  });

  it("allows public paths without authentication", () => {
    const res = decideAccess({
      authed: false,
      pathname: "/auth/signin",
      url: "https://app.test/auth/signin",
      bypass: false,
    });
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("allows authenticated requests through", () => {
    const res = decideAccess({
      authed: true,
      pathname: "/settings",
      url: "https://app.test/settings",
      bypass: false,
    });
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("allows everything when E2E bypass is enabled", () => {
    const res = decideAccess({
      authed: false,
      pathname: "/settings",
      url: "https://app.test/settings",
      bypass: true,
    });
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("isAuthenticated", () => {
  it("is true only for a session that has a user", () => {
    expect(isAuthenticated({ user: { email: "a@b.com" } })).toBe(true);
  });

  it("is false for null, undefined, or a session without a user", () => {
    expect(isAuthenticated(null)).toBe(false);
    expect(isAuthenticated(undefined)).toBe(false);
    expect(isAuthenticated({})).toBe(false);
  });

  it("is false for an Auth.js error object", () => {
    // On config errors Auth.js sets req.auth to { message: "..." }, not a session.
    expect(isAuthenticated({ message: "There was a problem with the server configuration." })).toBe(
      false,
    );
  });
});

describe("createGate", () => {
  const wrapperWithAuth =
    (authState: unknown): AuthWrapper =>
    (callback) =>
    () =>
      callback({ auth: authState });
  const throwingWrapper: AuthWrapper = () => () => {
    throw new Error("boom");
  };

  it("allows an authenticated request through", async () => {
    const gate = createGate(wrapperWithAuth({ user: { email: "a@b.com" } }));
    const res = await gate(fakeReq("/settings"), fakeEvent);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("redirects an unauthenticated page request to sign-in", async () => {
    const res = await createGate(wrapperWithAuth(null))(fakeReq("/settings"), fakeEvent);
    expect(res.status).toBe(307);
    expect(res.headers.get("location") ?? "").toContain("/auth/signin");
  });

  it("fails closed on a protected page when Auth.js injects an error object", async () => {
    const gate = createGate(wrapperWithAuth({ message: "config error" }));
    const res = await gate(fakeReq("/settings"), fakeEvent);
    expect(res.status).toBe(307);
  });

  it("fails closed with 401 on a protected API when an error object is injected", async () => {
    const gate = createGate(wrapperWithAuth({ message: "config error" }));
    const res = await gate(fakeReq("/api/chat"), fakeEvent);
    expect(res.status).toBe(401);
  });

  it("fails closed when the wrapper throws", async () => {
    const res = await createGate(throwingWrapper)(fakeReq("/settings"), fakeEvent);
    expect(res.status).toBe(307);
  });

  it("allows public paths even when an error object is injected", async () => {
    const gate = createGate(wrapperWithAuth({ message: "config error" }));
    const res = await gate(fakeReq("/auth/signin"), fakeEvent);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("allows everything when E2E bypass is enabled", async () => {
    process.env["E2E_AUTH_BYPASS"] = "true";
    const res = await createGate(wrapperWithAuth(null))(fakeReq("/settings"), fakeEvent);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("ignores E2E bypass in production", async () => {
    process.env["E2E_AUTH_BYPASS"] = "true";
    vi.stubEnv("NODE_ENV", "production");
    const res = await createGate(wrapperWithAuth(null))(fakeReq("/settings"), fakeEvent);
    expect(res.status).toBe(307);
    vi.unstubAllEnvs();
  });
});
