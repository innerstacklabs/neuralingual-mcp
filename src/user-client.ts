import type { ApiEnv, IntentStats, LibraryQueryParams, RenderConfigInput, RenderConfig, RenderStatus, SyncAffirmationsInput, SyncAffirmationsResult } from './types.js';
import { API_BASE_URLS } from './types.js';
import { loadAuth, saveAuth, clearAuth } from './auth-store.js';
import type { ResumeBlockingOutcome } from './streaming/generation-stream.js';
import { mapResumeJsonToOutcome } from './streaming/generation-stream.js';
import { McpError, classifyStatus, networkErrorToMcpError } from './mcp-error.js';
import { emitMcpFailure } from './mcp-telemetry.js';
import { normalizeMethod, runWithGetRetry } from './mcp-retry.js';

interface UserDto {
  id: string;
  email: string | null;
  displayName: string | null;
  username: string | null;
  authProvider: string;
  tonePreference: string;
  defaultCoach: string | null;
  completedOnboarding: boolean;
  subscriptionTier: string | null;
  subscriptionStatus: string | null;
  subscriptionExpiresAt: string | null;
  creditBalance: number;
  subscriptionCredits: number;
  purchasedCredits: number;
  creditsResetAt: string | null;
  role: string;
  createdAt?: string;
}

/** #3116 — Coach DTO (client-safe shape from GET /coaches). */
interface CoachDto {
  key: string;
  name: string;
  description: string;
  inspiredBy: string[];
  visual: { iconRef: string; focalPoint: { x: number; y: number }; aspectRatio: number };
  signatureVoiceId: string;
  defaultTone: string;
  voicePerspective: string;
}

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: UserDto;
}

interface LibraryItem {
  intent: {
    id: string;
    title: string;
    emoji: string | null;
    sessionContext: string;
    tonePreference: string | null;
    createdAt: string;
    updatedAt: string;
  };
  latestAffirmationSet: {
    id: string;
    intentId: string;
    source: string;
    createdAt: string;
    affirmationCount: number;
  } | null;
  latestRenderConfig: unknown | null;
  latestRenderJob: {
    id: string;
    status: string;
  } | null;
  configs?: Array<{
    renderConfig: unknown;
    latestRenderJob: { id: string; status: string } | null;
  }>;
  stats?: IntentStats;
}

interface IntentDetail {
  id: string;
  title: string;
  emoji: string | null;
  rawText: string;
  tonePreference: string | null;
  sessionContext: string;
  // Source-based generation (#930, #993)
  sourceType: string | null;
  sourceText: string | null;
  sourceTitle: string | null;
  sourceAuthor: string | null;
  sourceSummary: string | null;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
  affirmationSets: Array<{
    id: string;
    source: string;
    createdAt: string;
    affirmations: Array<{
      id: string;
      text: string;
      tone: string;
      isEnabled: boolean;
      feedback?: 'liked' | 'disliked' | null;
    }>;
    // Framework-first (#747) fields. Null on legacy/second-person sets.
    // Typed as `unknown` here to keep the mcp package free of the zod schema
    // from `@neuralingual/llm` — the renderer (`framework-render.ts`) handles
    // shape-tolerant parsing.
    framework?: unknown;
    schemaVersion?: number | null;
    generationStatus?: 'complete' | 'framework_only' | 'failed' | null;
  }>;
  renderConfigs: Array<{
    id: string;
    affirmationSetId: string;
    voiceId: string | null;
    voiceProvider: string;
    sessionContext: string;
    paceWpm: number;
    durationSeconds: number;
    backgroundAudioPath: string | null;
    backgroundVolume: number;
    affirmationRepeatCount: number;
    repetitionModel: string;
    binauralPreset: string | null;
    binauralVolume: number | null;
    subliminalEnabled: boolean;
    subliminalVolume: number | null;
    includePreamble: boolean;
    playAll: boolean;
    createdAt: string;
    updatedAt: string;
    renderJobs?: Array<{
      id: string;
      status: string;
      progress: number;
      errorMessage: string | null;
      createdAt: string;
    }>;
  }>;
}

interface UpdateIntentInput {
  title?: string;
  emoji?: string | null;
  intentText?: string;
  tonePreference?: string | null;
}

interface GenerateResult {
  intent: { id: string; title: string; emoji: string | null; rawText: string; sessionContext: string };
  affirmationSet: {
    id: string;
    affirmations: Array<{ id: string; text: string; tone: string; isEnabled: boolean }>;
  };
}

