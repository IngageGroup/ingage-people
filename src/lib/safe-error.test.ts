import { APIError } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { describeError, SafeError } from "@/lib/safe-error";

const QUESTION = "is my manager allowed to read my medical leave note";

describe("describeError", () => {
  it("keeps the message of an error marked safe", () => {
    expect(describeError(new SafeError("VOYAGE_API_KEY is not set"))).toBe(
      "SafeError: VOYAGE_API_KEY is not set",
    );
  });

  it("keeps a safe error's cause, described the same way", () => {
    const err = new SafeError("Topic check failed", { cause: new Error(QUESTION) });
    expect(describeError(err)).toBe("SafeError: Topic check failed (cause: Error)");
  });

  it("drops the message of any other error", () => {
    const text = describeError(new Error(`bad input: ${QUESTION}`));
    expect(text).toBe("Error");
    expect(text).not.toContain(QUESTION);
  });

  it("keeps an Anthropic API error's status, type, code, and request id, not its message", () => {
    const err = new APIError(
      400,
      { type: "error", error: { type: "invalid_request_error", message: QUESTION } },
      QUESTION,
      new Headers({ "request-id": "req_123" }),
    );
    const text = describeError(err);

    expect(text).toContain("status=400");
    expect(text).toContain("type=invalid_request_error");
    expect(text).toContain("requestId=req_123");
    expect(text).not.toContain(QUESTION);
  });

  it("keeps a database error's SQLSTATE code, not its message or detail", () => {
    const err = Object.assign(new Error(`syntax error near "${QUESTION}"`), {
      code: "42601",
      detail: QUESTION,
    });
    expect(describeError(err)).toBe("Error code=42601");
  });

  it("describes things that aren't errors by their type", () => {
    expect(describeError(QUESTION)).toBe("non-error string");
    expect(describeError(undefined)).toBe("non-error undefined");
  });
});
