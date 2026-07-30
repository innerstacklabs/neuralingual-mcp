/**
 * Integration tests for user-mcp custom handlers with a mocked UserApiClient.
 *
 * Focuses on the framework-surfacing additions in #749:
 *   - `guide` handler — framework-present and legacy cases
 *   - `info` handler — new hasFramework / frameworkSchemaVersion / frameworkTakeaway fields
 *   - `setExport` handler — default (no framework) and withFramework:true
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CUSTOM_HANDLERS } from './user-mcp.js';
import { UserApiClient } from './user-client.js';
import { NO_FRAMEWORK_MESSAGE } from './framework-render.js';

const INTENT_ID = 'intent-abc-123';

const frameworkFixture = {
  schemaVersion: 1,
  methodology:
    'Draws on contemporary CBT research, somatic practice, and philosophical grounding in agency.',
  principles: [
    { name: 'Self-compassion', description: 'Meet difficulty with warmth.' },
    { name: 'Agency', description: 'Choose the next small step.' },
    { name: 'Grounding', description: 'Anchor to breath.' },
  ],
  sources: [
    { name: 'Kristin Neff', work: 'Self-Compassion', contribution: 'Framework for self-kindness.' },
  ],
  groupings: [
    { name: 'Opening', purpose: 'Soften.' },
    { name: 'Anchoring', purpose: 'Stabilize.' },
  ],
  practical_application: 'Daily 10-minute session, morning and evening.',
  takeaway: 'Consistent small practice compounds.',
};

function buildLibraryStub(): { items: Array<{ intent: { id: string } }> } {
  return {
    items: [
      {
        intent: {
          id: INTENT_ID,
          title: 'Confidence',
          emoji: null,
          sessionContext: 'general',
          tonePreference: null,
          createdAt: '2026-04-01T00:00:00Z',
          updatedAt: '2026-04-01T00:00:00Z',
        },
      } as unknown as { intent: { id: string } },
    ],
  };
}

function buildIntentStub(framework: unknown) {
  return {
    intent: {
      id: INTENT_ID,
      title: 'Confidence',
      emoji: null,
      rawText: 'I am confident.',
      tonePreference: null,
      sessionContext: 'general',
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T00:00:00Z',
      affirmationSets: [
        {
          id: 'set-1',
          source: 'framework-first',
          createdAt: '2026-04-01T00:00:00Z',
          affirmations: [
            { id: 'aff-1', text: 'I am confident.', tone: 'steady', isEnabled: true },
          ],
          framework,
          schemaVersion: framework ? 1 : null,
          generationStatus: 'complete',
        },
      ],
      renderConfigs: [],
    },
  };
}

/** Replace UserApiClient.fromAuth with a stubbed instance whose methods we control. */
function installClientMock(overrides: {
  getLibrary?: () => Promise<unknown>;
  getIntent?: () => Promise<unknown>;
}) {
  const stub = {
    getLibrary: overrides.getLibrary ?? (() => Promise.resolve(buildLibraryStub())),
    getIntent: overrides.getIntent ?? (() => Promise.resolve(buildIntentStub(frameworkFixture))),
  };
  vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue(stub as unknown as UserApiClient);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('guide handler', () => {
  it('renders framework markdown when the latest set has one', async () => {
    installClientMock({});
    const guide = CUSTOM_HANDLERS['guide'];
    if (!guide) throw new Error('guide handler missing');
    const result = await guide({ id: INTENT_ID });
    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('# Framework');
    expect(text).toContain('## Methodology');
    expect(text).toContain('- **Self-compassion** — Meet difficulty with warmth.');
    expect(text).toContain('> Consistent small practice compounds.');
  });

  it('returns the fallback message (NOT an error) for legacy sets with framework=null', async () => {
    installClientMock({
      getIntent: () => Promise.resolve(buildIntentStub(null)),
    });
    const guide = CUSTOM_HANDLERS['guide'];
    if (!guide) throw new Error('guide handler missing');
    const result = await guide({ id: INTENT_ID });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe(NO_FRAMEWORK_MESSAGE);
  });

  it('errors cleanly when the playlist is not found', async () => {
    installClientMock({
      getLibrary: () => Promise.resolve({ items: [] }),
    });
    const guide = CUSTOM_HANDLERS['guide'];
    if (!guide) throw new Error('guide handler missing');
    const result = await guide({ id: 'does-not-exist' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Playlist not found');
  });
});

describe('libraryView handler — framework + rawText surfacing (#749, carried over from deleted nl_info per #42)', () => {
  // nl_info was retired outright (Dave, 2026-07-30 — no aliases, no users
  // yet). Its unique capabilities (rawText, hasFramework,
  // frameworkSchemaVersion, frameworkTakeaway — added for #749) had no
  // equivalent in libraryView, so they were folded into the shared
  // `libraryView` handler (used by nl_playlist_view) rather than lost.
  it('adds hasFramework, frameworkSchemaVersion, frameworkTakeaway, and rawText for framework-present sets', async () => {
    installClientMock({});
    const libraryView = CUSTOM_HANDLERS['libraryView'];
    if (!libraryView) throw new Error('libraryView handler missing');
    const result = await libraryView({ id: INTENT_ID });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(payload['hasFramework']).toBe(true);
    expect(payload['frameworkSchemaVersion']).toBe(1);
    expect(payload['frameworkTakeaway']).toBe('Consistent small practice compounds.');

    // Additive: existing fields untouched
    expect(payload['id']).toBe(INTENT_ID);
    expect(payload['title']).toBe('Confidence');
    expect(payload['rawText']).toBe('I am confident.');
    expect(Array.isArray(payload['affirmations'])).toBe(true);
  });

  it('does NOT leak framework/raw LLM payloads into the affirmations array (per #749 acceptance)', async () => {
    installClientMock({});
    const libraryView = CUSTOM_HANDLERS['libraryView'];
    if (!libraryView) throw new Error('libraryView handler missing');
    const result = await libraryView({ id: INTENT_ID });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    const affirmations = payload['affirmations'] as Array<Record<string, unknown>>;
    expect(affirmations).toHaveLength(1);
    // The affirmations array is built via an explicit field allowlist
    // (id/text/tone/isEnabled/feedback), so framework/raw LLM payloads can
    // never leak through — guard against a future regression to spreading.
    expect(affirmations[0]).not.toHaveProperty('framework');
    expect(affirmations[0]).not.toHaveProperty('rawFrameworkLlm');
    expect(affirmations[0]).not.toHaveProperty('rawAffirmationsLlm');
  });

  it('sets framework fields to falsy/null for legacy sets', async () => {
    installClientMock({
      getIntent: () => Promise.resolve(buildIntentStub(null)),
    });
    const libraryView = CUSTOM_HANDLERS['libraryView'];
    if (!libraryView) throw new Error('libraryView handler missing');
    const result = await libraryView({ id: INTENT_ID });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(payload['hasFramework']).toBe(false);
    expect(payload['frameworkSchemaVersion']).toBeNull();
    expect(payload['frameworkTakeaway']).toBeNull();
    expect(payload['id']).toBe(INTENT_ID);
  });
});

describe('setExport handler — withFramework option', () => {
  it('default (no withFramework) emits YAML only, backward-compat', async () => {
    installClientMock({});
    const setExport = CUSTOM_HANDLERS['setExport'];
    if (!setExport) throw new Error('setExport handler missing');
    const result = await setExport({ id: INTENT_ID });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('# Framework');
    expect(text).toContain('# Neuralingual Set File');
    expect(text).toContain('title:');
  });

  it('withFramework=false explicit is identical to default', async () => {
    installClientMock({});
    const setExport = CUSTOM_HANDLERS['setExport'];
    if (!setExport) throw new Error('setExport handler missing');
    const result = await setExport({ id: INTENT_ID, withFramework: false });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('# Framework');
  });

  it('withFramework=true prepends framework markdown before the YAML', async () => {
    installClientMock({});
    const setExport = CUSTOM_HANDLERS['setExport'];
    if (!setExport) throw new Error('setExport handler missing');
    const result = await setExport({ id: INTENT_ID, withFramework: true });
    const text = result.content[0]?.text ?? '';

    // Framework markdown appears first
    expect(text.indexOf('# Framework')).toBe(0);
    // Takeaway comes before the YAML body
    expect(text.indexOf('> Consistent small practice compounds.')).toBeLessThan(
      text.indexOf('# Neuralingual Set File'),
    );
    // YAML body still present
    expect(text).toContain('title:');
    // Safety: no standalone `---` between sections (YAML doc-start marker)
    expect(text.split('\n').filter((line) => line.trim() === '---')).toEqual([]);
  });

  it('withFramework=true on a legacy set renders the fallback notice then YAML', async () => {
    installClientMock({
      getIntent: () => Promise.resolve(buildIntentStub(null)),
    });
    const setExport = CUSTOM_HANDLERS['setExport'];
    if (!setExport) throw new Error('setExport handler missing');
    const result = await setExport({ id: INTENT_ID, withFramework: true });
    const text = result.content[0]?.text ?? '';
    expect(text.startsWith(NO_FRAMEWORK_MESSAGE)).toBe(true);
    expect(text).toContain('# Neuralingual Set File');
  });
});

// ── User profile + Username tools (#2138) ───────────────────────────

describe('userProfile handler', () => {
  it('returns full user profile including username', async () => {
    const mockGetMe = vi.fn().mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'dave@example.com',
        displayName: 'Dave R.',
        username: 'daveremy',
        tonePreference: 'grounded',
        subscriptionTier: 'pro',
        subscriptionStatus: 'active',
        creditBalance: 50,
        role: 'user',
        createdAt: '2026-01-01T00:00:00Z',
      },
    });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getMe: mockGetMe,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['userProfile'];
    if (!handler) throw new Error('userProfile handler missing');
    const result = await handler({});
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(payload['username']).toBe('daveremy');
    expect(payload['email']).toBe('dave@example.com');
    expect(payload['creditBalance']).toBe(50);
    expect(payload['subscriptionTier']).toBe('pro');
  });
});

