/**
 * Shared bounded transient-retry runner for the MCP HTTP clients (#2867).
 *
 * Both `client.ts` (admin) and `user-client.ts` (user) need the same loop:
 * fetch, classify, emit telemetry on failure, and retry idempotent GETs on
 * transient (5xx/network/timeout) failures with jittered backoff. This module
 * factors that loop out so the policy lives in one place.
 *
 * The two clients differ only in HOW they fetch (the user client does a 401
 * refresh-and-retry inside the attempt) and HOW they turn a response into a
 * result/error — those are injected as callbacks.
 *
 * Client-only and public-safe: no monorepo imports, no external deps.
 */
import {
  McpError,
  isRetryableTransient,
  networkErrorToMcpError,
} from './mcp-error.js';
import { emitMcpFailure } from './mcp-telemetry.js';

/** Max retries (in addition to the first attempt) for idempotent GETs. */
export const MAX_GET_RETRIES = 2; // 3 total attempts
const RETRY_BACKOFF_MS = [150, 400];

function backoffDelay(attempt: number): number {
  const base =
    RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 400;
  // Small jitter (±20%) to avoid synchronized retries.
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Normalize a method string and report whether it is a retryable idempotent GET. */
export function normalizeMethod(method: string | undefined): { httpMethod: string; isGet: boolean } {
  const httpMethod = (method ?? 'GET').toUpperCase();
  return { httpMethod, isGet: httpMethod === 'GET' };
}

export interface GetRetryRunner<T> {
  /** Normalized HTTP method (drives whether retries happen). */
  httpMethod: string;
  /** Request path, used for telemetry (query string is stripped downstream). */
  path: string;
  /** Perform one fetch attempt. May throw on transport failure. */
  doFetch: () => Promise<Response>;
  /** Map a 2xx response to the result value. */
  onOk: (res: Response) => Promise<T>;
  /** Map a non-2xx response to a canonical McpError. */
  onError: (res: Response) => Promise<McpError>;
}

/**
 * Run a request with bounded transient retry on idempotent GETs. Emits a
 * telemetry failure event for every failed attempt (with the 1-based
 * `attempt`). Retries only when the method is GET and the failure is
 * transient (5xx / network / timeout) — never 429, never 4xx, never mutations.
 */
export async function runWithGetRetry<T>(runner: GetRetryRunner<T>): Promise<T> {
  const { httpMethod, path, doFetch, onOk, onError } = runner;
  const maxAttempts = httpMethod === 'GET' ? MAX_GET_RETRIES + 1 : 1;
  let lastError: McpError | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await doFetch();
    } catch (cause) {
      lastError = networkErrorToMcpError(cause);
      emitMcpFailure({
        method: httpMethod,
        path,
        code: lastError.code,
        status: lastError.status,
        retryable: lastError.retryable,
        attempt: attempt + 1,
      });
      if (httpMethod === 'GET' && attempt < maxAttempts - 1) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw lastError;
    }

    if (res.ok) {
      return onOk(res);
    }

    const err = await onError(res);
    lastError = err;
    emitMcpFailure({
      method: httpMethod,
      path,
      code: err.code,
      status: err.status,
      retryable: err.retryable,
      attempt: attempt + 1,
    });
    if (httpMethod === 'GET' && isRetryableTransient(err) && attempt < maxAttempts - 1) {
      await sleep(backoffDelay(attempt));
      continue;
    }
    throw err;
  }
  // Unreachable: the loop always returns or throws. Satisfy the type checker.
  throw lastError ?? new McpError({ code: 'unknown', message: 'Request failed', status: null, retryable: false });
}
