import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { UserApiClient } from './user-client.js';
import { API_BASE_URLS } from './types.js';

// Mock auth-store
vi.mock('./auth-store.js', () => ({
  loadAuth: vi.fn(),
  saveAuth: vi.fn(),
  clearAuth: vi.fn(),
}));

import { loadAuth, saveAuth, clearAuth } from './auth-store.js';

const mockedLoadAuth = loadAuth as Mock;
const mockedSaveAuth = saveAuth as Mock;
const mockedClearAuth = clearAuth as Mock;

// Mock global fetch
const mockedFetch = vi.fn();
vi.stubGlobal('fetch', mockedFetch);

// --- Helpers ---

const TEST_ACCESS_TOKEN = 'test-access-token';
const TEST_REFRESH_TOKEN = 'test-refresh-token';
const BASE_URL = API_BASE_URLS.production;

function makeClient(env: 'dev' | 'production' = 'production'): UserApiClient {
  return new UserApiClient(API_BASE_URLS[env], env, TEST_ACCESS_TOKEN, TEST_REFRESH_TOKEN);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, body?: unknown): Response {
  const responseBody = body !== undefined ? JSON.stringify(body) : '';
  return new Response(responseBody, { status });
}

function voidResponse(status = 204): Response {
  return new Response(null, { status });
}

const MOCK_USER = {
  id: 'user-1',
  email: 'test@example.com',
  displayName: 'Test User',
  authProvider: 'apple',
  tonePreference: 'grounded',
  completedOnboarding: true,
  subscriptionTier: 'pro',
  subscriptionStatus: 'active',
  subscriptionExpiresAt: null,
  creditBalance: 10,
  subscriptionCredits: 5,
  purchasedCredits: 5,
  creditsResetAt: null,
  role: 'user',
};

const MOCK_LOGIN_RESULT = {
  accessToken: 'new-access-token',
  refreshToken: 'new-refresh-token',
  user: MOCK_USER,
};

// --- Tests ---

beforeEach(() => {
  vi.clearAllMocks();
});