describe('userSetUsername handler', () => {
  it('sets username and returns the result', async () => {
    installClientMock({});
    const mockSetUsername = vi.fn().mockResolvedValue({
      user: { username: 'newuser', displayName: 'Dave R.' },
    });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      setUsername: mockSetUsername,
      getLibrary: () => Promise.resolve(buildLibraryStub()),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['userSetUsername'];
    if (!handler) throw new Error('userSetUsername handler missing');
    const result = await handler({ username: 'newuser' });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(payload['username']).toBe('newuser');
    expect(payload['displayName']).toBe('Dave R.');
    expect(mockSetUsername).toHaveBeenCalledWith('newuser');
  });
});

describe('userCheckUsername handler', () => {
  it('returns availability when username is free', async () => {
    const mockCheckUsername = vi.fn().mockResolvedValue({ available: true });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      checkUsername: mockCheckUsername,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['userCheckUsername'];
    if (!handler) throw new Error('userCheckUsername handler missing');
    const result = await handler({ username: 'freeuser' });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(payload['available']).toBe(true);
  });

  it('returns suggestion when username is taken', async () => {
    const mockCheckUsername = vi.fn().mockResolvedValue({
      available: false,
      suggestion: 'dave42',
    });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      checkUsername: mockCheckUsername,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['userCheckUsername'];
    if (!handler) throw new Error('userCheckUsername handler missing');
    const result = await handler({ username: 'dave' });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(payload['available']).toBe(false);
    expect(payload['suggestion']).toBe('dave42');
  });
});

