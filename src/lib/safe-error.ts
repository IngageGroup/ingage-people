/**
 * An error whose message is safe to log: it never contains question, answer, or document
 * text. Throw this (or a subclass) for failures whose message helps operators.
 */
export class SafeError extends Error {
  override name = "SafeError";
}

function field(err: object, key: string): unknown {
  return (err as Record<string, unknown>)[key];
}

/** Identifying fields that upstream errors carry and that never hold user content. */
function safeFields(err: Error): string[] {
  const fields: string[] = [];
  const status = field(err, "status");
  if (typeof status === "number") fields.push(`status=${status}`);
  for (const key of ["type", "errorCode", "code"]) {
    const value = field(err, key);
    if (typeof value === "string" && value) fields.push(`${key}=${value}`);
  }
  const requestId = field(err, "requestID");
  if (typeof requestId === "string" && requestId) fields.push(`requestId=${requestId}`);
  return fields;
}

/**
 * Describes an error for logs without anything that could be a question or answer. A
 * `SafeError` keeps its message; any other error keeps only its name and identifying fields
 * (HTTP status, error type and code, SQLSTATE, request id). Upstream messages are dropped
 * because SDKs and APIs echo request content in them.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return `non-error ${typeof err}`;
  if (err instanceof SafeError) {
    const cause = err.cause === undefined ? "" : ` (cause: ${describeError(err.cause)})`;
    return `${err.name}: ${err.message}${cause}`;
  }
  return [err.name, ...safeFields(err)].join(" ");
}
