/** Runs once per server start, before requests are served. */
export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;
  const { startNodeServer } = await import("@/instrumentation-node");
  await startNodeServer();
}