// ── Library tools (#2209) ───────────────────────────────────────────

describe('libraryList handler', () => {
  it('returns enriched library listing with play stats', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () =>
        Promise.resolve({
          items: [
            {
              intent: {
                id: INTENT_ID,
                title: 'Confidence',
                emoji: '💪',
                sessionContext: 'general',
                createdAt: '2026-04-01T00:00:00Z',
                updatedAt: '2026-04-01T00:00:00Z',
              },
              latestAffirmationSet: { affirmationCount: 10 },
              latestRenderJob: { status: 'completed' },
              stats: { playCount: 5, lastPlayedAt: '2026-04-10T00:00:00Z' },
            },
          ],
        }),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['libraryList'];
    if (!handler) throw new Error('libraryList handler missing');
    const result = await handler({});
    const payload = JSON.parse(result.content[0]?.text ?? '[]') as Array<Record<string, unknown>>;

    expect(payload).toHaveLength(1);
    expect(payload[0]?.['playCount']).toBe(5);
    expect(payload[0]?.['renderStatus']).toBe('completed');
    expect(payload[0]?.['lastPlayedAt']).toBe('2026-04-10T00:00:00Z');
  });
});

describe('libraryView handler', () => {
  it('returns playlist detail with affirmations and feedback status', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      getIntent: () =>
        Promise.resolve({
          intent: {
            id: INTENT_ID,
            title: 'Confidence',
            emoji: null,
            sessionContext: 'general',
            tonePreference: 'grounded',
            createdAt: '2026-04-01T00:00:00Z',
            updatedAt: '2026-04-01T00:00:00Z',
            affirmationSets: [
              {
                id: 'set-1',
                affirmations: [
                  { id: 'aff-1', text: 'I am confident.', tone: 'steady', isEnabled: true, feedback: 'liked' },
                  { id: 'aff-2', text: 'I trust myself.', tone: 'gentle', isEnabled: false, feedback: null },
                ],
              },
            ],
            renderConfigs: [
              {
                affirmationSetId: 'set-1',
                renderJobs: [{ status: 'completed', progress: 100 }],
              },
            ],
          },
          stats: { playCount: 3, completedCount: 2, lastPlayedAt: '2026-04-10T00:00:00Z', totalListenSeconds: 600, createdAt: '2026-04-01T00:00:00Z' },
        }),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['libraryView'];
    if (!handler) throw new Error('libraryView handler missing');
    const result = await handler({ id: INTENT_ID });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(payload['affirmationCount']).toBe(2);
    expect(payload['renderStatus']).toBe('completed');
    const affs = payload['affirmations'] as Array<Record<string, unknown>>;
    expect(affs[0]?.['feedback']).toBe('liked');
    expect(affs[1]?.['feedback']).toBeNull();
    expect(payload['stats']).toBeTruthy();
  });

  it('errors when playlist not found', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve({ items: [] }),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['libraryView'];
    if (!handler) throw new Error('libraryView handler missing');
    const result = await handler({ id: 'does-not-exist' });
    expect(result.isError).toBe(true);
  });
});

// ── Affirmation management tools (#2209) ────────────────────────────

