import type { ApiEnv, IntentStats, LibraryQueryParams, RenderConfigInput, RenderConfig, RenderStatus, SyncAffirmationsInput, SyncAffirmationsResult } from './types.js';
import { API_BASE_URLS } from './types.js';
import { loadAuth, saveAuth, clearAuth } from './auth-store.js';

interface UserDto {
  id: string;
  email: string | null;
  displayName: string | null;
  authProvider: string;
  tonePreference: string;
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
    }>;
    // Framework-first (#747) fields. Null on legacy/second-person sets.
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
}

/**
 * Rate-limit metadata surfaced from successful (2xx) responses. Parsed from
 * `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`.
 * Returns `null` when the server didn't emit the headers.
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
 *   1. `Retry-After` header (RFC 9110 preferred -- seconds, or HTTP-date)
 *   2. Body `retryAfterMs` (structured 429)
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
  // 2. Body retry_after_ms (snake_case; camelCase fallback)
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
  // 3. X-RateLimit-Reset header (legacy -- accepts numeric epoch-ms or ISO string)
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
  // No signal -- default to 60s.
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const doRequest = async (token: string): Promise<Response> => {
      const url = `${this.baseUrl}${path}`;
      const headers: Record<string, string> = {
        'X-Access-Token': token,
      };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      const init: RequestInit = { method, headers };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      return fetch(url, init);
    };

    let res = await doRequest(this.accessToken);

    // Auto-refresh on 401
    if (res.status === 401) {
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        res = await doRequest(this.accessToken);
      }
    }

    if (!res.ok) {
      const data = await res.json().catch(() => null) as Record<string, unknown> | null;
      if (res.status === 429) {
        const { resetAt, retryAfterMs } = parse429Timing(res.headers, data);
        const errMsg =
          (data && typeof data['message'] === 'string' && (data['message'] as string)) ||
          (data && typeof data['error'] === 'string' && (data['error'] as string)) ||
          'HTTP 429 (rate limited)';
        const source =
          data && typeof data['source'] === 'string' ? (data['source'] as string) : undefined;
        const err = new Error(errMsg) as Error & {
          status: 429;
          resetAt: number | null;
          retryAfterMs: number;
          source?: string;
        };
        err.status = 429;
        err.resetAt = resetAt;
        err.retryAfterMs = retryAfterMs;
        if (source !== undefined) err.source = source;
        throw err;
      }
      const bodyMsg =
        (data && typeof data['message'] === 'string' && (data['message'] as string)) ||
        (data && typeof data['error'] === 'string' && (data['error'] as string)) ||
        undefined;
      const errMsg = bodyMsg
        ? `HTTP ${res.status}: ${bodyMsg}`
        : `HTTP ${res.status}`;
      const err = new Error(errMsg) as Error & { status: number };
      err.status = res.status;
      throw err;
    }

    return res.json() as Promise<T>;
  }

  private async requestWithRateMeta<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ data: T; rateLimit?: RateLimitMeta }> {
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

    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.status === 429) {
        const { resetAt, retryAfterMs } = parse429Timing(res.headers, data);
        const errMsg =
          (data && typeof data['message'] === 'string' && (data['message'] as string)) ||
          (data && typeof data['error'] === 'string' && (data['error'] as string)) ||
          'HTTP 429 (rate limited)';
        const source =
          data && typeof data['source'] === 'string' ? (data['source'] as string) : undefined;
        const err = new Error(errMsg) as Error & {
          status: 429;
          resetAt: number | null;
          retryAfterMs: number;
          source?: string;
        };
        err.status = 429;
        err.resetAt = resetAt;
        err.retryAfterMs = retryAfterMs;
        if (source !== undefined) err.source = source;
        throw err;
      }
      const bodyMsg =
        (data && typeof data['message'] === 'string' && (data['message'] as string)) ||
        (data && typeof data['error'] === 'string' && (data['error'] as string)) ||
        undefined;
      const errMsg = bodyMsg
        ? `HTTP ${res.status}: ${bodyMsg}`
        : `HTTP ${res.status}`;
      const err = new Error(errMsg) as Error & { status: number };
      err.status = res.status;
      throw err;
    }

    const rateLimit = parseRateLimitMeta(res.headers);
    const responseData = (await res.json()) as T;
    return rateLimit ? { data: responseData, rateLimit } : { data: responseData };
  }

  /** Request that returns no body (for DELETE 204 responses). */
  private async requestVoid(method: string, path: string): Promise<void> {
    const doRequest = async (token: string): Promise<Response> => {
      const url = `${this.baseUrl}${path}`;
      return fetch(url, {
        method,
        headers: { 'X-Access-Token': token },
      });
    };

    let res = await doRequest(this.accessToken);

    if (res.status === 401) {
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        res = await doRequest(this.accessToken);
      }
    }

    if (!res.ok) {
      const text = await res.text();
      let bodyMsg: string | undefined;
      let bodyData: Record<string, unknown> | undefined;
      try {
        const data = JSON.parse(text) as Record<string, unknown>;
        bodyData = data;
        if (typeof data['message'] === 'string') bodyMsg = data['message'];
        else if (typeof data['error'] === 'string') bodyMsg = data['error'];
      } catch { /* use default */ }
      const errMsg = bodyMsg ? `HTTP ${res.status}: ${bodyMsg}` : `HTTP ${res.status}`;
      const err = new Error(errMsg) as Error & { status: number; data?: Record<string, unknown> };
      err.status = res.status;
      if (bodyData) err.data = bodyData;
      throw err;
    }
  }

  /** Request that returns raw bytes (for audio download). */
  private async requestBuffer(method: string, path: string): Promise<Buffer> {
    const doRequest = async (token: string): Promise<Response> => {
      const url = `${this.baseUrl}${path}`;
      return fetch(url, {
        method,
        headers: { 'X-Access-Token': token },
      });
    };

    let res = await doRequest(this.accessToken);

    if (res.status === 401) {
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        res = await doRequest(this.accessToken);
      }
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Download failed (${res.status}): ${text}`);
    }

    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
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

  async logout(): Promise<void> {
    try {
      await this.request('POST', '/auth/logout');
    } catch {
      // Best-effort -- clear local tokens regardless
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

  async extractUrlPreview(url: string): Promise<{
    title: string;
    author: string | null;
    charCount: number;
    excerpt: string | null;
    truncated: boolean;
  }> {
    return this.request('POST', '/source/extract-preview', { url });
  }

  async extractYoutubePreview(url: string): Promise<{
    title: string;
    channelName: string | null;
    charCount: number;
    truncated: boolean;
    videoId: string;
  }> {
    return this.request('POST', '/source/extract-youtube', { url });
  }

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

    let res = await doUpload(this.accessToken);

    if (res.status === 401) {
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        res = await doUpload(this.accessToken);
      }
    }

    if (!res.ok) {
      const data = await res.json().catch(() => null) as Record<string, unknown> | null;
      const msg = (data && typeof data['error'] === 'string') ? data['error'] as string : `HTTP ${res.status}`;
      throw new Error(msg);
    }

    return res.json() as Promise<{ text: string; pageCount: number; charCount: number; truncated: boolean }>;
  }

  // --- Intents ---

  async createAndGenerate(
    intentText?: string,
    tonePreference?: string,
    source?: { type: string; text?: string; url?: string; title?: string; author?: string },
  ): Promise<GenerateResult> {
    const body: Record<string, unknown> = {};
    if (intentText) body['intentText'] = intentText;
    if (tonePreference) body['tonePreference'] = tonePreference;
    if (source) body['source'] = source;
    return this.request('POST', '/affirmations/generate', body);
  }

  async createAndGenerateWithMeta(
    intentText?: string,
    tonePreference?: string,
    source?: { type: string; text?: string; url?: string; title?: string; author?: string },
  ): Promise<{ data: GenerateResult; rateLimit?: RateLimitMeta }> {
    const body: Record<string, unknown> = {};
    if (intentText) body['intentText'] = intentText;
    if (tonePreference) body['tonePreference'] = tonePreference;
    if (source) body['source'] = source;
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

}
