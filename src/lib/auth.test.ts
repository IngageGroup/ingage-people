import { afterEach, describe, expect, it, vi } from "vitest";

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
import type { GraphTokens } from "@/lib/graph-token";

type Token = Record<string, unknown> & { graph?: GraphTokens };
interface Callbacks {
  jwt(args: { token: Token; account?: unknown }): Promise<Token | null>;
  session(args: { session: { user: Record<string, unknown> }; token: Token }): unknown;
}
const callbacks = () => (captured.config as { callbacks: Callbacks }).callbacks;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  authMock.mockReset();
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

describe("Graph tokens in the session", () => {
  const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
  const graph = (expiresAt: number): GraphTokens => ({
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt,
  });

  it("asks Entra for the Graph scopes and a refresh token", () => {
    const { authorization } = captured.provider as {
      authorization: { params: { scope: string } };
    };
    const scopes = authorization.params.scope.split(" ");
    expect(scopes).toEqual(expect.arrayContaining(["offline_access", "User.Read", "Mail.Read"]));
  });

  it("stores the tokens from the sign-in response", async () => {
    const account = { access_token: "a", refresh_token: "r", expires_at: 123 };
    const token = await callbacks().jwt({ token: { sub: "u1" }, account });
    expect(token?.graph).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: 123 });
  });

  it("keeps a valid token as it is", async () => {
    const token = { sub: "u1", graph: graph(inAnHour()) };
    expect(await callbacks().jwt({ token })).toEqual(token);
  });

  it("ends the session when the refresh fails", async () => {
    vi.stubEnv("AZURE_AD_TENANT_ID", "tenant-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await callbacks().jwt({ token: { sub: "u1", graph: graph(0) } })).toBeNull();
  });

  it("ends a session that has no Graph token", async () => {
    expect(await callbacks().jwt({ token: { sub: "u1" } })).toBeNull();
  });

  it("never puts the tokens in the session sent to the browser", () => {
    const session = callbacks().session({
      session: { user: { email: "a@x.com" } },
      token: { sub: "u1", graph: graph(inAnHour()) },
    });
    expect(JSON.stringify(session)).not.toContain("access");
    expect(JSON.stringify(session)).not.toContain("refresh");
  });
});