describe('affirmationsFeedback handler', () => {
  it('applies feedback to multiple affirmations with continue-on-error', async () => {
    const mockFeedback = vi.fn()
      .mockResolvedValueOnce({ affirmation: { id: 'aff-1', feedback: 'liked' } })
      .mockRejectedValueOnce(new Error('minimum 5 non-disliked required'));

    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      getIntent: () =>
        Promise.resolve({
          intent: {
            ...buildIntentStub(null).intent,
            affirmationSets: [
              {
                id: 'set-1',
                affirmations: [
                  { id: 'aff-1', text: 'A', tone: 'steady', isEnabled: true },
                  { id: 'aff-2', text: 'B', tone: 'steady', isEnabled: true },
                ],
              },
            ],
          },
        }),
      feedbackAffirmation: mockFeedback,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['affirmationsFeedback'];
    if (!handler) throw new Error('affirmationsFeedback handler missing');
    const result = await handler({
      id: INTENT_ID,
      affirmationIds: ['aff-1', 'aff-2'],
      feedback: 'liked',
    });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(payload['succeeded']).toBe(1);
    expect(payload['failed']).toBe(1);
    expect(payload['errors']).toBeTruthy();
  });

  it('rejects invalid affirmation IDs not in the set', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      getIntent: () =>
        Promise.resolve({
          intent: {
            ...buildIntentStub(null).intent,
            affirmationSets: [
              {
                id: 'set-1',
                affirmations: [
                  { id: 'aff-1', text: 'A', tone: 'steady', isEnabled: true },
                ],
              },
            ],
          },
        }),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['affirmationsFeedback'];
    if (!handler) throw new Error('affirmationsFeedback handler missing');
    const result = await handler({
      id: INTENT_ID,
      affirmationIds: ['invalid-id'],
      feedback: 'liked',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('invalid-id');
  });
});

describe('affirmationsToggle handler', () => {
  it('toggles affirmations via batch endpoint', async () => {
    const mockBatchToggle = vi.fn().mockResolvedValue({ affirmationSet: {} });

    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      getIntent: () =>
        Promise.resolve({
          intent: {
            ...buildIntentStub(null).intent,
            affirmationSets: [
              {
                id: 'set-1',
                affirmations: [
                  { id: 'aff-1', text: 'A', tone: 'steady', isEnabled: true },
                  { id: 'aff-2', text: 'B', tone: 'steady', isEnabled: true },
                ],
              },
            ],
          },
        }),
      batchToggleAffirmations: mockBatchToggle,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['affirmationsToggle'];
    if (!handler) throw new Error('affirmationsToggle handler missing');
    const result = await handler({
      id: INTENT_ID,
      affirmationIds: ['aff-1', 'aff-2'],
      isEnabled: false,
    });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(payload['toggled']).toBe(2);
    expect(payload['isEnabled']).toBe(false);
    expect(mockBatchToggle).toHaveBeenCalledWith('set-1', ['aff-1', 'aff-2'], false);
  });

  it('rejects invalid affirmation IDs not in the set', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      getIntent: () =>
        Promise.resolve({
          intent: {
            ...buildIntentStub(null).intent,
            affirmationSets: [
              {
                id: 'set-1',
                affirmations: [
                  { id: 'aff-1', text: 'A', tone: 'steady', isEnabled: true },
                ],
              },
            ],
          },
        }),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['affirmationsToggle'];
    if (!handler) throw new Error('affirmationsToggle handler missing');
    const result = await handler({
      id: INTENT_ID,
      affirmationIds: ['bad-id'],
      isEnabled: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('bad-id');
  });
});

// ── Catalog tools (#2336) ─────────────────────────────────────────────

describe('catalogBrowse handler', () => {
  const catalogSets = [
    {
      slug: 'morning-confidence',
      title: 'Morning Confidence',
      emoji: '☀️',
      catalogCategory: 'mindset',
      catalogDescription: 'Start your day with confidence',
      sessionContext: 'general',
      tonePreference: 'grounded',
      hasAudio: true,
      affirmationCount: 10,
      durationSeconds: 600,
    },
    {
      slug: 'sleep-relaxation',
      title: 'Sleep Relaxation',
      emoji: '🌙',
      catalogCategory: 'wellness',
      catalogDescription: 'Relax into deep sleep',
      sessionContext: 'sleep',
      tonePreference: 'open',
      hasAudio: true,
      affirmationCount: 8,
      durationSeconds: 900,
    },
  ];

  it('returns paginated catalog items with summary fields', async () => {
    const mockCatalogBrowse = vi.fn().mockResolvedValue({ sets: catalogSets });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      catalogBrowse: mockCatalogBrowse,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['catalogBrowse'];
    if (!handler) throw new Error('catalogBrowse handler missing');
    const result = await handler({});
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(payload['total']).toBe(2);
    expect(payload['limit']).toBe(20);
    expect(payload['offset']).toBe(0);
    const items = payload['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]?.['slug']).toBe('morning-confidence');
    expect(items[0]?.['title']).toBe('Morning Confidence');
    expect(items[0]?.['catalogCategory']).toBe('mindset');
    expect(items[0]?.['hasAudio']).toBe(true);
  });

  it('passes context/sort/filter to the client method', async () => {
    const mockCatalogBrowse = vi.fn().mockResolvedValue({ sets: catalogSets });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      catalogBrowse: mockCatalogBrowse,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['catalogBrowse'];
    if (!handler) throw new Error('catalogBrowse handler missing');
    await handler({ context: 'sleep', sort: 'title', filter: 'has-audio' });

    expect(mockCatalogBrowse).toHaveBeenCalledWith({
      context: 'sleep',
      sort: 'title',
      filter: 'has-audio',
    });
  });

  it('filters by category client-side', async () => {
    const mockCatalogBrowse = vi.fn().mockResolvedValue({ sets: catalogSets });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      catalogBrowse: mockCatalogBrowse,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['catalogBrowse'];
    if (!handler) throw new Error('catalogBrowse handler missing');
    const result = await handler({ category: 'wellness' });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(payload['total']).toBe(1);
    const items = payload['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]?.['slug']).toBe('sleep-relaxation');
  });

  it('applies limit and offset for pagination', async () => {
    const manySets = Array.from({ length: 5 }, (_, i) => ({
      slug: `set-${i}`,
      title: `Set ${i}`,
      emoji: null,
      catalogCategory: 'test',
      catalogDescription: `Description ${i}`,
      sessionContext: 'general',
      tonePreference: 'grounded',
      hasAudio: true,
      affirmationCount: 5,
      durationSeconds: 300,
    }));
    const mockCatalogBrowse = vi.fn().mockResolvedValue({ sets: manySets });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      catalogBrowse: mockCatalogBrowse,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['catalogBrowse'];
    if (!handler) throw new Error('catalogBrowse handler missing');
    const result = await handler({ limit: 2, offset: 1 });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(payload['total']).toBe(5);
    expect(payload['limit']).toBe(2);
    expect(payload['offset']).toBe(1);
    const items = payload['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]?.['slug']).toBe('set-1');
    expect(items[1]?.['slug']).toBe('set-2');
  });

  it('returns empty items when no sets match', async () => {
    const mockCatalogBrowse = vi.fn().mockResolvedValue({ sets: [] });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      catalogBrowse: mockCatalogBrowse,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['catalogBrowse'];
    if (!handler) throw new Error('catalogBrowse handler missing');
    const result = await handler({});
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(payload['total']).toBe(0);
    expect((payload['items'] as unknown[]).length).toBe(0);
  });

  it('handles API error gracefully', async () => {
    const mockCatalogBrowse = vi.fn().mockRejectedValue(new Error('HTTP 500'));
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      catalogBrowse: mockCatalogBrowse,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['catalogBrowse'];
    if (!handler) throw new Error('catalogBrowse handler missing');
    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('HTTP 500');
  });
});

describe('catalogView handler', () => {
  const catalogDetail = {
    slug: 'morning-confidence',
    title: 'Morning Confidence',
    emoji: '☀️',
    catalogCategory: 'mindset',
    catalogDescription: 'Start your day with confidence',
    sessionContext: 'general',
    affirmationCount: 2,
    affirmations: [
      { text: 'I am confident.', tone: 'steady', intensity: 3, tags: [], orderIndex: 0 },
      { text: 'I trust myself.', tone: 'gentle', intensity: 2, tags: [], orderIndex: 1 },
    ],
    framework: null,
    inspirations: null,
  };

  it('returns full catalog detail for a valid slug', async () => {
    const mockCatalogView = vi.fn().mockResolvedValue(catalogDetail);
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      catalogView: mockCatalogView,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['catalogView'];
    if (!handler) throw new Error('catalogView handler missing');
    const result = await handler({ slug: 'morning-confidence' });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(payload['slug']).toBe('morning-confidence');
    expect(payload['title']).toBe('Morning Confidence');
    expect((payload['affirmations'] as unknown[]).length).toBe(2);
    expect(mockCatalogView).toHaveBeenCalledWith('morning-confidence');
  });

  it('returns error when catalog set not found (404)', async () => {
    const err = new Error('HTTP 404: Catalog set not found') as Error & { status: number };
    err.status = 404;
    const mockCatalogView = vi.fn().mockRejectedValue(err);
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      catalogView: mockCatalogView,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['catalogView'];
    if (!handler) throw new Error('catalogView handler missing');
    const result = await handler({ slug: 'nonexistent-slug' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('404');
  });

  it('handles server errors gracefully', async () => {
    const err = new Error('HTTP 503') as Error & { status: number };
    err.status = 503;
    const mockCatalogView = vi.fn().mockRejectedValue(err);
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      catalogView: mockCatalogView,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['catalogView'];
    if (!handler) throw new Error('catalogView handler missing');
    const result = await handler({ slug: 'some-slug' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('HTTP 503');
  });
});

describe('catalogCopy handler', () => {
  it('copies catalog set and returns JSON with intent + affirmation set', async () => {
    const mockResult = {
      intent: { id: 'new-intent-123', title: 'Morning Confidence', emoji: '☀️' },
      affirmationSet: {
        id: 'new-set-456',
        affirmations: [{ id: 'aff-1', text: 'I am confident.', tone: 'steady', isEnabled: true }],
      },
    };
    const mockCatalogCopy = vi.fn().mockResolvedValue(mockResult);
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      catalogCopy: mockCatalogCopy,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['catalogCopy'];
    if (!handler) throw new Error('catalogCopy handler missing');
    const result = await handler({ slug: 'morning-confidence' });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    const intent = payload['intent'] as Record<string, unknown>;
    expect(intent['id']).toBe('new-intent-123');
    expect(intent['title']).toBe('Morning Confidence');
    expect(payload['affirmationSet']).toBeTruthy();
    expect(mockCatalogCopy).toHaveBeenCalledWith('morning-confidence');
  });

  it('returns error when catalog set not found (404)', async () => {
    const err = new Error('HTTP 404: Catalog set not found') as Error & { status: number };
    err.status = 404;
    const mockCatalogCopy = vi.fn().mockRejectedValue(err);
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      catalogCopy: mockCatalogCopy,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['catalogCopy'];
    if (!handler) throw new Error('catalogCopy handler missing');
    const result = await handler({ slug: 'nonexistent' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('404');
  });

  it('returns error when already copied (409)', async () => {
    const err = new Error('HTTP 409: Already in your library') as Error & { status: number };
    err.status = 409;
    const mockCatalogCopy = vi.fn().mockRejectedValue(err);
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      catalogCopy: mockCatalogCopy,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['catalogCopy'];
    if (!handler) throw new Error('catalogCopy handler missing');
    const result = await handler({ slug: 'already-copied' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Already in your library');
  });

  it('returns error when not logged in', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockImplementation(() => {
      throw new Error('Not logged in. Run `neuralingual login` first.');
    });

    const handler = CUSTOM_HANDLERS['catalogCopy'];
    if (!handler) throw new Error('catalogCopy handler missing');
    const result = await handler({ slug: 'some-slug' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Not logged in');
  });
});

// ── Playback tracking tools (#2338) ─────────────────────────────────

describe('playbackStart handler', () => {
  it('starts a playback session and returns the playback ID', async () => {
    const mockStartPlayback = vi.fn().mockResolvedValue({ id: 'pb-123' });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      startPlayback: mockStartPlayback,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['playbackStart'];
    if (!handler) throw new Error('playbackStart handler missing');
    const result = await handler({ id: INTENT_ID });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(payload['id']).toBe('pb-123');
    expect(mockStartPlayback).toHaveBeenCalledWith(INTENT_ID, undefined);
  });

  it('passes renderJobId when provided', async () => {
    const mockStartPlayback = vi.fn().mockResolvedValue({ id: 'pb-456' });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      startPlayback: mockStartPlayback,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['playbackStart'];
    if (!handler) throw new Error('playbackStart handler missing');
    const result = await handler({ id: INTENT_ID, renderJobId: 'rj-789' });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(payload['id']).toBe('pb-456');
    expect(mockStartPlayback).toHaveBeenCalledWith(INTENT_ID, 'rj-789');
  });

  it('resolves short ID prefix to full intent ID', async () => {
    const mockStartPlayback = vi.fn().mockResolvedValue({ id: 'pb-789' });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      startPlayback: mockStartPlayback,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['playbackStart'];
    if (!handler) throw new Error('playbackStart handler missing');
    // Use a prefix of the intent ID
    await handler({ id: 'intent-abc' });

    expect(mockStartPlayback).toHaveBeenCalledWith(INTENT_ID, undefined);
  });

  it('errors when playlist not found', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve({ items: [] }),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['playbackStart'];
    if (!handler) throw new Error('playbackStart handler missing');
    const result = await handler({ id: 'nonexistent' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Playlist not found');
  });

  it('handles API error gracefully', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      startPlayback: vi.fn().mockRejectedValue(new Error('HTTP 500')),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['playbackStart'];
    if (!handler) throw new Error('playbackStart handler missing');
    const result = await handler({ id: INTENT_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('HTTP 500');
  });
});

describe('playbackComplete handler', () => {
  it('completes a playback session with duration', async () => {
    const mockCompletePlayback = vi.fn().mockResolvedValue({ ok: true });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      completePlayback: mockCompletePlayback,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['playbackComplete'];
    if (!handler) throw new Error('playbackComplete handler missing');
    const result = await handler({ id: 'pb-123', durationSeconds: 300 });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(payload['ok']).toBe(true);
    expect(mockCompletePlayback).toHaveBeenCalledWith('pb-123', 300, undefined);
  });

  it('marks session as completed when flag is true', async () => {
    const mockCompletePlayback = vi.fn().mockResolvedValue({ ok: true });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      completePlayback: mockCompletePlayback,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['playbackComplete'];
    if (!handler) throw new Error('playbackComplete handler missing');
    await handler({ id: 'pb-123', durationSeconds: 600, completed: true });

    expect(mockCompletePlayback).toHaveBeenCalledWith('pb-123', 600, true);
  });

  it('handles not-found error (404)', async () => {
    const err = new Error('HTTP 404: Playback record not found') as Error & { status: number };
    err.status = 404;
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      completePlayback: vi.fn().mockRejectedValue(err),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['playbackComplete'];
    if (!handler) throw new Error('playbackComplete handler missing');
    const result = await handler({ id: 'bad-id', durationSeconds: 100 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('404');
  });

  it('returns error when not logged in', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockImplementation(() => {
      throw new Error('Not logged in. Run `neuralingual login` first.');
    });

    const handler = CUSTOM_HANDLERS['playbackComplete'];
    if (!handler) throw new Error('playbackComplete handler missing');
    const result = await handler({ id: 'pb-123', durationSeconds: 300 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Not logged in');
  });
});

// ── Affirmation + Intent management tools (#2337) ─────────────────────

describe('generateMore handler', () => {
  it('resolves intent to latest set and generates more affirmations', async () => {
    const mockGenerateMore = vi.fn().mockResolvedValue({
      affirmationSet: { id: 'set-1' },
      added: 5,
    });

    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      getIntent: () => Promise.resolve(buildIntentStub(null)),
      generateMore: mockGenerateMore,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['generateMore'];
    if (!handler) throw new Error('generateMore handler missing');
    const result = await handler({ id: INTENT_ID });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(payload['added']).toBe(5);
    expect(payload['setId']).toBe('set-1');
    expect(payload['message']).toContain('5');
    expect(mockGenerateMore).toHaveBeenCalledWith('set-1', undefined);
  });

  it('passes count parameter through to client', async () => {
    const mockGenerateMore = vi.fn().mockResolvedValue({
      affirmationSet: { id: 'set-1' },
      added: 3,
    });

    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      getIntent: () => Promise.resolve(buildIntentStub(null)),
      generateMore: mockGenerateMore,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['generateMore'];
    if (!handler) throw new Error('generateMore handler missing');
    await handler({ id: INTENT_ID, count: 10 });

    expect(mockGenerateMore).toHaveBeenCalledWith('set-1', 10);
  });

  it('errors when playlist not found', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve({ items: [] }),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['generateMore'];
    if (!handler) throw new Error('generateMore handler missing');
    const result = await handler({ id: 'nonexistent' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Playlist not found');
  });

  it('errors when no affirmation set exists', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      getIntent: () =>
        Promise.resolve({
          intent: { ...buildIntentStub(null).intent, affirmationSets: [] },
        }),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['generateMore'];
    if (!handler) throw new Error('generateMore handler missing');
    const result = await handler({ id: INTENT_ID });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('No affirmation set found');
  });

  it('propagates API errors (e.g. insufficient credits)', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      getIntent: () => Promise.resolve(buildIntentStub(null)),
      generateMore: vi.fn().mockRejectedValue(new Error('HTTP 402: Insufficient credits')),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['generateMore'];
    if (!handler) throw new Error('generateMore handler missing');
    const result = await handler({ id: INTENT_ID });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Insufficient credits');
  });
});

describe('affirmationAdd handler', () => {
  it('resolves intent to latest set and adds an affirmation', async () => {
    const mockAddAffirmation = vi.fn().mockResolvedValue({
      affirmation: { id: 'aff-new', text: 'I believe in myself.', tone: 'steady', isEnabled: true },
    });

    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      getIntent: () => Promise.resolve(buildIntentStub(null)),
      addAffirmation: mockAddAffirmation,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['affirmationAdd'];
    if (!handler) throw new Error('affirmationAdd handler missing');
    const result = await handler({ id: INTENT_ID, text: 'I believe in myself.' });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    const affirmation = payload['affirmation'] as Record<string, unknown>;
    expect(affirmation['id']).toBe('aff-new');
    expect(affirmation['text']).toBe('I believe in myself.');
    expect(mockAddAffirmation).toHaveBeenCalledWith('set-1', 'I believe in myself.');
  });

  it('errors when playlist not found', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve({ items: [] }),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['affirmationAdd'];
    if (!handler) throw new Error('affirmationAdd handler missing');
    const result = await handler({ id: 'nonexistent', text: 'test' });
    expect(result.isError).toBe(true);
  });

  it('propagates API errors (e.g. max affirmations reached)', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      getIntent: () => Promise.resolve(buildIntentStub(null)),
      addAffirmation: vi.fn().mockRejectedValue(new Error('HTTP 400: Maximum 60 affirmations per set')),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['affirmationAdd'];
    if (!handler) throw new Error('affirmationAdd handler missing');
    const result = await handler({ id: INTENT_ID, text: 'test' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Maximum 60 affirmations');
  });
});

describe('affirmationDelete handler', () => {
  it('validates and deletes an affirmation', async () => {
    const mockDeleteAffirmation = vi.fn().mockResolvedValue(undefined);

    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      getIntent: () =>
        Promise.resolve({
          intent: {
            ...buildIntentStub(null).intent,
            affirmationSets: [
              {
                id: 'set-1',
                affirmations: [
                  { id: 'aff-1', text: 'A', tone: 'steady', isEnabled: true },
                  { id: 'aff-2', text: 'B', tone: 'steady', isEnabled: true },
                ],
              },
            ],
          },
        }),
      deleteAffirmation: mockDeleteAffirmation,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['affirmationDelete'];
    if (!handler) throw new Error('affirmationDelete handler missing');
    const result = await handler({ id: INTENT_ID, affirmationId: 'aff-1' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('Deleted affirmation aff-1');
    expect(mockDeleteAffirmation).toHaveBeenCalledWith('aff-1');
  });

  it('rejects affirmation IDs not in the set', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      getIntent: () =>
        Promise.resolve({
          intent: {
            ...buildIntentStub(null).intent,
            affirmationSets: [
              {
                id: 'set-1',
                affirmations: [
                  { id: 'aff-1', text: 'A', tone: 'steady', isEnabled: true },
                ],
              },
            ],
          },
        }),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['affirmationDelete'];
    if (!handler) throw new Error('affirmationDelete handler missing');
    const result = await handler({ id: INTENT_ID, affirmationId: 'wrong-id' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('wrong-id');
  });

  it('propagates API errors (e.g. minimum 5 required)', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      getIntent: () =>
        Promise.resolve({
          intent: {
            ...buildIntentStub(null).intent,
            affirmationSets: [
              {
                id: 'set-1',
                affirmations: [
                  { id: 'aff-1', text: 'A', tone: 'steady', isEnabled: true },
                ],
              },
            ],
          },
        }),
      deleteAffirmation: vi.fn().mockRejectedValue(new Error('HTTP 400: Cannot delete: minimum 5 non-disliked affirmations required')),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['affirmationDelete'];
    if (!handler) throw new Error('affirmationDelete handler missing');
    const result = await handler({ id: INTENT_ID, affirmationId: 'aff-1' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('minimum 5');
  });
});

describe('intentUpdate handler', () => {
  it('updates intent text, title, emoji, and tone', async () => {
    const mockUpdateIntent = vi.fn().mockResolvedValue({
      intent: { id: INTENT_ID, title: 'New Title', emoji: '🔥' },
    });

    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      updateIntent: mockUpdateIntent,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['intentUpdate'];
    if (!handler) throw new Error('intentUpdate handler missing');
    const result = await handler({
      id: INTENT_ID,
      text: 'New intent text',
      title: 'New Title',
      emoji: '🔥',
      tone: 'open',
    });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    const intent = payload['intent'] as Record<string, unknown>;
    expect(intent['title']).toBe('New Title');
    expect(intent['emoji']).toBe('🔥');
    expect(mockUpdateIntent).toHaveBeenCalledWith(INTENT_ID, {
      intentText: 'New intent text',
      title: 'New Title',
      emoji: '🔥',
      tonePreference: 'open',
    });
  });

  it('maps text to intentText and tone to tonePreference correctly', async () => {
    const mockUpdateIntent = vi.fn().mockResolvedValue({
      intent: { id: INTENT_ID, title: 'Confidence', emoji: null },
    });

    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      updateIntent: mockUpdateIntent,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['intentUpdate'];
    if (!handler) throw new Error('intentUpdate handler missing');
    await handler({ id: INTENT_ID, text: 'Updated text' });

    expect(mockUpdateIntent).toHaveBeenCalledWith(INTENT_ID, {
      intentText: 'Updated text',
    });
  });

  it('allows updating only title without other fields', async () => {
    const mockUpdateIntent = vi.fn().mockResolvedValue({
      intent: { id: INTENT_ID, title: 'Just Title', emoji: null },
    });

    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      updateIntent: mockUpdateIntent,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['intentUpdate'];
    if (!handler) throw new Error('intentUpdate handler missing');
    await handler({ id: INTENT_ID, title: 'Just Title' });

    expect(mockUpdateIntent).toHaveBeenCalledWith(INTENT_ID, { title: 'Just Title' });
  });

  it('allows clearing emoji with null', async () => {
    const mockUpdateIntent = vi.fn().mockResolvedValue({
      intent: { id: INTENT_ID, title: 'Confidence', emoji: null },
    });

    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve(buildLibraryStub()),
      updateIntent: mockUpdateIntent,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['intentUpdate'];
    if (!handler) throw new Error('intentUpdate handler missing');
    await handler({ id: INTENT_ID, emoji: null });

    expect(mockUpdateIntent).toHaveBeenCalledWith(INTENT_ID, { emoji: null });
  });

  it('errors when no editable fields provided', async () => {
    const handler = CUSTOM_HANDLERS['intentUpdate'];
    if (!handler) throw new Error('intentUpdate handler missing');
    const result = await handler({ id: INTENT_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('At least one of');
  });

  it('errors when playlist not found', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getLibrary: () => Promise.resolve({ items: [] }),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['intentUpdate'];
    if (!handler) throw new Error('intentUpdate handler missing');
    const result = await handler({ id: 'nonexistent', title: 'test' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Playlist not found');
  });
});

describe('create handler — affirmations[] (#40, absorbed into nl_playlist_create)', () => {
  it('creates directly from affirmations via createManualIntent, WITHOUT calling createAndGenerate (no credit charge)', async () => {
    const mockCreateManualIntent = vi.fn().mockResolvedValue({
      intent: { id: INTENT_ID, title: 'My Playlist', emoji: null, rawText: 'I am focused.', sessionContext: 'general' },
      affirmationSet: {
        id: 'set-1',
        affirmations: [
          { id: 'aff-1', text: 'I am focused.', tone: 'steady', isEnabled: true },
          { id: 'aff-2', text: 'I am capable.', tone: 'steady', isEnabled: true },
        ],
      },
    });
    const mockCreateAndGenerate = vi.fn().mockResolvedValue({ intent: { id: 'should-not-be-called' } });

    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      createManualIntent: mockCreateManualIntent,
      createAndGenerate: mockCreateAndGenerate,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['create'];
    if (!handler) throw new Error('create handler missing');
    const result = await handler({
      text: 'I am focused.',
      title: 'My Playlist',
      affirmations: ['I am focused.', 'I am capable.'],
    });

    expect(result.isError).toBeUndefined();
    expect(mockCreateManualIntent).toHaveBeenCalledWith({
      title: 'My Playlist',
      rawText: 'I am focused.',
      tonePreference: null,
      affirmations: [{ text: 'I am focused.' }, { text: 'I am capable.' }],
    });
    // The credit-charging path must never be invoked in affirmations mode —
    // this is the client-level assertion that no credit was spent.
    expect(mockCreateAndGenerate).not.toHaveBeenCalled();
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect((payload['affirmationSet'] as Record<string, unknown>)['id']).toBe('set-1');
  });

  it('derives the title from text (first 120 chars) when title is omitted', async () => {
    const mockCreateManualIntent = vi.fn().mockResolvedValue({
      intent: { id: INTENT_ID, title: 'I am focused.', emoji: null, rawText: 'I am focused.', sessionContext: 'general' },
      affirmationSet: { id: 'set-1', affirmations: [] },
    });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      createManualIntent: mockCreateManualIntent,
      createAndGenerate: vi.fn(),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['create'];
    if (!handler) throw new Error('create handler missing');
    await handler({ text: 'I am focused.', affirmations: ['I am focused.'] });

    expect(mockCreateManualIntent).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'I am focused.' }),
    );
  });

  it('passes tone through as tonePreference', async () => {
    const mockCreateManualIntent = vi.fn().mockResolvedValue({
      intent: { id: INTENT_ID },
      affirmationSet: { id: 'set-1', affirmations: [] },
    });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      createManualIntent: mockCreateManualIntent,
      createAndGenerate: vi.fn(),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['create'];
    if (!handler) throw new Error('create handler missing');
    await handler({ text: 'I am focused.', tone: 'mystical', affirmations: ['I am focused.'] });

    expect(mockCreateManualIntent).toHaveBeenCalledWith(
      expect.objectContaining({ tonePreference: 'mystical' }),
    );
  });

  it('errors when affirmations is provided without text', async () => {
    const handler = CUSTOM_HANDLERS['create'];
    if (!handler) throw new Error('create handler missing');
    const result = await handler({ affirmations: ['I am focused.'] });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Please provide text');
  });

  it('ignores sourceText (and does not call the generation path) when affirmations is also provided', async () => {
    // Consistent with style/styleNotes/coachKey/setAsDefault: source params
    // are generation-only knobs, silently ignored rather than rejected when
    // affirmations is present — a caller may pass along the source it drew
    // affirmations from for context without wanting generation to run.
    const mockCreateManualIntent = vi.fn().mockResolvedValue({
      intent: { id: INTENT_ID },
      affirmationSet: { id: 'set-1', affirmations: [] },
    });
    const mockCreateAndGenerate = vi.fn();

    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      createManualIntent: mockCreateManualIntent,
      createAndGenerate: mockCreateAndGenerate,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['create'];
    if (!handler) throw new Error('create handler missing');
    const result = await handler({
      text: 'I am focused.',
      sourceText: 'Some source material long enough to pass validation.',
      affirmations: ['I am focused.'],
    });

    expect(result.isError).toBeUndefined();
    expect(mockCreateManualIntent).toHaveBeenCalledWith(
      expect.objectContaining({ rawText: 'I am focused.' }),
    );
    expect(mockCreateAndGenerate).not.toHaveBeenCalled();
  });

  it('falls back to the existing generate behavior when affirmations is absent', async () => {
    const mockCreateAndGenerate = vi.fn().mockResolvedValue({ intent: { id: INTENT_ID }, affirmationSet: { id: 'set-1' } });
    const mockCreateManualIntent = vi.fn();

    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      createAndGenerate: mockCreateAndGenerate,
      createManualIntent: mockCreateManualIntent,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['create'];
    if (!handler) throw new Error('create handler missing');
    await handler({ text: 'I am focused.' });

    expect(mockCreateAndGenerate).toHaveBeenCalled();
    expect(mockCreateManualIntent).not.toHaveBeenCalled();
  });
});

