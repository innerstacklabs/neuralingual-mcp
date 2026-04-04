#!/usr/bin/env node
/**
 * Neuralingual User MCP Server
 *
 * MCP server for AI assistant integration. Authenticates via stored JWT
 * from `neuralingual login`. Provides ~18 tools for library management,
 * creation, rendering, sharing, and YAML set file round-tripping.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { UserApiClient } from './user-client.js';
import { loadAuth } from './auth-store.js';
import { serializeSetFile, parseSetFile } from './set-file.js';
import { API_BASE_URLS } from './types.js';
import type {
  RenderConfigInput,
  SessionContext,
  TonePreference,
  Intent,
  Affirmation,
  RenderConfig,
} from './types.js';
import type { SetFileData } from './set-file.js';

const SERVER_NAME = 'neuralingual';
const SERVER_VERSION = '0.2.0';

const AUDIO_CACHE_DIR = join(homedir(), '.config', 'neuralingual', 'audio');

const toneSchema = z.enum(['grounded', 'open', 'mystical']).optional();

// ── Helpers ────────────────────────────────────────────────────────────────

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

const NOT_LOGGED_IN = 'Not logged in. Run `neuralingual login` first.';

function getClient(): UserApiClient {
  try {
    return UserApiClient.fromAuth();
  } catch {
    throw new Error(NOT_LOGGED_IN);
  }
}

async function withClient<T>(fn: (client: UserApiClient) => Promise<T>) {
  try {
    return await fn(getClient());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(msg);
  }
}

/**
 * Resolve a short/truncated intent ID to the full ID via library lookup.
 * Supports exact match and unique prefix match.
 */
async function resolveIntentId(client: UserApiClient, shortId: string): Promise<string> {
  const { items } = await client.getLibrary();
  const exact = items.find((i) => i.intent.id === shortId);
  if (exact) return exact.intent.id;

  const prefixMatches = items.filter((i) => i.intent.id.startsWith(shortId));
  if (prefixMatches.length === 1) return prefixMatches[0]!.intent.id;
  if (prefixMatches.length > 1) {
    throw new Error(
      `Ambiguous ID "${shortId}" matches ${prefixMatches.length} sets. Use a longer prefix or the full ID.`,
    );
  }

  throw new Error('Practice set not found. Use nl_library to see available sets.');
}

/**
 * Fetch set file data for YAML export. Maps user intent detail to SetFileData.
 */
async function fetchSetFileData(client: UserApiClient, intentId: string): Promise<SetFileData> {
  const { intent } = await client.getIntent(intentId);
  if (!intent) {
    throw new Error('Practice set not found. Use nl_library to see available sets.');
  }

  const latestSet = intent.affirmationSets[0];
  const affirmations: Affirmation[] = (latestSet?.affirmations ?? []).map((a, idx) => ({
    id: a.id,
    setId: latestSet?.id ?? '',
    text: a.text,
    tone: a.tone,
    intensity: 3,
    length: a.text.length < 60 ? 'short' : 'medium',
    tags: [],
    weight: 3,
    isFavorite: false,
    isEnabled: a.isEnabled,
    orderIndex: idx,
    createdAt: '',
    updatedAt: '',
  }));

  const latestSetId = latestSet?.id;
  const latestConfig =
    (latestSetId
      ? intent.renderConfigs.find((rc) => rc.affirmationSetId === latestSetId)
      : intent.renderConfigs[0]) ?? null;
  const renderConfig: RenderConfig | null = latestConfig
    ? {
        id: latestConfig.id,
        intentId: intent.id,
        affirmationSetId: latestConfig.affirmationSetId,
        voiceId: latestConfig.voiceId,
        voiceProvider: latestConfig.voiceProvider,
        sessionContext: latestConfig.sessionContext as SessionContext,
        paceWpm: latestConfig.paceWpm,
        durationSeconds: latestConfig.durationSeconds,
        backgroundAudioPath: latestConfig.backgroundAudioPath,
        backgroundVolume: latestConfig.backgroundVolume,
        affirmationRepeatCount: latestConfig.affirmationRepeatCount,
        includePreamble: latestConfig.includePreamble,
        playAll: latestConfig.playAll,
        createdAt: latestConfig.createdAt,
        updatedAt: latestConfig.updatedAt,
      }
    : null;

  const mappedIntent: Intent = {
    id: intent.id,
    userId: '',
    title: intent.title,
    emoji: intent.emoji,
    rawText: intent.rawText,
    tonePreference: (intent.tonePreference as TonePreference) ?? null,
    sessionContext: intent.sessionContext as SessionContext,
    isCatalog: false,
    catalogSlug: null,
    catalogCategory: null,
    catalogSubtitle: null,
    catalogDescription: null,
    catalogOrder: null,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
    archivedAt: null,
  };

  return { intent: mappedIntent, affirmations, renderConfig };
}

