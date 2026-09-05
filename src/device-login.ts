/**
 * RFC 8628 device-authorization login for the `nl` CLI (nl#421).
 *
 * `nl login` used to bind a loopback HTTP server on the CLI host and have the
 * browser POST tokens back to `127.0.0.1:<port>`. Over ssh the browser's
 * loopback is a different machine, so logging in on a headless box needed a
 * manual reverse tunnel and a copied port number. This flow replaces that with
 * a code the human carries between the two machines.
 *
 * ⛔ ONE RULE GOVERNS EVERYTHING BELOW: a login is saved only when the HTTP
 * STATUS and the validated PAYLOAD agree. Status alone would accept an OAuth
 * error body served with 200; payload alone would accept a token-shaped body
 * served with 400. Either gap turns a failure into a login, which for an auth
 * path is the worst direction to be wrong in. See `classifyTokenResponse`.
 *
 * ⚠️ This file is SYNCED to the standalone public repo
 * (`scripts/sync-public-mcp.sh`), which has no pnpm workspace. It may import
 * only sibling synced modules, external npm deps and node builtins — never
 * `@neuralingual/*`. That is why the user code arrives pre-formatted from the
 * server rather than being formatted here.
 */

import { z } from 'zod';
import { API_BASE_URLS } from './types.js';
import type { ApiEnv } from './types.js';
import { saveAuth } from './auth-store.js';
import { emitMcpFailure } from './mcp-telemetry.js';

/** Per-request timeout. A hung request must not eat the whole login window. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Consecutive transient failures tolerated before giving up. */
const MAX_TRANSIENT_FAILURES = 3;

/** Ceiling for the transient-failure backoff, seconds. */
const MAX_BACKOFF_SECONDS = 60;

/** RFC 8628 §3.5 — the minimum the client must add to its interval on a `slow_down`. */
const SLOW_DOWN_INCREMENT_SECONDS = 5;

/**
 * Ceiling on any interval, however the server got there.
 *
 * ⛔ The `slow_down` ratchet takes `max(current + 5, server suggestion)`, and
 * the suggestion is server-controlled: `{"error":"slow_down","interval":86400}`
 * would park the CLI for a day inside a 10-minute window. Bounded here so a
 * bad or hostile value can cost at most one skipped poll rather than the whole
 * login. The grant expires in 600s, so anything above that is meaningless.
 */
const MAX_INTERVAL_SECONDS = 300;

// ---------------------------------------------------------------------------
// Headless detection
// ---------------------------------------------------------------------------

/**
 * Should `nl login` default to the device flow?
 *
 * True when the loopback callback cannot work, i.e. the browser that will open
 * is not on this machine:
 *   - any `SSH_*` connection variable is set — the shell arrived over ssh;
 *   - or, on Linux only, neither `DISPLAY` nor `WAYLAND_DISPLAY` is set, so
 *     there is no local display server to open a browser on.
 *
 * ⛔ The display test is Linux-only on purpose. macOS never sets `DISPLAY` and
 * has a perfectly good browser, so applying that rule everywhere would push
 * every Mac user onto the device flow — a worse experience than the loopback
 * one they have today. Pure and exported so the matrix is unit-testable.
 */
export function isHeadlessEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  if (env['SSH_CONNECTION'] || env['SSH_CLIENT'] || env['SSH_TTY']) return true;
  if (platform !== 'linux') return false;
  return !env['DISPLAY'] && !env['WAYLAND_DISPLAY'];
}

/**
 * Resolve which login flow `nl login` should run.
 *
 * ⚠️ Lives HERE rather than in `cli.ts` because `cli.ts` carries the rule twice
 * — once live and once inside a `@public-only` comment block that the PUBLISHED
 * CLI compiles. Two hand-maintained copies of a detection rule is how the
 * published binary silently keeps old behaviour after someone edits only the
 * copy they can see. One definition, one unit test, two call sites that just
 * call it.
 */
export function shouldUseDeviceFlow(
  opts: { device?: boolean; browser?: boolean },
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  if (opts.device) return true;
  if (opts.browser) return false;
  return isHeadlessEnvironment(env, platform);
}

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

const deviceCodeResponseSchema = z.object({
  deviceCode: z.string().min(1),
  userCode: z.string().min(1),
  verificationUrl: z.string().min(1),
  verificationUrlComplete: z.string().min(1).optional(),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
});

export type DeviceCodeResponse = z.infer<typeof deviceCodeResponseSchema>;

/**
 * The success payload. `.passthrough()` on `user` is deliberate — the user DTO
 * grows fields regularly and the CLI must not break each time. The tokens
 * themselves are required, so a partial success cannot slip through.
 */
const tokenSuccessSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  user: z
    .object({
      id: z.string().min(1),
      email: z.string().nullable().optional(),
      displayName: z.string().nullable().optional(),
      creditBalance: z.number().optional(),
    })
    .passthrough(),
});

export type TokenSuccess = z.infer<typeof tokenSuccessSchema>;

/**
 * ⛔ `error` must look like an OAuth error CODE, not prose.
 *
 * RFC 6749 §5.2 error codes are lowercase snake_case tokens. This repo also
 * returns 503 bodies whose `error` is a human SENTENCE — the rate limiter's
 * fail-closed path sends `{ error: 'Service temporarily unavailable', message:
 * '...' }` (`apps/api/src/lib/rateLimit.ts`). Without this pattern that string
 * parses as a verdict, lands in `PollAction.code`, and aborts a login the human
 * may have already approved, over a transient Redis blip that deserved a retry.
 *
 * ⚠️ This is a consequence of the round-1 fix ("a parseable OAuth error body is
 * a verdict, whatever the status carries it"). That rule is right; it just has
 * to know what an OAuth error actually looks like. A sentence is not a code.
 */
const OAUTH_ERROR_CODE = /^[a-z_]+$/;

const tokenErrorSchema = z.object({
  error: z.string().regex(OAUTH_ERROR_CODE),
  error_description: z.string().optional(),
  interval: z.number().int().positive().optional(),
});

/** Poll outcomes the CLI acts on. */
export type PollAction =
  | { kind: 'success'; tokens: TokenSuccess }
  | { kind: 'pending' }
  | { kind: 'slow_down'; suggestedInterval?: number }
  | { kind: 'fatal'; message: string; code?: string }
  | { kind: 'transient'; message: string };

/**
 * What to say when the code turns out to be spent AFTER we failed to reach the
 * server. The plain `invalid_grant` message blames the user for a replay they
 * did not perform.
 *
 * ⛔ These are different realities that would otherwise share one observable: a
 * genuine reuse, versus "the server consumed the grant, then something failed,
 * and the response never reached us". The second is not the user's doing, and
 * telling them it was sends them looking in the wrong place.
 */
const UNCONFIRMED_COMPLETION_MESSAGE =
  'Lost contact with the server while signing in, and the login code has since been ' +
  'consumed. No credentials were received, so nothing was saved — run `nl login` again.';

/** Human text per RFC error code. Keyed on the machine code, never on prose. */
const FATAL_MESSAGES: Record<string, string> = {
  expired_token:
    'The login code expired before it was approved. Run `nl login` again to get a new one.',
  access_denied: 'The login request was denied in the browser.',
  invalid_grant:
    'That login code has already been used. Run `nl login` again to get a new one.',
  invalid_request: 'The server rejected the login request as malformed.',
  server_error: 'The server could not complete the login. Run `nl login` again.',
  service_unavailable:
    'Device login is temporarily unavailable. Try again in a few minutes.',
};

/**
 * Decide what one poll response means.
 *
 * ⛔ Both halves of the dispatch rule are enforced here, and each exists
 * because the other alone is insufficient:
 *
 *   - A 200 is only a success if the body has NO `error` key AND parses as a
 *     complete token payload. The `error`-key check cannot be expressed as a
 *     zod field: a plain object schema STRIPS unknown keys, so a 200 carrying
 *     complete tokens *plus* `error: "authorization_pending"` would otherwise
 *     parse clean and log the user in off an error response. A top-level
 *     `.strict()` was rejected as the fix — it would break the CLI the first
 *     time the API adds a field.
 *   - A non-200 is never a success, whatever it carries. A token-shaped body
 *     served with 400 or 500 is a bug or an attack, not a login.
 *
 * Exported so every branch is unit-testable without a network.
 */
