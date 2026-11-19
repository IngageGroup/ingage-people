import { describe, expect, it, vi } from "vitest";
import { GRAPH_BASE, GraphError, graphJson, graphRequest } from "@/lib/graph/client";

function respond(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function sequence(...responses: Response[]) {
  const fetchFn = vi.fn(async (_url: string, _init: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return next;
  });
  return fetchFn;
}

const noSleep = () => vi.fn(async (_ms: number) => {});

describe("graphRequest", () => {
  it("sends the bearer token to the Graph URL", async () => {
    const fetchFn = sequence(respond(200, { id: "me" }));
    await graphRequest("/me", { token: "tok", fetchFn });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${GRAPH_BASE}/me`);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
  });

  it("posts a JSON body", async () => {
    const fetchFn = sequence(respond(200));
    await graphRequest("/search/query", { token: "tok", method: "POST", body: { a: 1 }, fetchFn });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.body).toBe('{"a":1}');
  });

  it("reports 403 as forbidden without retrying", async () => {
    const fetchFn = sequence(respond(403, { error: { code: "ErrorAccessDenied" } }));
    await expect(graphRequest("/me/messages/abc", { token: "t", fetchFn })).rejects.toMatchObject({
      failure: "forbidden",
      status: 403,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("reports 404 as not-found", async () => {
    const fetchFn = sequence(respond(404));
    await expect(graphRequest("/drives/d/items/i", { token: "t", fetchFn })).rejects.toMatchObject({
      failure: "not-found",
    });
  });

  it("reports 401 as unauthorized", async () => {
    const fetchFn = sequence(respond(401));
    await expect(graphRequest("/me", { token: "t", fetchFn })).rejects.toMatchObject({
      failure: "unauthorized",
    });
  });

  it("waits Retry-After seconds on 429 and returns the retried response", async () => {
    const sleep = noSleep();
    const fetchFn = sequence(respond(429, {}, { "retry-after": "1" }), respond(200, { ok: 1 }));
    const response = await graphRequest("/me", { token: "t", fetchFn, sleep });
    expect(response.status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("fails at once as throttled when Retry-After is longer than a person should wait", async () => {
    const sleep = noSleep();
    const fetchFn = sequence(respond(429, {}, { "retry-after": "120" }));
    await expect(graphRequest("/me", { token: "t", fetchFn, sleep })).rejects.toMatchObject({
      failure: "throttled",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up as unavailable after three 5xx responses", async () => {
    const fetchFn = sequence(respond(503), respond(503), respond(503));
    await expect(
      graphRequest("/me", { token: "t", fetchFn, sleep: noSleep() }),
    ).rejects.toMatchObject({ failure: "unavailable" });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("reports other 4xx as failed without retrying", async () => {
    const fetchFn = sequence(respond(400, { error: { code: "BadRequest" } }));
    await expect(graphRequest("/me", { token: "t", fetchFn })).rejects.toMatchObject({
      failure: "failed",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("puts only method, path, status and Graph's code in the error message", async () => {
    const fetchFn = sequence(
      respond(403, { error: { code: "ErrorAccessDenied", message: "secret subject" } }),
    );
    const error = await graphRequest("/me/messages/abc?$select=body", {
      token: "t",
      fetchFn,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphError);
    expect((error as Error).message).toBe(
      "Graph GET /me/messages/abc failed: status=403 code=ErrorAccessDenied",
    );
  });

  it("uses code=unknown when the error body isn't Graph JSON", async () => {
    const fetchFn = sequence(new Response("<html>gateway</html>", { status: 400 }));
    const error = await graphRequest("/me", { token: "t", fetchFn }).catch((e: unknown) => e);
    expect((error as Error).message).toBe("Graph GET /me failed: status=400 code=unknown");
  });
});

describe("graphJson", () => {
  it("returns the parsed body", async () => {
    const fetchFn = sequence(respond(200, { displayName: "A" }));
    expect(await graphJson<{ displayName: string }>("/me", { token: "t", fetchFn })).toEqual({
      displayName: "A",
    });
  });
});
