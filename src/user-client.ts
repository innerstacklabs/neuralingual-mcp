import type { ApiEnv, RenderConfigInput, RenderConfig, RenderStatus, SyncAffirmationsInput, SyncAffirmationsResult } from './types.js';
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
}

interface IntentDetail {
  id: string;
  title: string;
  emoji: string | null;
  rawText: string;
  tonePreference: string | null;
  sessionContext: string;
  shareToken: string | null;
  sharedAt: string | null;
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

  /** Login with Apple identity token (from browser-based Sign In with Apple). */
  static async loginWithApple(
    env: ApiEnv,
    idToken: string,
    displayName?: string,
  ): Promise<{ client: UserApiClient; user: UserDto }> {
    const baseUrl = API_BASE_URLS[env];
    const body: Record<string, string> = { idToken };
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
      const errMsg = data && typeof data['error'] === 'string' ? data['error'] : `HTTP ${res.status}`;
      throw new Error(errMsg);
    }

    return res.json() as Promise<T>;
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
      let errMsg = `HTTP ${res.status}`;
      try {
        const data = JSON.parse(text) as Record<string, unknown>;
        if (typeof data['error'] === 'string') errMsg = data['error'];
      } catch { /* use default */ }
      throw new Error(errMsg);
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
      // Best-effort — clear local tokens regardless
    }
    clearAuth();
  }

  // --- Library ---

  async getLibrary(): Promise<{ items: LibraryItem[] }> {
    return this.request('GET', '/library');
  }

  // --- Intents ---

  async createAndGenerate(intentText: string, tonePreference?: string): Promise<GenerateResult> {
    const body: Record<string, unknown> = { intentText };
    if (tonePreference) body['tonePreference'] = tonePreference;
    return this.request('POST', '/affirmations/generate', body);
  }

  async getIntent(id: string): Promise<{ intent: IntentDetail | null }> {
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

  async unshareIntent(intentId: string): Promise<void> {
    return this.requestVoid('DELETE', `/intents/${encodeURIComponent(intentId)}/share`);
  }

  // --- Delete ---

  async deleteIntent(intentId: string): Promise<void> {
    return this.requestVoid('DELETE', `/intents/${encodeURIComponent(intentId)}`);
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