export function classifyTokenResponse(status: number, body: unknown): PollAction {
  const isObject = typeof body === 'object' && body !== null;
  const hasErrorKey = isObject && 'error' in (body as Record<string, unknown>);

  if (status === 200) {
    if (hasErrorKey) {
      return {
        kind: 'fatal',
        message:
          'The server returned a success status with an error body. Refusing to save these credentials.',
      };
    }
    const parsed = tokenSuccessSchema.safeParse(body);
    if (!parsed.success) {
      return {
        kind: 'fatal',
        message: 'The server returned an incomplete login response. Nothing was saved.',
      };
    }
    return { kind: 'success', tokens: parsed.data };
  }

  if (status === 429) {
    return {
      kind: 'fatal',
      message:
        'Rate limited while waiting for approval. Wait a few minutes and run `nl login` again.',
    };
  }

  // ⛔ A PARSEABLE OAuth error body is a VERDICT, whatever the status carrying
  // it — 5xx included. `500 { error: 'server_error' }` means the server already
  // consumed the grant and then failed to mint; retrying it just walks into
  // `invalid_grant` on the next poll, so the user would be told their code was
  // replayed when it was really our database that fell over. Two very different
  // realities, one final message. The server told us the truth; read it.
  const parsedError = tokenErrorSchema.safeParse(body);
  if (parsedError.success) {
    const { error, error_description: description, interval } = parsedError.data;

    if (error === 'authorization_pending') return { kind: 'pending' };
    if (error === 'slow_down') {
      // Carry the server's suggestion through verbatim; the CALLER decides the
      // new interval, because only it knows the current one (see below).
      // ⚠️ The key is OMITTED when absent rather than set to `undefined` —
      // `exactOptionalPropertyTypes` is on, and the two are not the same type.
      return interval === undefined
        ? { kind: 'slow_down' }
        : { kind: 'slow_down', suggestedInterval: interval };
    }
    return {
      kind: 'fatal',
      code: error,
      message: FATAL_MESSAGES[error] ?? description ?? `Login failed: ${error}`,
    };
  }

  // No parseable verdict. A 5xx here is an infrastructure blip — an ingress or
  // proxy returning HTML during a deploy, say — and the request produced no
  // answer at all, so retry rather than report a login failure that may not be
  // one. A 4xx without a verdict is the server refusing us in a shape we do not
  // understand; retrying that is pointless.
  if (status >= 500) {
    return { kind: 'transient', message: `Server returned HTTP ${status}.` };
  }
  return { kind: 'fatal', message: `Login failed (HTTP ${status}).` };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Injected in tests; defaults to the global fetch and a real timer. */
export interface DeviceLoginDeps {
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

export function defaultDeps(): DeviceLoginDeps {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (line) => console.log(line),
  };
}

async function postJson(
  deps: DeviceLoginDeps,
  url: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await deps.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // A body that is not JSON is not a verdict; `classifyTokenResponse` sees
  // `null` and falls through to its status-based branches.
  const parsed: unknown = await res.json().catch(() => null);
  return { status: res.status, body: parsed };
}

/** Ask the API for a device code. Throws on anything but a complete response. */
export async function requestDeviceCode(
  env: ApiEnv,
  deps: DeviceLoginDeps = defaultDeps(),
): Promise<DeviceCodeResponse> {
  const { status, body } = await postJson(
    deps,
    `${API_BASE_URLS[env]}/auth/device/code`,
    { clientType: 'cli' },
  );

  if (status !== 200) {
    const parsed = tokenErrorSchema.safeParse(body);
    const code = parsed.success ? parsed.data.error : undefined;
    throw new Error(
      (code && FATAL_MESSAGES[code]) ??
        `Could not start device login (HTTP ${status}).`,
    );
  }

  const parsed = deviceCodeResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('The server returned an incomplete device-code response.');
  }
  return parsed.data;
}

/**
 * Poll until the grant is approved, denied, or the window closes.
 *
 * The deadline is derived from `expiresIn` and re-checked around BOTH the fetch
 * and the sleep, so a slow response cannot carry the loop past it.
 */
