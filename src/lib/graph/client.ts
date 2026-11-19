import { SafeError } from "@/lib/safe-error";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type GraphFailure =
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "throttled"
  | "unavailable"
  | "failed";

/** Someone is waiting for the answer, so retries are few and short. */
const MAX_ATTEMPTS = 3;
const MAX_WAIT_SECONDS = 5;
const ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * A failed Graph call. The message holds the method, the path without its query, the
 * status, and Graph's error code; Graph's message and body are dropped because they can
 * echo file names, subjects, or message text.
 */
export class GraphError extends SafeError {
  override name = "GraphError";

  constructor(
    readonly failure: GraphFailure,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GraphRequestOptions {
  token: string;
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failureFor(status: number): GraphFailure {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 429) return "throttled";
  if (status >= 500) return "unavailable";
  return "failed";
}

async function graphErrorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === "string" ? body.error.code : "unknown";
  } catch {
    return "unknown";
  }
}

async function toError(response: Response, method: string, path: string): Promise<GraphError> {
  const code = await graphErrorCode(response);
  const where = path.split("?")[0];
  return new GraphError(
    failureFor(response.status),
    response.status,
    `Graph ${method} ${where} failed: status=${response.status} code=${code}`,
  );
}

/** Seconds to wait before retrying, or null when the response shouldn't be retried. */
function retryDelaySeconds(response: Response, attempt: number): number | null {
  const retryable = response.status === 429 || response.status >= 500;
  if (!retryable || attempt === MAX_ATTEMPTS) return null;
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter > MAX_WAIT_SECONDS ? null : retryAfter;
  }
  return (2 ** attempt * 250) / 1000;
}

/**
 * Calls Microsoft Graph as the signed-in user. Retries throttling and server errors a few
 * times, honouring `Retry-After` up to a few seconds; other failures throw `GraphError` at
 * once.
 */
export async function graphRequest(path: string, options: GraphRequestOptions): Promise<Response> {
  const { token, method = "GET", body, fetchFn = fetch, sleep = wait } = options;
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");

  for (let attempt = 1; ; attempt++) {
    const response = await fetchFn(`${GRAPH_BASE}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    if (response.ok) return response;
    const delay = retryDelaySeconds(response, attempt);
    if (delay === null) throw await toError(response, method, path);
    await sleep(delay * 1000);
  }
}

/** `graphRequest` and the parsed JSON body. */
export async function graphJson<T>(path: string, options: GraphRequestOptions): Promise<T> {
  const response = await graphRequest(path, options);
  return (await response.json()) as T;
}