interface RenderJob {
  id: string;
  renderConfigId: string;
  status: string;
  progress: number;
  outputKey: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CreditTransaction {
  id: string;
  amount: number;
  type: string;
  createdAt: string;
  balanceAfter: number;
}

interface ShareResult {
  shareToken: string;
  shareUrl: string;
}

interface ContextSettings {
  sessionContext: string;
  paceWpm: number | null;
  pauseMs: number | null;
  durationMinutes: number | null;
  repeatCount: number | null;
  backgroundVolume: number | null;
  voiceId: string | null;
  backgroundKey: string | null;
  binauralPreset: string | null;
  playbackMode: string | null;
  binauralVolume: number | null;
  subliminalEnabled: boolean | null;
  subliminalVolume: number | null;
}

interface WizardDefaults {
  voiceId: string | null;
  backgroundKey: string | null;
  backgroundVolume: number;
  binauralPreset: string | null;
  binauralVolume: number;
  subliminalEnabled: boolean;
  subliminalVolume: number;
  durationMinutes: number | null;
  playbackMode: string;
  source: 'intent' | 'recent' | 'onboarding' | 'system';
}

/**
 * Rate-limit metadata surfaced from successful (2xx) responses. Parsed from
 * `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`. Added
 * for #855 so `nl create` can print "Quota: 3/10 remaining this hour." on
 * success. Returns `null` when the server didn't emit the headers.
 */
export interface RateLimitMeta {
  limit: number;
  remaining: number;
  /** ISO8601 timestamp when the surfaced cap resets. */
  resetAt: string;
}

function parseRateLimitMeta(headers: Headers): RateLimitMeta | undefined {
  const limit = headers.get('x-ratelimit-limit');
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  if (limit === null || remaining === null || reset === null) return undefined;
  const limitN = Number(limit);
  const remainingN = Number(remaining);
  if (!Number.isFinite(limitN) || !Number.isFinite(remainingN)) return undefined;
  return { limit: limitN, remaining: remainingN, resetAt: reset };
}

/**
 * Parse retry-after timing from a 429 response. Precedence:
 *   1. `Retry-After` header (RFC 9110 preferred — seconds, or HTTP-date)
 *   2. Body `retryAfterMs` (#855 structured 429)
 *   3. `X-RateLimit-Reset` header (legacy)
 *   4. Body `resetAt` ISO string (legacy)
 * Falls back to 60s when no signal is present.
 */
function parse429Timing(
  headers: Headers,
  body: Record<string, unknown> | null,
): { resetAt: number | null; retryAfterMs: number } {
  // 1. Retry-After
  const retryHeader = headers.get('retry-after');
  if (retryHeader !== null) {
    const asInt = parseInt(retryHeader, 10);
    if (Number.isFinite(asInt) && asInt > 0) {
      const ms = Math.max(1000, asInt * 1000);
      return { resetAt: Date.now() + ms, retryAfterMs: ms };
    }
    const asDate = Date.parse(retryHeader);
    if (!Number.isNaN(asDate)) {
      return { resetAt: asDate, retryAfterMs: Math.max(1000, asDate - Date.now()) };
    }
  }
  // 2. Body retry_after_ms (snake_case per #855 contract; camelCase fallback)
  if (body) {
    const retryMs =
      typeof body['retry_after_ms'] === 'number'
        ? (body['retry_after_ms'] as number)
        : typeof body['retryAfterMs'] === 'number'
        ? (body['retryAfterMs'] as number)
        : null;
    if (retryMs !== null && retryMs > 0) {
      const ms = Math.max(1000, retryMs);
      return { resetAt: Date.now() + ms, retryAfterMs: ms };
    }
  }
  // 3. X-RateLimit-Reset header (legacy — accepts numeric epoch-ms or ISO string)
  const resetHeader = headers.get('x-ratelimit-reset');
  if (resetHeader !== null) {
    let resetAt: number | null = null;
    if (/^\d+$/.test(resetHeader)) resetAt = parseInt(resetHeader, 10);
    else {
      const parsed = Date.parse(resetHeader);
      if (!Number.isNaN(parsed)) resetAt = parsed;
    }
    if (resetAt !== null) {
      return { resetAt, retryAfterMs: Math.max(1000, resetAt - Date.now()) };
    }
  }
  // 4. Body reset_at / resetAt (legacy)
  const resetBody =
    body !== null && 'reset_at' in body
      ? body['reset_at']
      : body !== null && 'resetAt' in body
      ? body['resetAt']
      : undefined;
  if (typeof resetBody === 'string') {
    const parsed = Date.parse(resetBody);
    if (!Number.isNaN(parsed)) {
      return { resetAt: parsed, retryAfterMs: Math.max(1000, parsed - Date.now()) };
    }
  } else if (typeof resetBody === 'number') {
    return { resetAt: resetBody, retryAfterMs: Math.max(1000, resetBody - Date.now()) };
  }
  // No signal — default to 60s.
  return { resetAt: null, retryAfterMs: 60_000 };
}

/**
 * HTTP client for the Neuralingual user API.
 * Authenticates via X-Access-Token header (JWT).
 * Handles automatic token refresh on 401.
 */
export class UserApiClient {
  private baseUrl: string;
  private env: ApiEnv;
  private accessToken: string;
  private refreshToken: string;

