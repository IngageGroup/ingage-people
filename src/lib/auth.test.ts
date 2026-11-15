import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authMock, captured } = vi.hoisted(() => ({
  authMock: vi.fn(),
  captured: { config: undefined as unknown, provider: undefined as unknown },
}));

vi.mock("next-auth", () => ({
  default: (config: unknown) => {
    captured.config = config;
    return { handlers: {}, auth: authMock };
  },
}));

vi.mock("next-auth/providers/microsoft-entra-id", () => ({
  default: (options: unknown) => {
    captured.provider = options;
    return {};
  },
}));

import { getCurrentUserEmail, isAllowedEmail } from "@/lib/auth";
import { GRAPH_SCOPES } from "@/lib/graph-token";

type Token = Record<string, unknown>;
type Callbacks = {
  signIn: (args: { profile?: Token; account?: Token | null }) => boolean;
  jwt: (args: { token: Token; account?: Token | null }) => Promise<Token | null>;
  session: (args: { session: { user: Token }; token: Token }) => { user: Token };
};
const callbacks = () => (captured.config as { callbacks: Callbacks }).callbacks;

const NOW_S = Date.UTC(2026, 10, 15, 12, 0, 0) / 1000;
const SIGN_IN_ACCOUNT = { access_token: "at", refresh_token: "rt", expires_at: NOW_S + 3600 };
const fetchMock = vi.fn();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  authMock.mockReset();
  fetchMock.mockReset();
});

describe("isAllowedEmail", () => {
  it("defaults to ingagepartners.com when ALLOWED_EMAIL_DOMAIN is unset", () => {
    delete process.env["ALLOWED_EMAIL_DOMAIN"];
    expect(isAllowedEmail("user@ingagepartners.com")).toBe(true);
    expect(isAllowedEmail("anyone@anywhere.com")).toBe(false);
  });

  it("treats an empty ALLOWED_EMAIL_DOMAIN like an unset one", () => {
    vi.stubEnv("ALLOWED_EMAIL_DOMAIN", "  ");
    expect(isAllowedEmail("anyone@anywhere.com")).toBe(false);
  });

  it("allows any email in the tenant only when ALLOWED_EMAIL_DOMAIN is *", () => {
    vi.stubEnv("ALLOWED_EMAIL_DOMAIN", "*");
    expect(isAllowedEmail("anyone@anywhere.com")).toBe(true);
    expect(isAllowedEmail(undefined)).toBe(false);
  });

  it("allows a matching domain regardless of case", () => {
    vi.stubEnv("ALLOWED_EMAIL_DOMAIN", "ingagepartners.com");
    expect(isAllowedEmail("user@ingagepartners.com")).toBe(true);
    expect(isAllowedEmail("User@INGAGEPARTNERS.COM")).toBe(true);
  });

  it("rejects other domains, including suffix look-alikes", () => {
    vi.stubEnv("ALLOWED_EMAIL_DOMAIN", "ingagepartners.com");
    expect(isAllowedEmail("user@gmail.com")).toBe(false);
    expect(isAllowedEmail("attacker@evilingagepartners.com")).toBe(false);
  });

  it("rejects non-string and empty values when a domain is configured", () => {
    vi.stubEnv("ALLOWED_EMAIL_DOMAIN", "ingagepartners.com");
    expect(isAllowedEmail(undefined)).toBe(false);
    expect(isAllowedEmail(null)).toBe(false);
    expect(isAllowedEmail("")).toBe(false);
    expect(isAllowedEmail(42)).toBe(false);
  });
});

