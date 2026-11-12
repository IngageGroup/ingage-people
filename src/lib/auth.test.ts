import { afterEach, describe, expect, it, vi } from "vitest";

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));

vi.mock("next-auth", () => ({
  default: () => ({ handlers: {}, auth: authMock }),
}));

vi.mock("next-auth/providers/microsoft-entra-id", () => ({
  default: () => ({}),
}));

import { getCurrentUserEmail, isAllowedEmail } from "@/lib/auth";

afterEach(() => {
  vi.unstubAllEnvs();
  authMock.mockReset();
});

describe("isAllowedEmail", () => {
  it("defaults to ingagepartners.com when ALLOWED_EMAIL_DOMAIN is unset", () => {
    delete process.env["ALLOWED_EMAIL_DOMAIN"];
    expect(isAllowedEmail("user@ingagepartners.com")).toBe(true);
    expect(isAllowedEmail("anyone@anywhere.com")).toBe(false);
  });

  it("treats an empty ALLOWED_EMAIL_DOMAIN like an unset one", () => {
    vi.stubEnv("ALLOWED_EMAIL_DOMAIN", "  ");
    expect(isAllowedEmail("anyone@anywhere.com")).toBe(false);
  });

  it("allows any email in the tenant only when ALLOWED_EMAIL_DOMAIN is *", () => {
    vi.stubEnv("ALLOWED_EMAIL_DOMAIN", "*");
    expect(isAllowedEmail("anyone@anywhere.com")).toBe(true);
    expect(isAllowedEmail(undefined)).toBe(false);
  });

  it("allows a matching domain regardless of case", () => {
    vi.stubEnv("ALLOWED_EMAIL_DOMAIN", "ingagepartners.com");
    expect(isAllowedEmail("user@ingagepartners.com")).toBe(true);
    expect(isAllowedEmail("User@INGAGEPARTNERS.COM")).toBe(true);
  });

  it("rejects other domains, including suffix look-alikes", () => {
    vi.stubEnv("ALLOWED_EMAIL_DOMAIN", "ingagepartners.com");
    expect(isAllowedEmail("user@gmail.com")).toBe(false);
    expect(isAllowedEmail("attacker@evilingagepartners.com")).toBe(false);
  });

  it("rejects non-string and empty values when a domain is configured", () => {
    vi.stubEnv("ALLOWED_EMAIL_DOMAIN", "ingagepartners.com");
    expect(isAllowedEmail(undefined)).toBe(false);
    expect(isAllowedEmail(null)).toBe(false);
    expect(isAllowedEmail("")).toBe(false);
    expect(isAllowedEmail(42)).toBe(false);
  });
});

describe("getCurrentUserEmail", () => {
  it("returns the fixed test identity under auth bypass without resolving a session", async () => {
    vi.stubEnv("E2E_AUTH_BYPASS", "true");
    expect(await getCurrentUserEmail()).toBe("e2e@example.com");
    expect(authMock).not.toHaveBeenCalled();
  });

  it("ignores auth bypass in production", async () => {
    vi.stubEnv("E2E_AUTH_BYPASS", "true");
    vi.stubEnv("NODE_ENV", "production");
    authMock.mockResolvedValue(null);
    expect(await getCurrentUserEmail()).toBeNull();
  });

  it("returns the signed-in user's email", async () => {
    vi.stubEnv("E2E_AUTH_BYPASS", "");
    authMock.mockResolvedValue({ user: { email: "a@x.com" } });
    expect(await getCurrentUserEmail()).toBe("a@x.com");
  });

  it("returns null when there is no session", async () => {
    vi.stubEnv("E2E_AUTH_BYPASS", "");
    authMock.mockResolvedValue(null);
    expect(await getCurrentUserEmail()).toBeNull();
  });
});