/**
 * Apply a YAML set file to an existing practice set.
 */
async function applySetFile(
  client: UserApiClient,
  intentId: string,
  content: string,
  originalData: SetFileData,
): Promise<string> {
  const parsed = parseSetFile(content);
  const changes: string[] = [];

  // 1. Intent metadata updates
  const intentUpdates: { title?: string; emoji?: string | null; intentText?: string; tonePreference?: string | null } =
    {};
  if (parsed.title !== undefined && parsed.title !== originalData.intent.title) {
    intentUpdates.title = parsed.title;
  }
  if (parsed.tone !== undefined && parsed.tone !== originalData.intent.tonePreference) {
    intentUpdates.tonePreference = parsed.tone;
  }
  if (parsed.intent !== undefined && parsed.intent !== originalData.intent.rawText) {
    intentUpdates.intentText = parsed.intent;
  }
  if (parsed.emoji !== undefined && parsed.emoji !== originalData.intent.emoji) {
    intentUpdates.emoji = parsed.emoji;
  }

  if (Object.keys(intentUpdates).length > 0) {
    await client.updateIntent(intentId, intentUpdates);
    changes.push(`intent: updated ${Object.keys(intentUpdates).join(', ')}`);
  }

  // 2. Affirmation sync
  if (parsed.affirmations && parsed.affirmations.length > 0) {
    const syncResult = await client.syncAffirmations(intentId, {
      affirmations: parsed.affirmations.map((a) => ({
        id: a.id,
        text: a.text,
        enabled: a.enabled,
      })),
    });

    const parts: string[] = [];
    if (syncResult.added > 0) parts.push(`${syncResult.added} added`);
    if (syncResult.updated > 0) parts.push(`${syncResult.updated} updated`);
    if (syncResult.removed > 0) parts.push(`${syncResult.removed} removed`);
    if (parts.length > 0) {
      changes.push(`affirmations: ${parts.join(', ')}`);
    }
  }

  // 3. Render config updates
  const hasRenderFields =
    parsed.voice !== undefined ||
    parsed.duration !== undefined ||
    parsed.pace !== undefined ||
    parsed.renderContext !== undefined ||
    parsed.intentContext !== undefined ||
    parsed.background !== undefined ||
    parsed.backgroundVolume !== undefined ||
    parsed.repeats !== undefined ||
    parsed.preamble !== undefined ||
    parsed.playAll !== undefined;

  if (hasRenderFields) {
    if (!originalData.renderConfig) {
      changes.push('render config: skipped (no existing config — run nl_render_configure first)');
    } else {
      const rc = originalData.renderConfig;
      const input: RenderConfigInput = {
        voiceId: parsed.voice ?? rc.voiceId ?? '',
        sessionContext: (parsed.renderContext ?? rc.sessionContext ?? parsed.intentContext ?? 'general') as SessionContext,
        durationMinutes: parsed.duration ?? Math.round(rc.durationSeconds / 60),
      };
      if (parsed.pace !== undefined) input.paceWpm = parsed.pace;
      if (parsed.background !== undefined) input.backgroundAudioPath = parsed.background;
      if (parsed.backgroundVolume !== undefined) input.backgroundVolume = parsed.backgroundVolume;
      if (parsed.repeats !== undefined) input.affirmationRepeatCount = parsed.repeats;
      if (parsed.preamble !== undefined) input.includePreamble = parsed.preamble;
      if (parsed.playAll !== undefined) input.playAll = parsed.playAll;
      await client.configureRender(intentId, input);
      changes.push('render config: updated');
    }
  }

  if (changes.length === 0) {
    return 'No changes detected.';
  }
  return `Applied ${changes.length} change(s):\n${changes.map((c) => `  - ${c}`).join('\n')}`;
}

