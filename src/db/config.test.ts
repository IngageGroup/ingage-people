import { describe, expect, it, vi } from "vitest";

const { credentialCtor, getTokenMock } = vi.hoisted(() => ({
  credentialCtor: vi.fn(),
  getTokenMock: vi.fn(),
}));

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn(function DefaultAzureCredential(options: unknown) {
    credentialCtor(options);
    return { getToken: getTokenMock };
  }),
}));

import { createEntraTokenProvider, getPoolConfig } from "@/db/config";

const neverCalled = () => Promise.reject(new Error("token should not be requested"));

describe("getPoolConfig", () => {
  it("uses DATABASE_URL when set, without requesting a token", () => {
    const getToken = vi.fn(neverCalled);
    const config = getPoolConfig({ DATABASE_URL: "postgres://u:p@h:5432/d" }, getToken);
    expect(config).toEqual({
      connectionString: "postgres://u:p@h:5432/d",
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
      keepAlive: true,
    });
    expect(getToken).not.toHaveBeenCalled();
  });

  it("uses PGHOST/PGDATABASE/PGUSER with an Entra token as the password", async () => {
    const getToken = vi.fn().mockResolvedValue("token-1");
    const config = getPoolConfig(
      { PGHOST: "pg.example", PGDATABASE: "app", PGUSER: "id-app-dev" },
      getToken,
    );
    expect(config).toMatchObject({
      host: "pg.example",
      database: "app",
      user: "id-app-dev",
      port: 5432,
      ssl: true,
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
      keepAlive: true,
    });
    expect(typeof config.password).toBe("function");
  });

  it("requests a fresh token for every new connection", async () => {
    const getToken = vi.fn().mockResolvedValueOnce("token-1").mockResolvedValueOnce("token-2");
    const config = getPoolConfig({ PGHOST: "h", PGDATABASE: "d", PGUSER: "u" }, getToken);
    const password = config.password as () => Promise<string>;
    expect(await password()).toBe("token-1");
    expect(await password()).toBe("token-2");
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it("explains both connection modes when nothing is configured", () => {
    expect(() => getPoolConfig({}, neverCalled)).toThrow(/DATABASE_URL[\s\S]*PGHOST/);
  });

  it("names the missing variables when Azure mode is partly configured", () => {
    expect(() => getPoolConfig({ PGHOST: "h" }, neverCalled)).toThrow(/PGDATABASE, PGUSER/);
  });
});

describe("createEntraTokenProvider", () => {
  it("does not create an Azure credential until a token is requested", () => {
    credentialCtor.mockClear();
    createEntraTokenProvider("client-id");
    expect(credentialCtor).not.toHaveBeenCalled();
  });

  it("requests a Postgres-scoped token with the managed identity's client id", async () => {
    credentialCtor.mockClear();
    getTokenMock.mockResolvedValue({ token: "abc" });
    const getToken = createEntraTokenProvider("client-id");
    expect(await getToken()).toBe("abc");
    expect(await getToken()).toBe("abc");
    expect(credentialCtor).toHaveBeenCalledOnce();
    expect(credentialCtor).toHaveBeenCalledWith({ managedIdentityClientId: "client-id" });
    expect(getTokenMock).toHaveBeenCalledWith("https://ossrdbms-aad.database.windows.net/.default");
  });
});
