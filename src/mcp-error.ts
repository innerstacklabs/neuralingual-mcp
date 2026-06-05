/**
 * Unified MCP error model (#2867 / FIX-13, epic #2831 taxonomy item D).
 *
 * Before this module the MCP layer had three non-interoperable error models:
 *   - admin `client.ts` threw `Error & { status }`
 *   - user `user-client.ts` threw `Error & { status, resetAt?, retryAfterMs?, ... }`
 *   - the streaming SSE consumer surfaced a discriminated `StreamError` union
 *
 * `McpErrorShape` is now THE one canonical MCP failure model. The two HTTP
 * clients throw `McpError` (which *is* the shape). The streaming SSE consumer
 * keeps its ergonomic `StreamError` union for `switch(kind)` handling, but
 * every streaming failure normalizes to `McpErrorShape` at the failure
 * boundary via {@link streamErrorToMcpShape} — so classification, telemetry,
 * and retry logic see exactly one shape.
 *
 * Classification is structured (HTTP status + node network error codes), never
 * by sniffing message substrings (audit pattern E).
 *
 * This module is client-only and public-safe: no monorepo imports, no Sentry,
 * no runtime dependencies beyond the standard library.
 */

/** The one canonical MCP failure shape. */
export interface McpErrorShape {
  /**
   * Machine-readable code. One of:
   *   'http_<status>' (generic 4xx), 'rate_limited' (429),
   *   'insufficient_credits' (402), 'unauthorized' (401/403),
   *   'conflict' (409), 'server_error' (5xx), 'network', 'timeout', 'unknown'.
   */
  code: string;
  /** Human-readable message. */
  message: string;
  /** HTTP status when known; `null` for transport/network failures. */
  status: number | null;
  /**
   * Whether the failure is *semantically* transient. NOTE: a `true` here is a
   * hint for callers (e.g. the CLI's 429-aware backoff). It does NOT by itself
   * authorize the generic GET retry loop — that loop additionally requires an
   * idempotent GET and excludes 429 (see {@link isRetryableTransient}).
   */
  retryable: boolean;
}

/** Optional extras some callers depend on (preserved for back-compat). */
export interface McpErrorExtras {
  /** 429 only: epoch-ms when the cap resets, or `null` if unknown. */
  resetAt?: number | null;
  /** 429 only: milliseconds to wait before retrying. */
  retryAfterMs?: number;
  /** 429 only: which limiter fired (e.g. 'generation', 'global'). */
  source?: string;
  /** Parsed error body, when available (used by requestVoid callers). */
  data?: Record<string, unknown>;
}

/**
 * Canonical MCP error. Subclasses `Error` so callers keep `instanceof Error`
 * and `.message`, and exposes the unified `McpErrorShape` fields plus the
 * back-compat extras (`.status`, `.resetAt`, etc.) that existing call sites
 * already read.
 */
export class McpError extends Error implements McpErrorShape, McpErrorExtras {
  code: string;
  status: number | null;
  retryable: boolean;
  resetAt?: number | null;
  retryAfterMs?: number;
  source?: string;
  data?: Record<string, unknown>;

  constructor(shape: McpErrorShape, extras?: McpErrorExtras) {
    super(shape.message);
    this.name = 'McpError';
    this.code = shape.code;
    this.status = shape.status;
    this.retryable = shape.retryable;
    if (extras) {
      if (extras.resetAt !== undefined) this.resetAt = extras.resetAt;
      if (extras.retryAfterMs !== undefined) this.retryAfterMs = extras.retryAfterMs;
      if (extras.source !== undefined) this.source = extras.source;
      if (extras.data !== undefined) this.data = extras.data;
    }
  }
}

