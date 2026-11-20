import { runMigrations } from "@/db/migrate";
import { chatSkills } from "@/lib/chat/skills";

/**
 * Node.js server startup: telemetry when configured, the chat skills, then migrations in
 * production. A broken skill file or a failed migration exits the process so the container
 * never serves traffic it can't answer.
 */
export async function startNodeServer(): Promise<void> {
  if (process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"]) {
    const { useAzureMonitor: enableAzureMonitor } = await import("@azure/monitor-opentelemetry");
    const { AZURE_MONITOR_OPTIONS } = await import("@/lib/telemetry");
    enableAzureMonitor(AZURE_MONITOR_OPTIONS);
    console.info("[telemetry] Azure Monitor enabled");
  }

  try {
    chatSkills();
  } catch (err) {
    console.error("[skills] failed to load; exiting", err);
    process.exit(1);
    return;
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
