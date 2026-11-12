/** Identity used for the signed-in user while the auth bypass is active. */
export const E2E_USER_EMAIL = "e2e@example.com";

/**
 * Whether the E2E/dev auth bypass is active.
 *
 * Requires E2E_AUTH_BYPASS=true and a non-production build, so a stray env var
 * on a deployed app can never disable authentication.
 */
export function isAuthBypassed(): boolean {
  return process.env["E2E_AUTH_BYPASS"] === "true" && process.env["NODE_ENV"] !== "production";
}
