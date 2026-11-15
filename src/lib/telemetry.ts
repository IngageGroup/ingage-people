import type { AzureMonitorOpenTelemetryOptions } from "@azure/monitor-opentelemetry";

/**
 * Postgres spans record the SQL text only. With enhanced reporting they would also record
 * parameter values, which include the question (keyword search) and chunk text (ingest).
 */
const postgreSql = { enabled: true, enhancedDatabaseReporting: false };

/**
 * Telemetry that can't carry question or answer text. Spans record URLs, status codes,
 * timings, and parameterized SQL; never request or response bodies, headers, or query values.
 * Console output isn't collected (Container Apps keeps stdout, which `describeError` keeps
 * clean). Instrumentations for stores this app doesn't use are off.
 */
export const AZURE_MONITOR_OPTIONS: AzureMonitorOpenTelemetryOptions = {
  instrumentationOptions: {
    http: { enabled: true },
    azureSdk: { enabled: true },
    postgreSql,
    console: { enabled: false },
    bunyan: { enabled: false },
    winston: { enabled: false },
    mongoDb: { enabled: false },
    mySql: { enabled: false },
    redis: { enabled: false },
    redis4: { enabled: false },
  },
};
