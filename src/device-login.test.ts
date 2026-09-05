/**
 * nl#421 — CLI device-login state machine.
 *
 * Everything here runs against injected fakes: no network, no timers, no
 * filesystem. The behaviour under test is a decision table, and the tests that
 * matter most are the ones proving a FAILURE cannot be read as a login.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const saveAuth = vi.fn();
vi.mock('./auth-store.js', () => ({
  saveAuth: (...args: unknown[]) => saveAuth(...args),
  loadAuth: vi.fn(),
  clearAuth: vi.fn(),
}));

const {
  classifyTokenResponse,
  deviceLogin,
  isHeadlessEnvironment,
  pollForDeviceToken,
  requestDeviceCode,
  shouldUseDeviceFlow,
} = await import('./device-login.js');
type DeviceLoginDeps = Parameters<typeof pollForDeviceToken>[2] & object;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GRANT = {
  deviceCode: 'device-code-abc',
  userCode: 'BCDF-2345',
  verificationUrl: 'https://app.neuralingual.com/auth/device',
  verificationUrlComplete: 'https://app.neuralingual.com/auth/device?code=BCDF-2345',
  expiresIn: 600,
  interval: 5,
};

const TOKENS = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: { id: 'user-1', email: 'dave@example.com', displayName: 'Dave', creditBalance: 12 },
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as unknown as Response;
}

/**
 * Deps whose clock advances by the amount each `sleep` asks for, so deadline
 * behaviour is exercised deterministically without real timers.
 */
function makeDeps(responses: Array<{ status: number; body: unknown }>): DeviceLoginDeps & {
  calls: number;
  lines: string[];
} {
  let clock = 0;
  let calls = 0;
  const lines: string[] = [];
  const deps = {
    fetch: vi.fn(async () => {
      const next = responses[Math.min(calls, responses.length - 1)]!;
      calls += 1;
      deps.calls = calls;
      return jsonResponse(next.status, next.body);
    }) as unknown as typeof globalThis.fetch,
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    log: (line: string) => lines.push(line),
    calls: 0,
    lines,
  };
  return deps;
}

beforeEach(() => {
  saveAuth.mockClear();
});

// ---------------------------------------------------------------------------
// isHeadlessEnvironment
// ---------------------------------------------------------------------------

