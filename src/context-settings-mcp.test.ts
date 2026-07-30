/**
 * Tests for context settings and wizard defaults MCP tools (#2335).
 *
 * Tests cover:
 * - nl_context_settings_list: valid response, empty state
 * - nl_context_settings_update: valid update, partial fields, null to clear
 * - nl_context_settings_reset: valid reset, confirmation message
 * - nl_wizard_defaults: without intentId, with intentId, response shape
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CUSTOM_HANDLERS } from './user-mcp.js';
import { UserApiClient } from './user-client.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

// ── nl_context_settings_list ──────────────────────────────────────────

describe('contextSettingsList handler', () => {
  it('returns all context settings for the user', async () => {
    const mockSettings = [
      {
        sessionContext: 'sleep',
        paceWpm: 100,
        pauseMs: null,
        durationMinutes: 30,
        repeatCount: null,
        backgroundVolume: 0.5,
        voiceId: 'voice-calm-01',
        backgroundKey: 'rain-soft',
        binauralPreset: 'theta',
        playbackMode: null,
        binauralVolume: 0.3,
        subliminalEnabled: null,
        subliminalVolume: null,
      },
      {
        sessionContext: 'workout',
        paceWpm: 180,
        pauseMs: null,
        durationMinutes: 15,
        repeatCount: 2,
        backgroundVolume: 0.8,
        voiceId: 'voice-energetic-02',
        backgroundKey: null,
        binauralPreset: 'beta',
        playbackMode: 'shuffle',
        binauralVolume: 0.5,
        subliminalEnabled: true,
        subliminalVolume: 0.2,
      },
    ];

    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getContextSettings: vi.fn().mockResolvedValue({ settings: mockSettings }),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['contextSettingsList'];
    if (!handler) throw new Error('contextSettingsList handler missing');
    const result = await handler({});
    const payload = JSON.parse(result.content[0]?.text ?? '[]') as unknown[];

    expect(result.isError).toBeUndefined();
    expect(payload).toHaveLength(2);
    expect((payload[0] as Record<string, unknown>)['sessionContext']).toBe('sleep');
    expect((payload[0] as Record<string, unknown>)['voiceId']).toBe('voice-calm-01');
    expect((payload[1] as Record<string, unknown>)['sessionContext']).toBe('workout');
    expect((payload[1] as Record<string, unknown>)['binauralPreset']).toBe('beta');
  });

  it('returns empty array when no settings are configured', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getContextSettings: vi.fn().mockResolvedValue({ settings: [] }),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['contextSettingsList'];
    if (!handler) throw new Error('contextSettingsList handler missing');
    const result = await handler({});
    const payload = JSON.parse(result.content[0]?.text ?? '[]') as unknown[];

    expect(result.isError).toBeUndefined();
    expect(payload).toHaveLength(0);
  });

  it('returns error when not logged in', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockImplementation(() => {
      throw new Error('Not logged in. Run `nl login` first.');
    });

    const handler = CUSTOM_HANDLERS['contextSettingsList'];
    if (!handler) throw new Error('contextSettingsList handler missing');
    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Not logged in');
  });

  it('returns error when API call fails', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getContextSettings: vi.fn().mockRejectedValue(new Error('HTTP 500: Internal Server Error')),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['contextSettingsList'];
    if (!handler) throw new Error('contextSettingsList handler missing');
    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('HTTP 500');
  });
});

// ── nl_context_settings_update ────────────────────────────────────────

describe('contextSettingsUpdate handler', () => {
  it('updates context settings with provided fields', async () => {
    const mockUpdateResult = {
      sessionContext: 'meditation',
      paceWpm: null,
      pauseMs: null,
      durationMinutes: 20,
      repeatCount: null,
      backgroundVolume: null,
      voiceId: 'voice-zen-03',
      backgroundKey: 'ocean-waves',
      binauralPreset: 'alpha',
      playbackMode: null,
      binauralVolume: 0.4,
      subliminalEnabled: null,
      subliminalVolume: null,
    };

    const mockUpdateFn = vi.fn().mockResolvedValue({ settings: mockUpdateResult });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      updateContextSettings: mockUpdateFn,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['contextSettingsUpdate'];
    if (!handler) throw new Error('contextSettingsUpdate handler missing');
    const result = await handler({
      context: 'meditation',
      voiceId: 'voice-zen-03',
      durationMinutes: 20,
      binauralPreset: 'alpha',
      backgroundKey: 'ocean-waves',
      binauralVolume: 0.4,
    });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(payload['sessionContext']).toBe('meditation');
    expect(payload['voiceId']).toBe('voice-zen-03');
    expect(payload['durationMinutes']).toBe(20);
    expect(payload['binauralPreset']).toBe('alpha');
    expect(mockUpdateFn).toHaveBeenCalledWith('meditation', {
      voiceId: 'voice-zen-03',
      durationMinutes: 20,
      binauralPreset: 'alpha',
      backgroundKey: 'ocean-waves',
      binauralVolume: 0.4,
    });
  });

  it('passes null values to clear overrides', async () => {
    const mockUpdateFn = vi.fn().mockResolvedValue({
      settings: {
        sessionContext: 'sleep',
        paceWpm: null,
        pauseMs: null,
        durationMinutes: null,
        repeatCount: null,
        backgroundVolume: null,
        voiceId: null,
        backgroundKey: null,
        binauralPreset: null,
        playbackMode: null,
        binauralVolume: null,
        subliminalEnabled: null,
        subliminalVolume: null,
      },
    });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      updateContextSettings: mockUpdateFn,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['contextSettingsUpdate'];
    if (!handler) throw new Error('contextSettingsUpdate handler missing');
    const result = await handler({
      context: 'sleep',
      voiceId: null,
      binauralPreset: null,
    });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(payload['voiceId']).toBeNull();
    expect(payload['binauralPreset']).toBeNull();
    expect(mockUpdateFn).toHaveBeenCalledWith('sleep', {
      voiceId: null,
      binauralPreset: null,
    });
  });

  it('sends only provided fields (does not send undefined)', async () => {
    const mockUpdateFn = vi.fn().mockResolvedValue({
      settings: {
        sessionContext: 'focus',
        paceWpm: 150,
        pauseMs: null,
        durationMinutes: null,
        repeatCount: null,
        backgroundVolume: null,
        voiceId: null,
        backgroundKey: null,
        binauralPreset: null,
        playbackMode: null,
        binauralVolume: null,
        subliminalEnabled: null,
        subliminalVolume: null,
      },
    });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      updateContextSettings: mockUpdateFn,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['contextSettingsUpdate'];
    if (!handler) throw new Error('contextSettingsUpdate handler missing');
    await handler({ context: 'focus', paceWpm: 150 });

    // Only paceWpm should be in the data, not voiceId or other fields
    expect(mockUpdateFn).toHaveBeenCalledWith('focus', { paceWpm: 150 });
  });

  it('returns error when API call fails', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      updateContextSettings: vi.fn().mockRejectedValue(new Error('HTTP 400: Invalid context')),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['contextSettingsUpdate'];
    if (!handler) throw new Error('contextSettingsUpdate handler missing');
    const result = await handler({ context: 'invalid', voiceId: 'x' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('HTTP 400');
  });

  it('handles all supported override fields', async () => {
    const mockUpdateFn = vi.fn().mockResolvedValue({
      settings: { sessionContext: 'general' },
    });
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      updateContextSettings: mockUpdateFn,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['contextSettingsUpdate'];
    if (!handler) throw new Error('contextSettingsUpdate handler missing');
    await handler({
      context: 'general',
      voiceId: 'v1',
      durationMinutes: 10,
      binauralPreset: 'theta',
      paceWpm: 120,
      backgroundKey: 'rain',
      backgroundVolume: 0.5,
      binauralVolume: 0.3,
      subliminalEnabled: true,
      subliminalVolume: 0.1,
      playbackMode: 'shuffle',
      repeatCount: 3,
      pauseMs: 2000,
    });

    expect(mockUpdateFn).toHaveBeenCalledWith('general', {
      voiceId: 'v1',
      durationMinutes: 10,
      binauralPreset: 'theta',
      paceWpm: 120,
      backgroundKey: 'rain',
      backgroundVolume: 0.5,
      binauralVolume: 0.3,
      subliminalEnabled: true,
      subliminalVolume: 0.1,
      playbackMode: 'shuffle',
      repeatCount: 3,
      pauseMs: 2000,
    });
  });
});

// ── nl_context_settings_reset ─────────────────────────────────────────

describe('contextSettingsReset handler', () => {
  it('resets context settings and returns confirmation', async () => {
    const mockDeleteFn = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      deleteContextSettings: mockDeleteFn,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['contextSettingsReset'];
    if (!handler) throw new Error('contextSettingsReset handler missing');
    const result = await handler({ context: 'sleep' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('Context "sleep" reset to system defaults.');
    expect(mockDeleteFn).toHaveBeenCalledWith('sleep');
  });

  it('works for all valid contexts', async () => {
    const mockDeleteFn = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      deleteContextSettings: mockDeleteFn,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['contextSettingsReset'];
    if (!handler) throw new Error('contextSettingsReset handler missing');

    const contexts = ['general', 'sleep', 'nap', 'meditation', 'workout', 'focus', 'walk', 'chores'];
    for (const ctx of contexts) {
      const result = await handler({ context: ctx });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toBe(`Context "${ctx}" reset to system defaults.`);
    }
    expect(mockDeleteFn).toHaveBeenCalledTimes(contexts.length);
  });

  it('returns error when API call fails', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      deleteContextSettings: vi.fn().mockRejectedValue(new Error('HTTP 404: Not found')),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['contextSettingsReset'];
    if (!handler) throw new Error('contextSettingsReset handler missing');
    const result = await handler({ context: 'sleep' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('HTTP 404');
  });

  it('returns error when not logged in', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockImplementation(() => {
      throw new Error('Not logged in. Run `nl login` first.');
    });

    const handler = CUSTOM_HANDLERS['contextSettingsReset'];
    if (!handler) throw new Error('contextSettingsReset handler missing');
    const result = await handler({ context: 'workout' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Not logged in');
  });
});

// ── nl_wizard_defaults ────────────────────────────────────────────────

describe('wizardDefaults handler', () => {
  const mockDefaults = {
    voiceId: 'voice-calm-01',
    backgroundKey: 'rain-soft',
    backgroundVolume: 0.5,
    binauralPreset: null,
    binauralVolume: 0.3,
    subliminalEnabled: false,
    subliminalVolume: 0.1,
    durationMinutes: 10,
    playbackMode: 'shuffle',
    source: 'recent' as const,
  };

  it('returns wizard defaults without intentId', async () => {
    const mockGetDefaults = vi.fn().mockResolvedValue(mockDefaults);
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getWizardDefaults: mockGetDefaults,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['wizardDefaults'];
    if (!handler) throw new Error('wizardDefaults handler missing');
    const result = await handler({});
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(payload['voiceId']).toBe('voice-calm-01');
    expect(payload['backgroundKey']).toBe('rain-soft');
    expect(payload['durationMinutes']).toBe(10);
    expect(payload['playbackMode']).toBe('shuffle');
    expect(payload['source']).toBe('recent');
    expect(mockGetDefaults).toHaveBeenCalledWith(undefined);
  });

  it('passes intentId when provided', async () => {
    const intentDefaults = { ...mockDefaults, source: 'intent' as const };
    const mockGetDefaults = vi.fn().mockResolvedValue(intentDefaults);
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getWizardDefaults: mockGetDefaults,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['wizardDefaults'];
    if (!handler) throw new Error('wizardDefaults handler missing');
    const result = await handler({ intentId: 'intent-123' });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(payload['source']).toBe('intent');
    expect(mockGetDefaults).toHaveBeenCalledWith('intent-123');
  });

  it('returns system defaults when user has no config', async () => {
    const systemDefaults = {
      voiceId: null,
      backgroundKey: null,
      backgroundVolume: 0.3,
      binauralPreset: null,
      binauralVolume: 0.3,
      subliminalEnabled: false,
      subliminalVolume: 0.1,
      durationMinutes: 10,
      playbackMode: 'shuffle',
      source: 'system' as const,
    };
    const mockGetDefaults = vi.fn().mockResolvedValue(systemDefaults);
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getWizardDefaults: mockGetDefaults,
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['wizardDefaults'];
    if (!handler) throw new Error('wizardDefaults handler missing');
    const result = await handler({});
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(payload['voiceId']).toBeNull();
    expect(payload['source']).toBe('system');
    expect(payload['durationMinutes']).toBe(10);
  });

  it('returns error when API call fails', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockReturnValue({
      getWizardDefaults: vi.fn().mockRejectedValue(new Error('HTTP 500: Internal Server Error')),
    } as unknown as UserApiClient);

    const handler = CUSTOM_HANDLERS['wizardDefaults'];
    if (!handler) throw new Error('wizardDefaults handler missing');
    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('HTTP 500');
  });

  it('returns error when not logged in', async () => {
    vi.spyOn(UserApiClient, 'fromAuth').mockImplementation(() => {
      throw new Error('Not logged in. Run `nl login` first.');
    });

    const handler = CUSTOM_HANDLERS['wizardDefaults'];
    if (!handler) throw new Error('wizardDefaults handler missing');
    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Not logged in');
  });
});
