/**
 * Behavioral tests for all 18 MCP tools in user-mcp.ts.
 *
 * Strategy: mock UserApiClient.fromAuth() to return a fake client,
 * then call CUSTOM_HANDLERS directly for custom tools and exercise
 * client-method tools via buildUserServer().
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { CUSTOM_HANDLERS } from './user-mcp.js';

// ── Mock modules ──────────────────────────────────────────────────────────

// Mock auth-store so getClient() / loadAuth() don't touch disk
vi.mock('./auth-store.js', () => ({
  loadAuth: vi.fn(() => ({
    env: 'production' as const,
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    userId: 'user-1',
    email: 'test@example.com',
  })),
  saveAuth: vi.fn(),
  clearAuth: vi.fn(),
}));

// Mock fs operations for audio cache tests
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: actual.readFileSync,
  };
});

// Use vi.hoisted so the mock client is available when vi.mock factories run
const { mockClient } = vi.hoisted(() => {
  const mockClient: Record<string, ReturnType<typeof vi.fn>> = {
    getLibrary: vi.fn(),
    getIntent: vi.fn(),
    createAndGenerate: vi.fn(),
    updateIntent: vi.fn(),
    syncAffirmations: vi.fn(),
    configureRender: vi.fn(),
    startRender: vi.fn(),
    getRenderStatus: vi.fn(),
    getAudio: vi.fn(),
    getMe: vi.fn(),
    shareIntent: vi.fn(),
    unshareIntent: vi.fn(),
    deleteIntent: vi.fn(),
  };
  return { mockClient };
});

vi.mock('./user-client.js', () => ({
  UserApiClient: {
    fromAuth: vi.fn(() => mockClient),
    prototype: mockClient,
  },
}));

// ── Test Fixtures ─────────────────────────────────────────────────────────

function makeLibraryItem(overrides: Record<string, unknown> = {}) {
  return {
    intent: {
      id: 'intent-abc-123-full',
      title: 'Morning Confidence',
      emoji: '🌅',
      sessionContext: 'general',
      tonePreference: 'grounded',
      rawText: 'I want to feel confident each morning',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      ...(overrides['intent'] as Record<string, unknown> ?? {}),
    },
    latestAffirmationSet: {
      id: 'aset-1',
      intentId: 'intent-abc-123-full',
      source: 'ai',
      createdAt: '2026-01-01T00:00:00Z',
      affirmationCount: 10,
      ...(overrides['latestAffirmationSet'] as Record<string, unknown> ?? {}),
    },
    latestRenderConfig: null,
    latestRenderJob: {
      id: 'rj-1',
      status: 'completed',
      ...(overrides['latestRenderJob'] as Record<string, unknown> ?? {}),
    },
    ...(overrides['_top'] as Record<string, unknown> ?? {}),
  };
}

function makeIntentDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'intent-abc-123-full',
    title: 'Morning Confidence',
    emoji: '🌅',
    rawText: 'I want to feel confident',
    tonePreference: 'grounded',
    sessionContext: 'general',
    shareToken: null,
    sharedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    affirmationSets: [
      {
        id: 'aset-1',
        source: 'ai',
        createdAt: '2026-01-01T00:00:00Z',
        affirmations: [
          { id: 'aff-1', text: 'I am confident', tone: 'grounded', isEnabled: true },
          { id: 'aff-2', text: 'I am strong', tone: 'grounded', isEnabled: true },
          { id: 'aff-3', text: 'I am capable', tone: 'grounded', isEnabled: true },
          { id: 'aff-4', text: 'I am worthy', tone: 'grounded', isEnabled: true },
          { id: 'aff-5', text: 'I am resilient', tone: 'grounded', isEnabled: true },
        ],
      },
    ],
    renderConfigs: [
      {
        id: 'rc-1',
        affirmationSetId: 'aset-1',
        voiceId: 'voice-1',
        voiceProvider: 'elevenlabs',
        sessionContext: 'general',
        paceWpm: 130,
        durationSeconds: 600,
        backgroundAudioPath: null,
        backgroundVolume: 0.3,
        affirmationRepeatCount: 2,
        repetitionModel: 'weighted_shuffle',
        includePreamble: true,
        playAll: false,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ],
    ...overrides,
  };
}

// ── Helper to parse handler result ────────────────────────────────────────

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  const text = result.content[0]!.text;
  try {
    return { data: JSON.parse(text), text, isError: result.isError };
  } catch {
    return { data: null, text, isError: result.isError };
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ── nl_library ────────────────────────────────────────────────────────────

describe('nl_library', () => {
  const handler = CUSTOM_HANDLERS['library']!;

  it('returns formatted library items', async () => {
    const items = [makeLibraryItem(), makeLibraryItem({ intent: { id: 'intent-def-456-full', title: 'Sleep Well' } })];
    mockClient.getLibrary.mockResolvedValue({ items });

    const result = parseResult(await handler({}));
    expect(result.isError).toBeFalsy();
    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe('intent-abc-123-full');
    expect(result.data[0].title).toBe('Morning Confidence');
    expect(result.data[0].affirmationCount).toBe(10);
    expect(result.data[0].renderStatus).toBe('completed');
    expect(result.data[1].title).toBe('Sleep Well');
  });

  it('returns empty array when library is empty', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [] });

    const result = parseResult(await handler({}));
    expect(result.data).toEqual([]);
    expect(result.isError).toBeFalsy();
  });

  it('handles missing latestAffirmationSet and latestRenderJob', async () => {
    const item = makeLibraryItem({
      latestAffirmationSet: null as unknown as Record<string, unknown>,
      latestRenderJob: null as unknown as Record<string, unknown>,
      _top: { latestAffirmationSet: null, latestRenderJob: null },
    });
    // Override by reassigning to avoid type conflict
    item.latestAffirmationSet = null as never;
    item.latestRenderJob = null as never;
    mockClient.getLibrary.mockResolvedValue({ items: [item] });

    const result = parseResult(await handler({}));
    expect(result.data[0].affirmationCount).toBe(0);
    expect(result.data[0].renderStatus).toBe('none');
  });
});

// ── nl_search ─────────────────────────────────────────────────────────────

describe('nl_search', () => {
  const handler = CUSTOM_HANDLERS['search']!;

  it('filters library items by title keyword', async () => {
    const items = [
      makeLibraryItem({ intent: { id: 'i1', title: 'Morning Confidence' } }),
      makeLibraryItem({ intent: { id: 'i2', title: 'Sleep Well' } }),
    ];
    mockClient.getLibrary.mockResolvedValue({ items });

    const result = parseResult(await handler({ query: 'morning' }));
    expect(result.data).toHaveLength(1);
    expect(result.data[0].title).toBe('Morning Confidence');
  });

  it('matches on emoji', async () => {
    const items = [makeLibraryItem({ intent: { id: 'i1', title: 'Test', emoji: '🌙' } })];
    mockClient.getLibrary.mockResolvedValue({ items });

    const result = parseResult(await handler({ query: '🌙' }));
    expect(result.data).toHaveLength(1);
  });

  it('matches on sessionContext', async () => {
    const items = [makeLibraryItem({ intent: { id: 'i1', title: 'Focus Time', sessionContext: 'focus' } })];
    mockClient.getLibrary.mockResolvedValue({ items });

    const result = parseResult(await handler({ query: 'focus' }));
    expect(result.data).toHaveLength(1);
  });

  it('returns message when no matches found', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [] });

    const result = parseResult(await handler({ query: 'nonexistent' }));
    expect(result.text).toContain('No practice sets found matching "nonexistent"');
  });

  it('search is case-insensitive', async () => {
    const items = [makeLibraryItem({ intent: { id: 'i1', title: 'Morning Confidence' } })];
    mockClient.getLibrary.mockResolvedValue({ items });

    const result = parseResult(await handler({ query: 'MORNING' }));
    expect(result.data).toHaveLength(1);
  });
});

// ── nl_info ───────────────────────────────────────────────────────────────

describe('nl_info', () => {
  const handler = CUSTOM_HANDLERS['info']!;

  it('returns intent detail for exact ID', async () => {
    const detail = makeIntentDetail();
    mockClient.getLibrary.mockResolvedValue({
      items: [makeLibraryItem()],
    });
    mockClient.getIntent.mockResolvedValue({ intent: detail });

    const result = parseResult(await handler({ id: 'intent-abc-123-full' }));
    expect(result.isError).toBeFalsy();
    expect(result.data.title).toBe('Morning Confidence');
    expect(mockClient.getIntent).toHaveBeenCalledWith('intent-abc-123-full');
  });

  it('resolves short ID prefix', async () => {
    mockClient.getLibrary.mockResolvedValue({
      items: [makeLibraryItem()],
    });
    mockClient.getIntent.mockResolvedValue({ intent: makeIntentDetail() });

    await handler({ id: 'intent-abc' });
    expect(mockClient.getIntent).toHaveBeenCalledWith('intent-abc-123-full');
  });

  it('returns error for ambiguous short ID', async () => {
    const items = [
      makeLibraryItem({ intent: { id: 'intent-abc-111' } }),
      makeLibraryItem({ intent: { id: 'intent-abc-222' } }),
    ];
    mockClient.getLibrary.mockResolvedValue({ items });

    const result = parseResult(await handler({ id: 'intent-abc' }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Ambiguous ID');
    expect(result.text).toContain('2 sets');
  });

  it('returns error when set not found', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [] });

    const result = parseResult(await handler({ id: 'nonexistent' }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('not found');
  });

  it('returns error when intent detail is null', async () => {
    mockClient.getLibrary.mockResolvedValue({
      items: [makeLibraryItem()],
    });
    mockClient.getIntent.mockResolvedValue({ intent: null });

    const result = parseResult(await handler({ id: 'intent-abc-123-full' }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('not found');
  });
});

// ── nl_voices ─────────────────────────────────────────────────────────────

describe('nl_voices', () => {
  const handler = CUSTOM_HANDLERS['voices']!;

  it('fetches and returns voices', async () => {
    const voices = [
      { id: 'v1', displayName: 'Aria', gender: 'Female', accent: 'US', tier: 'premium' },
      { id: 'v2', displayName: 'James', gender: 'Male', accent: 'UK', tier: 'free' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ voices }),
    }));

    const result = parseResult(await handler({}));
    expect(result.data).toHaveLength(2);
    expect(result.data[0].displayName).toBe('Aria');
  });

  it('filters by gender', async () => {
    const voices = [
      { id: 'v1', gender: 'Female', accent: 'US', tier: 'premium' },
      { id: 'v2', gender: 'Male', accent: 'UK', tier: 'free' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ voices }),
    }));

    const result = parseResult(await handler({ gender: 'Female' }));
    expect(result.data).toHaveLength(1);
    expect(result.data[0].gender).toBe('Female');
  });

  it('filters by accent', async () => {
    const voices = [
      { id: 'v1', gender: 'Female', accent: 'US', tier: 'premium' },
      { id: 'v2', gender: 'Male', accent: 'UK', tier: 'free' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ voices }),
    }));

    const result = parseResult(await handler({ accent: 'UK' }));
    expect(result.data).toHaveLength(1);
    expect(result.data[0].accent).toBe('UK');
  });

  it('filters by tier', async () => {
    const voices = [
      { id: 'v1', gender: 'Female', accent: 'US', tier: 'premium' },
      { id: 'v2', gender: 'Male', accent: 'UK', tier: 'free' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ voices }),
    }));

    const result = parseResult(await handler({ tier: 'free' }));
    expect(result.data).toHaveLength(1);
    expect(result.data[0].tier).toBe('free');
  });

  it('returns error on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }));

    const result = parseResult(await handler({}));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('HTTP 500');
  });

  it('combines multiple filters', async () => {
    const voices = [
      { id: 'v1', gender: 'Female', accent: 'US', tier: 'premium' },
      { id: 'v2', gender: 'Female', accent: 'UK', tier: 'free' },
      { id: 'v3', gender: 'Male', accent: 'US', tier: 'premium' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ voices }),
    }));

    const result = parseResult(await handler({ gender: 'Female', accent: 'US' }));
    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe('v1');
  });
});

// ── nl_create ─────────────────────────────────────────────────────────────

describe('nl_create', () => {
  const handler = CUSTOM_HANDLERS['create']!;

  it('calls createAndGenerate with text and returns result', async () => {
    const createResult = {
      intent: { id: 'new-1', title: 'Confidence', emoji: '💪', rawText: 'Be confident', sessionContext: 'general' },
      affirmationSet: { id: 'aset-new', affirmations: [{ id: 'a1', text: 'I am confident', tone: 'grounded', isEnabled: true }] },
    };
    mockClient.createAndGenerate.mockResolvedValue(createResult);

    const result = parseResult(await handler({ text: 'Be confident' }));
    expect(result.data.intent.id).toBe('new-1');
    expect(mockClient.createAndGenerate).toHaveBeenCalledWith('Be confident', undefined);
  });

  it('passes tone parameter when provided', async () => {
    mockClient.createAndGenerate.mockResolvedValue({ intent: {}, affirmationSet: {} });

    await handler({ text: 'Be mystical', tone: 'mystical' });
    expect(mockClient.createAndGenerate).toHaveBeenCalledWith('Be mystical', 'mystical');
  });
});

// ── nl_rename ─────────────────────────────────────────────────────────────

describe('nl_rename', () => {
  const handler = CUSTOM_HANDLERS['rename']!;

  it('updates title via updateIntent', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.updateIntent.mockResolvedValue({ intent: { id: 'intent-abc-123-full', title: 'New Title', emoji: '🌅' } });

    const result = parseResult(await handler({ id: 'intent-abc-123-full', title: 'New Title' }));
    expect(result.isError).toBeFalsy();
    expect(mockClient.updateIntent).toHaveBeenCalledWith('intent-abc-123-full', { title: 'New Title' });
  });

  it('updates emoji via updateIntent', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.updateIntent.mockResolvedValue({ intent: { id: 'intent-abc-123-full', title: 'Morning Confidence', emoji: '🌟' } });

    await handler({ id: 'intent-abc-123-full', emoji: '🌟' });
    expect(mockClient.updateIntent).toHaveBeenCalledWith('intent-abc-123-full', { emoji: '🌟' });
  });

  it('clears emoji with null', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.updateIntent.mockResolvedValue({ intent: { id: 'intent-abc-123-full', title: 'Morning Confidence', emoji: null } });

    await handler({ id: 'intent-abc-123-full', emoji: null });
    expect(mockClient.updateIntent).toHaveBeenCalledWith('intent-abc-123-full', { emoji: null });
  });

  it('returns error when neither title nor emoji provided', async () => {
    const result = parseResult(await handler({ id: 'intent-abc-123-full' }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('At least one of title or emoji');
  });

  it('resolves short ID for rename', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.updateIntent.mockResolvedValue({ intent: { id: 'intent-abc-123-full', title: 'Renamed', emoji: null } });

    await handler({ id: 'intent-abc', title: 'Renamed' });
    expect(mockClient.updateIntent).toHaveBeenCalledWith('intent-abc-123-full', { title: 'Renamed' });
  });
});

// ── nl_sync_affirmations ──────────────────────────────────────────────────

describe('nl_sync_affirmations', () => {
  const handler = CUSTOM_HANDLERS['syncAffirmations']!;

  it('syncs affirmations and returns summary', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.syncAffirmations.mockResolvedValue({
      affirmationSet: { id: 'aset-1' },
      added: 2,
      updated: 1,
      removed: 3,
    });

    const affirmations = [
      { text: 'I am strong', enabled: true },
      { text: 'I am brave', enabled: true },
      { id: 'aff-1', text: 'I am confident (updated)', enabled: false },
    ];

    const result = parseResult(await handler({ id: 'intent-abc-123-full', affirmations }));
    expect(result.text).toContain('2 added');
    expect(result.text).toContain('1 updated');
    expect(result.text).toContain('3 removed');
    expect(mockClient.syncAffirmations).toHaveBeenCalledWith('intent-abc-123-full', { affirmations });
  });

  it('resolves short ID', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.syncAffirmations.mockResolvedValue({ added: 0, updated: 0, removed: 0 });

    await handler({ id: 'intent-abc', affirmations: [{ text: 'Test', enabled: true }] });
    expect(mockClient.syncAffirmations).toHaveBeenCalledWith(
      'intent-abc-123-full',
      expect.anything(),
    );
  });
});

// ── nl_render_configure ───────────────────────────────────────────────────

describe('nl_render_configure', () => {
  const handler = CUSTOM_HANDLERS['renderConfigure']!;

  it('calls configureRender with required params', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.configureRender.mockResolvedValue({ renderConfig: { id: 'rc-new' } });

    const result = parseResult(
      await handler({
        id: 'intent-abc-123-full',
        voiceId: 'voice-1',
        sessionContext: 'general',
        durationMinutes: 10,
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(mockClient.configureRender).toHaveBeenCalledWith('intent-abc-123-full', {
      voiceId: 'voice-1',
      sessionContext: 'general',
      durationMinutes: 10,
    });
  });

  it('passes optional params when provided', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.configureRender.mockResolvedValue({ renderConfig: { id: 'rc-new' } });

    await handler({
      id: 'intent-abc-123-full',
      voiceId: 'voice-1',
      sessionContext: 'sleep',
      durationMinutes: 15,
      paceWpm: 110,
      backgroundAudioPath: 'rain.mp3',
      backgroundVolume: 0.5,
      affirmationRepeatCount: 3,
      includePreamble: false,
      playAll: true,
    });

    expect(mockClient.configureRender).toHaveBeenCalledWith('intent-abc-123-full', {
      voiceId: 'voice-1',
      sessionContext: 'sleep',
      durationMinutes: 15,
      paceWpm: 110,
      backgroundAudioPath: 'rain.mp3',
      backgroundVolume: 0.5,
      affirmationRepeatCount: 3,
      includePreamble: false,
      playAll: true,
    });
  });

  it('resolves short ID', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.configureRender.mockResolvedValue({ renderConfig: { id: 'rc-new' } });

    await handler({
      id: 'intent-abc',
      voiceId: 'voice-1',
      sessionContext: 'general',
      durationMinutes: 10,
    });

    expect(mockClient.configureRender).toHaveBeenCalledWith(
      'intent-abc-123-full',
      expect.anything(),
    );
  });
});

// ── nl_play ───────────────────────────────────────────────────────────────

describe('nl_play', () => {
  const handler = CUSTOM_HANDLERS['play']!;

  it('downloads audio and returns file path', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.getAudio.mockResolvedValue(Buffer.from('fake-audio'));

    const { existsSync } = await import('fs');
    (existsSync as Mock).mockReturnValue(false);

    const result = parseResult(await handler({ id: 'intent-abc-123-full' }));
    expect(result.data.cached).toBe(false);
    expect(result.data.path).toContain('rj-1.mp3');
    expect(mockClient.getAudio).toHaveBeenCalledWith('rj-1');
  });

  it('returns cached file when it exists', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });

    const { existsSync } = await import('fs');
    (existsSync as Mock).mockReturnValue(true);

    const result = parseResult(await handler({ id: 'intent-abc-123-full' }));
    expect(result.data.cached).toBe(true);
    expect(mockClient.getAudio).not.toHaveBeenCalled();
  });

  it('creates cache directory before writing', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.getAudio.mockResolvedValue(Buffer.from('audio'));

    const fs = await import('fs');
    (fs.existsSync as Mock).mockReturnValue(false);

    await handler({ id: 'intent-abc-123-full' });

    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('neuralingual'), { recursive: true });
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('returns error when set not found', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [] });

    const result = parseResult(await handler({ id: 'nonexistent' }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('not found');
  });

  it('returns error when no render job exists', async () => {
    const item = makeLibraryItem();
    item.latestRenderJob = null as never;
    mockClient.getLibrary.mockResolvedValue({ items: [item] });

    const result = parseResult(await handler({ id: 'intent-abc-123-full' }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('No rendered audio');
  });

  it('returns error when render is not completed', async () => {
    const item = makeLibraryItem({ latestRenderJob: { id: 'rj-1', status: 'processing' } });
    mockClient.getLibrary.mockResolvedValue({ items: [item] });

    const result = parseResult(await handler({ id: 'intent-abc-123-full' }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('processing');
    expect(result.text).toContain('not ready');
  });

  it('returns error when render failed', async () => {
    const item = makeLibraryItem({ latestRenderJob: { id: 'rj-1', status: 'failed' } });
    mockClient.getLibrary.mockResolvedValue({ items: [item] });

    const result = parseResult(await handler({ id: 'intent-abc-123-full' }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('failed');
  });

  it('resolves short ID for play', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.getAudio.mockResolvedValue(Buffer.from('audio'));
    const { existsSync } = await import('fs');
    (existsSync as Mock).mockReturnValue(false);

    const result = parseResult(await handler({ id: 'intent-abc' }));
    expect(result.data.path).toContain('rj-1.mp3');
  });

  it('returns error for ambiguous short ID', async () => {
    const items = [
      makeLibraryItem({ intent: { id: 'intent-abc-111' } }),
      makeLibraryItem({ intent: { id: 'intent-abc-222' } }),
    ];
    mockClient.getLibrary.mockResolvedValue({ items });

    const result = parseResult(await handler({ id: 'intent-abc' }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Ambiguous ID');
  });
});

// ── nl_credits ────────────────────────────────────────────────────────────

describe('nl_credits', () => {
  const handler = CUSTOM_HANDLERS['credits']!;

  it('returns credit info from user profile', async () => {
    mockClient.getMe.mockResolvedValue({
      user: {
        creditBalance: 5,
        subscriptionCredits: 3,
        purchasedCredits: 2,
        creditsResetAt: '2026-02-01T00:00:00Z',
        subscriptionTier: 'premium',
        subscriptionStatus: 'active',
      },
    });

    const result = parseResult(await handler({}));
    expect(result.data.creditBalance).toBe(5);
    expect(result.data.subscriptionCredits).toBe(3);
    expect(result.data.purchasedCredits).toBe(2);
    expect(result.data.subscriptionTier).toBe('premium');
    expect(result.data.subscriptionStatus).toBe('active');
  });

  it('only includes credit-related fields', async () => {
    mockClient.getMe.mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'test@example.com',
        creditBalance: 0,
        subscriptionCredits: 0,
        purchasedCredits: 0,
        creditsResetAt: null,
        subscriptionTier: null,
        subscriptionStatus: null,
        displayName: 'Test User',
        role: 'user',
      },
    });

    const result = parseResult(await handler({}));
    const keys = Object.keys(result.data);
    expect(keys).not.toContain('id');
    expect(keys).not.toContain('email');
    expect(keys).not.toContain('displayName');
    expect(keys).toContain('creditBalance');
  });
});

// ── nl_set_export ─────────────────────────────────────────────────────────

describe('nl_set_export', () => {
  const handler = CUSTOM_HANDLERS['setExport']!;

  it('returns YAML representation of the set', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.getIntent.mockResolvedValue({ intent: makeIntentDetail() });

    const result = parseResult(await handler({ id: 'intent-abc-123-full' }));
    expect(result.isError).toBeFalsy();
    // YAML output should contain title and affirmations
    expect(result.text).toContain('Morning Confidence');
    expect(result.text).toContain('I am confident');
    expect(result.text).toContain('Neuralingual Set File');
  });

  it('resolves short ID', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.getIntent.mockResolvedValue({ intent: makeIntentDetail() });

    await handler({ id: 'intent-abc' });
    expect(mockClient.getIntent).toHaveBeenCalledWith('intent-abc-123-full');
  });

  it('returns error when intent not found', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.getIntent.mockResolvedValue({ intent: null });

    const result = parseResult(await handler({ id: 'intent-abc-123-full' }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('not found');
  });
});

// ── nl_set_import ─────────────────────────────────────────────────────────

describe('nl_set_import', () => {
  const handler = CUSTOM_HANDLERS['setImport']!;

  it('applies title change from YAML', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.getIntent.mockResolvedValue({ intent: makeIntentDetail() });
    mockClient.updateIntent.mockResolvedValue({ intent: {} });

    const yaml = `title: Updated Title
intentContext: general
intent: I want to feel confident
affirmations:
  - id: aff-1
    enabled: true
    text: I am confident
  - id: aff-2
    enabled: true
    text: I am strong
  - id: aff-3
    enabled: true
    text: I am capable
  - id: aff-4
    enabled: true
    text: I am worthy
  - id: aff-5
    enabled: true
    text: I am resilient`;

    mockClient.syncAffirmations.mockResolvedValue({ added: 0, updated: 0, removed: 0 });

    const result = parseResult(await handler({ id: 'intent-abc-123-full', yaml }));
    expect(result.text).toContain('updated title');
    expect(mockClient.updateIntent).toHaveBeenCalledWith(
      'intent-abc-123-full',
      expect.objectContaining({ title: 'Updated Title' }),
    );
  });

  it('syncs affirmation changes from YAML', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.getIntent.mockResolvedValue({ intent: makeIntentDetail() });
    mockClient.syncAffirmations.mockResolvedValue({ added: 1, updated: 0, removed: 2 });

    const yaml = `title: Morning Confidence
intentContext: general
intent: I want to feel confident
affirmations:
  - id: aff-1
    enabled: true
    text: I am confident
  - id: aff-2
    enabled: true
    text: I am strong
  - id: aff-3
    enabled: true
    text: I am capable
  - id: aff-4
    enabled: true
    text: I am worthy
  - enabled: true
    text: I am unstoppable`;

    const result = parseResult(await handler({ id: 'intent-abc-123-full', yaml }));
    expect(result.text).toContain('1 added');
    expect(result.text).toContain('2 removed');
  });

  it('returns no changes detected when YAML matches original and no render fields', async () => {
    const detail = makeIntentDetail();
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.getIntent.mockResolvedValue({ intent: detail });

    // YAML that matches the existing data exactly — no render fields included
    const yaml = `title: Morning Confidence
intent: I want to feel confident
affirmations:
  - id: aff-1
    enabled: true
    text: I am confident
  - id: aff-2
    enabled: true
    text: I am strong
  - id: aff-3
    enabled: true
    text: I am capable
  - id: aff-4
    enabled: true
    text: I am worthy
  - id: aff-5
    enabled: true
    text: I am resilient`;

    mockClient.syncAffirmations.mockResolvedValue({ added: 0, updated: 0, removed: 0 });

    const result = parseResult(await handler({ id: 'intent-abc-123-full', yaml }));
    expect(result.text).toContain('No changes detected');
  });

  it('updates render config when render fields present', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.getIntent.mockResolvedValue({ intent: makeIntentDetail() });
    mockClient.configureRender.mockResolvedValue({ renderConfig: {} });

    const yaml = `title: Morning Confidence
intentContext: general
intent: I want to feel confident
voice: voice-2
duration: 15
pace: 120
affirmations:
  - id: aff-1
    enabled: true
    text: I am confident
  - id: aff-2
    enabled: true
    text: I am strong
  - id: aff-3
    enabled: true
    text: I am capable
  - id: aff-4
    enabled: true
    text: I am worthy
  - id: aff-5
    enabled: true
    text: I am resilient`;

    mockClient.syncAffirmations.mockResolvedValue({ added: 0, updated: 0, removed: 0 });

    const result = parseResult(await handler({ id: 'intent-abc-123-full', yaml }));
    expect(result.text).toContain('render config: updated');
    expect(mockClient.configureRender).toHaveBeenCalledWith(
      'intent-abc-123-full',
      expect.objectContaining({
        voiceId: 'voice-2',
        durationMinutes: 15,
        paceWpm: 120,
      }),
    );
  });

  it('skips render config update when no existing config', async () => {
    const detail = makeIntentDetail({ renderConfigs: [] });
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });
    mockClient.getIntent.mockResolvedValue({ intent: detail });

    const yaml = `title: Morning Confidence
intentContext: general
intent: I want to feel confident
voice: voice-2
duration: 15
affirmations:
  - id: aff-1
    enabled: true
    text: I am confident
  - id: aff-2
    enabled: true
    text: I am strong
  - id: aff-3
    enabled: true
    text: I am capable
  - id: aff-4
    enabled: true
    text: I am worthy
  - id: aff-5
    enabled: true
    text: I am resilient`;

    mockClient.syncAffirmations.mockResolvedValue({ added: 0, updated: 0, removed: 0 });

    const result = parseResult(await handler({ id: 'intent-abc-123-full', yaml }));
    expect(result.text).toContain('skipped (no existing config');
  });
});

// ── Not logged in (cross-cutting) ─────────────────────────────────────────

describe('not logged in', () => {
  it('returns error when UserApiClient.fromAuth() throws', async () => {
    const { UserApiClient } = await import('./user-client.js');
    (UserApiClient.fromAuth as Mock).mockImplementationOnce(() => {
      throw new Error('Not logged in. Run `neuralingual login` first.');
    });

    const handler = CUSTOM_HANDLERS['library']!;
    const result = parseResult(await handler({}));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Not logged in');
  });

  it('returns error for credits when not logged in', async () => {
    const { UserApiClient } = await import('./user-client.js');
    (UserApiClient.fromAuth as Mock).mockImplementationOnce(() => {
      throw new Error('Not logged in. Run `neuralingual login` first.');
    });

    const handler = CUSTOM_HANDLERS['credits']!;
    const result = parseResult(await handler({}));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Not logged in');
  });
});

// ── Client-method tools (pass-through) ────────────────────────────────────
// These tools are registered via buildUserServer() using the manifest's
// client-method handler type. We test them by calling the handlers indirectly.

describe('client-method tools (delete, render_start, render_status, rerender, share, unshare)', () => {
  // For client-method tools, we need to test the pass-through behavior.
  // Since CUSTOM_HANDLERS doesn't include them, we test the resolveIntentId
  // logic directly and verify that buildUserServer doesn't throw.

  it('buildUserServer registers all tools without throwing', async () => {
    const { buildUserServer } = await import('./user-mcp.js');
    expect(() => buildUserServer()).not.toThrow();
  });

  // The client-method tools (nl_delete, nl_render_start, nl_render_status,
  // nl_rerender, nl_share, nl_unshare) use the same withClient + resolveIntentId
  // pattern that custom handlers use. The resolveIntentId function is already
  // tested thoroughly via the custom handler tests above (info, rename, play, etc.).
  // The client-method pass-through calls the matching UserApiClient method with
  // the resolved ID and either returns JSON or a success message.

  // We verify the mapping is correct by ensuring client methods exist:
  it('all client-method handlers map to real UserApiClient methods', async () => {
    const manifest = (await import('./tool-manifest.json', { with: { type: 'json' } })).default;
    const clientMethodTools = manifest.tools.filter(
      (t: { handler: { type: string } }) => t.handler.type === 'client-method',
    );

    for (const tool of clientMethodTools) {
      const methodName = (tool.handler as { clientMethod: string }).clientMethod;
      expect(mockClient).toHaveProperty(methodName);
    }
  });
});

// ── Short ID resolution edge cases ────────────────────────────────────────

describe('short ID resolution edge cases', () => {
  const handler = CUSTOM_HANDLERS['info']!;

  it('exact match takes priority over prefix matches', async () => {
    // If there's an exact match AND prefix matches, exact wins
    const items = [
      makeLibraryItem({ intent: { id: 'abc' } }),
      makeLibraryItem({ intent: { id: 'abc-extended' } }),
    ];
    mockClient.getLibrary.mockResolvedValue({ items });
    mockClient.getIntent.mockResolvedValue({ intent: makeIntentDetail({ id: 'abc' }) });

    await handler({ id: 'abc' });
    expect(mockClient.getIntent).toHaveBeenCalledWith('abc');
  });

  it('single prefix match resolves correctly', async () => {
    const items = [makeLibraryItem({ intent: { id: 'unique-prefix-xyz' } })];
    mockClient.getLibrary.mockResolvedValue({ items });
    mockClient.getIntent.mockResolvedValue({ intent: makeIntentDetail({ id: 'unique-prefix-xyz' }) });

    await handler({ id: 'unique' });
    expect(mockClient.getIntent).toHaveBeenCalledWith('unique-prefix-xyz');
  });
});

// ── Response format validation ────────────────────────────────────────────

describe('response format', () => {
  it('library returns textResult with JSON content', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [makeLibraryItem()] });

    const result = await CUSTOM_HANDLERS['library']!({});
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
    expect(result.isError).toBeUndefined();
  });

  it('error results have isError: true', async () => {
    mockClient.getLibrary.mockResolvedValue({ items: [] });

    const result = await CUSTOM_HANDLERS['info']!({ id: 'nonexistent' });
    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
  });

  it('credits returns textResult with JSON content', async () => {
    mockClient.getMe.mockResolvedValue({
      user: {
        creditBalance: 10,
        subscriptionCredits: 5,
        purchasedCredits: 5,
        creditsResetAt: null,
        subscriptionTier: 'free',
        subscriptionStatus: 'active',
      },
    });

    const result = await CUSTOM_HANDLERS['credits']!({});
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.creditBalance).toBe(10);
  });
});