describe('isHeadlessEnvironment', () => {
  it.each([
    ['ssh on linux', { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' }, 'linux' as const, true],
    ['ssh on darwin', { SSH_TTY: '/dev/ttys001' }, 'darwin' as const, true],
    ['SSH_CLIENT alone', { SSH_CLIENT: '10.0.0.1 22 22' }, 'linux' as const, true],
    ['linux with no display server', {}, 'linux' as const, true],
    ['linux with X11', { DISPLAY: ':0' }, 'linux' as const, false],
    ['linux with Wayland', { WAYLAND_DISPLAY: 'wayland-0' }, 'linux' as const, false],
  ])('%s -> %s', (_label, env, platform, expected) => {
    expect(isHeadlessEnvironment(env as NodeJS.ProcessEnv, platform)).toBe(expected);
  });

  /**
   * The regression that matters for everyone NOT on the hub: macOS and Windows
   * never set DISPLAY, so a platform-blind display test would push every
   * desktop user onto the device flow and make `nl login` worse for them.
   */
  it.each(['darwin', 'win32'] as const)(
    'is NOT headless on %s merely because DISPLAY is unset',
    (platform) => {
      expect(isHeadlessEnvironment({}, platform)).toBe(false);
    },
  );
});

/**
 * `cli.ts` carries the login action twice — once live, once in a `@public-only`
 * comment block that the PUBLISHED CLI compiles. Both call this function, so
 * this is the single place the rule is pinned; a divergence between those two
 * copies can no longer change which flow runs.
 */
describe('shouldUseDeviceFlow', () => {
  const ssh = { SSH_CONNECTION: 'x' } as NodeJS.ProcessEnv;
  const desktop = { DISPLAY: ':0' } as NodeJS.ProcessEnv;

  it('--device forces the device flow even on a desktop with a browser', () => {
    expect(shouldUseDeviceFlow({ device: true }, desktop, 'linux')).toBe(true);
    expect(shouldUseDeviceFlow({ device: true }, {}, 'darwin')).toBe(true);
  });

  it('--browser forces the loopback flow even over ssh', () => {
    expect(shouldUseDeviceFlow({ browser: true }, ssh, 'linux')).toBe(false);
  });

  it('with neither flag, falls through to headless detection', () => {
    expect(shouldUseDeviceFlow({}, ssh, 'linux')).toBe(true);
    expect(shouldUseDeviceFlow({}, desktop, 'linux')).toBe(false);
    expect(shouldUseDeviceFlow({}, {}, 'darwin')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyTokenResponse — the dispatch rule
// ---------------------------------------------------------------------------

describe('classifyTokenResponse', () => {
  it('accepts a 200 with a complete token payload', () => {
    const action = classifyTokenResponse(200, TOKENS);
    expect(action.kind).toBe('success');
  });

  it.each([
    ['authorization_pending', 'pending'],
    ['slow_down', 'slow_down'],
  ])('maps 400 %s to %s', (error, kind) => {
    expect(classifyTokenResponse(400, { error, interval: 10 }).kind).toBe(kind);
  });

  it('carries the server\'s suggested interval out of a slow_down', () => {
    const action = classifyTokenResponse(400, { error: 'slow_down', interval: 15 });
    expect(action).toEqual({ kind: 'slow_down', suggestedInterval: 15 });
  });

  it('passes a slow_down through even when the server omits an interval', () => {
    expect(classifyTokenResponse(400, { error: 'slow_down' })).toEqual({ kind: 'slow_down' });
  });

  it.each(['expired_token', 'access_denied', 'invalid_grant', 'invalid_request'])(
    'treats 400 %s as fatal with a distinct message',
    (error) => {
      const action = classifyTokenResponse(400, { error });
      expect(action.kind).toBe('fatal');
      expect(action.kind === 'fatal' && action.message.length).toBeGreaterThan(10);
    },
  );

  it('gives each fatal RFC code its OWN message', () => {
    const messages = ['expired_token', 'access_denied', 'invalid_grant'].map((error) => {
      const action = classifyTokenResponse(400, { error });
      return action.kind === 'fatal' ? action.message : '';
    });
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('treats 429 as fatal — polling on would burn the rest of the quota', () => {
    expect(classifyTokenResponse(429, { error: 'rate_limit_exceeded' }).kind).toBe('fatal');
  });

  it('treats an UNPARSEABLE 5xx as transient, since no verdict was produced', () => {
    expect(classifyTokenResponse(502, null).kind).toBe('transient');
    // An ingress or proxy returning HTML during a deploy.
    expect(classifyTokenResponse(503, '<html>502 Bad Gateway</html>').kind).toBe('transient');
  });

  /**
   * ⛔ THE REGRESSION TEST for the round-1 code-review finding. `500
   * server_error` used to be classified transient, so the CLI retried — and the
   * next poll hit `invalid_grant`, because the server consumes the grant BEFORE
   * minting. A database failure and a genuine replay therefore ended with the
   * same message. The server had told us the truth on the first response.
   */
  it('treats a 5xx CARRYING a verdict as fatal, with that verdict\'s message', () => {
    const action = classifyTokenResponse(500, { error: 'server_error' });
    expect(action.kind).toBe('fatal');
    expect(action.kind === 'fatal' && action.message).toMatch(/could not complete the login/i);
    // ...and distinctly NOT the replay message.
    expect(action.kind === 'fatal' && action.message).not.toMatch(/already been used/i);
  });

  /**
   * ⛔ MEASURED: `apps/api/src/lib/rateLimit.ts`'s fail-closed path sends
   * `{ error: 'Service temporarily unavailable', message: '...' }` — `error` is
   * a human SENTENCE, not an OAuth code. Without the shape check that string
   * parses as a verdict and ABORTS a login the human may already have approved,
   * over a transient Redis blip that deserved a retry. A sentence is not a code.
   */
  it.each([
    ['the rate limiter fail-closed body', { error: 'Service temporarily unavailable', message: 'Please try again in a moment.' }],
    ['a capitalised word', { error: 'Unavailable' }],
    ['a sentence with punctuation', { error: 'something went wrong.' }],
  ])('treats a 503 whose `error` is prose as TRANSIENT: %s', (_label, body) => {
    expect(classifyTokenResponse(503, body).kind).toBe('transient');
  });

  it('still treats a 503 carrying a real OAuth code as fatal', () => {
    expect(classifyTokenResponse(503, { error: 'service_unavailable' }).kind).toBe('fatal');
  });

  it('treats a 503 service_unavailable as fatal, not as a bad code', () => {
    const action = classifyTokenResponse(503, { error: 'service_unavailable' });
    expect(action.kind).toBe('fatal');
    expect(action.kind === 'fatal' && action.message).toMatch(/temporarily unavailable/i);
  });

  /**
   * ⛔ The three coercion directions. Each one alone would turn an error into a
   * login, which is the single worst outcome for this flow, so each gets its
   * own case rather than riding on a sibling.
   */
  describe('refuses to coerce an error into a login', () => {
    it.each([
      'authorization_pending',
      'slow_down',
      'expired_token',
      'access_denied',
      'invalid_grant',
    ])('a 200 carrying complete tokens PLUS error=%s', (error) => {
      // A plain zod object strips unknown keys, so without the explicit
      // `error`-key check this body would parse as a clean success.
      const action = classifyTokenResponse(200, { ...TOKENS, error });
      expect(action.kind).toBe('fatal');
    });

    it.each([400, 500, 503])('a %d carrying a token-shaped body', (status) => {
      const action = classifyTokenResponse(status, TOKENS);
      expect(action.kind).not.toBe('success');
    });

    it('a 200 missing refreshToken', () => {
      const { refreshToken: _dropped, ...partial } = TOKENS;
      expect(classifyTokenResponse(200, partial).kind).toBe('fatal');
    });

    it('a 200 missing the user id', () => {
      const action = classifyTokenResponse(200, { ...TOKENS, user: { email: 'x@y.z' } });
      expect(action.kind).toBe('fatal');
    });

    it('a 200 with a non-JSON body', () => {
      expect(classifyTokenResponse(200, null).kind).toBe('fatal');
    });
  });

  it('tolerates unknown fields on the user DTO (it grows over time)', () => {
    const action = classifyTokenResponse(200, {
      ...TOKENS,
      user: { ...TOKENS.user, somethingAddedLater: true },
    });
    expect(action.kind).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// requestDeviceCode
// ---------------------------------------------------------------------------

describe('requestDeviceCode', () => {
  it('returns the grant on a complete 200', async () => {
    const deps = makeDeps([{ status: 200, body: GRANT }]);
    await expect(requestDeviceCode('production', deps)).resolves.toEqual(GRANT);
  });

  it('rejects an incomplete 200 rather than proceeding with a partial grant', async () => {
    const deps = makeDeps([{ status: 200, body: { deviceCode: 'x' } }]);
    await expect(requestDeviceCode('production', deps)).rejects.toThrow(/incomplete/i);
  });

  it('surfaces a 503 as unavailable, not as a bad request', async () => {
    const deps = makeDeps([{ status: 503, body: { error: 'service_unavailable' } }]);
    await expect(requestDeviceCode('production', deps)).rejects.toThrow(/temporarily unavailable/i);
  });
});

// ---------------------------------------------------------------------------
// pollForDeviceToken
// ---------------------------------------------------------------------------

describe('pollForDeviceToken', () => {
  it('polls through pending until approval', async () => {
    const deps = makeDeps([
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 200, body: TOKENS },
    ]);
    await expect(pollForDeviceToken('production', GRANT, deps)).resolves.toEqual(TOKENS);
    expect(deps.calls).toBe(3);
  });

  /**
   * ⛔ RFC 8628 §3.5 — a `slow_down` MUST increase the interval by 5 seconds.
   * Adopting the server's echoed value verbatim does not guarantee that: an
   * omitted `interval` would leave the client polling at the rate it was just
   * told was too fast, and a smaller one would ACCELERATE it. Both directions
   * are pinned, because either alone would make a throttle useless.
   */
  it.each([
    ['a larger suggestion is adopted', 20, [5000, 20000]],
    ['an omitted suggestion still adds 5s', undefined, [5000, 10000]],
    ['a SMALLER suggestion cannot speed us up', 2, [5000, 10000]],
    ['an equal suggestion cannot stall the increase', 5, [5000, 10000]],
  ])('%s', async (_label, suggested, expectedSleeps) => {
    const sleeps: number[] = [];
    const body: Record<string, unknown> = { error: 'slow_down' };
    if (suggested !== undefined) body['interval'] = suggested;
    const deps = makeDeps([
      { status: 400, body },
      { status: 200, body: TOKENS },
    ]);
    const originalSleep = deps.sleep;
    deps.sleep = async (ms: number) => {
      sleeps.push(ms);
      await originalSleep(ms);
    };
    await pollForDeviceToken('production', GRANT, deps);
    expect(sleeps).toEqual(expectedSleeps);
  });

  /**
   * ⛔ The `slow_down` interval is SERVER-CONTROLLED. Without a ceiling,
   * `{"error":"slow_down","interval":86400}` parks the CLI for a day inside a
   * ten-minute window — and the sleep is clamped to the deadline so the loop
   * still wakes to report the timeout instead of hanging.
   */
  it('caps an absurd server-suggested interval and still times out on schedule', async () => {
    const sleeps: number[] = [];
    const deps = makeDeps([{ status: 400, body: { error: 'slow_down', interval: 86400 } }]);
    const originalSleep = deps.sleep;
    deps.sleep = async (ms: number) => {
      sleeps.push(ms);
      await originalSleep(ms);
    };
    await expect(
      pollForDeviceToken('production', { ...GRANT, expiresIn: 600 }, deps),
    ).rejects.toThrow(/timed out/i);
    // First sleep is the initial interval; the second is clamped to what remains
    // of the window, never the 86400s the server asked for.
    expect(sleeps[0]).toBe(5000);
    expect(sleeps[1]).toBeLessThanOrEqual(600_000);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(600_000);
  });

  it('keeps ratcheting the interval up across repeated slow_downs', async () => {
    const sleeps: number[] = [];
    const deps = makeDeps([
      { status: 400, body: { error: 'slow_down' } },
      { status: 400, body: { error: 'slow_down' } },
      { status: 200, body: TOKENS },
    ]);
    const originalSleep = deps.sleep;
    deps.sleep = async (ms: number) => {
      sleeps.push(ms);
      await originalSleep(ms);
    };
    await pollForDeviceToken('production', GRANT, deps);
    expect(sleeps).toEqual([5000, 10000, 15000]);
  });

  it.each([
    ['expired_token', /expired/i],
    ['access_denied', /denied/i],
    ['invalid_grant', /already been used/i],
  ])('fails loudly on %s', async (error, pattern) => {
    const deps = makeDeps([{ status: 400, body: { error } }]);
    await expect(pollForDeviceToken('production', GRANT, deps)).rejects.toThrow(pattern);
  });

  it('stops immediately on 429 instead of burning the rest of the window', async () => {
    const deps = makeDeps([{ status: 429, body: { error: 'rate_limit_exceeded' } }]);
    await expect(pollForDeviceToken('production', GRANT, deps)).rejects.toThrow(/rate limited/i);
    expect(deps.calls).toBe(1);
  });

  it('retries a transient 5xx, then gives up after the bound', async () => {
    const deps = makeDeps([{ status: 502, body: null }]);
    await expect(pollForDeviceToken('production', GRANT, deps)).rejects.toThrow(/lost contact/i);
    expect(deps.calls).toBe(3);
  });

  /**
   * A mint failure must end the login on the FIRST response. If it retried, the
   * next poll would answer `invalid_grant` (the grant is consumed before the
   * mint) and the user would be told they replayed a code they never reused.
   */
  it('stops on the first 500 server_error and never polls again', async () => {
    const deps = makeDeps([
      { status: 500, body: { error: 'server_error' } },
      { status: 400, body: { error: 'invalid_grant' } },
    ]);
    await expect(pollForDeviceToken('production', GRANT, deps)).rejects.toThrow(
      /could not complete the login/i,
    );
    expect(deps.calls, 'the second poll must never happen').toBe(1);
  });

  /**
   * ⛔ A REPLAY and a LOST COMPLETION are different realities. If the server
   * consumed the grant, then failed, and the response never reached us, the
   * next poll answers `invalid_grant` — and reporting "you already used that
   * code" blames the user for something they did not do and sends them looking
   * in the wrong place. Once any request fails to produce a verdict, a later
   * `invalid_grant` is ambiguous, and the message must say so.
   */
  it.each([
    ['a transport failure', { status: 502, body: null }],
    ['an unparseable 5xx', { status: 503, body: '<html>Bad Gateway</html>' }],
  ])('reports UNCONFIRMED, not "already used", when %s precedes invalid_grant', async (
    _label,
    blip,
  ) => {
    const deps = makeDeps([blip, { status: 400, body: { error: 'invalid_grant' } }]);
    await expect(pollForDeviceToken('production', GRANT, deps)).rejects.toThrow(
      /lost contact with the server while signing in/i,
    );
    expect(saveAuth).not.toHaveBeenCalled();
  });

  it('still reports a plain replay as a replay when nothing was lost', async () => {
    const deps = makeDeps([{ status: 400, body: { error: 'invalid_grant' } }]);
    await expect(pollForDeviceToken('production', GRANT, deps)).rejects.toThrow(
      /already been used/i,
    );
  });

  /**
   * RFC 8628 §3.5 asks a client to reduce its polling frequency after a
   * connection timeout. The three-failure bound is a stopping rule, not a rate.
   */
  it('backs off after a transient failure instead of retrying at the same rate', async () => {
    const sleeps: number[] = [];
    const deps = makeDeps([
      { status: 502, body: null },
      { status: 502, body: null },
      { status: 200, body: TOKENS },
    ]);
    const originalSleep = deps.sleep;
    deps.sleep = async (ms: number) => {
      sleeps.push(ms);
      await originalSleep(ms);
    };
    await pollForDeviceToken('production', GRANT, deps);
    expect(sleeps).toEqual([5000, 10000, 20000]);
  });

  /**
   * ⛔ The backoff must never speed the client up. `slow_down` ratchets the
   * interval without an upper bound, so it can exceed the backoff cap — and a
   * naive `min(interval * 2, CAP)` would then DROP the client below a floor the
   * server had just established, inviting more throttling.
   */
  it('a transient failure never lowers an interval already above the backoff cap', async () => {
    const sleeps: number[] = [];
    const deps = makeDeps([
      { status: 400, body: { error: 'slow_down', interval: 90 } },
      { status: 502, body: null },
      { status: 200, body: TOKENS },
    ]);
    const originalSleep = deps.sleep;
    deps.sleep = async (ms: number) => {
      sleeps.push(ms);
      await originalSleep(ms);
    };
    // expiresIn must outlast the raised interval for the run to reach success.
    await pollForDeviceToken('production', { ...GRANT, expiresIn: 3600 }, deps);
    expect(sleeps).toEqual([5000, 90000, 90000]);
  });

  it('resets the transient counter after a good poll, so a blip is not fatal', async () => {
    const deps = makeDeps([
      { status: 502, body: null },
      { status: 502, body: null },
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 502, body: null },
      { status: 502, body: null },
      { status: 200, body: TOKENS },
    ]);
    await expect(pollForDeviceToken('production', GRANT, deps)).resolves.toEqual(TOKENS);
  });

  it('treats a network throw as transient, not as a failed login', async () => {
    let calls = 0;
    let clock = 0;
    const deps = {
      fetch: vi.fn(async () => {
        calls += 1;
        if (calls < 3) throw new TypeError('fetch failed');
        return jsonResponse(200, TOKENS);
      }) as unknown as typeof globalThis.fetch,
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
      log: () => {},
    };
    await expect(pollForDeviceToken('production', GRANT, deps)).resolves.toEqual(TOKENS);
  });

  it('ends at the deadline rather than polling forever', async () => {
    const deps = makeDeps([{ status: 400, body: { error: 'authorization_pending' } }]);
    // 30s window at a 5s interval — the loop must stop on its own.
    await expect(
      pollForDeviceToken('production', { ...GRANT, expiresIn: 30 }, deps),
    ).rejects.toThrow(/timed out/i);
    expect(deps.calls).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// deviceLogin
// ---------------------------------------------------------------------------

describe('deviceLogin', () => {
  it('prints the URL and the code, then saves the tokens', async () => {
    const deps = makeDeps([
      { status: 200, body: GRANT },
      { status: 200, body: TOKENS },
    ]);
    await deviceLogin('production', deps);

    const printed = deps.lines.join('\n');
    expect(printed).toContain(GRANT.verificationUrl);
    expect(printed).toContain(GRANT.userCode);
    expect(saveAuth).toHaveBeenCalledWith({
      env: 'production',
      accessToken: TOKENS.accessToken,
      refreshToken: TOKENS.refreshToken,
      userId: TOKENS.user.id,
      email: TOKENS.user.email,
    });
  });

  /**
   * A failed login must never log you out. `saveAuth` is the only writer of
   * `~/.config/neuralingual/auth.json`, so "not called" IS "credentials
   * untouched".
   */
  it.each([
    ['a denied grant', { status: 400, body: { error: 'access_denied' } }],
    ['an expired code', { status: 400, body: { error: 'expired_token' } }],
    ['a mint failure', { status: 500, body: { error: 'server_error' } }],
    ['a tokens+error 200', { status: 200, body: { ...TOKENS, error: 'invalid_grant' } }],
    ['a token-shaped 400', { status: 400, body: TOKENS }],
  ])('leaves existing credentials untouched after %s', async (_label, response) => {
    const deps = makeDeps([{ status: 200, body: GRANT }, response]);
    await expect(deviceLogin('production', deps)).rejects.toThrow();
    expect(saveAuth).not.toHaveBeenCalled();
  });
});
