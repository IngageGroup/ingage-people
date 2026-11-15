import Anthropic from "@anthropic-ai/sdk";

/**
 * The Claude client for chat requests. The log level is pinned to "warn" because "debug" and
 * "info" (also reachable through ANTHROPIC_LOG) log request and response bodies, which hold
 * the question, the passages, and the answer.
 */
export function chatClient(): Anthropic {
  return new Anthropic({ logLevel: "warn" });
}
