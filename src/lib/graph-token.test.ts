import { encode } from "next-auth/jwt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { headersMock } = vi.hoisted(() => ({ headersMock: vi.fn() }));
vi.mock("next/headers", () => ({ headers: headersMock }));

import {
  freshGraphTokens,
  GraphTokenError,
  type GraphTokens,
  getGraphAccessToken,
  graphTokensFromAccount,
  REFRESH_MARGIN_SECONDS,
  refreshGraphTokens,
} from "@/lib/graph-token";

const SECRET = "test-secret-at-least-32-characters-long";
const COOKIE = "authjs.session-token";
const SECURE_COOKIE = "__Secure-authjs.session-token";

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function tokens(expiresIn: number): GraphTokens {
  return { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: now() + expiresIn };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function refreshOk(body: Record<string, unknown> = {}) {
  return vi.fn(async () =>
    jsonResponse(200, {
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      ...body,
    }),
  );
}

async function useSessionCookie(graph: GraphTokens | undefined, name = COOKIE): Promise<void> {
  const value = await encode({ token: { sub: "u1", graph }, secret: SECRET, salt: name });
  headersMock.mockResolvedValue(new Headers({ cookie: `${name}=${value}` }));
}

beforeEach(() => {
  vi.stubEnv("AZURE_AD_TENANT_ID", "tenant-1");
  vi.stubEnv("AZURE_AD_CLIENT_ID", "client-1");
  vi.stubEnv("AZURE_AD_CLIENT_SECRET", "client-secret");
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("E2E_AUTH_BYPASS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  headersMock.mockReset();
});

describe("graphTokensFromAccount", () => {
  it("takes the tokens and expiry from the sign-in response", () => {
    const account = { access_token: "a", refresh_token: "r", expires_at: 123 };
    expect(graphTokensFromAccount(account)).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 123,
    });
  });

  it("fails sign-in when Entra returned no refresh token", () => {
    expect(() => graphTokensFromAccount({ access_token: "a", expires_at: 123 })).toThrow(
      /offline_access/,
    );
  });
});

describe("refreshGraphTokens", () => {
  it("posts the refresh token to the tenant's token endpoint and keeps the rotated one", async () => {
    const fetchFn = refreshOk();
    const result = await refreshGraphTokens("old-refresh", fetchFn);

    expect(result).toEqual({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: expect.closeTo(now() + 3600, 2),
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
    const form = init.body as URLSearchParams;
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("old-refresh");
    expect(form.get("client_id")).toBe("client-1");
    expect(form.get("scope")).toContain("offline_access");
  });

  it("keeps the old refresh token when Entra doesn't send a new one", async () => {
    const result = await refreshGraphTokens("old-refresh", refreshOk({ refresh_token: undefined }));
    expect(result.refreshToken).toBe("old-refresh");
  });

  it("reports Entra's error code, without the token, when refresh is refused", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(400, { error: "invalid_grant", error_description: "AADSTS70008 expired" }),
    );
    const error = await refreshGraphTokens("old-refresh", fetchFn).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GraphTokenError);
    expect(error).toMatchObject({ reason: "refresh-failed" });
    expect((error as Error).message).toBe(
      "Graph token refresh failed: status=400 error=invalid_grant",
    );
  });

  it("fails when the response has no access token", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { token_type: "Bearer" }));
    await expect(refreshGraphTokens("old-refresh", fetchFn)).rejects.toMatchObject({
      reason: "refresh-failed",
    });
  });

  it("fails clearly when the tenant id isn't configured", async () => {
    vi.stubEnv("AZURE_AD_TENANT_ID", "");
    await expect(refreshGraphTokens("old-refresh", refreshOk())).rejects.toThrow(
      /AZURE_AD_TENANT_ID/,
    );
  });
});

describe("freshGraphTokens", () => {
  it("keeps a token that has more than the margin left", async () => {
    const fetchFn = refreshOk();
    const current = tokens(REFRESH_MARGIN_SECONDS + 60);
    expect(await freshGraphTokens(current, fetchFn)).toBe(current);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refreshes a token inside the margin", async () => {
    const result = await freshGraphTokens(tokens(REFRESH_MARGIN_SECONDS - 60), refreshOk());
    expect(result.accessToken).toBe("new-access");
  });

  it("refreshes an expired token", async () => {
    const result = await freshGraphTokens(tokens(-60), refreshOk());
    expect(result.accessToken).toBe("new-access");
  });
});

describe("getGraphAccessToken", () => {
  it("returns a valid token from the session cookie without calling Entra", async () => {
    await useSessionCookie(tokens(3600));
    const fetchFn = refreshOk();
    expect(await getGraphAccessToken(fetchFn)).toBe("old-access");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reads the __Secure- cookie used over https", async () => {
    await useSessionCookie(tokens(3600), SECURE_COOKIE);
    expect(await getGraphAccessToken(refreshOk())).toBe("old-access");
  });

  it("refreshes an expired token", async () => {
    await useSessionCookie(tokens(-60));
    expect(await getGraphAccessToken(refreshOk())).toBe("new-access");
  });

  it("fails with refresh-failed when Entra refuses the refresh", async () => {
    await useSessionCookie(tokens(-60));
    const fetchFn = vi.fn(async () => jsonResponse(400, { error: "invalid_grant" }));
    await expect(getGraphAccessToken(fetchFn)).rejects.toMatchObject({
      reason: "refresh-failed",
    });
  });

  it("fails with signed-out when there's no session cookie", async () => {
    headersMock.mockResolvedValue(new Headers());
    await expect(getGraphAccessToken(refreshOk())).rejects.toMatchObject({
      reason: "signed-out",
    });
  });

  it("fails with signed-out when the session has no Graph token", async () => {
    await useSessionCookie(undefined);
    await expect(getGraphAccessToken(refreshOk())).rejects.toMatchObject({
      reason: "signed-out",
    });
  });

  it("fails with signed-out when the cookie was encrypted with another secret", async () => {
    await useSessionCookie(tokens(3600));
    vi.stubEnv("AUTH_SECRET", "a-different-secret-also-32-characters");
    await expect(getGraphAccessToken(refreshOk())).rejects.toMatchObject({
      reason: "signed-out",
    });
  });

  it("is unavailable under the auth bypass, without reading the session", async () => {
    vi.stubEnv("E2E_AUTH_BYPASS", "true");
    await expect(getGraphAccessToken(refreshOk())).rejects.toMatchObject({
      reason: "unavailable",
    });
    expect(headersMock).not.toHaveBeenCalled();
  });
});