// ── Server ─────────────────────────────────────────────────────────────────

function buildServer() {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // ── Library & Discovery ────────────────────────────────────────────────

  server.registerTool(
    'nl_library',
    {
      description:
        "List all practice sets in the user's library. Returns title, emoji, context, affirmation count, and render status for each set.",
      inputSchema: {},
    },
    async () =>
      withClient(async (client) => {
        const { items } = await client.getLibrary();
        const summary = items.map((item) => ({
          id: item.intent.id,
          title: item.intent.title,
          emoji: item.intent.emoji,
          context: item.intent.sessionContext,
          affirmationCount: item.latestAffirmationSet?.affirmationCount ?? 0,
          renderStatus: item.latestRenderJob?.status ?? 'none',
          updatedAt: item.intent.updatedAt,
        }));
        return textResult(JSON.stringify(summary, null, 2));
      }),
  );

  server.registerTool(
    'nl_search',
    {
      description:
        'Search practice sets in the library by keyword. Matches against title, emoji, and session context.',
      inputSchema: {
        query: z.string().min(1).describe('Search keyword to match against title, emoji, or context'),
      },
    },
    async ({ query }) =>
      withClient(async (client) => {
        const { items } = await client.getLibrary();
        const q = query.toLowerCase();
        const matches = items.filter(
          (item) =>
            item.intent.title.toLowerCase().includes(q) ||
            (item.intent.emoji ?? '').toLowerCase().includes(q) ||
            item.intent.sessionContext.toLowerCase().includes(q),
        );
        const summary = matches.map((item) => ({
          id: item.intent.id,
          title: item.intent.title,
          emoji: item.intent.emoji,
          context: item.intent.sessionContext,
          affirmationCount: item.latestAffirmationSet?.affirmationCount ?? 0,
          renderStatus: item.latestRenderJob?.status ?? 'none',
        }));
        return textResult(
          matches.length === 0
            ? `No practice sets found matching "${query}".`
            : JSON.stringify(summary, null, 2),
        );
      }),
  );

  server.registerTool(
    'nl_info',
    {
      description:
        'Get detailed information about a practice set, including all affirmations, render config, and share status. Accepts full or short ID.',
      inputSchema: {
        id: z.string().min(1).describe('Practice set ID (full or short prefix)'),
      },
    },
    async ({ id }) =>
      withClient(async (client) => {
        const resolvedId = await resolveIntentId(client, id);
        const { intent } = await client.getIntent(resolvedId);
        if (!intent) {
          return errorResult('Practice set not found. Use nl_library to see available sets.');
        }
        return textResult(JSON.stringify(intent, null, 2));
      }),
  );

  server.registerTool(
    'nl_voices',
    {
      description:
        'List available voices for rendering. Returns voice ID, name, gender, accent, and tier. Voices are used with nl_render_configure.',
      inputSchema: {
        gender: z.string().optional().describe('Filter by gender (e.g. Male, Female)'),
        accent: z.string().optional().describe('Filter by accent (e.g. US, UK, AU)'),
        tier: z.string().optional().describe('Filter by tier (e.g. free, premium)'),
      },
    },
    async ({ gender, accent, tier }) => {
      try {
        // Voices endpoint is public — no auth needed, but use the correct env
        const auth = loadAuth();
        const baseUrl = API_BASE_URLS[auth?.env ?? 'production'];
        const res = await fetch(`${baseUrl}/voices`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { voices: Array<Record<string, unknown>> };
        let voices = data.voices;
        if (gender) {
          const g = gender.toLowerCase();
          voices = voices.filter((v) => String(v['gender'] ?? '').toLowerCase() === g);
        }
        if (accent) {
          const a = accent.toLowerCase();
          voices = voices.filter((v) => String(v['accent'] ?? '').toLowerCase() === a);
        }
        if (tier) {
          const t = tier.toLowerCase();
          voices = voices.filter((v) => String(v['tier'] ?? '').toLowerCase() === t);
        }
        return textResult(JSON.stringify(voices, null, 2));
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── Create & Edit ──────────────────────────────────────────────────────

  server.registerTool(
    'nl_create',
    {
      description:
        'Create a new practice set from intent text. AI generates affirmations based on your intent. Returns the new set with generated affirmations. Costs 1 credit.',
      inputSchema: {
        text: z
          .string()
          .min(1)
          .max(500)
          .describe('Intent text describing what you want to practice (e.g. "I am confident and capable")'),
        tone: toneSchema.describe('Tone preference: grounded (default), open, or mystical'),
      },
    },
    async ({ text, tone }) =>
      withClient(async (client) => {
        const result = await client.createAndGenerate(text, tone);
        return textResult(JSON.stringify(result, null, 2));
      }),
  );

  server.registerTool(
    'nl_rename',
    {
      description:
        'Update the title and/or emoji of a practice set. At least one of title or emoji must be provided.',
      inputSchema: {
        id: z.string().min(1).describe('Practice set ID (full or short prefix)'),
        title: z.string().min(1).max(200).optional().describe('New title'),
        emoji: z.string().nullable().optional().describe('New emoji (or null to clear)'),
      },
    },
    async ({ id, title, emoji }) => {
      if (title === undefined && emoji === undefined) {
        return errorResult('At least one of title or emoji must be provided.');
      }
      return withClient(async (client) => {
        const resolvedId = await resolveIntentId(client, id);
        const input: { title?: string; emoji?: string | null } = {};
        if (title !== undefined) input.title = title;
        if (emoji !== undefined) input.emoji = emoji;
        const result = await client.updateIntent(resolvedId, input);
        return textResult(JSON.stringify(result, null, 2));
      });
    },
  );

  server.registerTool(
    'nl_sync_affirmations',
    {
      description:
        'Declarative edit of affirmations in a practice set. Provide the complete desired list — affirmations not in the list are removed, new ones are added, existing ones are updated. Each affirmation needs text and enabled status. Include id for existing affirmations to preserve them.',
      inputSchema: {
        id: z.string().min(1).describe('Practice set ID (full or short prefix)'),
        affirmations: z
          .array(
            z.object({
              id: z.string().optional().describe('Existing affirmation ID (omit for new)'),
              text: z.string().min(1).describe('Affirmation text'),
              enabled: z.boolean().describe('Whether this affirmation is active'),
            }),
          )
          .min(1)
          .describe('Complete list of desired affirmations'),
      },
    },
    async ({ id, affirmations }) =>
      withClient(async (client) => {
        const resolvedId = await resolveIntentId(client, id);
        const result = await client.syncAffirmations(resolvedId, { affirmations });
        return textResult(
          `Sync complete: ${result.added} added, ${result.updated} updated, ${result.removed} removed.`,
        );
      }),
  );

  server.registerTool(
    'nl_delete',
    {
      description:
        'Delete a practice set permanently. This cannot be undone.',
      inputSchema: {
        id: z.string().min(1).describe('Practice set ID (full or short prefix)'),
      },
    },
    async ({ id }) =>
      withClient(async (client) => {
        const resolvedId = await resolveIntentId(client, id);
        await client.deleteIntent(resolvedId);
        return textResult(`Deleted practice set ${resolvedId}.`);
      }),
  );

  // ── Render & Playback ──────────────────────────────────────────────────

  server.registerTool(
    'nl_render_configure',
    {
      description:
        'Configure render settings for a practice set. Must be done before starting a render. Use nl_voices to find available voice IDs.',
      inputSchema: {
        id: z.string().min(1).describe('Practice set ID (full or short prefix)'),
        voiceId: z.string().min(1).describe('Voice ID to use (from nl_voices)'),
        sessionContext: z
          .enum(['general', 'sleep', 'nap', 'meditation', 'workout', 'focus', 'walk', 'chores'])
          .describe('Session context for pacing and tone'),
        durationMinutes: z.number().int().min(1).max(120).describe('Target duration in minutes'),
        paceWpm: z.number().int().min(90).max(220).optional().describe('Pace in words per minute'),
        backgroundAudioPath: z
          .string()
          .nullable()
          .optional()
          .describe('Background sound storageKey (from nl_voices background list), or null to disable'),
        backgroundVolume: z.number().min(0).max(1).optional().describe('Background volume 0-1'),
        affirmationRepeatCount: z.number().int().min(1).max(5).optional().describe('Times each affirmation repeats'),
        includePreamble: z.boolean().optional().describe('Include intro/outro preamble'),
        playAll: z.boolean().optional().describe('Play all affirmations instead of fitting within duration'),
      },
    },
    async ({ id, voiceId, sessionContext, durationMinutes, paceWpm, backgroundAudioPath, backgroundVolume, affirmationRepeatCount, includePreamble, playAll }) =>
      withClient(async (client) => {
        const resolvedId = await resolveIntentId(client, id);
        const input: RenderConfigInput = { voiceId, sessionContext, durationMinutes };
        if (paceWpm !== undefined) input.paceWpm = paceWpm;
        if (backgroundAudioPath !== undefined) input.backgroundAudioPath = backgroundAudioPath;
        if (backgroundVolume !== undefined) input.backgroundVolume = backgroundVolume;
        if (affirmationRepeatCount !== undefined) input.affirmationRepeatCount = affirmationRepeatCount;
        if (includePreamble !== undefined) input.includePreamble = includePreamble;
        if (playAll !== undefined) input.playAll = playAll;
        const result = await client.configureRender(resolvedId, input);
        return textResult(JSON.stringify(result, null, 2));
      }),
  );

  server.registerTool(
    'nl_render_start',
    {
      description:
        'Start rendering audio for a practice set. The set must have a render config (use nl_render_configure first). Returns a job ID for tracking progress.',
      inputSchema: {
        id: z.string().min(1).describe('Practice set ID (full or short prefix)'),
      },
    },
    async ({ id }) =>
      withClient(async (client) => {
        const resolvedId = await resolveIntentId(client, id);
        const result = await client.startRender(resolvedId);
        return textResult(JSON.stringify(result, null, 2));
      }),
  );

  server.registerTool(
    'nl_render_status',
    {
      description:
        'Check the render progress of a practice set. Returns status (none, queued, processing, completed, failed) and progress percentage.',
      inputSchema: {
        id: z.string().min(1).describe('Practice set ID (full or short prefix)'),
      },
    },
    async ({ id }) =>
      withClient(async (client) => {
        const resolvedId = await resolveIntentId(client, id);
        const result = await client.getRenderStatus(resolvedId);
        return textResult(JSON.stringify(result, null, 2));
      }),
  );

  server.registerTool(
    'nl_rerender',
    {
      description:
        'Re-render a practice set with its current config. Convenience wrapper that starts a new render job.',
      inputSchema: {
        id: z.string().min(1).describe('Practice set ID (full or short prefix)'),
      },
    },
    async ({ id }) =>
      withClient(async (client) => {
        const resolvedId = await resolveIntentId(client, id);
        const result = await client.startRender(resolvedId);
        return textResult(JSON.stringify(result, null, 2));
      }),
  );

  server.registerTool(
    'nl_play',
    {
      description:
        'Download rendered audio for a practice set and return the local file path. The audio must be fully rendered first (status: completed). The file is cached locally for future use.',
      inputSchema: {
        id: z.string().min(1).describe('Practice set ID (full or short prefix)'),
      },
    },
    async ({ id }) =>
      withClient(async (client) => {
        // Find the library item, resolving short IDs with ambiguity check
        const { items } = await client.getLibrary();
        let item = items.find((i) => i.intent.id === id);
        if (!item) {
          const prefixMatches = items.filter((i) => i.intent.id.startsWith(id));
          if (prefixMatches.length === 1) {
            item = prefixMatches[0];
          } else if (prefixMatches.length > 1) {
            throw new Error(
              `Ambiguous ID "${id}" matches ${prefixMatches.length} sets. Use a longer prefix or the full ID.`,
            );
          }
        }
        if (!item) {
          return errorResult('Practice set not found. Use nl_library to see available sets.');
        }
        const renderJob = item.latestRenderJob;
        if (!renderJob?.id) {
          return errorResult('No rendered audio available. Use nl_render_start first.');
        }
        if (renderJob.status !== 'completed') {
          return errorResult(`Render is ${renderJob.status}, not ready to play. Wait for completion.`);
        }

        const cacheFile = join(AUDIO_CACHE_DIR, `${renderJob.id}.mp3`);
        if (existsSync(cacheFile)) {
          return textResult(JSON.stringify({ path: cacheFile, cached: true }, null, 2));
        }

        const audio = await client.getAudio(renderJob.id);
        mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
        writeFileSync(cacheFile, audio);

        return textResult(JSON.stringify({ path: cacheFile, cached: false }, null, 2));
      }),
  );

  // ── Sharing & Settings ─────────────────────────────────────────────────

  server.registerTool(
    'nl_share',
    {
      description:
        'Generate a public share link for a practice set. Anyone with the link can view and copy it.',
      inputSchema: {
        id: z.string().min(1).describe('Practice set ID (full or short prefix)'),
      },
    },
    async ({ id }) =>
      withClient(async (client) => {
        const resolvedId = await resolveIntentId(client, id);
        const result = await client.shareIntent(resolvedId);
        return textResult(JSON.stringify(result, null, 2));
      }),
  );

  server.registerTool(
    'nl_unshare',
    {
      description:
        'Revoke the share link for a practice set. The link will no longer work.',
      inputSchema: {
        id: z.string().min(1).describe('Practice set ID (full or short prefix)'),
      },
    },
    async ({ id }) =>
      withClient(async (client) => {
        const resolvedId = await resolveIntentId(client, id);
        await client.unshareIntent(resolvedId);
        return textResult(`Share link revoked for ${resolvedId}.`);
      }),
  );

  server.registerTool(
    'nl_credits',
    {
      description:
        'Check the current credit balance. Shows subscription credits, purchased credits, and total available.',
      inputSchema: {},
    },
    async () =>
      withClient(async (client) => {
        const { user } = await client.getMe();
        return textResult(
          JSON.stringify(
            {
              creditBalance: user.creditBalance,
              subscriptionCredits: user.subscriptionCredits,
              purchasedCredits: user.purchasedCredits,
              creditsResetAt: user.creditsResetAt,
              subscriptionTier: user.subscriptionTier,
              subscriptionStatus: user.subscriptionStatus,
            },
            null,
            2,
          ),
        );
      }),
  );

  // ── YAML Set Files ─────────────────────────────────────────────────────

  server.registerTool(
    'nl_set_export',
    {
      description:
        'Export a practice set as a YAML string. Includes title, emoji, intent text, affirmations, and render config. The YAML can be edited and re-imported with nl_set_import.',
      inputSchema: {
        id: z.string().min(1).describe('Practice set ID (full or short prefix)'),
      },
    },
    async ({ id }) =>
      withClient(async (client) => {
        const resolvedId = await resolveIntentId(client, id);
        const data = await fetchSetFileData(client, resolvedId);
        const yaml = serializeSetFile(data);
        return textResult(yaml);
      }),
  );

  server.registerTool(
    'nl_set_import',
    {
      description:
        'Apply a YAML set file to an existing practice set. Updates title, emoji, affirmations, and render config based on the YAML content. Use nl_set_export to get the current YAML first, edit it, then import.',
      inputSchema: {
        id: z.string().min(1).describe('Practice set ID (full or short prefix)'),
        yaml: z.string().min(1).describe('YAML content to apply (from nl_set_export, edited)'),
      },
    },
    async ({ id, yaml }) =>
      withClient(async (client) => {
        const resolvedId = await resolveIntentId(client, id);
        const originalData = await fetchSetFileData(client, resolvedId);
        const result = await applySetFile(client, resolvedId, yaml, originalData);
        return textResult(result);
      }),
  );

  return server;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