/**
 * Classify an HTTP status into a `{ code, retryable }` pair. Structured —
 * never inspects message text.
 *   - 429 → rate_limited, retryable (but excluded from the generic GET loop)
 *   - 402 → insufficient_credits, not retryable
 *   - 401/403 → unauthorized, not retryable
 *   - 409 → conflict, not retryable
 *   - other 4xx → http_<status>, not retryable
 *   - >=500 → server_error, retryable
 *   - null → unknown, not retryable (use {@link networkErrorToMcpError} for
 *     transport failures, which classify as network/timeout)
 */
export function classifyStatus(status: number | null): { code: string; retryable: boolean } {
  if (status === null) return { code: 'unknown', retryable: false };
  if (status === 429) return { code: 'rate_limited', retryable: true };
  if (status === 402) return { code: 'insufficient_credits', retryable: false };
  if (status === 401 || status === 403) return { code: 'unauthorized', retryable: false };
  if (status === 409) return { code: 'conflict', retryable: false };
  if (status >= 500) return { code: 'server_error', retryable: true };
  if (status >= 400) return { code: `http_${status}`, retryable: false };
  // 1xx–3xx shouldn't reach here (callers only classify !res.ok), but be safe.
  return { code: `http_${status}`, retryable: false };
}

/** Node/undici network error codes that indicate a transient transport failure. */
const TRANSIENT_NET_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Convert a thrown fetch/transport rejection into an `McpError`. A `fetch()`
 * rejection (no HTTP response) means we never reached the server — classify as
 * `timeout` (when the error code/name says so) or `network`. Both are
 * retryable for idempotent GETs.
 */
export function networkErrorToMcpError(cause: unknown): McpError {
  const errno =
    cause && typeof cause === 'object' && 'code' in cause
      ? String((cause as { code?: unknown }).code ?? '')
      : '';
  // undici wraps the underlying errno on `.cause`.
  const innerErrno =
    cause && typeof cause === 'object' && 'cause' in cause && (cause as { cause?: unknown }).cause &&
    typeof (cause as { cause?: unknown }).cause === 'object' &&
    'code' in ((cause as { cause: object }).cause as object)
      ? String(((cause as { cause: { code?: unknown } }).cause).code ?? '')
      : '';
  const effectiveErrno = errno || innerErrno;
  const message = cause instanceof Error ? cause.message : String(cause);
  const isTimeout =
    effectiveErrno === 'ETIMEDOUT' ||
    effectiveErrno === 'UND_ERR_CONNECT_TIMEOUT' ||
    effectiveErrno === 'UND_ERR_HEADERS_TIMEOUT' ||
    effectiveErrno === 'UND_ERR_BODY_TIMEOUT' ||
    /timed? ?out/i.test(message);
  return new McpError({
    code: isTimeout ? 'timeout' : 'network',
    message: message || (isTimeout ? 'Request timed out' : 'Network request failed'),
    status: null,
    retryable: true,
  });
}

/**
 * Is this failure eligible for the **generic GET retry loop**? Only 5xx and
 * network/timeout — explicitly NOT 429 (we honor rate limits rather than
 * hammering them) and never 4xx semantic failures.
 */
export function isRetryableTransient(err: unknown): boolean {
  if (err instanceof McpError) {
    if (err.status !== null && err.status >= 500) return true;
    return err.code === 'network' || err.code === 'timeout';
  }
  // Plain error with a transient network errno.
  if (err && typeof err === 'object' && 'code' in err) {
    return TRANSIENT_NET_CODES.has(String((err as { code?: unknown }).code ?? ''));
  }
  return false;
}

/** Normalize any thrown value into the canonical `McpError` (idempotent). */
export function toMcpError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  if (
    err &&
    typeof err === 'object' &&
    'status' in err &&
    typeof (err as { status?: unknown }).status === 'number'
  ) {
    const status = (err as { status: number }).status;
    const { code, retryable } = classifyStatus(status);
    const message = err instanceof Error ? err.message : `HTTP ${status}`;
    return new McpError({ code, message, status, retryable });
  }
  // No status → treat as a transport/network failure.
  return networkErrorToMcpError(err);
}