  constructor(baseUrl: string, env: ApiEnv, accessToken: string, refreshToken: string) {
    this.baseUrl = baseUrl;
    this.env = env;
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
  }

  /** Create a client from stored auth. Throws if not logged in. */
  static fromAuth(): UserApiClient {
    const auth = loadAuth();
    if (!auth) {
      throw new Error('Not logged in. Run `nl login` first.');
    }
    return new UserApiClient(API_BASE_URLS[auth.env], auth.env, auth.accessToken, auth.refreshToken);
  }

  /** Login with email + secret. Returns the user info. */
  static async login(env: ApiEnv, email: string, secret: string): Promise<{ client: UserApiClient; user: UserDto }> {
    const baseUrl = API_BASE_URLS[env];
    const res = await fetch(`${baseUrl}/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, secret, clientType: 'cli' }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => null) as Record<string, unknown> | null;
      const msg = data && typeof data['error'] === 'string' ? data['error'] : `Login failed (HTTP ${res.status})`;
      throw new Error(msg);
    }

    const result = await res.json() as LoginResult;
    saveAuth({
      env,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      userId: result.user.id,
      email: result.user.email,
    });

    const client = new UserApiClient(baseUrl, env, result.accessToken, result.refreshToken);
    return { client, user: result.user };
  }

  /** Login with Apple identity token (from browser-based Sign In with Apple). */
  static async loginWithApple(
    env: ApiEnv,
    idToken: string,
    displayName?: string,
  ): Promise<{ client: UserApiClient; user: UserDto }> {
    const baseUrl = API_BASE_URLS[env];
    const body: Record<string, string> = { idToken, clientType: 'cli' };
    if (displayName) body['displayName'] = displayName;

    const res = await fetch(`${baseUrl}/auth/apple/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => null) as Record<string, unknown> | null;
      const msg = data && typeof data['error'] === 'string' ? data['error'] : `Login failed (HTTP ${res.status})`;
      throw new Error(msg);
    }

    const result = await res.json() as LoginResult;
    saveAuth({
      env,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      userId: result.user.id,
      email: result.user.email,
    });

    const client = new UserApiClient(baseUrl, env, result.accessToken, result.refreshToken);
    return { client, user: result.user };
  }

  /**
   * Build the unified `McpError` (#2867) for a non-ok response, preserving the
   * back-compat extras callers already read: 429 timing (`resetAt`,
   * `retryAfterMs`, `source`, from #806/#855) and the `HTTP <status>: <msg>`
   * message format (#1179). Returns an `McpError` whose `.status` matches the
   * pre-#2867 plain-Error shape, so existing call sites keep working.
   */
  private buildHttpError(res: Response, data: Record<string, unknown> | null): McpError {
    if (res.status === 429) {
      const { resetAt, retryAfterMs } = parse429Timing(res.headers, data);
      const errMsg =
        (data && typeof data['message'] === 'string' && (data['message'] as string)) ||
        (data && typeof data['error'] === 'string' && (data['error'] as string)) ||
        'HTTP 429 (rate limited)';
      const source =
        data && typeof data['source'] === 'string' ? (data['source'] as string) : undefined;
      const { code, retryable } = classifyStatus(429);
      return new McpError(
        { code, message: errMsg, status: 429, retryable },
        source !== undefined ? { resetAt, retryAfterMs, source } : { resetAt, retryAfterMs },
      );
    }
    // #1179 — Include HTTP status in non-429 errors. Prefer body.message
    // (human-readable) over body.error (machine code).
    const bodyMsg =
      (data && typeof data['message'] === 'string' && (data['message'] as string)) ||
      (data && typeof data['error'] === 'string' && (data['error'] as string)) ||
      undefined;
    const errMsg = bodyMsg ? `HTTP ${res.status}: ${bodyMsg}` : `HTTP ${res.status}`;
    const { code, retryable } = classifyStatus(res.status);
    return new McpError({ code, message: errMsg, status: res.status, retryable });
  }

