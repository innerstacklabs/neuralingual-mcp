#!/usr/bin/env node
/**
 * Neuralingual User MCP Server (manifest-driven)
 *
 * Registers user-facing MCP tools by iterating tool-manifest.json.
 * The manifest is the single source of truth for tool names, descriptions,
 * and parameter schemas. Handler logic lives in CUSTOM_HANDLERS below.
 *
 * Handler types:
 * - "client-method": generic pass-through to UserApiClient methods
 * - "custom": tool-specific logic defined in CUSTOM_HANDLERS
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { UserApiClient } from './user-client.js';
import { loadAuth } from './auth-store.js';
import { serializeSetFile, parseSetFile } from './set-file.js';
import { jsonSchemaToInputSchema, type JsonSchema } from './json-schema-to-zod.js';
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
import manifest from './tool-manifest.json' with { type: 'json' };

const SERVER_NAME = 'neuralingual';
const SERVER_VERSION = '0.2.0';

const AUDIO_CACHE_DIR = join(homedir(), '.config', 'neuralingual', 'audio');

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
        repetitionModel: latestConfig.repetitionModel ?? 'weighted_shuffle',
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
        sessionContext: (parsed.renderContext ?? parsed.intentContext ?? rc.sessionContext ?? 'general') as SessionContext,
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

// ── Custom Handlers ───────────────────────────────────────────────────────
// These tools have non-trivial client-side logic that can't be expressed
// as a simple "call client method, return JSON" pass-through.

type CustomHandlerFn = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}>;

export const CUSTOM_HANDLERS: Record<string, CustomHandlerFn> = {
  library: async () =>
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

  info: async (params) =>
    withClient(async (client) => {
      const resolvedId = await resolveIntentId(client, params['id'] as string);
      const { intent } = await client.getIntent(resolvedId);
      if (!intent) {
        return errorResult('Practice set not found. Use nl_library to see available sets.');
      }
      return textResult(JSON.stringify(intent, null, 2));
    }),

  search: async (params) =>
    withClient(async (client) => {
      const query = params['query'] as string;
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

  voices: async (params) => {
    try {
      // Voices endpoint is public — no auth needed, but use the correct env
      const auth = loadAuth();
      const baseUrl = API_BASE_URLS[auth?.env ?? 'production'];
      const res = await fetch(`${baseUrl}/voices`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { voices: Array<Record<string, unknown>> };
      let voices = data.voices;
      const gender = params['gender'] as string | undefined;
      const accent = params['accent'] as string | undefined;
      const tier = params['tier'] as string | undefined;
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

  create: async (params) =>
    withClient(async (client) => {
      const text = params['text'] as string;
      const tone = params['tone'] as string | undefined;
      const result = await client.createAndGenerate(text, tone);
      return textResult(JSON.stringify(result, null, 2));
    }),

  rename: async (params) => {
    const title = params['title'] as string | undefined;
    const emoji = params['emoji'] as string | null | undefined;
    if (title === undefined && emoji === undefined) {
      return errorResult('At least one of title or emoji must be provided.');
    }
    return withClient(async (client) => {
      const resolvedId = await resolveIntentId(client, params['id'] as string);
      const input: { title?: string; emoji?: string | null } = {};
      if (title !== undefined) input.title = title;
      if (emoji !== undefined) input.emoji = emoji;
      const result = await client.updateIntent(resolvedId, input);
      return textResult(JSON.stringify(result, null, 2));
    });
  },

  syncAffirmations: async (params) =>
    withClient(async (client) => {
      const resolvedId = await resolveIntentId(client, params['id'] as string);
      const affirmations = params['affirmations'] as Array<{
        id?: string;
        text: string;
        enabled: boolean;
      }>;
      const result = await client.syncAffirmations(resolvedId, { affirmations });
      return textResult(
        `Sync complete: ${result.added} added, ${result.updated} updated, ${result.removed} removed.`,
      );
    }),

  renderConfigure: async (params) =>
    withClient(async (client) => {
      const resolvedId = await resolveIntentId(client, params['id'] as string);
      const input: RenderConfigInput = {
        voiceId: params['voiceId'] as string,
        sessionContext: params['sessionContext'] as SessionContext,
        durationMinutes: params['durationMinutes'] as number,
      };
      if (params['paceWpm'] !== undefined) input.paceWpm = params['paceWpm'] as number;
      if (params['backgroundAudioPath'] !== undefined) input.backgroundAudioPath = params['backgroundAudioPath'] as string | null;
      if (params['backgroundVolume'] !== undefined) input.backgroundVolume = params['backgroundVolume'] as number;
      if (params['affirmationRepeatCount'] !== undefined) input.affirmationRepeatCount = params['affirmationRepeatCount'] as number;
      if (params['includePreamble'] !== undefined) input.includePreamble = params['includePreamble'] as boolean;
      if (params['playAll'] !== undefined) input.playAll = params['playAll'] as boolean;
      const result = await client.configureRender(resolvedId, input);
      return textResult(JSON.stringify(result, null, 2));
    }),

  play: async (params) =>
    withClient(async (client) => {
      const id = params['id'] as string;
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

  credits: async () =>
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

  setExport: async (params) =>
    withClient(async (client) => {
      const resolvedId = await resolveIntentId(client, params['id'] as string);
      const data = await fetchSetFileData(client, resolvedId);
      const yaml = serializeSetFile(data);
      return textResult(yaml);
    }),

  setImport: async (params) =>
    withClient(async (client) => {
      const resolvedId = await resolveIntentId(client, params['id'] as string);
      const originalData = await fetchSetFileData(client, resolvedId);
      const result = await applySetFile(client, resolvedId, params['yaml'] as string, originalData);
      return textResult(result);
    }),
};

// ── Manifest types ────────────────────────────────────────────────────────

interface EndpointDef {
  method: string;
  path: string;
  auth: string;
  note?: string;
}

interface ToolManifestEntry {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  endpoint: EndpointDef;
  handler:
    | {
        type: 'client-method';
        clientMethod: string;
        resolveId: boolean;
        responseFormat: 'json' | 'void';
        successMessage?: string;
      }
    | {
        type: 'custom';
        customHandler: string;
      };
}

interface ToolManifest {
  tools: ToolManifestEntry[];
}

// ── Server Builder ────────────────────────────────────────────────────────

export function buildUserServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const tools = (manifest as unknown as ToolManifest).tools;

  for (const tool of tools) {
    const inputSchema = jsonSchemaToInputSchema(tool.parameters as JsonSchema);

    if (tool.handler.type === 'custom') {
      const handlerFn = CUSTOM_HANDLERS[tool.handler.customHandler];
      if (!handlerFn) {
        throw new Error(
          `Missing custom handler "${tool.handler.customHandler}" for tool "${tool.name}"`,
        );
      }

      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema },
        async (params: Record<string, unknown>) => handlerFn(params),
      );
    } else {
      // client-method: generic pass-through
      const { clientMethod, resolveId, responseFormat, successMessage } = tool.handler;

      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema },
        async (params: Record<string, unknown>) =>
          withClient(async (client) => {
            let id = params['id'] as string | undefined;

            if (resolveId && id) {
              id = await resolveIntentId(client, id);
            }

            // Call the client method with the resolved ID
            const method = client[clientMethod as keyof UserApiClient] as (
              ...args: unknown[]
            ) => Promise<unknown>;

            let result: unknown;
            if (id) {
              result = await method.call(client, id);
            } else {
              result = await method.call(client);
            }

            if (responseFormat === 'void') {
              const msg = successMessage
                ? successMessage.replace('{id}', id ?? '')
                : 'Done.';
              return textResult(msg);
            }

            return textResult(JSON.stringify(result, null, 2));
          }),
      );
    }
  }

  return server;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const server = buildUserServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run when executed directly (not when imported in tests)
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/user-mcp.js');

if (isMainModule) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
