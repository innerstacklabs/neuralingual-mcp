/**
 * nl#599 — `whoami --no-refresh` read-only probe.
 *
 * The tests that matter most are the ones proving the probe can never refresh:
 * a 401 must come back as exit 1 with exactly ONE request (to /auth/me) and no
 * /auth/refresh call, and the stored auth file must be byte-identical after.
 * Everything runs against a mocked fetch and a fake auth file under a scratch
 * HOME — never the real ~/.config/neuralingual/auth.json, never the network.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthData } from './auth-store.js';
import { decodeJwtExp, probeToken, type ProbeDeps } from './whoami-probe.js';

const NOW_MS = Date.UTC(2026, 9, 12, 12, 0, 0);
const NOW_S = NOW_MS / 1000;

/** Unsigned fake JWT carrying only the claims the probe reads. */
function fakeJwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(claims)}.fake-signature`;
}

function authWith(accessToken: string): AuthData {
  return { env: 'dev', accessToken, refreshToken: 'fake-refresh-token', userId: 'usr_stored', email: null };
}

const FUTURE_TOKEN = fakeJwt({ exp: NOW_S + 3600 });
// probeStoredToken uses the real clock, so its token must outlive any wall-clock date the tests run on.
const LONG_LIVED_TOKEN = fakeJwt({ exp: Date.UTC(2100, 0, 1) / 1000 });
const EXPIRED_TOKEN = fakeJwt({ exp: NOW_S - 60 });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function depsFor(
  auth: AuthData | null,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): ProbeDeps & { fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn(fetchImpl);
  return { loadAuth: () => auth, fetchFn: fetchMock as unknown as typeof fetch, now: () => NOW_MS, fetchMock };
}

function urlsCalled(d: { fetchMock: ReturnType<typeof vi.fn> }): string[] {
  return d.fetchMock.mock.calls.map((c) => String(c[0]));
}

describe('decodeJwtExp', () => {
  it('reads a numeric exp', () => {
    expect(decodeJwtExp(fakeJwt({ exp: 1234 }))).toBe(1234);
  });
  it.each([
    ['not a jwt', 'opaque-token'],
    ['empty payload segment', 'a..c'],
    ['payload not json', 'a.%%%.c'],
    ['no exp claim', fakeJwt({ sub: 'x' })],
    ['string exp', fakeJwt({ exp: '1234' })],
  ])('returns null for %s', (_name, token) => {
    expect(decodeJwtExp(token)).toBeNull();
  });
});

describe('probeToken decision table', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('200 -> valid (exit 0), prints user id and expiry, one GET /auth/me with the stored token', async () => {
    const d = depsFor(authWith(FUTURE_TOKEN), async () => json(200, { user: { id: 'usr_server' } }));
    const r = await probeToken(d);
    expect(r.exitCode).toBe(0);
    expect(r.status).toBe('valid');
    expect(r.message).toContain('usr_server');
    expect(r.message).toContain(new Date((NOW_S + 3600) * 1000).toISOString());
    expect(d.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = d.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/auth/me');
    expect(init.method).toBe('GET');
    // The API reads the JWT from X-Access-Token (apps/api authMiddleware), not Authorization.
    expect(init.headers).toEqual({ 'X-Access-Token': FUTURE_TOKEN });
  });

  it('200 with an unreadable body is still valid and falls back to the stored user id', async () => {
    const d = depsFor(authWith(FUTURE_TOKEN), async () => new Response('not json', { status: 200 }));
    const r = await probeToken(d);
    expect(r.exitCode).toBe(0);
    expect(r.message).toContain('usr_stored');
  });

  it('401 -> invalid (exit 1) with ZERO /auth/refresh calls and exactly one request', async () => {
    // tryRefresh() in user-client.ts uses the GLOBAL fetch, which the injected
    // fetchFn would never see — so watch the global too.
    const globalFetch = vi.fn(async () => json(200, {}));
    vi.stubGlobal('fetch', globalFetch);
    const d = depsFor(authWith(FUTURE_TOKEN), async () => json(401, { error: 'unauthorized' }));
    const r = await probeToken(d);
    expect(r.exitCode).toBe(1);
    expect(r.status).toBe('invalid');
    expect(urlsCalled(d)).toEqual(['http://localhost:3001/auth/me']);
    expect(urlsCalled(d).some((u) => u.includes('/auth/refresh'))).toBe(false);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('exp in the past -> invalid (exit 1) without any network call', async () => {
    const d = depsFor(authWith(EXPIRED_TOKEN), async () => json(200, { user: { id: 'x' } }));
    const r = await probeToken(d);
    expect(r.exitCode).toBe(1);
    expect(d.fetchMock).not.toHaveBeenCalled();
  });

  it('exp exactly now counts as expired', async () => {
    const d = depsFor(authWith(fakeJwt({ exp: NOW_S })), async () => json(200, {}));
    expect((await probeToken(d)).exitCode).toBe(1);
    expect(d.fetchMock).not.toHaveBeenCalled();
  });

  it('no auth file -> unknown (exit 2) without any network call', async () => {
    const d = depsFor(null, async () => json(200, {}));
    const r = await probeToken(d);
    expect(r.exitCode).toBe(2);
    expect(r.status).toBe('unknown');
    expect(d.fetchMock).not.toHaveBeenCalled();
  });

  it.each([500, 502, 503, 429, 403, 404])('HTTP %i -> unknown (exit 2), no refresh', async (status) => {
    const d = depsFor(authWith(FUTURE_TOKEN), async () => json(status, {}));
    const r = await probeToken(d);
    expect(r.exitCode).toBe(2);
    expect(urlsCalled(d)).toEqual(['http://localhost:3001/auth/me']);
  });

  it('network error -> unknown (exit 2), no refresh', async () => {
    const d = depsFor(authWith(FUTURE_TOKEN), async () => {
      throw new TypeError('fetch failed');
    });
    const r = await probeToken(d);
    expect(r.exitCode).toBe(2);
    expect(urlsCalled(d)).toEqual(['http://localhost:3001/auth/me']);
  });

  it('an opaque (non-JWT) token is not treated as expired: the server decides', async () => {
    const d = depsFor(authWith('opaque-access-token'), async () => json(200, { user: { id: 'usr_server' } }));
    const r = await probeToken(d);
    expect(r.exitCode).toBe(0);
    expect(r.message).toContain('unknown (token is not a decodable JWT)');
  });

  it('never echoes either token in its message', async () => {
    for (const handler of [
      async () => json(200, { user: { id: 'u' } }),
      async () => json(401, {}),
      async () => json(500, {}),
    ]) {
      const r = await probeToken(depsFor(authWith(FUTURE_TOKEN), handler));
      expect(r.message).not.toContain(FUTURE_TOKEN);
      expect(r.message).not.toContain('fake-refresh-token');
    }
  });
});

describe('probe against the real auth store (scratch HOME)', () => {
  const realHome = process.env['HOME'];
  let scratch: string | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env['HOME'] = realHome;
    vi.resetModules();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it('a 401 leaves auth.json byte-identical and makes no /auth/refresh call', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'nl-whoami-probe-'));
    const authDir = join(scratch, '.config', 'neuralingual');
    mkdirSync(authDir, { recursive: true });
    const authFile = join(authDir, 'auth.json');
    writeFileSync(authFile, JSON.stringify(authWith(FUTURE_TOKEN), null, 2) + '\n', { mode: 0o600 });
    const before = readFileSync(authFile, 'utf8');

    process.env['HOME'] = scratch; // auth-store resolves its path from homedir() at import time
    vi.resetModules();
    const store = await import('./auth-store.js');
    const probe = await import('./whoami-probe.js');

    const fetchMock = vi.fn(async () => json(401, { error: 'unauthorized' }));
    const globalFetch = vi.fn(async () => json(200, {}));
    vi.stubGlobal('fetch', globalFetch);
    const r = await probe.probeToken({
      loadAuth: store.loadAuth,
      fetchFn: fetchMock as unknown as typeof fetch,
      now: () => NOW_MS,
    });

    expect(r.exitCode).toBe(1);
    expect(fetchMock.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual(['http://localhost:3001/auth/me']);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(readFileSync(authFile, 'utf8')).toBe(before);
  });

  it('probeStoredToken (production wiring) on a 401 touches only /auth/me and leaves auth.json alone', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'nl-whoami-probe-'));
    const authDir = join(scratch, '.config', 'neuralingual');
    mkdirSync(authDir, { recursive: true });
    const authFile = join(authDir, 'auth.json');
    writeFileSync(authFile, JSON.stringify(authWith(LONG_LIVED_TOKEN), null, 2) + '\n', { mode: 0o600 });
    const before = readFileSync(authFile, 'utf8');

    process.env['HOME'] = scratch;
    vi.resetModules();
    const globalFetch = vi.fn(async () => json(401, { error: 'unauthorized' }));
    vi.stubGlobal('fetch', globalFetch);
    const probe = await import('./whoami-probe.js');

    const r = await probe.probeStoredToken();

    expect(r.exitCode).toBe(1);
    expect(globalFetch.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual(['http://localhost:3001/auth/me']);
    expect(readFileSync(authFile, 'utf8')).toBe(before);
  });
});

describe('nl whoami --no-refresh (built CLI wiring)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const CLI = join(here, '..', 'dist', 'cli.js');

  // Needs `pnpm build` first; the standard gate order builds before testing.
  // Only paths that need no network are exercised: no auth file, expired token.
  function runCli(home: string) {
    return spawnSync(process.execPath, [CLI, 'whoami', '--no-refresh'], {
      env: { PATH: process.env['PATH'] ?? '', HOME: home },
      encoding: 'utf8',
      timeout: 20_000,
    });
  }

  it.skipIf(!existsSync(CLI))('exits 2 with no stored login and 1 for an expired token, without the network', () => {
    const home = mkdtempSync(join(tmpdir(), 'nl-whoami-cli-'));
    try {
      const none = runCli(home);
      expect(none.status).toBe(2);

      const dir = join(home, '.config', 'neuralingual');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'auth.json');
      writeFileSync(file, JSON.stringify(authWith(fakeJwt({ exp: 1 }))) + '\n', { mode: 0o600 });
      const before = readFileSync(file, 'utf8');
      const expired = runCli(home);
      expect(expired.status).toBe(1);
      expect(expired.stderr).toContain('expired');
      expect(readFileSync(file, 'utf8')).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