  /** Fetch with one-shot 401 refresh-and-retry. The 401 refresh is orthogonal
   *  to the transient-retry loop (401 is non-retryable there). */
  private async fetchWithRefresh(method: string, path: string, body?: unknown): Promise<Response> {
    const doRequest = async (token: string): Promise<Response> => {
      const url = `${this.baseUrl}${path}`;
      const headers: Record<string, string> = { 'X-Access-Token': token };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = JSON.stringify(body);
      return fetch(url, init);
    };
    let res = await doRequest(this.accessToken);
    if (res.status === 401) {
      const refreshed = await this.tryRefresh();
      if (refreshed) res = await doRequest(this.accessToken);
    }
    return res;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // Normalize for retry gating — GET is idempotent (#2867).
    const { httpMethod } = normalizeMethod(method);
    // Bounded transient retry on idempotent GETs only (#2867).
    return runWithGetRetry<T>({
      httpMethod,
      path,
      doFetch: () => this.fetchWithRefresh(httpMethod, path, body),
      // Explicit `res: Response` (not just inferred) so this file typechecks
      // under the public repo's stricter tsconfig regardless of how the
      // runWithGetRetry import resolves. (#3068)
      onOk: (res: Response) => res.json() as Promise<T>,
      onError: async (res: Response) => {
        const data = await res.json().catch(() => null) as Record<string, unknown> | null;
        return this.buildHttpError(res, data);
      },
    });
  }

