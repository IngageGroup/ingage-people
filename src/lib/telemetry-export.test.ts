import { gunzipSync } from "node:zlib";
import { AzureMonitorTraceExporter } from "@azure/monitor-opentelemetry-exporter";
import { afterEach, describe, expect, it, vi } from "vitest";

type ReadableSpan = Parameters<AzureMonitorTraceExporter["export"]>[0][number];

/** `SpanKind.SERVER` and `SpanStatusCode.UNSET` from `@opentelemetry/api`. */
const SERVER = 1;
const UNSET = 0;

/**
 * The incoming-request span `@opentelemetry/instrumentation-http` 0.221 records for the Entra
 * sign-in callback: `url.query` holds the authorization code, unredacted (GHSA-3v2p-hm54-8qcq).
 */
const CALLBACK_SPAN = {
  name: "GET",
  kind: SERVER,
  spanContext: () => ({
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: 1,
  }),
  startTime: [1_763_600_000, 0],
  endTime: [1_763_600_000, 5_000_000],
  duration: [0, 5_000_000],
  status: { code: UNSET },
  attributes: {
    "http.request.method": "GET",
    "url.scheme": "https",
    "server.address": "people.example.com",
    "url.path": "/api/auth/callback/microsoft-entra-id",
    "url.query": "code=SECRET-AUTH-CODE&state=SECRET-STATE",
    "http.response.status_code": 302,
  },
  links: [],
  events: [],
  ended: true,
  resource: { attributes: {} },
  instrumentationScope: { name: "@opentelemetry/instrumentation-http" },
  droppedAttributesCount: 0,
  droppedEventsCount: 0,
  droppedLinksCount: 0,
} as unknown as ReadableSpan;

/** Stands in for the network: records each body the exporter sends to the ingestion endpoint. */
function capturingClient() {
  const sent: string[] = [];
  const httpClient = {
    async sendRequest(request: {
      body?: unknown;
      headers: { get(name: string): string | undefined };
    }) {
      const body = Buffer.from(request.body as Uint8Array);
      const gzipped = request.headers.get("content-encoding") === "gzip";
      sent.push((gzipped ? gunzipSync(body) : body).toString("utf8"));
      return {
        request,
        status: 200,
        headers: { get: () => undefined, has: () => false, toJSON: () => ({}) },
        bodyAsText: JSON.stringify({ itemsReceived: 1, itemsAccepted: 1, errors: [] }),
      };
    },
  };
  return { sent, httpClient };
}

afterEach(() => vi.unstubAllEnvs());

describe("Azure Monitor export", () => {
  it("never sends an incoming request's query string to Application Insights", async () => {
    vi.stubEnv("APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL", "true");
    const { sent, httpClient } = capturingClient();
    const exporter = new AzureMonitorTraceExporter({
      connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
      disableOfflineStorage: true,
      httpClient: httpClient as never,
    });
    const result = await new Promise<{ code: number }>((resolve) =>
      exporter.export([CALLBACK_SPAN], resolve),
    );
    await exporter.shutdown();

    expect(result.code).toBe(0);
    const body = sent.join("\n");
    expect(body).toContain("/api/auth/callback/microsoft-entra-id");
    expect(body).not.toContain("SECRET");
  });
});