describe("getCurrentUserEmail", () => {
  it("returns the fixed test identity under auth bypass without resolving a session", async () => {
    vi.stubEnv("E2E_AUTH_BYPASS", "true");
    expect(await getCurrentUserEmail()).toBe("e2e@example.com");
    expect(authMock).not.toHaveBeenCalled();
  });

  it("ignores auth bypass in production", async () => {
    vi.stubEnv("E2E_AUTH_BYPASS", "true");
    vi.stubEnv("NODE_ENV", "production");
    authMock.mockResolvedValue(null);
    expect(await getCurrentUserEmail()).toBeNull();
  });

  it("returns the signed-in user's email", async () => {
    vi.stubEnv("E2E_AUTH_BYPASS", "");
    authMock.mockResolvedValue({ user: { email: "a@x.com" } });
    expect(await getCurrentUserEmail()).toBe("a@x.com");
  });

  it("returns null when there is no session", async () => {
    vi.stubEnv("E2E_AUTH_BYPASS", "");
    authMock.mockResolvedValue(null);
    expect(await getCurrentUserEmail()).toBeNull();
  });
});

describe("Entra provider", () => {
  it("requests the Graph scopes, including offline_access", () => {
    const options = captured.provider as { authorization: { params: { scope: string } } };
    expect(options.authorization.params.scope).toBe(GRAPH_SCOPES.join(" "));
  });
});

describe("signIn callback", () => {
  it("allows an allowed email whose account carries Graph tokens", () => {
    vi.stubEnv("ALLOWED_EMAIL_DOMAIN", "x.com");
    expect(callbacks().signIn({ profile: { email: "a@x.com" }, account: SIGN_IN_ACCOUNT })).toBe(
      true,
    );
  });

  it("refuses an email outside the allowed domain", () => {
    vi.stubEnv("ALLOWED_EMAIL_DOMAIN", "x.com");
    expect(callbacks().signIn({ profile: { email: "a@y.com" }, account: SIGN_IN_ACCOUNT })).toBe(
      false,
    );
  });

  it("refuses sign-in when Entra returned no refresh token", () => {
    vi.stubEnv("ALLOWED_EMAIL_DOMAIN", "x.com");
    const { refresh_token: _omitted, ...withoutRefresh } = SIGN_IN_ACCOUNT;
    expect(callbacks().signIn({ profile: { email: "a@x.com" }, account: withoutRefresh })).toBe(
      false,
    );
  });
});

describe("jwt callback", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW_S * 1000, toFake: ["Date"] });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("stores the Graph tokens at sign-in", async () => {
    const token = await callbacks().jwt({ token: { sub: "u1" }, account: SIGN_IN_ACCOUNT });
    expect(token).toEqual({
      sub: "u1",
      graph: { accessToken: "at", refreshToken: "rt", expiresAt: NOW_S + 3600 },
    });
  });

  it("keeps a token that isn't close to expiry, without refreshing", async () => {
    const graph = { accessToken: "at", refreshToken: "rt", expiresAt: NOW_S + 3600 };
    expect(await callbacks().jwt({ token: { sub: "u1", graph } })).toEqual({ sub: "u1", graph });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes a token close to expiry", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }),
      ),
    );
    const graph = { accessToken: "at", refreshToken: "rt", expiresAt: NOW_S + 30 };

    expect(await callbacks().jwt({ token: { sub: "u1", graph } })).toEqual({
      sub: "u1",
      graph: { accessToken: "new-at", refreshToken: "new-rt", expiresAt: NOW_S + 3600 },
    });
  });

  it("ends the session when refresh fails, and logs without the tokens", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );
    const graph = { accessToken: "secret-at", refreshToken: "secret-rt", expiresAt: NOW_S - 1 };

    expect(await callbacks().jwt({ token: { sub: "u1", graph } })).toBeNull();
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("invalid_grant");
    expect(logged).not.toContain("secret-rt");
    warn.mockRestore();
  });

  it("ends a session that has no Graph token, so the user signs in again", async () => {
    expect(await callbacks().jwt({ token: { sub: "u1", email: "a@x.com" } })).toBeNull();
  });
});

describe("session callback", () => {
  it("never copies the Graph tokens into the session the browser sees", () => {
    const graph = { accessToken: "at", refreshToken: "rt", expiresAt: NOW_S };
    const session = callbacks().session({ session: { user: {} }, token: { sub: "u1", graph } });
    expect(JSON.stringify(session)).not.toContain("rt");
    expect(JSON.stringify(session)).not.toContain('"at"');
    expect(session.user["id"]).toBe("u1");
  });
});