describe('UserApiClient', () => {

  // =====================================================================
  // Static factory: fromAuth
  // =====================================================================
  describe('fromAuth', () => {
    it('creates a client from stored auth', () => {
      mockedLoadAuth.mockReturnValue({
        env: 'production',
        accessToken: 'stored-access',
        refreshToken: 'stored-refresh',
        userId: 'u1',
        email: 'test@example.com',
      });

      const client = UserApiClient.fromAuth();
      expect(client).toBeInstanceOf(UserApiClient);
      expect(mockedLoadAuth).toHaveBeenCalledOnce();
    });

    it('throws when no auth is stored', () => {
      mockedLoadAuth.mockReturnValue(null);

      expect(() => UserApiClient.fromAuth()).toThrow('Not logged in');
    });

    it('uses the correct base URL for dev env', () => {
      mockedLoadAuth.mockReturnValue({
        env: 'dev',
        accessToken: 'dev-access',
        refreshToken: 'dev-refresh',
        userId: 'u1',
        email: null,
      });

      mockedFetch.mockResolvedValue(jsonResponse({ user: MOCK_USER }));

      const client = UserApiClient.fromAuth();
      // Trigger a request to verify the base URL
      client.getMe();

      expect(mockedFetch).toHaveBeenCalledWith(
        expect.stringContaining(API_BASE_URLS.dev),
        expect.any(Object),
      );
    });
  });

  // =====================================================================
  // Static login methods
  // =====================================================================
  describe('login (email + secret)', () => {
    it('sends POST to /auth/admin/login with correct body', async () => {
      mockedFetch.mockResolvedValue(jsonResponse(MOCK_LOGIN_RESULT));

      const result = await UserApiClient.login('production', 'test@example.com', 'secret123');

      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/auth/admin/login`,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'test@example.com', secret: 'secret123', clientType: 'cli' }),
        }),
      );
      expect(result.user).toEqual(MOCK_USER);
      expect(result.client).toBeInstanceOf(UserApiClient);
    });

    it('saves auth tokens on successful login', async () => {
      mockedFetch.mockResolvedValue(jsonResponse(MOCK_LOGIN_RESULT));

      await UserApiClient.login('production', 'test@example.com', 'secret123');

      expect(mockedSaveAuth).toHaveBeenCalledWith({
        env: 'production',
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        userId: 'user-1',
        email: 'test@example.com',
      });
    });

    it('uses dev base URL when env is dev', async () => {
      mockedFetch.mockResolvedValue(jsonResponse(MOCK_LOGIN_RESULT));

      await UserApiClient.login('dev', 'test@example.com', 'secret123');

      expect(mockedFetch).toHaveBeenCalledWith(
        `${API_BASE_URLS.dev}/auth/admin/login`,
        expect.any(Object),
      );
    });

    it('throws with server error message on failure', async () => {
      mockedFetch.mockResolvedValue(jsonResponse({ error: 'Invalid credentials' }, 401));

      await expect(UserApiClient.login('production', 'bad@example.com', 'wrong'))
        .rejects.toThrow('Invalid credentials');
    });

    it('throws generic message when error response has no error field', async () => {
      mockedFetch.mockResolvedValue(errorResponse(500));

      await expect(UserApiClient.login('production', 'test@example.com', 'secret123'))
        .rejects.toThrow('Login failed (HTTP 500)');
    });

    it('throws generic message when error response is not valid JSON', async () => {
      mockedFetch.mockResolvedValue(new Response('Internal Server Error', { status: 500 }));

      await expect(UserApiClient.login('production', 'test@example.com', 'secret123'))
        .rejects.toThrow('Login failed (HTTP 500)');
    });
  });

  describe('loginWithApple', () => {
    it('sends POST to /auth/apple/callback with idToken', async () => {
      mockedFetch.mockResolvedValue(jsonResponse(MOCK_LOGIN_RESULT));

      const result = await UserApiClient.loginWithApple('production', 'apple-id-token-123');

      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/auth/apple/callback`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ idToken: 'apple-id-token-123', clientType: 'cli' }),
        }),
      );
      expect(result.client).toBeInstanceOf(UserApiClient);
      expect(result.user).toEqual(MOCK_USER);
    });

    it('includes displayName when provided', async () => {
      mockedFetch.mockResolvedValue(jsonResponse(MOCK_LOGIN_RESULT));

      await UserApiClient.loginWithApple('production', 'apple-id-token', 'Dave');

      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/auth/apple/callback`,
        expect.objectContaining({
          body: JSON.stringify({ idToken: 'apple-id-token', clientType: 'cli', displayName: 'Dave' }),
        }),
      );
    });

    it('saves auth on successful Apple login', async () => {
      mockedFetch.mockResolvedValue(jsonResponse(MOCK_LOGIN_RESULT));

      await UserApiClient.loginWithApple('production', 'apple-id-token');

      expect(mockedSaveAuth).toHaveBeenCalledWith(expect.objectContaining({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      }));
    });

    it('throws on failure with error message', async () => {
      mockedFetch.mockResolvedValue(jsonResponse({ error: 'Apple auth failed' }, 401));

      await expect(UserApiClient.loginWithApple('production', 'bad-token'))
        .rejects.toThrow('Apple auth failed');
    });
  });

  // =====================================================================
  // Auth headers & request mechanics
  // =====================================================================
  describe('request mechanics', () => {
    it('sends X-Access-Token header on authenticated requests', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ user: MOCK_USER }));

      await client.getMe();

      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/auth/me`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'X-Access-Token': TEST_ACCESS_TOKEN,
          }),
        }),
      );
    });

    it('includes Content-Type header when body is provided', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ intent: { id: '1', title: 'Test', emoji: null } }));

      await client.updateIntent('intent-1', { title: 'New Title' });

      expect(mockedFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Access-Token': TEST_ACCESS_TOKEN,
          }),
          body: JSON.stringify({ title: 'New Title' }),
        }),
      );
    });

    it('does not include Content-Type header for GET requests', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ user: MOCK_USER }));

      await client.getMe();

      const callHeaders = (mockedFetch.mock.calls[0] as unknown[])[1] as RequestInit;
      expect((callHeaders.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    });
  });

  // =====================================================================
  // 401 handling & token refresh
  // =====================================================================
  describe('401 handling and token refresh', () => {
    it('refreshes token on 401 and retries the original request', async () => {
      const client = makeClient();
      mockedLoadAuth.mockReturnValue({
        env: 'production',
        accessToken: TEST_ACCESS_TOKEN,
        refreshToken: TEST_REFRESH_TOKEN,
        userId: 'u1',
        email: 'test@example.com',
      });

      // First call: 401, Second call (refresh): success, Third call (retry): success
      mockedFetch
        .mockResolvedValueOnce(errorResponse(401))
        .mockResolvedValueOnce(jsonResponse(MOCK_LOGIN_RESULT))
        .mockResolvedValueOnce(jsonResponse({ user: MOCK_USER }));

      const result = await client.getMe();

      expect(result).toEqual({ user: MOCK_USER });
      expect(mockedFetch).toHaveBeenCalledTimes(3);

      // Verify refresh call
      expect(mockedFetch).toHaveBeenNthCalledWith(2,
        `${BASE_URL}/auth/refresh`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ refreshToken: TEST_REFRESH_TOKEN }),
        }),
      );
    });

    it('persists new tokens after successful refresh', async () => {
      const client = makeClient();
      mockedLoadAuth.mockReturnValue({
        env: 'production',
        accessToken: TEST_ACCESS_TOKEN,
        refreshToken: TEST_REFRESH_TOKEN,
        userId: 'u1',
        email: 'test@example.com',
      });

      mockedFetch
        .mockResolvedValueOnce(errorResponse(401))
        .mockResolvedValueOnce(jsonResponse(MOCK_LOGIN_RESULT))
        .mockResolvedValueOnce(jsonResponse({ user: MOCK_USER }));

      await client.getMe();

      expect(mockedSaveAuth).toHaveBeenCalledWith(expect.objectContaining({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      }));
    });

    it('throws error when refresh fails (refresh returns non-200)', async () => {
      const client = makeClient();

      mockedFetch
        .mockResolvedValueOnce(errorResponse(401))
        .mockResolvedValueOnce(errorResponse(401)); // refresh also fails

      // After failed refresh, original 401 response is still not ok → throws
      await expect(client.getMe()).rejects.toThrow('HTTP 401');
      // Note: tryRefresh does not clear auth on failure — it only returns false
      expect(mockedClearAuth).not.toHaveBeenCalled();
    });

    it('throws error when refresh request itself throws', async () => {
      const client = makeClient();

      mockedFetch
        .mockResolvedValueOnce(errorResponse(401))
        .mockRejectedValueOnce(new Error('Network error during refresh'));

      // tryRefresh catches and returns false, so the original 401 propagates
      await expect(client.getMe()).rejects.toThrow('HTTP 401');
      expect(mockedClearAuth).not.toHaveBeenCalled();
    });

    it('uses new token for the retry request after refresh', async () => {
      const client = makeClient();
      mockedLoadAuth.mockReturnValue({
        env: 'production',
        accessToken: TEST_ACCESS_TOKEN,
        refreshToken: TEST_REFRESH_TOKEN,
        userId: 'u1',
        email: null,
      });

      mockedFetch
        .mockResolvedValueOnce(errorResponse(401))
        .mockResolvedValueOnce(jsonResponse(MOCK_LOGIN_RESULT))
        .mockResolvedValueOnce(jsonResponse({ user: MOCK_USER }));

      await client.getMe();

      // Third call should use the new access token
      const thirdCallInit = (mockedFetch.mock.calls[2] as unknown[])[1] as RequestInit;
      expect((thirdCallInit.headers as Record<string, string>)['X-Access-Token']).toBe('new-access-token');
    });

    it('handles 401 on requestVoid methods', async () => {
      const client = makeClient();
      mockedLoadAuth.mockReturnValue({
        env: 'production',
        accessToken: TEST_ACCESS_TOKEN,
        refreshToken: TEST_REFRESH_TOKEN,
        userId: 'u1',
        email: null,
      });

      mockedFetch
        .mockResolvedValueOnce(errorResponse(401))
        .mockResolvedValueOnce(jsonResponse(MOCK_LOGIN_RESULT))
        .mockResolvedValueOnce(voidResponse());

      await client.deleteIntent('intent-1');

      expect(mockedFetch).toHaveBeenCalledTimes(3);
    });

    it('handles 401 on requestBuffer methods', async () => {
      const client = makeClient();
      mockedLoadAuth.mockReturnValue({
        env: 'production',
        accessToken: TEST_ACCESS_TOKEN,
        refreshToken: TEST_REFRESH_TOKEN,
        userId: 'u1',
        email: null,
      });

      const audioData = new Uint8Array([1, 2, 3, 4]).buffer;
      mockedFetch
        .mockResolvedValueOnce(errorResponse(401))
        .mockResolvedValueOnce(jsonResponse(MOCK_LOGIN_RESULT))
        .mockResolvedValueOnce(new Response(audioData, { status: 200 }));

      const result = await client.getAudio('job-1');

      expect(Buffer.isBuffer(result)).toBe(true);
      expect(mockedFetch).toHaveBeenCalledTimes(3);
    });
  });

  // =====================================================================
  // Error responses
  // =====================================================================
  describe('error responses', () => {
    it('throws error message from JSON error field', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ error: 'Intent not found' }, 404));

      await expect(client.getIntent('missing')).rejects.toThrow('Intent not found');
    });

    it('throws generic HTTP error when no error field in response', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ message: 'something else' }, 500));

      await expect(client.getIntent('id')).rejects.toThrow('HTTP 500');
    });

    it('throws generic HTTP error when response is not valid JSON', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(new Response('not json', { status: 500 }));

      await expect(client.getIntent('id')).rejects.toThrow('HTTP 500');
    });

    it('throws error for requestVoid on non-ok status', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ error: 'Cannot delete' }, 403));

      await expect(client.deleteIntent('id')).rejects.toThrow('Cannot delete');
    });

    it('throws error for requestVoid with non-JSON error body', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(new Response('Server Error', { status: 500 }));

      await expect(client.deleteIntent('id')).rejects.toThrow('HTTP 500');
    });

    it('throws error for requestBuffer on non-ok status', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));

      await expect(client.getAudio('missing-job')).rejects.toThrow('Download failed (404)');
    });
  });

  // =====================================================================
  // Network errors
  // =====================================================================
  describe('network errors', () => {
    it('propagates fetch errors on request', async () => {
      const client = makeClient();
      mockedFetch.mockRejectedValue(new Error('fetch failed'));

      await expect(client.getMe()).rejects.toThrow('fetch failed');
    });

    it('propagates fetch errors on requestVoid', async () => {
      const client = makeClient();
      mockedFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(client.deleteIntent('id')).rejects.toThrow('ECONNREFUSED');
    });

    it('propagates fetch errors on requestBuffer', async () => {
      const client = makeClient();
      mockedFetch.mockRejectedValue(new Error('timeout'));

      await expect(client.getAudio('job-id')).rejects.toThrow('timeout');
    });
  });

  // =====================================================================
  // Environment switching
  // =====================================================================
  describe('environment switching', () => {
    it('uses production base URL by default', async () => {
      const client = makeClient('production');
      mockedFetch.mockResolvedValue(jsonResponse({ user: MOCK_USER }));

      await client.getMe();

      expect(mockedFetch).toHaveBeenCalledWith(
        `${API_BASE_URLS.production}/auth/me`,
        expect.any(Object),
      );
    });

    it('uses dev base URL when constructed with dev env', async () => {
      const client = makeClient('dev');
      mockedFetch.mockResolvedValue(jsonResponse({ user: MOCK_USER }));

      await client.getMe();

      expect(mockedFetch).toHaveBeenCalledWith(
        `${API_BASE_URLS.dev}/auth/me`,
        expect.any(Object),
      );
    });
  });

  // =====================================================================
  // Auth methods
  // =====================================================================
  describe('getMe', () => {
    it('sends GET to /auth/me', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ user: MOCK_USER }));

      const result = await client.getMe();

      expect(result).toEqual({ user: MOCK_USER });
      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/auth/me`,
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  describe('logout', () => {
    it('sends POST to /auth/logout and clears auth', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({}));

      await client.logout();

      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/auth/logout`,
        expect.objectContaining({ method: 'POST' }),
      );
      expect(mockedClearAuth).toHaveBeenCalledOnce();
    });

    it('clears auth even if server logout fails', async () => {
      const client = makeClient();
      mockedFetch.mockRejectedValue(new Error('Network error'));

      await client.logout();

      expect(mockedClearAuth).toHaveBeenCalledOnce();
    });
  });

  // =====================================================================
  // Library
  // =====================================================================
  describe('getLibrary', () => {
    it('sends GET to /library with no params', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ items: [] }));

      const result = await client.getLibrary();

      expect(result).toEqual({ items: [] });
      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/library`,
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('appends query params when provided', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ items: [] }));

      await client.getLibrary({
        sort: 'recent',
        filter: 'has-audio',
        context: 'sleep',
      });

      const calledUrl = (mockedFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain('sort=recent');
      expect(calledUrl).toContain('filter=has-audio');
      expect(calledUrl).toContain('context=sleep');
    });

    it('includes playedSince and notPlayedSince params', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ items: [] }));

      await client.getLibrary({
        playedSince: '2025-01-01',
        notPlayedSince: '2025-06-01',
      });

      const calledUrl = (mockedFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain('playedSince=2025-01-01');
      expect(calledUrl).toContain('notPlayedSince=2025-06-01');
    });

    it('omits undefined params from query string', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ items: [] }));

      await client.getLibrary({ sort: 'title' });

      const calledUrl = (mockedFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toBe(`${BASE_URL}/library?sort=title`);
    });
  });

  // =====================================================================
  // Intents
  // =====================================================================
  describe('createAndGenerate', () => {
    it('sends POST to /affirmations/generate with intentText', async () => {
      const client = makeClient();
      const mockResult = {
        intent: { id: 'i1', title: 'Test', emoji: null, rawText: 'test', sessionContext: 'general' },
        affirmationSet: { id: 'as1', affirmations: [] },
      };
      mockedFetch.mockResolvedValue(jsonResponse(mockResult));

      const result = await client.createAndGenerate('I want to be more confident');

      expect(result).toEqual(mockResult);
      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/affirmations/generate`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ intentText: 'I want to be more confident' }),
        }),
      );
    });

    it('includes tonePreference when provided', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({
        intent: { id: 'i1', title: 'T', emoji: null, rawText: 't', sessionContext: 'general' },
        affirmationSet: { id: 'as1', affirmations: [] },
      }));

      await client.createAndGenerate('intent text', 'mystical');

      expect(mockedFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ intentText: 'intent text', tonePreference: 'mystical' }),
        }),
      );
    });
  });

  describe('getIntent', () => {
    it('sends GET to /intents/:id', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ intent: null }));

      await client.getIntent('intent-123');

      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/intents/intent-123`,
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('encodes special characters in intent id', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ intent: null }));

      await client.getIntent('id/with/slashes');

      const calledUrl = (mockedFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain('id%2Fwith%2Fslashes');
    });
  });

  describe('updateIntent', () => {
    it('sends PATCH to /intents/:id with input body', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ intent: { id: 'i1', title: 'Updated', emoji: null } }));

      const result = await client.updateIntent('i1', { title: 'Updated', emoji: '🎯' });

      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/intents/i1`,
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ title: 'Updated', emoji: '🎯' }),
        }),
      );
      expect(result.intent.title).toBe('Updated');
    });
  });

  // =====================================================================
  // Render
  // =====================================================================
  describe('configureRender', () => {
    it('sends PUT to /intents/:id/render-config', async () => {
      const client = makeClient();
      const mockConfig = { id: 'rc1', intentId: 'i1' };
      mockedFetch.mockResolvedValue(jsonResponse({ renderConfig: mockConfig }));

      const input = {
        voiceId: 'voice-1',
        sessionContext: 'sleep' as const,
        durationMinutes: 15,
        paceWpm: 120,
      };
      await client.configureRender('i1', input);

      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/intents/i1/render-config`,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(input),
        }),
      );
    });
  });

  describe('startRender', () => {
    it('sends POST to /intents/:id/render', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ jobId: 'job-1', status: 'queued' }));

      const result = await client.startRender('i1');

      expect(result).toEqual({ jobId: 'job-1', status: 'queued' });
      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/intents/i1/render`,
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('getRenderStatus', () => {
    it('sends GET to /intents/:id/render-status', async () => {
      const client = makeClient();
      const mockStatus = { status: 'completed', progress: 100, outputKey: 'audio.mp3', errorMessage: null };
      mockedFetch.mockResolvedValue(jsonResponse(mockStatus));

      const result = await client.getRenderStatus('i1');

      expect(result).toEqual(mockStatus);
      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/intents/i1/render-status`,
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  describe('getRenderJob', () => {
    it('sends GET to /render-jobs/:jobId', async () => {
      const client = makeClient();
      const mockJob = { renderJob: { id: 'job-1', status: 'completed', progress: 100 } };
      mockedFetch.mockResolvedValue(jsonResponse(mockJob));

      const result = await client.getRenderJob('job-1');

      expect(result.renderJob.id).toBe('job-1');
      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/render-jobs/job-1`,
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  describe('createRenderJob', () => {
    it('sends POST to /render-jobs with renderConfigId', async () => {
      const client = makeClient();
      const mockJob = { renderJob: { id: 'job-2', renderConfigId: 'rc1', status: 'queued' } };
      mockedFetch.mockResolvedValue(jsonResponse(mockJob));

      await client.createRenderJob('rc1');

      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/render-jobs`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ renderConfigId: 'rc1' }),
        }),
      );
    });
  });

  describe('getAudio', () => {
    it('sends GET to /render-jobs/:id/audio and returns Buffer', async () => {
      const client = makeClient();
      const audioBytes = new Uint8Array([0x49, 0x44, 0x33]); // fake mp3 header
      mockedFetch.mockResolvedValue(new Response(audioBytes.buffer, { status: 200 }));

      const result = await client.getAudio('job-1');

      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.length).toBe(3);
      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/render-jobs/job-1/audio`,
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  // =====================================================================
  // Credits
  // =====================================================================
  describe('getCreditTransactions', () => {
    it('sends GET to /credit-transactions with default take', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ transactions: [], nextCursor: undefined }));

      await client.getCreditTransactions();

      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/credit-transactions?take=20`,
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('uses custom take parameter', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ transactions: [] }));

      await client.getCreditTransactions(50);

      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/credit-transactions?take=50`,
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  // =====================================================================
  // Share
  // =====================================================================
  describe('shareIntent', () => {
    it('sends POST to /intents/:id/share', async () => {
      const client = makeClient();
      const mockResult = { shareToken: 'abc123', shareUrl: 'https://example.com/share/abc123' };
      mockedFetch.mockResolvedValue(jsonResponse(mockResult));

      const result = await client.shareIntent('i1');

      expect(result).toEqual(mockResult);
      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/intents/i1/share`,
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('unshareIntent', () => {
    it('sends DELETE to /intents/:id/share', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(voidResponse());

      await client.unshareIntent('i1');

      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/intents/i1/share`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  // =====================================================================
  // Delete
  // =====================================================================
  describe('deleteIntent', () => {
    it('sends DELETE to /intents/:id', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(voidResponse());

      await client.deleteIntent('i1');

      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/intents/i1`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('bulkDeleteIntents', () => {
    it('sends POST to /intents/bulk-delete with ids', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ deleted: 3, notFound: [] }));

      const result = await client.bulkDeleteIntents(['id1', 'id2', 'id3']);

      expect(result).toEqual({ deleted: 3, notFound: [] });
      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/intents/bulk-delete`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ ids: ['id1', 'id2', 'id3'] }),
        }),
      );
    });

    it('returns notFound ids when some do not exist', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ deleted: 1, notFound: ['id2'] }));

      const result = await client.bulkDeleteIntents(['id1', 'id2']);

      expect(result.notFound).toEqual(['id2']);
    });
  });

  // =====================================================================
  // Profile
  // =====================================================================
  describe('updateProfile', () => {
    it('sends PATCH to /auth/me with profile data', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ user: MOCK_USER }));

      await client.updateProfile({ displayName: 'New Name', tonePreference: 'mystical' });

      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/auth/me`,
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ displayName: 'New Name', tonePreference: 'mystical' }),
        }),
      );
    });
  });

  // =====================================================================
  // Account
  // =====================================================================
  describe('deleteAccount', () => {
    it('sends DELETE to /auth/account', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(voidResponse());

      await client.deleteAccount();

      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/auth/account`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  // =====================================================================
  // Context Settings
  // =====================================================================
  describe('getContextSettings', () => {
    it('sends GET to /context-settings', async () => {
      const client = makeClient();
      const mockSettings = { settings: [{ sessionContext: 'sleep', paceWpm: 100 }] };
      mockedFetch.mockResolvedValue(jsonResponse(mockSettings));

      const result = await client.getContextSettings();

      expect(result).toEqual(mockSettings);
      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/context-settings`,
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  describe('updateContextSettings', () => {
    it('sends PATCH to /context-settings/:context with data', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ settings: { sessionContext: 'sleep', paceWpm: 110 } }));

      await client.updateContextSettings('sleep', { paceWpm: 110 });

      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/context-settings/sleep`,
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ paceWpm: 110 }),
        }),
      );
    });

    it('encodes context parameter', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ settings: {} }));

      await client.updateContextSettings('my context', { paceWpm: 100 });

      const calledUrl = (mockedFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain('my%20context');
    });
  });

  describe('deleteContextSettings', () => {
    it('sends DELETE to /context-settings/:context', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(voidResponse());

      await client.deleteContextSettings('sleep');

      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/context-settings/sleep`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  // =====================================================================
  // Affirmation sync
  // =====================================================================
  describe('syncAffirmations', () => {
    it('sends PUT to /intents/:id/affirmations/sync with input', async () => {
      const client = makeClient();
      const syncInput = {
        affirmations: [
          { text: 'I am confident', enabled: true },
          { id: 'existing-1', text: 'I am strong', enabled: false },
        ],
      };
      const mockResult = {
        affirmationSet: { id: 'as1', intentId: 'i1', source: 'manual', createdAt: '2025-01-01', affirmations: [] },
        added: 1,
        removed: 0,
        updated: 1,
      };
      mockedFetch.mockResolvedValue(jsonResponse(mockResult));

      const result = await client.syncAffirmations('i1', syncInput);

      expect(result).toEqual(mockResult);
      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/intents/i1/affirmations/sync`,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(syncInput),
        }),
      );
    });
  });

  // =====================================================================
  // Manual intent creation
  // =====================================================================
  describe('createManualIntent', () => {
    it('sends POST to /intents/manual with full input', async () => {
      const client = makeClient();
      const input = {
        title: 'My Set',
        rawText: 'I want to be confident',
        tonePreference: 'grounded' as const,
        sessionContext: 'general',
        affirmations: [{ text: 'I am confident' }, { text: 'I am strong' }],
      };
      const mockResult = {
        intent: { id: 'i1', title: 'My Set', emoji: null, rawText: 'I want to be confident', sessionContext: 'general' },
        affirmationSet: { id: 'as1', affirmations: [] },
      };
      mockedFetch.mockResolvedValue(jsonResponse(mockResult));

      const result = await client.createManualIntent(input);

      expect(result).toEqual(mockResult);
      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/intents/manual`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(input),
        }),
      );
    });
  });

  // =====================================================================
  // Edge cases
  // =====================================================================
  describe('edge cases', () => {
    it('handles empty library response', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ items: [] }));

      const result = await client.getLibrary();

      expect(result.items).toEqual([]);
    });

    it('handles intent with null fields', async () => {
      const client = makeClient();
      const intentDetail = {
        intent: {
          id: 'i1',
          title: 'Test',
          emoji: null,
          rawText: '',
          tonePreference: null,
          sessionContext: 'general',
          shareToken: null,
          sharedAt: null,
          createdAt: '2025-01-01',
          updatedAt: '2025-01-01',
          affirmationSets: [],
          renderConfigs: [],
        },
      };
      mockedFetch.mockResolvedValue(jsonResponse(intentDetail));

      const result = await client.getIntent('i1');

      expect(result.intent?.emoji).toBeNull();
      expect(result.intent?.tonePreference).toBeNull();
    });

    it('handles bulk delete with empty ids array', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ deleted: 0, notFound: [] }));

      const result = await client.bulkDeleteIntents([]);

      expect(mockedFetch).toHaveBeenCalledWith(
        `${BASE_URL}/intents/bulk-delete`,
        expect.objectContaining({
          body: JSON.stringify({ ids: [] }),
        }),
      );
      expect(result.deleted).toBe(0);
    });

    it('handles getLibrary with all params set', async () => {
      const client = makeClient();
      mockedFetch.mockResolvedValue(jsonResponse({ items: [] }));

      await client.getLibrary({
        sort: 'most-played',
        filter: 'never-played',
        playedSince: '2025-01-01',
        notPlayedSince: '2025-12-31',
        context: 'meditation',
      });

      const calledUrl = (mockedFetch.mock.calls[0] as unknown[])[0] as string;
      const url = new URL(calledUrl);
      expect(url.searchParams.get('sort')).toBe('most-played');
      expect(url.searchParams.get('filter')).toBe('never-played');
      expect(url.searchParams.get('playedSince')).toBe('2025-01-01');
      expect(url.searchParams.get('notPlayedSince')).toBe('2025-12-31');
      expect(url.searchParams.get('context')).toBe('meditation');
    });

    it('constructor accepts and uses provided tokens', async () => {
      const client = new UserApiClient(
        'https://custom.api.com',
        'production',
        'custom-access',
        'custom-refresh',
      );
      mockedFetch.mockResolvedValue(jsonResponse({ user: MOCK_USER }));

      await client.getMe();

      const calledUrl = (mockedFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toBe('https://custom.api.com/auth/me');

      const callInit = (mockedFetch.mock.calls[0] as unknown[])[1] as RequestInit;
      expect((callInit.headers as Record<string, string>)['X-Access-Token']).toBe('custom-access');
    });
  });
});
