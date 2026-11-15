import { runMigrations } from "@/db/migrate";

/**
 * Node.js server startup: telemetry when configured, then migrations in production.
 * A failed migration exits the process so the container never serves traffic
 * against an out-of-date schema.
 */
export async function startNodeServer(): Promise<void> {
  if (process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"]) {
    const { useAzureMonitor: enableAzureMonitor } = await import("@azure/monitor-opentelemetry");
    const { AZURE_MONITOR_OPTIONS } = await import("@/lib/telemetry");
    enableAzureMonitor(AZURE_MONITOR_OPTIONS);
    console.info("[telemetry] Azure Monitor enabled");
  }

  if (process.env["NODE_ENV"] !== "production") return;

  try {
    await runMigrations();
    console.info("[migrate] database is up to date");
  } catch (err) {
    console.error("[migrate] failed; exiting", err);
    process.exit(1);
  }
}