export async function pollForDeviceToken(
  env: ApiEnv,
  grant: DeviceCodeResponse,
  deps: DeviceLoginDeps = defaultDeps(),
): Promise<TokenSuccess> {
  const url = `${API_BASE_URLS[env]}/auth/device/token`;
  const deadline = deps.now() + grant.expiresIn * 1000;
  const timedOut = () =>
    new Error('Timed out waiting for approval. Run `nl login` again to get a new code.');
  let interval = grant.interval;
  let transientFailures = 0;
  /** Status of the most recent response, for telemetry. `null` = transport failure. */
  let lastStatus: number | null = null;
  /**
   * Set once any request fails to produce a verdict. From that moment we can no
   * longer tell whether the server acted on a request we never saw the answer
   * to, so a later `invalid_grant` is ambiguous rather than a proven replay.
   */
  let hadUnverifiedAttempt = false;

  for (;;) {
    if (deps.now() >= deadline) throw timedOut();

    // ⛔ Clamped to the deadline. Sleeping the full interval past a window that
    // has already closed turns a clean timeout into a hang the user watches —
    // with a large server-suggested interval, a very long one. The clamp means
    // the loop always wakes to report the timeout at the moment it happens.
    await deps.sleep(Math.min(interval * 1000, Math.max(deadline - deps.now(), 0)));

    // Re-checked after the sleep as well: a slow response must not carry the
    // loop past the window the server already closed.
    if (deps.now() >= deadline) throw timedOut();

    let action: PollAction;
    try {
      const { status, body } = await postJson(deps, url, { deviceCode: grant.deviceCode });
      lastStatus = status;
      action = classifyTokenResponse(status, body);
    } catch (err) {
      // Network-level failure: no verdict was produced, so this is transient.
      lastStatus = null;
      action = {
        kind: 'transient',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    switch (action.kind) {
      case 'success':
        return action.tokens;
      case 'fatal': {
        // ⚠️ Reported, not just thrown. A device login fails on a headless box
        // where nobody is watching the terminal, so without this the only CLI
        // HTTP failures invisible to the telemetry sink would be the ones you
        // most want to see. Never throws into our error path (see emitMcpFailure).
        const unconfirmed = action.code === 'invalid_grant' && hadUnverifiedAttempt;
        emitMcpFailure({
          tool: 'nl_login_device',
          method: 'POST',
          path: '/auth/device/token',
          code: unconfirmed ? 'DEVICE_LOGIN_UNCONFIRMED' : 'DEVICE_LOGIN_FAILED',
          status: lastStatus,
          retryable: false,
        });
        throw new Error(unconfirmed ? UNCONFIRMED_COMPLETION_MESSAGE : action.message);
      }
      case 'slow_down':
        // ⛔ RFC 8628 §3.5: a `slow_down` MUST increase the interval by 5
        // seconds. Adopting the server's echo verbatim does not guarantee that
        // — a response that omits `interval` would leave the client polling at
        // exactly the rate it was just told was too fast, and one echoing a
        // smaller value would ACCELERATE it. Take whichever is larger, so a
        // throttle can only ever slow us down.
        interval = Math.min(
          Math.max(interval + SLOW_DOWN_INCREMENT_SECONDS, action.suggestedInterval ?? 0),
          MAX_INTERVAL_SECONDS,
        );
        transientFailures = 0;
        break;
      case 'pending':
        transientFailures = 0;
        break;
      case 'transient':
        transientFailures += 1;
        // We never learned what the server did with that request.
        hadUnverifiedAttempt = true;
        // ⚠️ Back off before retrying. RFC 8628 §3.5 asks a client to reduce
        // its polling frequency after a connection timeout, and the
        // three-failure bound is a stopping rule, not a rate. Deliberately NOT
        // reset when a poll succeeds again: re-accelerating after a blip is the
        // behaviour the backoff exists to prevent.
        //
        // ⛔ The outer `max` is load-bearing. `min(interval * 2, CAP)` alone
        // would LOWER an interval already above the cap — reachable through
        // repeated `slow_down`s, since the ratchet is unbounded upward — so a
        // transport blip would drop the client below a floor the server had
        // established and invite more throttling. A backoff must never be able
        // to speed anything up.
        interval = Math.min(
          Math.max(interval, Math.min(interval * 2, MAX_BACKOFF_SECONDS)),
          MAX_INTERVAL_SECONDS,
        );
        if (transientFailures >= MAX_TRANSIENT_FAILURES) {
          emitMcpFailure({
            tool: 'nl_login_device',
            method: 'POST',
            path: '/auth/device/token',
            code: 'DEVICE_LOGIN_UNREACHABLE',
            status: lastStatus,
            retryable: true,
            attempt: transientFailures,
          });
          throw new Error(
            `Lost contact with the server while waiting for approval (${action.message}).`,
          );
        }
        break;
    }
  }
}

/**
 * The whole headless login: request a grant, tell the human where to go, poll,
 * then persist.
 *
 * `saveAuth` runs ONLY after `pollForDeviceToken` returns a validated success,
 * so a failed attempt leaves any existing `~/.config/neuralingual/auth.json`
 * exactly as it was — a login that fails must never log you out.
 */
export async function deviceLogin(
  env: ApiEnv,
  deps: DeviceLoginDeps = defaultDeps(),
): Promise<TokenSuccess> {
  const grant = await requestDeviceCode(env, deps);

  deps.log('');
  deps.log(`Open ${grant.verificationUrl} and enter code ${grant.userCode}`);
  if (grant.verificationUrlComplete) {
    deps.log(`Or open this link directly: ${grant.verificationUrlComplete}`);
  }
  deps.log('');
  deps.log(`Waiting for approval (the code expires in ${Math.round(grant.expiresIn / 60)} minutes)...`);

  const tokens = await pollForDeviceToken(env, grant, deps);

  saveAuth({
    env,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    userId: tokens.user.id,
    email: tokens.user.email ?? null,
  });

  const label = tokens.user.displayName ?? tokens.user.email ?? tokens.user.id;
  deps.log(`\nLogged in as ${label} (${env})`);
  if (typeof tokens.user.creditBalance === 'number') {
    deps.log(`Credits: ${tokens.user.creditBalance}`);
  }

  return tokens;
}
