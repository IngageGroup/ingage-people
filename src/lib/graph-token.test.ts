import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cookieHeader, getTokenMock } = vi.hoisted(() => ({
  cookieHeader: { value: "" },
  getTokenMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: cookieHeader.value }),
}));

vi.mock("next-auth/jwt", () => ({ getToken: getTokenMock }));

import {
  GRAPH_SCOPES,
  GraphTokenError,
  getGraphAccessToken,
  graphTokenFromAccount,
  needsRefresh,
  readGraphToken,
  refreshGraphToken,
} from "@/lib/graph-token";

const NOW_MS = Date.UTC(2026, 10, 15, 12, 0, 0);
const NOW_S = NOW_MS / 1000;
const fetchMock = vi.fn();

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW_MS, toFake: ["Date"] });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("AZURE_AD_TENANT_ID", "tenant-1");
  vi.stubEnv("AZURE_AD_CLIENT_ID", "client-1");
  vi.stubEnv("AZURE_AD_CLIENT_SECRET", "secret-1");
  vi.stubEnv("AUTH_SECRET", "auth-secret");
  vi.stubEnv("E2E_AUTH_BYPASS", "");
  cookieHeader.value = "authjs.session-token=abc";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchMock.mockReset();
  getTokenMock.mockReset();
});

describe("GRAPH_SCOPES", () => {
  it("asks for a refresh token and only read permissions", () => {
    expect(GRAPH_SCOPES).toContain("offline_access");
    expect(GRAPH_SCOPES.filter((s) => /Write|Send/i.test(s))).toEqual([]);
  });
});

describe("graphTokenFromAccount", () => {
  it("keeps the access token, refresh token and expiry from sign-in", () => {
    expect(
      graphTokenFromAccount({ access_token: "at", refresh_token: "rt", expires_at: NOW_S + 3600 }),
    ).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: NOW_S + 3600 });
  });

  it("returns null when Entra didn't return a refresh token", () => {
    expect(graphTokenFromAccount({ access_token: "at", expires_at: NOW_S + 3600 })).toBeNull();
  });

  it("returns null when there's no access token or expiry", () => {
    expect(graphTokenFromAccount({ refresh_token: "rt", expires_at: NOW_S })).toBeNull();
    expect(graphTokenFromAccount({ access_token: "at", refresh_token: "rt" })).toBeNull();
  });
});

describe("readGraphToken", () => {
  it("returns a well-formed token set", () => {
    const set = { accessToken: "at", refreshToken: "rt", expiresAt: NOW_S };
    expect(readGraphToken(set)).toEqual(set);
  });

  it("returns null for anything else", () => {
    expect(readGraphToken(undefined)).toBeNull();
    expect(readGraphToken("at")).toBeNull();
    expect(readGraphToken({ accessToken: "at", refreshToken: "rt" })).toBeNull();
    expect(readGraphToken({ accessToken: "", refreshToken: "rt", expiresAt: NOW_S })).toBeNull();
    expect(readGraphToken({ accessToken: "at", refreshToken: 1, expiresAt: NOW_S })).toBeNull();
  });
});

describe("needsRefresh", () => {
  it("is false while more than a minute is left", () => {
    expect(needsRefresh({ accessToken: "a", refreshToken: "r", expiresAt: NOW_S + 61 })).toBe(
      false,
    );
  });

  it("is true within a minute of expiry, and after it", () => {
    expect(needsRefresh({ accessToken: "a", refreshToken: "r", expiresAt: NOW_S + 60 })).toBe(true);
    expect(needsRefresh({ accessToken: "a", refreshToken: "r", expiresAt: NOW_S - 1 })).toBe(true);
  });
});

