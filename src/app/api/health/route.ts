import { NextResponse } from "next/server";
import { pingDb } from "@/db";

export const dynamic = "force-dynamic";

const PING_TIMEOUT_MS = 5000;

function pingWithTimeout(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`database ping timed out after ${PING_TIMEOUT_MS} ms`)),
      PING_TIMEOUT_MS,
    );
  });
  return Promise.race([pingDb(), timeout]).finally(() => clearTimeout(timer));
}

/** Liveness/readiness for Container Apps probes. Public: see PUBLIC_PATHS in proxy.ts. */
export async function GET(): Promise<NextResponse> {
  try {
    await pingWithTimeout();
    return NextResponse.json({ status: "ok" });
  } catch (err) {
    console.error("[api/health] database ping failed", err);
    return NextResponse.json({ status: "unavailable" }, { status: 503 });
  }
}