  /**
   * Like request(), but also returns the response's rate-limit headers so
   * the caller (e.g., `nl create`) can show "Quota: N/Y remaining this hour."
   * after a successful mutation. Non-success responses still throw, same as
   * request(). Added for #855 — the vanilla `request()` return shape is used
   * by dozens of callers and changing it would be too invasive.
   */
  private async requestWithRateMeta<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ data: T; rateLimit?: RateLimitMeta }> {
    let res: Response;
    try {
      res = await this.fetchWithRefresh(method, path, body);
    } catch (cause) {
      // Transport rejection (network/timeout) before any Response — converge on
      // the unified McpError + telemetry just like request() (#2867). No retry:
      // this path serves the non-idempotent generate mutation.
      const err = networkErrorToMcpError(cause);
      emitMcpFailure({
        method: method.toUpperCase(),
        path,
        code: err.code,
        status: err.status,
        retryable: err.retryable,
      });
      throw err;
    }

    if (!res.ok) {
      // Converge on the unified error (#2867) via the shared builder. No
      // transient retry here — this path serves mutations (POST /affirmations
      // /generate), which are NOT idempotent.
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const err = this.buildHttpError(res, data);
      emitMcpFailure({
        method: method.toUpperCase(),
        path,
        code: err.code,
        status: err.status,
        retryable: err.retryable,
      });
      throw err;
    }

    const rateLimit = parseRateLimitMeta(res.headers);
    const responseData = (await res.json()) as T;
    return rateLimit ? { data: responseData, rateLimit } : { data: responseData };
  }

  /** Request that returns no body (for DELETE 204 responses). */
  private async requestVoid(method: string, path: string): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchWithRefresh(method, path);
    } catch (cause) {
      // Transport rejection — unified McpError + telemetry (#2867). DELETE is a
      // mutation → no retry.
      const err = networkErrorToMcpError(cause);
      emitMcpFailure({
        method: method.toUpperCase(),
        path,
        code: err.code,
        status: err.status,
        retryable: err.retryable,
      });
      throw err;
    }

    if (!res.ok) {
      // DELETE is a mutation → no transient retry. Converge on McpError (#2867)
      // while preserving the parsed `.data` body some callers read.
      const text = await res.text();
      let bodyData: Record<string, unknown> | undefined;
      try {
        bodyData = JSON.parse(text) as Record<string, unknown>;
      } catch { /* leave undefined */ }
      const err = this.buildHttpError(res, bodyData ?? null);
      if (bodyData) err.data = bodyData;
      emitMcpFailure({
        method: method.toUpperCase(),
        path,
        code: err.code,
        status: err.status,
        retryable: err.retryable,
      });
      throw err;
    }
  }

  /** Request that returns raw bytes (for audio download). GET → idempotent,
   *  so it gets the same bounded transient retry as request() (#2867). */
  private async requestBuffer(method: string, path: string): Promise<Buffer> {
    const { httpMethod } = normalizeMethod(method);
    return runWithGetRetry<Buffer>({
      httpMethod,
      path,
      doFetch: () => this.fetchWithRefresh(httpMethod, path),
      // Explicit `res: Response` — see request() above. (#3068)
      onOk: async (res: Response) => Buffer.from(await res.arrayBuffer()),
      onError: async (res: Response) => {
        const text = await res.text();
        const { code, retryable } = classifyStatus(res.status);
        return new McpError({
          code,
          message: `Download failed (${res.status}): ${text}`,
          status: res.status,
          retryable,
        });
      },
    });
  }

  private async tryRefresh(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      });

      if (!res.ok) return false;

      const data = await res.json() as LoginResult;
      this.accessToken = data.accessToken;
      this.refreshToken = data.refreshToken;

      // Persist the new tokens
      const auth = loadAuth();
      saveAuth({
        env: this.env,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        userId: auth?.userId ?? data.user.id,
        email: auth?.email ?? data.user.email,
      });

      return true;
    } catch {
      return false;
    }
  }

  // --- Auth ---

  async getMe(): Promise<{ user: UserDto }> {
    return this.request('GET', '/auth/me');
  }

  // --- Streaming helpers (#862) ---

  /** Expose the API base URL so the streaming module can talk to the same host the client is authed against. */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** Expose the current access token. Fresh each call; streaming module invokes this when opening the stream. */
  getAccessToken(): string {
    return this.accessToken;
  }

  /**
   * Refresh the access token iff its remaining lifetime is below the
   * threshold. Used by the CLI BEFORE opening an SSE stream so a
   * mid-stream 401 doesn't surface as `auth_expired`. Returns:
   *   - `true` if the token is fresh (already valid or refreshed ok)
   *   - `false` if refresh was attempted and failed
   *
   * If the token's `exp` claim can't be decoded, skips pre-flight and
   * returns `true` (the server's 401 path is the backstop).
   */
  async refreshIfExpiringSoon(thresholdMs = 10 * 60 * 1000): Promise<boolean> {
    const expMs = this.decodeTokenExpMs();
    if (expMs === null) return true; // Opaque token — let the server decide.
    if (expMs - Date.now() > thresholdMs) return true; // Still valid for long enough.
    return this.tryRefresh();
  }

  /** Decode the JWT payload's `exp` claim (ms). Returns `null` if the token isn't a decodable JWT. */
  private decodeTokenExpMs(): number | null {
    const parts = this.accessToken.split('.');
    if (parts.length !== 3) return null;
    try {
      const b64url = parts[1] ?? '';
      // Base64url → base64 and pad.
      const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const decoded = Buffer.from(padded, 'base64').toString('utf8');
      const payload = JSON.parse(decoded) as { exp?: number };
      if (typeof payload.exp !== 'number') return null;
      return payload.exp * 1000;
    } catch {
      return null;
    }
  }

  /**
   * Blocking resume — `POST /intents/:id/resume` without
   * `Accept: text/event-stream`. Returns a typed outcome for EVERY
   * response (happy-path AND precheck 4xx), so the CLI can render
   * blocking + streaming paths through the same renderer. Throws only
   * on raw transport failures (fetch rejection, JSON parse).
   */
  async resumeIntent(
    intentId: string,
    clientIdempotencyKey: string,
  ): Promise<ResumeBlockingOutcome> {
    const doRequest = async (token: string): Promise<Response> => {
      const url = `${this.baseUrl}/intents/${encodeURIComponent(intentId)}/resume`;
      const headers: Record<string, string> = {
        'X-Access-Token': token,
        'X-Idempotency-Key': clientIdempotencyKey,
        'Content-Type': 'application/json',
      };
      return fetch(url, { method: 'POST', headers, body: '{}' });
    };

    let res = await doRequest(this.accessToken);
    if (res.status === 401) {
      const refreshed = await this.tryRefresh();
      if (refreshed) res = await doRequest(this.accessToken);
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // No body or non-JSON — leave body empty.
    }
    return mapResumeJsonToOutcome(res.status, body);
  }

  async logout(): Promise<void> {
    try {
      await this.request('POST', '/auth/logout');
    } catch {
      // Best-effort — clear local tokens regardless
    }
    clearAuth();
  }

  // --- Library ---

  async getLibrary(params?: LibraryQueryParams): Promise<{ items: LibraryItem[] }> {
    const qs = new URLSearchParams();
    if (params?.sort) qs.set('sort', params.sort);
    if (params?.filter) qs.set('filter', params.filter);
    if (params?.playedSince) qs.set('playedSince', params.playedSince);
    if (params?.notPlayedSince) qs.set('notPlayedSince', params.notPlayedSince);
    if (params?.context) qs.set('context', params.context);
    const query = qs.toString();
    return this.request('GET', `/library${query ? `?${query}` : ''}`);
  }

  // --- Source preview ---

  /**
   * #993 — Extract preview metadata from a URL without generating.
   * Used by the CLI to show title + char count before spending a credit.
   */
  async extractUrlPreview(url: string): Promise<{
    title: string;
    author: string | null;
    charCount: number;
    excerpt: string | null;
    truncated: boolean;
  }> {
    return this.request('POST', '/source/extract-preview', { url });
  }

  /**
   * #1001 — Extract YouTube transcript preview (title, channel, char count)
   * without triggering generation.
   */
  async extractYoutubePreview(url: string): Promise<{
    title: string;
    channelName: string | null;
    charCount: number;
    truncated: boolean;
    videoId: string;
  }> {
    return this.request('POST', '/source/extract-youtube', { url });
  }

  /**
   * #2334 — Extract text from a Twitter/X post URL (thread text, author info).
   */
  async extractTwitterPreview(url: string): Promise<{
    text: string;
    author: string | null;
    authorHandle: string | null;
    charCount: number;
    truncated: boolean;
  }> {
    return this.request('POST', '/source/extract-twitter', { url });
  }

  /**
   * #999 — Upload a PDF file and extract text for source-based generation.
   * Uses multipart/form-data instead of JSON. Mirrors the 401 refresh-and-retry
   * pattern from request() since we can't reuse it (it forces JSON Content-Type).
   */
  async uploadPdf(buffer: Buffer): Promise<{
    text: string;
    pageCount: number;
    charCount: number;
    truncated: boolean;
  }> {
    const doUpload = async (token: string): Promise<Response> => {
      const url = `${this.baseUrl}/source/upload-pdf`;
      const blob = new Blob([new Uint8Array(buffer)], { type: 'application/pdf' });
      const formData = new FormData();
      formData.append('pdf', blob, 'upload.pdf');
      return fetch(url, {
        method: 'POST',
        headers: { 'X-Access-Token': token },
        body: formData,
      });
    };

    const path = '/source/upload-pdf';
    let res: Response;
    try {
      res = await doUpload(this.accessToken);
      // Auto-refresh on 401 (mirrors request() behavior)
      if (res.status === 401) {
        const refreshed = await this.tryRefresh();
        if (refreshed) res = await doUpload(this.accessToken);
      }
    } catch (cause) {
      // Transport rejection — unified McpError + telemetry (#2867). POST
      // multipart mutation → no retry.
      const err = networkErrorToMcpError(cause);
      emitMcpFailure({ method: 'POST', path, code: err.code, status: err.status, retryable: err.retryable });
      throw err;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => null) as Record<string, unknown> | null;
      const err = this.buildHttpError(res, data);
      emitMcpFailure({ method: 'POST', path, code: err.code, status: err.status, retryable: err.retryable });
      throw err;
    }

    return res.json() as Promise<{ text: string; pageCount: number; charCount: number; truncated: boolean }>;
  }

  // --- Intents ---

  async createAndGenerate(
    intentText?: string,
    tonePreference?: string,
    source?: { type: string; text?: string; url?: string; title?: string; author?: string },
    style?: string,
    styleNotes?: Record<string, unknown>,
    coachKey?: string,
    setAsDefault?: boolean,
  ): Promise<GenerateResult> {
    const body: Record<string, unknown> = {};
    if (intentText) body['intentText'] = intentText;
    if (tonePreference) body['tonePreference'] = tonePreference;
    if (source) body['source'] = source;
    // #3062 — Optional rhetorical-style steering (preset and/or free-form).
    if (style) body['style'] = style;
    if (styleNotes) body['styleNotes'] = styleNotes;
    // #3111 — Optional per-generation coach override (server resolves tolerantly).
    if (coachKey) body['coachKey'] = coachKey;
    // #3115 — Persist coachKey as defaultCoach after successful generation.
    if (setAsDefault) body['setAsDefault'] = true;
    return this.request('POST', '/affirmations/generate', body);
  }

  /**
   * Same as `createAndGenerate` but also returns the rate-limit headers
   * from the 2xx response so `nl create` can print the user's remaining
   * quota. Added for #855.
   */
  async createAndGenerateWithMeta(
    intentText?: string,
    tonePreference?: string,
    source?: { type: string; text?: string; url?: string; title?: string; author?: string },
    style?: string,
    styleNotes?: Record<string, unknown>,
    coachKey?: string,
    setAsDefault?: boolean,
  ): Promise<{ data: GenerateResult; rateLimit?: RateLimitMeta }> {
    const body: Record<string, unknown> = {};
    if (intentText) body['intentText'] = intentText;
    if (tonePreference) body['tonePreference'] = tonePreference;
    if (source) body['source'] = source;
    // #3062 — Optional rhetorical-style steering (preset and/or free-form).
    if (style) body['style'] = style;
    if (styleNotes) body['styleNotes'] = styleNotes;
    // #3111 — Optional per-generation coach override (server resolves tolerantly).
    if (coachKey) body['coachKey'] = coachKey;
    // #3115 — Persist coachKey as defaultCoach after successful generation.
    if (setAsDefault) body['setAsDefault'] = true;
    return this.requestWithRateMeta<GenerateResult>('POST', '/affirmations/generate', body);
  }

  async getIntent(id: string): Promise<{ intent: IntentDetail | null; stats?: IntentStats }> {
    return this.request('GET', `/intents/${encodeURIComponent(id)}`);
  }

  async updateIntent(id: string, input: UpdateIntentInput): Promise<{ intent: { id: string; title: string; emoji: string | null } }> {
    return this.request('PATCH', `/intents/${encodeURIComponent(id)}`, input);
  }

  // --- Render ---

  async configureRender(intentId: string, input: RenderConfigInput): Promise<{ renderConfig: RenderConfig }> {
    return this.request('PUT', `/intents/${encodeURIComponent(intentId)}/render-config`, input);
  }

  async startRender(intentId: string): Promise<{ jobId: string; status: string }> {
    return this.request('POST', `/intents/${encodeURIComponent(intentId)}/render`);
  }

  async getRenderStatus(intentId: string): Promise<RenderStatus> {
    return this.request('GET', `/intents/${encodeURIComponent(intentId)}/render-status`);
  }

  async getRenderJob(jobId: string): Promise<{ renderJob: RenderJob }> {
    return this.request('GET', `/render-jobs/${encodeURIComponent(jobId)}`);
  }

  /** Get an affirmation set by id. Returns the owning intent id for
   *  the perf harness's `nl admin perf render --set <id>` resolver to
   *  accept either id type transparently (#806). */
  async getAffirmationSet(setId: string): Promise<{ affirmationSet: { id: string; intentId: string } }> {
    return this.request('GET', `/affirmation-sets/${encodeURIComponent(setId)}`);
  }

  /** Expose stored auth env for CLI-level env-mismatch guards (#806). */
  getEnv(): ApiEnv {
    return this.env;
  }

  async createRenderJob(renderConfigId: string): Promise<{ renderJob: RenderJob }> {
    return this.request('POST', '/render-jobs', { renderConfigId });
  }

  async getAudio(renderJobId: string): Promise<Buffer> {
    return this.requestBuffer('GET', `/render-jobs/${encodeURIComponent(renderJobId)}/audio`);
  }

  // --- Credits ---

  async getCreditTransactions(take = 20): Promise<{ transactions: CreditTransaction[]; nextCursor?: string }> {
    return this.request('GET', `/credit-transactions?take=${take}`);
  }

  // --- Share ---

  async shareIntent(intentId: string): Promise<ShareResult> {
    return this.request('POST', `/intents/${encodeURIComponent(intentId)}/share`);
  }

  async unshareIntent(intentId: string): Promise<void> {
    return this.requestVoid('DELETE', `/intents/${encodeURIComponent(intentId)}/share`);
  }

  // --- Delete ---

  async deleteIntent(intentId: string): Promise<void> {
    return this.requestVoid('DELETE', `/intents/${encodeURIComponent(intentId)}`);
  }

  async bulkDeleteIntents(
    ids: string[],
  ): Promise<{ deleted: number; notFound: string[] }> {
    return this.request('POST', '/intents/bulk-delete', { ids });
  }

  // --- Profile ---

  async updateProfile(data: { displayName?: string; tonePreference?: string }): Promise<{ user: UserDto }> {
    return this.request('PATCH', '/auth/me', data);
  }

  // --- Username (#2138) ---

  /** Set or update the authenticated user's username via PATCH /auth/me. */
  async setUsername(username: string): Promise<{ user: UserDto }> {
    return this.request('PATCH', '/auth/me', { username });
  }

  /**
   * Check username availability. This is a public endpoint (no auth required)
   * but we route through the client for consistency and base URL resolution.
   */
  async checkUsername(username: string): Promise<{ available: boolean; suggestion?: string; error?: string }> {
    const qs = encodeURIComponent(username);
    return this.request('GET', `/auth/username/available?username=${qs}`);
  }

  // --- Coaches (#3116) ---

  /**
   * List all coaches (GET /coaches). Returns 404 when the coaches flag is off.
   */
  async getCoaches(): Promise<{ coaches: CoachDto[] }> {
    return this.request('GET', '/coaches');
  }

  // --- Affirmation feedback & toggle (#2209) ---

  /** Set feedback (like/dislike/clear) on a single affirmation. */
  async feedbackAffirmation(
    affirmationId: string,
    feedback: 'liked' | 'disliked' | null,
  ): Promise<{ affirmation: { id: string; feedback: 'liked' | 'disliked' | null } }> {
    return this.request('PATCH', `/affirmations/${encodeURIComponent(affirmationId)}/feedback`, { feedback });
  }

  /** Batch toggle isEnabled for multiple affirmations in one set. */
  async batchToggleAffirmations(
    setId: string,
    affirmationIds: string[],
    isEnabled: boolean,
  ): Promise<{ affirmationSet: unknown }> {
    return this.request('PATCH', `/affirmation-sets/${encodeURIComponent(setId)}/batch-toggle`, {
      affirmationIds,
      isEnabled,
    });
  }

  // --- Context Settings ---

  async getContextSettings(): Promise<{ settings: ContextSettings[] }> {
    return this.request('GET', '/context-settings');
  }

  async updateContextSettings(
    context: string,
    data: Partial<Omit<ContextSettings, 'sessionContext'>>,
  ): Promise<{ settings: ContextSettings }> {
    return this.request('PATCH', `/context-settings/${encodeURIComponent(context)}`, data);
  }

  async deleteContextSettings(context: string): Promise<void> {
    return this.requestVoid('DELETE', `/context-settings/${encodeURIComponent(context)}`);
  }

  // --- Wizard Defaults ---

  async getWizardDefaults(intentId?: string): Promise<WizardDefaults> {
    const qs = intentId ? `?intentId=${encodeURIComponent(intentId)}` : '';
    return this.request('GET', `/wizard/defaults${qs}`);
  }

  // --- Affirmation management (#2337) ---

  /** Generate more affirmations for an existing set. Costs 1 credit. */
  async generateMore(setId: string, count?: number): Promise<{ affirmationSet: unknown; added: number }> {
    const body: Record<string, unknown> = {};
    if (count !== undefined) body['count'] = count;
    return this.request('POST', `/affirmation-sets/${encodeURIComponent(setId)}/generate-more`, body);
  }

  /** Add a custom (user-written) affirmation to a set. */
  async addAffirmation(setId: string, text: string): Promise<{ affirmation: { id: string; text: string; tone: string; isEnabled: boolean } }> {
    return this.request('POST', `/affirmation-sets/${encodeURIComponent(setId)}/affirmations`, { text });
  }

  /** Delete a single affirmation. Returns 204. */
  async deleteAffirmation(affirmationId: string): Promise<void> {
    return this.requestVoid('DELETE', `/affirmations/${encodeURIComponent(affirmationId)}`);
  }

  // --- Affirmation sync ---

  async syncAffirmations(intentId: string, input: SyncAffirmationsInput): Promise<SyncAffirmationsResult> {
    return this.request('PUT', `/intents/${encodeURIComponent(intentId)}/affirmations/sync`, input);
  }

  // --- Manual intent creation (with affirmations) ---

  async createManualIntent(input: {
    title: string;
    rawText: string;
    tonePreference?: string | null;
    sessionContext?: string | undefined;
    affirmations: Array<{ text: string }>;
  }): Promise<{
    intent: { id: string; title: string; emoji: string | null; rawText: string; sessionContext: string };
    affirmationSet: {
      id: string;
      affirmations: Array<{ id: string; text: string; tone: string; isEnabled: boolean }>;
    };
  }> {
    return this.request('POST', '/intents/manual', input);
  }

  // --- Catalog (#2336) ---

  /** Browse catalog sets. Public endpoint (auth sent but not required). */
  async catalogBrowse(params?: {
    context?: string;
    sort?: string;
    filter?: string;
  }): Promise<{ sets: Array<Record<string, unknown>> }> {
    const qs = new URLSearchParams();
    if (params?.context) qs.set('context', params.context);
    if (params?.sort) qs.set('sort', params.sort);
    if (params?.filter) qs.set('filter', params.filter);
    const query = qs.toString();
    return this.request('GET', `/catalog${query ? `?${query}` : ''}`);
  }

  /** View a specific catalog item by slug. Public endpoint. */
  async catalogView(slug: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/catalog/${encodeURIComponent(slug)}`);
  }

  /** Copy a catalog set to the user's library. Requires auth (rate-limited). */
  async catalogCopy(slug: string): Promise<{
    intent: { id: string; title: string; emoji: string | null };
    affirmationSet: { id: string; affirmations: Array<{ id: string; text: string; tone: string; isEnabled: boolean }> };
  }> {
    return this.request('POST', `/catalog/${encodeURIComponent(slug)}/copy`);
  }

  // --- Playback tracking (#2338) ---

  /** Start a playback session. Creates a PlaybackHistory record. */
  async startPlayback(intentId: string, renderJobId?: string): Promise<{ id: string }> {
    const body: Record<string, string> = { intentId };
    if (renderJobId) body['renderJobId'] = renderJobId;
    return this.request('POST', '/playback', body);
  }

  /** Update a playback session with duration and optional completion. */
  async completePlayback(
    playbackId: string,
    durationSeconds: number,
    completed?: boolean,
  ): Promise<{ ok: true }> {
    const body: Record<string, unknown> = { durationSeconds };
    if (completed !== undefined) body['completed'] = completed;
    return this.request('PATCH', `/playback/${encodeURIComponent(playbackId)}`, body);
  }

}