describe("refreshGraphToken", () => {
  it("posts a refresh_token grant to the tenant's token endpoint", async () => {
    fetchMock.mockResolvedValue(
      tokenResponse({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }),
    );

    await refreshGraphToken("old-rt");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
    const body = new URLSearchParams(init.body as string);
    expect(init.method).toBe("POST");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-rt");
    expect(body.get("client_id")).toBe("client-1");
    expect(body.get("client_secret")).toBe("secret-1");
    expect(body.get("scope")).toBe(GRAPH_SCOPES.join(" "));
  });

  it("returns the new tokens with an absolute expiry", async () => {
    fetchMock.mockResolvedValue(
      tokenResponse({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }),
    );
    expect(await refreshGraphToken("old-rt")).toEqual({
      accessToken: "new-at",
      refreshToken: "new-rt",
      expiresAt: NOW_S + 3600,
    });
  });

  it("keeps the old refresh token when Entra doesn't send a new one", async () => {
    fetchMock.mockResolvedValue(tokenResponse({ access_token: "new-at", expires_in: 3600 }));
    expect((await refreshGraphToken("old-rt")).refreshToken).toBe("old-rt");
  });

  it("throws a refresh-failed error that names the Entra error but not the tokens", async () => {
    fetchMock.mockResolvedValue(
      tokenResponse({ error: "invalid_grant", error_description: "AADSTS70043: expired" }, 400),
    );

    const error = await refreshGraphToken("old-rt").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GraphTokenError);
    expect((error as GraphTokenError).reason).toBe("refresh-failed");
    expect((error as Error).message).toContain("400");
    expect((error as Error).message).toContain("invalid_grant");
    expect((error as Error).message).not.toContain("old-rt");
  });

  it("throws refresh-failed when the token endpoint can't be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(refreshGraphToken("old-rt")).rejects.toMatchObject({ reason: "refresh-failed" });
  });

  it("throws refresh-failed when a 200 response has no access token", async () => {
    fetchMock.mockResolvedValue(tokenResponse({ expires_in: 3600 }));
    await expect(refreshGraphToken("old-rt")).rejects.toMatchObject({ reason: "refresh-failed" });
  });
});

describe("getGraphAccessToken", () => {
  it("is unavailable under the auth bypass, without reading the session", async () => {
    vi.stubEnv("E2E_AUTH_BYPASS", "true");
    await expect(getGraphAccessToken()).rejects.toMatchObject({ reason: "unavailable" });
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it("returns the session's access token while it's still valid", async () => {
    getTokenMock.mockResolvedValue({
      graph: { accessToken: "at", refreshToken: "rt", expiresAt: NOW_S + 3600 },
    });

    expect(await getGraphAccessToken()).toBe("at");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired access token", async () => {
    getTokenMock.mockResolvedValue({
      graph: { accessToken: "old-at", refreshToken: "rt", expiresAt: NOW_S - 10 },
    });
    fetchMock.mockResolvedValue(tokenResponse({ access_token: "new-at", expires_in: 3600 }));

    expect(await getGraphAccessToken()).toBe("new-at");
  });

  it("propagates a failed refresh", async () => {
    getTokenMock.mockResolvedValue({
      graph: { accessToken: "old-at", refreshToken: "rt", expiresAt: NOW_S - 10 },
    });
    fetchMock.mockResolvedValue(tokenResponse({ error: "invalid_grant" }, 400));

    await expect(getGraphAccessToken()).rejects.toMatchObject({ reason: "refresh-failed" });
  });

  it("is signed-out when there's no session cookie", async () => {
    getTokenMock.mockResolvedValue(null);
    await expect(getGraphAccessToken()).rejects.toMatchObject({ reason: "signed-out" });
  });

  it("is signed-out when the session has no Graph token", async () => {
    getTokenMock.mockResolvedValue({ email: "a@x.com" });
    await expect(getGraphAccessToken()).rejects.toMatchObject({ reason: "signed-out" });
  });

  it("is signed-out when the session's Graph token is malformed", async () => {
    getTokenMock.mockResolvedValue({ graph: { accessToken: "at" } });
    await expect(getGraphAccessToken()).rejects.toMatchObject({ reason: "signed-out" });
  });

  it("fails with a config error when AUTH_SECRET is unset", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    await expect(getGraphAccessToken()).rejects.toThrow(/AUTH_SECRET/);
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it("reads the plain cookie locally", async () => {
    getTokenMock.mockResolvedValue(null);
    await getGraphAccessToken().catch(() => undefined);
    expect(getTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ secret: "auth-secret", secureCookie: false }),
    );
  });

  it("reads the __Secure- cookie behind HTTPS", async () => {
    cookieHeader.value = "__Secure-authjs.session-token=abc";
    getTokenMock.mockResolvedValue(null);
    await getGraphAccessToken().catch(() => undefined);
    expect(getTokenMock).toHaveBeenCalledWith(expect.objectContaining({ secureCookie: true }));
  });
});
