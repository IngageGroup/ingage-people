import { afterEach, describe, expect, it, vi } from "vitest";
import { isAuthBypassed } from "@/lib/e2e-bypass";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isAuthBypassed", () => {
  it("is false when E2E_AUTH_BYPASS is not set", () => {
    vi.stubEnv("E2E_AUTH_BYPASS", "");
    expect(isAuthBypassed()).toBe(false);
  });

  it("is true outside production when E2E_AUTH_BYPASS=true", () => {
    vi.stubEnv("E2E_AUTH_BYPASS", "true");
    expect(isAuthBypassed()).toBe(true);
  });

  it("is false in production even when E2E_AUTH_BYPASS=true", () => {
    vi.stubEnv("E2E_AUTH_BYPASS", "true");
    vi.stubEnv("NODE_ENV", "production");
    expect(isAuthBypassed()).toBe(false);
  });
});
