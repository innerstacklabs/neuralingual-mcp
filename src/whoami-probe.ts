/**
 * nl#599 — read-only login probe behind `nl whoami --no-refresh`.
 *
 * Answers "is this stored login still valid?" WITHOUT ever rotating it.
 * The refresh token is single-use: one `/auth/refresh` call invalidates the
 * previous pair, so a status check that refreshes can lock out any other
 * process (e.g. a long-running MCP server) that still holds the old pair
 * (lifeos#1252). That is why this module deliberately does NOT import
 * `user-client.ts` (home of `tryRefresh()`), has no refresh code path, and
 * never writes `auth.json`.
 *
 * Exit-code contract (pass / fail / unknown):
 *   0 = valid    — `GET /auth/me` with the stored access token returned 200
 *   1 = invalid  — 401 from the server, or the token's `exp` is already past
 *   2 = unknown  — no auth file, network error, timeout, 5xx or any other
 *                  response that does not say whether the token is good
 *
 * Everything external is injected so the decision table is unit-testable
 * without a network, a clock or a real auth file.
 */
import { loadAuth } from './auth-store.js';
import type { AuthData } from './auth-store.js';
import { API_BASE_URLS } from './types.js';

export type ProbeStatus = 'valid' | 'invalid' | 'unknown';

export interface ProbeResult {
  status: ProbeStatus;
  /** Process exit code: 0 valid, 1 invalid, 2 unknown. */
  exitCode: 0 | 1 | 2;
  /** Human-readable one-liner (or two lines when valid). Never contains a token. */
  message: string;
}

export interface ProbeDeps {
  loadAuth: () => AuthData | null;
  fetchFn: typeof fetch;
  /** Current time in epoch milliseconds. */
  now: () => number;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const EXIT_CODE: Record<ProbeStatus, 0 | 1 | 2> = { valid: 0, invalid: 1, unknown: 2 };

function result(status: ProbeStatus, message: string): ProbeResult {
  return { status, exitCode: EXIT_CODE[status], message };
}

/**
 * Read the `exp` claim (epoch SECONDS) from a JWT payload without verifying the
 * signature — this is only used to short-circuit an obviously expired token and
 * to display the expiry; the server's answer is what decides validity.
 * Returns null for anything that is not a decodable JWT with a numeric `exp`.
 */
export function decodeJwtExp(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null) return null;
    const exp = (payload as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/** Pull `user.id` out of a `/auth/me` body, or null if the shape is unexpected. */
function extractUserId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const user = (body as { user?: unknown }).user;
  if (typeof user !== 'object' || user === null) return null;
  const id = (user as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Probe the stored login. Makes at most ONE request, to `GET /auth/me`, and
 * never anything else.
 */
export async function probeToken(deps: ProbeDeps): Promise<ProbeResult> {
  const auth = deps.loadAuth();
  if (!auth) {
    return result('unknown', 'Not logged in: no stored credentials found. Run `nl login`.');
  }

  const exp = decodeJwtExp(auth.accessToken);
  const expiryText = exp === null ? 'unknown (token is not a decodable JWT)' : new Date(exp * 1000).toISOString();

  if (exp !== null && exp * 1000 <= deps.now()) {
    return result('invalid', `Access token expired at ${expiryText}. Run \`nl login\` to sign in again.`);
  }

  const baseUrl = API_BASE_URLS[auth.env];
  if (!baseUrl) {
    return result('unknown', `Unrecognised environment in stored credentials: ${String(auth.env)}.`);
  }

  let res: Response;
  try {
    res = await deps.fetchFn(`${baseUrl}/auth/me`, {
      method: 'GET',
      // The API reads the JWT from X-Access-Token (apps/api authMiddleware), NOT Authorization.
      headers: { 'X-Access-Token': auth.accessToken },
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.name : 'error';
    return result('unknown', `Could not reach ${baseUrl} (${reason}); token state unknown.`);
  }

  if (res.status === 401) {
    return result('invalid', 'Server rejected the access token (401). Run `nl login` to sign in again.');
  }
  if (!res.ok) {
    return result('unknown', `Unexpected response from /auth/me (HTTP ${res.status}); token state unknown.`);
  }

  let userId: string | null = null;
  try {
    userId = extractUserId(await res.json());
  } catch {
    // 200 with an unreadable body still proves the token was accepted.
  }
  return result('valid', `Valid. User ID: ${userId ?? auth.userId}\nAccess token expires: ${expiryText}`);
}

/** Probe with the real auth store, global fetch and wall clock. */
export async function probeStoredToken(): Promise<ProbeResult> {
  try {
    return await probeToken({ loadAuth, fetchFn: fetch, now: Date.now });
  } catch {
    // Never let an unexpected throw surface as Node's default exit 1, which
    // callers would read as "invalid". Anything unplanned is "unknown".
    return result('unknown', 'Unexpected error while probing the stored login; token state unknown.');
  }
}
