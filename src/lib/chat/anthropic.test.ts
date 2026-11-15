import { afterEach, describe, expect, it, vi } from "vitest";
import { chatClient } from "@/lib/chat/anthropic";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("chatClient", () => {
  it("keeps request bodies out of the SDK's logs even when ANTHROPIC_LOG asks for them", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("ANTHROPIC_LOG", "debug");
    expect(chatClient().logLevel).toBe("warn");
  });
});
