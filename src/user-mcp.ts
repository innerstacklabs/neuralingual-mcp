#!/usr/bin/env node
/**
 * Neuralingual User MCP Server (manifest-driven)
 *
 * Registers user-facing MCP tools by iterating tool-manifest.json.
 * This is the single source of truth for tool definitions — the public
 * repo (neuralingual-mcp) will consume this manifest in Phase 2.
 *
 * Handlers use tool-specific logic defined in CUSTOM_HANDLERS.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { UserApiClient, deriveTitleFromText } from './user-client.js';
import {
  nlCoachViewResultSchema,
  nlCoachesResultSchema,
  nlPlaylistDeleteResultSchema,
  nlRenderStartResultSchema,
  nlRenderStatusResultSchema,
  nlShareResultSchema,
  nlUnshareResultSchema,
  renderJobStatusEnum,
  renderStatusApiSchema,
  shareIntentApiSchema,
  startRenderApiSchema,
  toMcpOutputSchema,
  toMcpToolError,
  typedToolResult,
  type McpToolError,
} from './mcp-tool-result.js';
import { loadAuth } from './auth-store.js';
import { buildRenderInputFromSetFile, hasRenderSettings, serializeSetFile, parseSetFile } from './set-file.js';
import { jsonSchemaToInputSchema, type JsonSchema } from './json-schema-to-zod.js';
import {
  renderFrameworkMarkdown,
  extractFrameworkSchemaVersion,
  extractFrameworkTakeaway,
  hasFramework,
} from './framework-render.js';
import { API_BASE_URLS, DEFAULT_USER_INTENT_VOICE_PERSPECTIVE } from './types.js';
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

// Read version from package.json at runtime so it can't drift from the
// published version.  Works in both the monorepo (packages/mcp) and the
// public repo (neuralingual-mcp) because each has its own package.json.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_VERSION: string = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
).version;

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
    return errorResult(toMcpToolError(err).message);
  }
}

export async function withTypedClient<T>(
  fn: (client: UserApiClient) => Promise<T>,
): Promise<T | McpToolError> {
  try {
    return await fn(getClient());
  } catch (err: unknown) {
    return toMcpToolError(err);
  }
}

function isMcpToolError(result: unknown): result is McpToolError {
  return (
    typeof result === 'object' &&
    result !== null &&
    'kind' in result &&
    result.kind === 'error'
  );
}

/**
 * Resolve an intent to its latest affirmation set and validate that
 * all provided affirmation IDs belong to it. Returns the set ID and
 * validated IDs, or an error result for early return.
 */
async function resolveSetAndValidateAffirmations(
  client: UserApiClient,
  intentIdOrPrefix: string,
  affirmationIds: string[],
): Promise<
  | { ok: true; setId: string }
  | { ok: false; error: ReturnType<typeof errorResult> }
> {
  const resolvedId = await resolveIntentId(client, intentIdOrPrefix);
  const { intent } = await client.getIntent(resolvedId);
  if (!intent) {
    return { ok: false, error: errorResult('Playlist not found.') };
  }
  const latestSet = intent.affirmationSets[0];
  if (!latestSet) {
    return { ok: false, error: errorResult('No affirmation set found for this playlist.') };
  }

  const setAffIds = new Set(latestSet.affirmations.map((a) => a.id));
  const invalidIds = affirmationIds.filter((id) => !setAffIds.has(id));
  if (invalidIds.length > 0) {
    return {
      ok: false,
      error: errorResult(
        `Affirmation IDs not found in this playlist: ${invalidIds.join(', ')}. Use nl_playlist_view to see affirmation IDs.`,
      ),
    };
  }

  return { ok: true, setId: latestSet.id };
}

/**
 * Resolve an intent to its latest affirmation set ID. Simpler than
 * resolveSetAndValidateAffirmations when no affirmation validation is needed.
 */
async function resolveLatestSetId(
  client: UserApiClient,
  intentIdOrPrefix: string,
): Promise<
  | { ok: true; intentId: string; setId: string }
  | { ok: false; error: ReturnType<typeof errorResult> }
> {
  const resolvedId = await resolveIntentId(client, intentIdOrPrefix);
  const { intent } = await client.getIntent(resolvedId);
  if (!intent) {
    return { ok: false, error: errorResult('Playlist not found.') };
  }
  const latestSet = intent.affirmationSets[0];
  if (!latestSet) {
    return { ok: false, error: errorResult('No affirmation set found for this playlist.') };
  }
  return { ok: true, intentId: resolvedId, setId: latestSet.id };
}

/**
 * Resolve a short/truncated intent ID to the full ID via library lookup.
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

  throw new Error('Playlist not found. Use nl_playlist_list to see available sets.');
}

/**
 * Fetch set file data for YAML export. Also returns the raw framework JSON
 * from the latest affirmation set so callers that need both (e.g.
 * `setExport` with `withFramework: true`) don't re-fetch the intent.
 */
async function fetchSetFileData(
  client: UserApiClient,
  intentId: string,
): Promise<{ data: SetFileData; framework: unknown }> {
  const { intent } = await client.getIntent(intentId);
  if (!intent) {
    throw new Error('Playlist not found. Use nl_playlist_list to see available sets.');
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
        pauseMsBetweenAffirmations: latestConfig.pauseMsBetweenAffirmations,
        durationSeconds: latestConfig.durationSeconds,
        backgroundAudioPath: latestConfig.backgroundAudioPath,
        backgroundVolume: latestConfig.backgroundVolume,
        normalizeLoudness: latestConfig.normalizeLoudness,
        affirmationRepeatCount: latestConfig.affirmationRepeatCount,
        includePreamble: latestConfig.includePreamble,
        playAll: latestConfig.playAll,
        repetitionModel: latestConfig.repetitionModel ?? 'shuffle',
        binauralPreset: latestConfig.binauralPreset ?? null,
        binauralVolume: latestConfig.binauralVolume ?? null,
        subliminalEnabled: latestConfig.subliminalEnabled ?? false,
        subliminalVolume: latestConfig.subliminalVolume ?? null,
        preambleText: latestConfig.preambleText,
        postambleText: latestConfig.postambleText,
        createdAt: latestConfig.createdAt,
        updatedAt: latestConfig.updatedAt,
      }
    : null;

  // User intents don't have catalog fields or voicePerspective on this DTO — default them.
  const mappedIntent: Intent = {
    id: intent.id,
    userId: '',
    title: intent.title,
    emoji: intent.emoji,
    rawText: intent.rawText,
    tonePreference: (intent.tonePreference as TonePreference) ?? null,
    sessionContext: intent.sessionContext as SessionContext,
    voicePerspective: DEFAULT_USER_INTENT_VOICE_PERSPECTIVE,
    isCatalog: false,
    catalogSlug: null,
    catalogCategory: null,
    catalogDescription: null,
    catalogOrder: null,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
    archivedAt: null,
  };

  const framework = latestSet?.framework ?? null;
  return { data: { intent: mappedIntent, affirmations, renderConfig }, framework };
}

/**
 * Apply a YAML set file to an existing playlist.
 */
async function applySetFile(
  client: UserApiClient,
  intentId: string,
  content: string,
  originalData: SetFileData,
): Promise<string> {
  const parsed = parseSetFile(content);
  const changes: string[] = [];

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

  if (hasRenderSettings(parsed)) {
    if (!originalData.renderConfig) {
      changes.push('render config: skipped (no existing config — run nl_render_configure first)');
    } else {
      const rc = originalData.renderConfig;
      await client.configureRender(intentId, buildRenderInputFromSetFile(parsed, rc));
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
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

/**
 * Shared "the API responded but not in the shape we validate against" error.
 * Used by every custom handler that safeParses a raw API response before
 * building its success branch.
 */
function invalidResponseError(message: string): {
  kind: 'error';
  code: 'invalid_response';
  message: string;
  status: null;
  retryable: false;
} {
  return { kind: 'error', code: 'invalid_response', message, status: null, retryable: false };
}

// ── Tool argument schemas (nl#178) ────────────────────────────────────────
// One typed zod schema per custom handler, parsed once at the top of the
// handler. Each mirrors the tool's `parameters` entry in tool-manifest.json
// as `buildUserServer` turns it into zod via `jsonSchemaToInputSchema`: the
// same types, enums, string lengths, number bounds and `minItems`, and the
// same required set. That converter does not apply `format` or `maxItems`,
// so neither do these schemas: the SDK already checks every argument against
// the converted schema before a handler runs, and a schema stricter than that
// would change what a client sees. `user-mcp-args.test.ts` pins both facts.
// Unknown keys are stripped, as they are on the wire.

const playlistIdArgs = z.object({ id: z.string().min(1) });
const sessionContextSchema = z.enum([
  'general',
  'sleep',
  'nap',
  'meditation',
  'workout',
  'focus',
  'walk',
  'chores',
]);

// The coach roster comes from tool-manifest.json, the one generated copy of it the
// public package may hold (see CoachDto in types.ts; #183). This file is synced as-is
// to the public repo, which cannot resolve a workspace package (#194), and
// scripts/gen-coaches.test.ts forbids a second literal z.enum over coach keys.
function manifestCoachKeys(): [string, ...string[]] {
  const tool = (manifest as ToolManifest).tools.find((t) => t.name === 'nl_playlist_create');
  const coachKey = tool?.parameters.properties?.['coachKey'] as { enum?: unknown } | undefined;
  const keys = coachKey?.enum;
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === 'string')) {
    throw new Error('tool-manifest.json: nl_playlist_create.coachKey has no string enum');
  }
  return keys as [string, ...string[]];
}
const coachKeySchema = z.enum(manifestCoachKeys());

const searchArgs = z.object({ query: z.string().min(1) });

const voicesArgs = z.object({
  gender: z.string().optional(),
  accent: z.string().optional(),
  tier: z.string().optional(),
});

const createArgs = z.object({
  text: z.string().min(1).max(500).optional(),
  title: z.string().min(1).max(120).optional(),
  tone: z.enum(['grounded', 'open', 'mystical']).optional(),
  sourceText: z.string().min(1).max(16000).optional(),
  sourceTitle: z.string().max(200).optional(),
  sourceAuthor: z.string().max(200).optional(),
  sourceUrl: z.string().optional(),
  sourcePdf: z.string().optional(),
  sourceYoutube: z.string().optional(),
  style: coachKeySchema.optional(),
  styleNotes: z.record(z.string(), z.unknown()).optional(),
  coachKey: coachKeySchema.optional(),
  affirmations: z.array(z.string().min(1).max(240)).min(1).optional(),
  voicePerspective: z.enum(['first_person', 'second_person']).optional(),
});

const syncAffirmationsArgs = z.object({
  id: z.string().min(1),
  affirmations: z
    .array(
      z.object({
        id: z.string().optional(),
        text: z.string().min(1),
        enabled: z.boolean(),
      }),
    )
    .min(1),
});

const renderConfigureArgs = z.object({
  id: z.string().min(1),
  voiceId: z.string().min(1),
  sessionContext: sessionContextSchema,
  durationMinutes: z.number().int().min(1).max(120),
  paceWpm: z.number().int().min(90).max(220).optional(),
  backgroundAudioPath: z.string().nullable().optional(),
  backgroundVolume: z.number().min(0).max(1).optional(),
  affirmationRepeatCount: z.number().int().min(1).max(5).optional(),
  includePreamble: z.boolean().optional(),
  playAll: z.boolean().optional(),
});

const setExportArgs = z.object({
  id: z.string().min(1),
  withFramework: z.boolean().optional(),
});

const setImportArgs = z.object({
  id: z.string().min(1),
  yaml: z.string().min(1),
});

const userSetUsernameArgs = z.object({ username: z.string().min(3).max(30) });

const userCheckUsernameArgs = z.object({ username: z.string().min(1) });

const catalogBrowseArgs = z.object({
  category: z.string().optional(),
  context: sessionContextSchema.optional(),
  sort: z.enum(['recent', 'created', 'most-played', 'last-played', 'title']).optional(),
  filter: z.enum(['has-audio', 'no-audio', 'never-played']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

const catalogSlugArgs = z.object({ slug: z.string().min(1) });

/**
 * Argument schema of each handler converted so far, keyed by the manifest's
 * `customHandler` name. `user-mcp-args.test.ts` compares every entry with its
 * manifest entry.
 */
export const USER_MCP_ARG_SCHEMAS = {
  renderStart: playlistIdArgs,
  rerender: playlistIdArgs,
  guide: playlistIdArgs,
  search: searchArgs,
  voices: voicesArgs,
  create: createArgs,
  syncAffirmations: syncAffirmationsArgs,
  renderConfigure: renderConfigureArgs,
  play: playlistIdArgs,
  setExport: setExportArgs,
  setImport: setImportArgs,
  userSetUsername: userSetUsernameArgs,
  userCheckUsername: userCheckUsernameArgs,
  catalogBrowse: catalogBrowseArgs,
  catalogView: catalogSlugArgs,
  catalogCopy: catalogSlugArgs,
  libraryView: playlistIdArgs,
} as const;

type CustomHandlerResult = Awaited<ReturnType<CustomHandlerFn>>;

/**
 * Parse a handler's argument bag once. A failure becomes the canonical tool
 * error (`kind: 'error'`, the `McpErrorShape` fields from mcp-error.ts), so a
 * direct caller that bypasses the SDK gets an error result instead of a value
 * used as the wrong type.
 */
function parseToolArgs<S extends z.ZodType>(
  schema: S,
  params: Record<string, unknown>,
): { ok: true; args: z.output<S> } | { ok: false; result: CustomHandlerResult } {
  const parsed = schema.safeParse(params);
  if (parsed.success) return { ok: true, args: parsed.data };
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(arguments)'}: ${issue.message}`)
    .join('; ');
  const message = `Invalid arguments: ${detail}`;
  const error: McpToolError = {
    kind: 'error',
    code: 'validation',
    message,
    status: null,
    retryable: false,
  };
  return { ok: false, result: typedToolResult(error, message) };
}

// Shared by the `renderStart` and `rerender` CUSTOM_HANDLERS entries — both
// tools start a render the same way; `nl_rerender` is just the retry-facing
// name for the same operation.
const startRenderHandler: CustomHandlerFn = async (params) => {
  const parsedArgs = parseToolArgs(playlistIdArgs, params);
  if (!parsedArgs.ok) return parsedArgs.result;
  const { id } = parsedArgs.args;
  const result = await withTypedClient(async (client) => {
    const resolvedId = await resolveIntentId(client, id);
    return client.startRender(resolvedId);
  });
  if (isMcpToolError(result)) {
    return typedToolResult(result, result.message);
  }

  const parsed = startRenderApiSchema.safeParse(result);
  if (!parsed.success) {
    const message = 'Render start response did not match the expected shape.';
    return typedToolResult(invalidResponseError(message), message);
  }

  const output = { kind: 'ok' as const, ...parsed.data };
  return typedToolResult(output, JSON.stringify(output, null, 2));
};

/**
 * The settings `PUT /setting-preferences` accepts (core's `CONTEXT_CASCADE_SETTINGS`).
 * Spelled out here because the public package cannot import core (#194);
 * `tool-manifest.test.ts` asserts this list equals core's constant in the monorepo.
 * The route refuses the other eight settings and `global` scope — this tool never widens that.
 */
export const SETTING_PREFERENCE_SAVE_SETTINGS = [
  'durationMinutes',
  'repeatCount',
  'paceWpm',
  'pauseMs',
] as const;

export const CUSTOM_HANDLERS: Record<string, CustomHandlerFn> = {
  guide: async (params) => {
    const parsedArgs = parseToolArgs(playlistIdArgs, params);
    if (!parsedArgs.ok) return parsedArgs.result;
    const { id } = parsedArgs.args;
    return withClient(async (client) => {
      const resolvedId = await resolveIntentId(client, id);
      const { intent } = await client.getIntent(resolvedId);
      if (!intent) {
        return errorResult('Playlist not found. Use nl_playlist_list to see available sets.');
      }
      const latestSet = intent.affirmationSets[0];
      const framework = latestSet?.framework ?? null;
      return textResult(renderFrameworkMarkdown(framework));
    });
  },

  search: async (params) => {
    const parsedArgs = parseToolArgs(searchArgs, params);
    if (!parsedArgs.ok) return parsedArgs.result;
    const { query } = parsedArgs.args;
    return withClient(async (client) => {
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
          ? `No playlists found matching "${query}".`
          : JSON.stringify(summary, null, 2),
      );
    });
  },

  voices: async (params) => {
    const parsedArgs = parseToolArgs(voicesArgs, params);
    if (!parsedArgs.ok) return parsedArgs.result;
    const { gender, accent, tier } = parsedArgs.args;
    try {
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

  create: async (params) => {
    // Argument validation runs BEFORE client acquisition. `withClient` resolves
    // auth first, so a guard placed inside it reports "Not logged in" for what
    // is actually a missing-argument error — misleading, and it made the test
    // for this guard pass only on machines that happen to have auth.json
    // (green locally, red in clean CI).
    const parsedArgs = parseToolArgs(createArgs, params);
    if (!parsedArgs.ok) return parsedArgs.result;
    const {
      text,
      tone,
      sourceText,
      sourceUrl,
      sourcePdf,
      sourceYoutube,
      sourceTitle,
      sourceAuthor,
      // #3062 — Optional rhetorical-style steering: a named preset and/or
      // free-form dials. Resolved + validated server-side (unknown preset,
      // over-bounds, or injection → 400).
      style,
      styleNotes,
      // #3111 — Optional per-generation coach override. Resolved tolerantly
      // server-side (unknown/stale → falls back to the user's last-used coach,
      // no error). nl#304: a generation stamps that coach as last-used, so there
      // is no separate "set as default" knob to pass.
      coachKey,
      // #40 — Optional affirmations[]: create the playlist directly from
      // user-authored affirmations, skipping generation and the credit
      // charge entirely (nl_playlist_create).
      // Consistent with style/styleNotes/coachKey (all generation-only
      // knobs), any source* params are simply IGNORED here
      // rather than rejected — a caller may legitimately pass along the
      // source it drew affirmations from for context without wanting
      // generation to run against it.
      affirmations,
      title,
      voicePerspective,
    } = parsedArgs.args;
    if (affirmations && affirmations.length > 0 && !text) {
      return errorResult('Please provide text (the playlist intent) when creating from affirmations.');
    }
    return withClient(async (client) => {
      if (affirmations && affirmations.length > 0) {
        // Unreachable in practice — the same condition is checked before
        // withClient above (so a missing arg isn't reported as an auth
        // error). Retained for type narrowing and defence in depth.
        if (!text) {
          return errorResult('Please provide text (the playlist intent) when creating from affirmations.');
        }
        // #44 — voicePerspective was silently defaulting to first_person on the
        // manual path: createManualIntentInputSchema accepts it, but this call
        // never passed it, and there was no tool param to set it. A coach
        // authoring second-person affirmations ("You train from love") got them
        // stored as first_person. Generation-path defaults do not apply here.
        const result = await client.createManualIntent({
          title: title ?? deriveTitleFromText(text),
          rawText: text,
          tonePreference: tone ?? null,
          ...(voicePerspective ? { voicePerspective } : {}),
          affirmations: affirmations.map((a) => ({ text: a })),
        });
        return textResult(JSON.stringify(result, null, 2));
      }

      if (!text && !sourceText && !sourceUrl && !sourcePdf && !sourceYoutube) {
        return errorResult('Please provide intent text, source material (sourceText, sourceUrl, sourcePdf, or sourceYoutube), affirmations, or a combination.');
      }

      const sourceFlags = [sourceText, sourceUrl, sourcePdf, sourceYoutube].filter(Boolean);
      if (sourceFlags.length > 1) {
        return errorResult('sourceText, sourceUrl, sourcePdf, and sourceYoutube are mutually exclusive. Use one at a time.');
      }

      // #999 — PDF source: file path or base64-encoded content
      let pdfExtractedText: string | undefined;
      if (sourcePdf) {
        let buffer: Buffer;

        // Detect base64 vs file path: base64-encoded PDFs always start
        // with "JVBER" (base64 of "%PDF-"). Anything else is a file path.
        const isBase64Pdf = sourcePdf.startsWith('JVBER');
        if (!isBase64Pdf) {
          const { readFileSync, existsSync } = await import('node:fs');
          if (!existsSync(sourcePdf)) {
            return errorResult(`File not found: ${sourcePdf}`);
          }
          buffer = readFileSync(sourcePdf);
        } else {
          // Base64-encoded PDF content
          try {
            buffer = Buffer.from(sourcePdf, 'base64');
          } catch {
            return errorResult('Invalid sourcePdf: expected a file path or base64-encoded PDF content.');
          }
          if (buffer.length === 0) {
            return errorResult('Invalid sourcePdf: base64 content decoded to empty buffer.');
          }
        }

        if (buffer.length > 10 * 1024 * 1024) {
          return errorResult('PDF file is too large. Maximum size is 10 MB.');
        }
        const preview = await client.uploadPdf(buffer);
        pdfExtractedText = preview.text;
      }

      const source: { type: string; text?: string; url?: string; title?: string; author?: string } | undefined =
        sourceText
          ? {
              type: 'text' as const,
              text: sourceText,
              ...(sourceTitle ? { title: sourceTitle } : {}),
              ...(sourceAuthor ? { author: sourceAuthor } : {}),
            }
          : sourceUrl
            ? {
                type: 'url' as const,
                url: sourceUrl,
                ...(sourceTitle ? { title: sourceTitle } : {}),
                ...(sourceAuthor ? { author: sourceAuthor } : {}),
              }
            : sourceYoutube
              ? {
                  type: 'youtube' as const,
                  url: sourceYoutube,
                  ...(sourceTitle ? { title: sourceTitle } : {}),
                  ...(sourceAuthor ? { author: sourceAuthor } : {}),
                }
              : pdfExtractedText
                ? {
                    type: 'pdf' as const,
                    text: pdfExtractedText,
                    ...(sourceTitle ? { title: sourceTitle } : {}),
                    ...(sourceAuthor ? { author: sourceAuthor } : {}),
                  }
                : undefined;

      // #1001 — Fetch YouTube preview metadata and include in result
      let youtubePreview: { title: string; channelName: string | null; charCount: number; truncated: boolean } | undefined;
      if (source?.type === 'youtube' && source.url) {
        try {
          const preview = await client.extractYoutubePreview(source.url);
          youtubePreview = {
            title: preview.title,
            channelName: preview.channelName,
            charCount: preview.charCount,
            truncated: preview.truncated,
          };
        } catch {
          // Preview failure is non-fatal — generation will still extract
        }
      }

      const result = await client.createAndGenerate(text, tone, source, style, styleNotes, coachKey);
      const output = youtubePreview
        ? { ...result, youtubePreview }
        : result;
      return textResult(JSON.stringify(output, null, 2));
    });
  },

  syncAffirmations: async (params) => {
    const parsedArgs = parseToolArgs(syncAffirmationsArgs, params);
    if (!parsedArgs.ok) return parsedArgs.result;
    const { id, affirmations } = parsedArgs.args;
    return withClient(async (client) => {
      const resolvedId = await resolveIntentId(client, id);
      const result = await client.syncAffirmations(resolvedId, { affirmations });
      return textResult(
        `Sync complete: ${result.added} added, ${result.updated} updated, ${result.removed} removed.`,
      );
    });
  },

  renderConfigure: async (params) => {
    const parsedArgs = parseToolArgs(renderConfigureArgs, params);
    if (!parsedArgs.ok) return parsedArgs.result;
    const args = parsedArgs.args;
    return withClient(async (client) => {
      const resolvedId = await resolveIntentId(client, args.id);
      const input: RenderConfigInput = {
        voiceId: args.voiceId,
        sessionContext: args.sessionContext,
        durationMinutes: args.durationMinutes,
      };
      if (args.paceWpm !== undefined) input.paceWpm = args.paceWpm;
      if (args.backgroundAudioPath !== undefined) input.backgroundAudioPath = args.backgroundAudioPath;
      if (args.backgroundVolume !== undefined) input.backgroundVolume = args.backgroundVolume;
      if (args.affirmationRepeatCount !== undefined) input.affirmationRepeatCount = args.affirmationRepeatCount;
      if (args.includePreamble !== undefined) input.includePreamble = args.includePreamble;
      if (args.playAll !== undefined) input.playAll = args.playAll;
      const result = await client.configureRender(resolvedId, input);
      return textResult(JSON.stringify(result, null, 2));
    });
  },

  play: async (params) => {
    const parsedArgs = parseToolArgs(playlistIdArgs, params);
    if (!parsedArgs.ok) return parsedArgs.result;
    const { id } = parsedArgs.args;
    return withClient(async (client) => {
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
        return errorResult('Playlist not found. Use nl_playlist_list to see available sets.');
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
    });
  },

  credits: async () =>
    withClient(async (client) => {
      const { user } = await client.getMe();
      return textResult(
        JSON.stringify(
          {
            username: user.username,
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

  setExport: async (params) => {
    const parsedArgs = parseToolArgs(setExportArgs, params);
    if (!parsedArgs.ok) return parsedArgs.result;
    const { id, withFramework } = parsedArgs.args;
    return withClient(async (client) => {
      const resolvedId = await resolveIntentId(client, id);
      const { data, framework } = await fetchSetFileData(client, resolvedId);
      const yaml = serializeSetFile(data);

      if (!withFramework) {
        return textResult(yaml);
      }

      // Prepend framework markdown before the YAML body. Blank-line separator
      // (no standalone `---`) avoids colliding with YAML's document-start
      // marker. The combined output is NOT re-importable via nl_playlist_import
      // — that's documented in the tool description.
      const markdown = renderFrameworkMarkdown(framework);
      return textResult(`${markdown}\n${yaml}`);
    });
  },

  setImport: async (params) => {
    const parsedArgs = parseToolArgs(setImportArgs, params);
    if (!parsedArgs.ok) return parsedArgs.result;
    const { id, yaml } = parsedArgs.args;
    return withClient(async (client) => {
      const resolvedId = await resolveIntentId(client, id);
      const { data: originalData } = await fetchSetFileData(client, resolvedId);
      const result = await applySetFile(client, resolvedId, yaml, originalData);
      return textResult(result);
    });
  },

  // ── Username tools (#2138) ──────────────────────────────────────────

  userProfile: async () =>
    withClient(async (client) => {
      const { user } = await client.getMe();
      return textResult(
        JSON.stringify(
          {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            username: user.username,
            tonePreference: user.tonePreference,
            lastCoachKey: user.lastCoachKey,
            subscriptionTier: user.subscriptionTier,
            subscriptionStatus: user.subscriptionStatus,
            creditBalance: user.creditBalance,
            role: user.role,
            createdAt: user.createdAt ?? null,
          },
          null,
          2,
        ),
      );
    }),

  userSetUsername: async (params) => {
    const parsedArgs = parseToolArgs(userSetUsernameArgs, params);
    if (!parsedArgs.ok) return parsedArgs.result;
    const { username } = parsedArgs.args;
    return withClient(async (client) => {
      const result = await client.setUsername(username);
      return textResult(
        JSON.stringify(
          {
            username: result.user.username,
            displayName: result.user.displayName,
          },
          null,
          2,
        ),
      );
    });
  },

  userCheckUsername: async (params) => {
    const parsedArgs = parseToolArgs(userCheckUsernameArgs, params);
    if (!parsedArgs.ok) return parsedArgs.result;
    const { username } = parsedArgs.args;
    return withClient(async (client) => {
      const result = await client.checkUsername(username);
      return textResult(JSON.stringify(result, null, 2));
    });
  },

  // ── Catalog tools (#2336) ───────────────────────────────────────────

  catalogBrowse: async (params) => {
    const parsedArgs = parseToolArgs(catalogBrowseArgs, params);
    if (!parsedArgs.ok) return parsedArgs.result;
    const { category, context, sort, filter, limit = 20, offset = 0 } = parsedArgs.args;
    return withClient(async (client) => {
      const data = await client.catalogBrowse({
        ...(context ? { context } : {}),
        ...(sort ? { sort } : {}),
        ...(filter ? { filter } : {}),
      });
      let sets = data.sets;
      // Client-side category filter (not supported as API query param)
      if (category) {
        const c = category.toLowerCase();
        sets = sets.filter((s) => String(s['catalogCategory'] ?? '').toLowerCase() === c);
      }
      const total = sets.length;
      // Client-side pagination
      sets = sets.slice(offset, offset + limit);
      // Summarize for token efficiency (full details via nl_catalog_view)
      const summary = sets.map((s) => ({
        slug: s['slug'],
        title: s['title'],
        emoji: s['emoji'],
        catalogCategory: s['catalogCategory'],
        catalogDescription: s['catalogDescription'],
        sessionContext: s['sessionContext'],
        tonePreference: s['tonePreference'],
        hasAudio: s['hasAudio'],
        affirmationCount: s['affirmationCount'],
        durationSeconds: s['durationSeconds'],
      }));
      return textResult(JSON.stringify({ items: summary, total, limit, offset }, null, 2));
    });
  },

  catalogView: async (params) => {
    const parsedArgs = parseToolArgs(catalogSlugArgs, params);
    if (!parsedArgs.ok) return parsedArgs.result;
    const { slug } = parsedArgs.args;
    return withClient(async (client) => {
      const data = await client.catalogView(slug);
      return textResult(JSON.stringify(data, null, 2));
    });
  },

  catalogCopy: async (params) => {
    const parsedArgs = parseToolArgs(catalogSlugArgs, params);
    if (!parsedArgs.ok) return parsedArgs.result;
    const { slug } = parsedArgs.args;
    return withClient(async (client) => {
      const result = await client.catalogCopy(slug);
      return textResult(JSON.stringify(result, null, 2));
    });
  },

  // ── Library tools (#2209) ───────────────────────────────────────────

  libraryList: async () =>
    withClient(async (client) => {
      const { items } = await client.getLibrary();
      const summary = items.map((item) => ({
        id: item.intent.id,
        title: item.intent.title,
        emoji: item.intent.emoji,
        context: item.intent.sessionContext,
        affirmationCount: item.latestAffirmationSet?.affirmationCount ?? 0,
        renderStatus: item.latestRenderJob?.status ?? 'none',
        playCount: item.stats?.playCount ?? 0,
        lastPlayedAt: item.stats?.lastPlayedAt ?? null,
        createdAt: item.intent.createdAt,
        updatedAt: item.intent.updatedAt,
      }));
      return textResult(JSON.stringify(summary, null, 2));
    }),

  libraryView: async (params) => {
    const parsedArgs = parseToolArgs(playlistIdArgs, params);
    if (!parsedArgs.ok) return parsedArgs.result;
    const { id } = parsedArgs.args;
    return withClient(async (client) => {
      const resolvedId = await resolveIntentId(client, id);
      const { intent, stats } = await client.getIntent(resolvedId);
      if (!intent) {
        return errorResult('Playlist not found. Use nl_playlist_list to see available sets.');
      }
      const latestSet = intent.affirmationSets[0];
      const affirmations = (latestSet?.affirmations ?? []).map((a) => ({
        id: a.id,
        text: a.text,
        tone: a.tone,
        isEnabled: a.isEnabled,
        feedback: a.feedback ?? null,
      }));
      const latestConfig = latestSet
        ? intent.renderConfigs.find((rc) => rc.affirmationSetId === latestSet.id)
        : intent.renderConfigs[0] ?? null;
      const latestRenderJob = latestConfig?.renderJobs?.[0] ?? null;
      // Framework surfacing (#749, carried over from the deleted nl_info tool
      // — this is now the only user-facing tool exposing these fields). Per
      // #749 acceptance criteria we must NOT dump the full framework JSON —
      // that's nl_guide's job — so only the lightweight metadata surfaces.
      const framework = latestSet?.framework ?? null;

      const response = {
        id: intent.id,
        title: intent.title,
        emoji: intent.emoji,
        rawText: intent.rawText,
        context: intent.sessionContext,
        tonePreference: intent.tonePreference,
        affirmationCount: affirmations.length,
        affirmations,
        renderStatus: latestRenderJob?.status ?? 'none',
        renderProgress: latestRenderJob?.progress ?? 0,
        hasFramework: hasFramework(framework),
        frameworkSchemaVersion: extractFrameworkSchemaVersion(framework),
        frameworkTakeaway: extractFrameworkTakeaway(framework),
        stats: stats ?? null,
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt,
      };
      return textResult(JSON.stringify(response, null, 2));
    });
  },

  // ── Affirmation management tools (#2209) ────────────────────────────

  affirmationsFeedback: async (params) =>
    withClient(async (client) => {
      const affirmationIds = params['affirmationIds'] as string[];
      const feedback = params['feedback'] as 'liked' | 'disliked' | null;

      const resolved = await resolveSetAndValidateAffirmations(
        client,
        params['id'] as string,
        affirmationIds,
      );
      if (!resolved.ok) return resolved.error;

      // Process each affirmation, collecting results (continue-on-error)
      const results: Array<{ id: string; success: boolean; error?: string }> = [];
      for (const affId of affirmationIds) {
        try {
          await client.feedbackAffirmation(affId, feedback);
          results.push({ id: affId, success: true });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ id: affId, success: false, error: msg });
        }
      }

      const succeeded = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success).length;

      return textResult(
        JSON.stringify(
          {
            feedback,
            total: affirmationIds.length,
            succeeded,
            failed,
            ...(failed > 0 ? { errors: results.filter((r) => !r.success) } : {}),
          },
          null,
          2,
        ),
      );
    }),

  affirmationsToggle: async (params) =>
    withClient(async (client) => {
      const affirmationIds = params['affirmationIds'] as string[];
      const isEnabled = params['isEnabled'] as boolean;

      const resolved = await resolveSetAndValidateAffirmations(
        client,
        params['id'] as string,
        affirmationIds,
      );
      if (!resolved.ok) return resolved.error;

      await client.batchToggleAffirmations(resolved.setId, affirmationIds, isEnabled);

      return textResult(
        JSON.stringify(
          {
            isEnabled,
            toggled: affirmationIds.length,
            affirmationIds,
          },
          null,
          2,
        ),
      );
    }),

  // ── Context Settings tools (#2335) ─────────────────────────────────

  contextSettingsList: async () =>
    withClient(async (client) => {
      const { settings } = await client.getContextSettings();
      return textResult(JSON.stringify(settings, null, 2));
    }),

  contextSettingsUpdate: async (params) =>
    withClient(async (client) => {
      const context = params['context'] as string;
      const data: Record<string, unknown> = {};
      if (params['voiceId'] !== undefined) data['voiceId'] = params['voiceId'];
      if (params['durationMinutes'] !== undefined) data['durationMinutes'] = params['durationMinutes'];
      if (params['binauralPreset'] !== undefined) data['binauralPreset'] = params['binauralPreset'];
      if (params['paceWpm'] !== undefined) data['paceWpm'] = params['paceWpm'];
      if (params['backgroundKey'] !== undefined) data['backgroundKey'] = params['backgroundKey'];
      if (params['backgroundVolume'] !== undefined) data['backgroundVolume'] = params['backgroundVolume'];
      if (params['binauralVolume'] !== undefined) data['binauralVolume'] = params['binauralVolume'];
      if (params['subliminalEnabled'] !== undefined) data['subliminalEnabled'] = params['subliminalEnabled'];
      if (params['subliminalVolume'] !== undefined) data['subliminalVolume'] = params['subliminalVolume'];
      if (params['playbackMode'] !== undefined) data['playbackMode'] = params['playbackMode'];
      if (params['repeatCount'] !== undefined) data['repeatCount'] = params['repeatCount'];
      if (params['pauseMs'] !== undefined) data['pauseMs'] = params['pauseMs'];

      const { settings } = await client.updateContextSettings(context, data);
      return textResult(JSON.stringify(settings, null, 2));
    }),

  contextSettingsReset: async (params) =>
    withClient(async (client) => {
      const context = params['context'] as string;
      await client.deleteContextSettings(context);
      return textResult(`Context "${context}" reset to system defaults.`);
    }),

  // PUT /setting-preferences writes evidence, so a null is a saved choice (Full Set), not an unset.
  settingPreferenceSave: async (params) =>
    withClient(async (client) => {
      const context = params['context'];
      const setting = params['setting'];
      const value = params['value'];
      if (typeof context !== 'string' || context === '') {
        return errorResult('context is required.');
      }
      if (
        typeof setting !== 'string' ||
        !(SETTING_PREFERENCE_SAVE_SETTINGS as readonly string[]).includes(setting)
      ) {
        return errorResult(
          `setting must be one of: ${SETTING_PREFERENCE_SAVE_SETTINGS.join(', ')}.`,
        );
      }
      // `undefined` is not `null`: an omitted value must not be sent as a Full Set choice.
      if (value !== null && typeof value !== 'number') {
        return errorResult('value is required: a number, or null to save the no-custom-value choice.');
      }

      const saved = await client.saveSettingPreference(context, setting, value);
      return textResult(JSON.stringify(saved, null, 2));
    }),

  wizardDefaults: async (params) =>
    withClient(async (client) => {
      const intentId = params['intentId'] as string | undefined;
      const defaults = await client.getWizardDefaults(intentId);
      return textResult(JSON.stringify(defaults, null, 2));
    }),

  // ── Source extraction tools (#2334) ─────────���──────────────────────

  sourceExtract: async (params) =>
    withClient(async (client) => {
      const url = params['url'] as string;
      const result = await client.extractUrlPreview(url);
      return textResult(JSON.stringify(result, null, 2));
    }),

  sourceYoutube: async (params) =>
    withClient(async (client) => {
      const url = params['url'] as string;
      const result = await client.extractYoutubePreview(url);
      return textResult(JSON.stringify(result, null, 2));
    }),

  sourceTwitter: async (params) =>
    withClient(async (client) => {
      const url = params['url'] as string;
      const result = await client.extractTwitterPreview(url);
      return textResult(JSON.stringify(result, null, 2));
    }),

  sourcePdf: async (params) =>
    withClient(async (client) => {
      const filePath = params['filePath'] as string;

      const { readFileSync, existsSync } = await import('node:fs');
      if (!existsSync(filePath)) {
        return errorResult(`File not found: ${filePath}`);
      }

      const buffer = readFileSync(filePath);
      if (buffer.length > 10 * 1024 * 1024) {
        return errorResult('PDF file is too large. Maximum size is 10 MB.');
      }

      const result = await client.uploadPdf(buffer);
      return textResult(JSON.stringify(result, null, 2));
    }),

  // ── Playback tracking tools (#2338) ──────────────────────────────────

  playbackStart: async (params) =>
    withClient(async (client) => {
      const resolvedId = await resolveIntentId(client, params['id'] as string);
      const renderJobId = params['renderJobId'] as string | undefined;
      const result = await client.startPlayback(resolvedId, renderJobId);
      return textResult(JSON.stringify(result, null, 2));
    }),

  playbackComplete: async (params) =>
    withClient(async (client) => {
      const id = params['id'] as string;
      const durationSeconds = params['durationSeconds'] as number;
      const completed = params['completed'] as boolean | undefined;
      const result = await client.completePlayback(id, durationSeconds, completed);
      return textResult(JSON.stringify(result, null, 2));
    }),

  // ── Affirmation + Intent management tools (#2337) ──────────────────

  generateMore: async (params) =>
    withClient(async (client) => {
      const resolved = await resolveLatestSetId(client, params['id'] as string);
      if (!resolved.ok) return resolved.error;

      const count = params['count'] as number | undefined;
      const result = await client.generateMore(resolved.setId, count);
      return textResult(
        JSON.stringify(
          {
            setId: resolved.setId,
            added: result.added,
            message: `Generated ${result.added} new affirmation(s).`,
          },
          null,
          2,
        ),
      );
    }),

  affirmationAdd: async (params) =>
    withClient(async (client) => {
      const text = params['text'] as string;
      const resolved = await resolveLatestSetId(client, params['id'] as string);
      if (!resolved.ok) return resolved.error;

      const result = await client.addAffirmation(resolved.setId, text);
      return textResult(JSON.stringify(result, null, 2));
    }),

  affirmationDelete: async (params) =>
    withClient(async (client) => {
      const affirmationId = params['affirmationId'] as string;

      // Validate affirmation belongs to the intent's latest set
      const resolved = await resolveSetAndValidateAffirmations(
        client,
        params['id'] as string,
        [affirmationId],
      );
      if (!resolved.ok) return resolved.error;

      await client.deleteAffirmation(affirmationId);
      return textResult(`Deleted affirmation ${affirmationId}.`);
    }),

  intentUpdate: async (params) => {
    const text = params['text'] as string | undefined;
    const title = params['title'] as string | undefined;
    const emoji = params['emoji'] as string | null | undefined;
    const tone = params['tone'] as string | undefined;

    if (text === undefined && title === undefined && emoji === undefined && tone === undefined) {
      return errorResult('At least one of text, title, emoji, or tone must be provided.');
    }

    return withClient(async (client) => {
      const resolvedId = await resolveIntentId(client, params['id'] as string);
      const input: { intentText?: string; title?: string; emoji?: string | null; tonePreference?: string | null } = {};
      if (text !== undefined) input.intentText = text;
      if (title !== undefined) input.title = title;
      if (emoji !== undefined) input.emoji = emoji;
      if (tone !== undefined) input.tonePreference = tone;
      const result = await client.updateIntent(resolvedId, input);
      return textResult(JSON.stringify(result, null, 2));
    });
  },

  // ── #3117 — User settings update ─────────────────────────────────────────

  userSettingsUpdate: async (params) =>
    withClient(async (client) => {
      // ⛔ No coach setting here (nl#304). There is no stored default coach to
      // update; `nl_playlist_create.coachKey` picks the coach per generation and
      // the API remembers it as the user's last-used, exactly as the app does.
      const tonePreference = params['tonePreference'];

      if (tonePreference === undefined) {
        return errorResult('At least one setting must be provided (tonePreference).');
      }

      const result = await client.updateSettings({
        tonePreference: tonePreference as string | null,
      });
      return textResult(
        JSON.stringify({ tonePreference: result.user.tonePreference }, null, 2),
      );
    }),

  // ── #3116 — Coach catalog tools ──────────────────────────────────────────

  coaches: async () => {
    const result = await withTypedClient(async (client) => {
      const { coaches } = await client.getCoaches();

      // nl#304 — mark the coach this user last generated with. It is NOT a
      // "default" any more: nothing sets it directly, it is stamped by the
      // generation path, and `nl_playlist_create.coachKey` overrides it per call.
      let lastCoachKey: string | null = null;
      try {
        const me = await client.getMe();
        lastCoachKey = me.user.lastCoachKey;
      } catch {
        // Non-fatal — still show coaches without the last-used marker.
      }

      return { coaches, lastCoachKey };
    });
    if (isMcpToolError(result)) {
      if (result.status === 404) {
        const message =
          'The coaches feature is not enabled for your account. Contact support or wait for the feature rollout.';
        return typedToolResult({ kind: 'feature_gated', message }, message);
      }
      return typedToolResult(result, result.message);
    }

    const mapped = result.coaches.map((coach) => ({
      ...coach,
      isLastUsed: coach.key === result.lastCoachKey,
    }));
    const output = { kind: 'ok' as const, lastCoachKey: result.lastCoachKey, coaches: mapped };
    return typedToolResult(
      output,
      JSON.stringify({ lastCoachKey: result.lastCoachKey, coaches: mapped }, null, 2),
    );
  },

  // `nl_render_start` and `nl_rerender` map to the same client call
  // (starting a render is the same operation whether it's the first attempt
  // or a retry) — one implementation, aliased under both keys below.
  renderStart: startRenderHandler,
  rerender: startRenderHandler,

  renderStatus: async (params) => {
    const result = await withTypedClient(async (client) => {
      const resolvedId = await resolveIntentId(client, params['id'] as string);
      return client.getRenderStatus(resolvedId);
    });
    if (isMcpToolError(result)) {
      return typedToolResult(result, result.message);
    }

    const parsed = renderStatusApiSchema.safeParse(result);
    if (!parsed.success) {
      const message = 'Render status response did not match the expected shape.';
      return typedToolResult(invalidResponseError(message), message);
    }
    if (parsed.data.status === 'none') {
      return typedToolResult({ kind: 'no_render_job' }, 'No render job for this playlist.');
    }

    const status = renderJobStatusEnum.safeParse(parsed.data.status);
    if (!status.success) {
      const output = { kind: 'unknown_status' as const, raw: parsed.data.status };
      return typedToolResult(output, JSON.stringify(output, null, 2));
    }

    const output = {
      kind: 'ok' as const,
      status: status.data,
      progress: parsed.data.progress,
      outputKey: parsed.data.outputKey ?? null,
      errorMessage: parsed.data.errorMessage ?? null,
      ...(parsed.data.jobId !== undefined ? { jobId: parsed.data.jobId } : {}),
    };
    return typedToolResult(output, JSON.stringify(output, null, 2));
  },

  share: async (params) => {
    const result = await withTypedClient(async (client) => {
      const resolvedId = await resolveIntentId(client, params['id'] as string);
      return client.shareIntent(resolvedId);
    });
    if (isMcpToolError(result)) {
      return typedToolResult(result, result.message);
    }

    const parsed = shareIntentApiSchema.safeParse(result);
    if (!parsed.success) {
      const message = 'Share response did not match the expected shape.';
      return typedToolResult(invalidResponseError(message), message);
    }

    const output = { kind: 'ok' as const, ...parsed.data };
    return typedToolResult(output, JSON.stringify(output, null, 2));
  },

  unshare: async (params) => {
    const result = await withTypedClient(async (client) => {
      const resolvedId = await resolveIntentId(client, params['id'] as string);
      return client.unshareIntent(resolvedId);
    });
    if (isMcpToolError(result)) {
      return typedToolResult(result, result.message);
    }

    return typedToolResult({ kind: 'ok' }, 'Share link revoked.');
  },

  playlistDelete: async (params) => {
    const result = await withTypedClient(async (client) => {
      const resolvedId = await resolveIntentId(client, params['id'] as string);
      await client.deleteIntent(resolvedId);
      return { resolvedId };
    });
    if (isMcpToolError(result)) {
      return typedToolResult(result, result.message);
    }

    return typedToolResult({ kind: 'ok' }, `Deleted playlist ${result.resolvedId}.`);
  },

  coachView: async (params) => {
    const key = params['key'] as string | undefined;
    if (!key) {
      // ⛔ Do NOT name example keys here. This file is synced to the public repo,
      // where `@neuralingual/core` does not exist, so the roster cannot be imported —
      // a hand-written example list is a roster copy that nothing can keep honest, and
      // this one had drifted to naming only three of the four (#272). `nl_coaches`
      // returns the live list, and the unknown-key branch below names it from the
      // server response.
      const message = 'Please provide a coach key. Run nl_coaches to list them.';
      return typedToolResult(
        {
          kind: 'error',
          code: 'validation',
          message,
          status: null,
          retryable: false,
        },
        message,
      );
    }

    const result = await withTypedClient(async (client) => {
      const { coaches } = await client.getCoaches();
      const coach = coaches.find((candidate) => candidate.key === key);
      if (!coach) {
        return { coach: null, validKeys: coaches.map((candidate) => candidate.key) };
      }

      // nl#304 — last-used, not default. See the note in `coaches` above.
      let isLastUsed = false;
      try {
        const me = await client.getMe();
        isLastUsed = me.user.lastCoachKey === key;
      } catch {
        // Non-fatal.
      }

      return { coach, validKeys: coaches.map((candidate) => candidate.key), isLastUsed };
    });
    if (isMcpToolError(result)) {
      if (result.status === 404) {
        const message =
          'The coaches feature is not enabled for your account. Contact support or wait for the feature rollout.';
        return typedToolResult({ kind: 'feature_gated', message }, message);
      }
      return typedToolResult(result, result.message);
    }

    if (!result.coach) {
      const output = { kind: 'not_found' as const, validKeys: result.validKeys };
      return typedToolResult(
        output,
        `Unknown coach key "${key}". Valid keys: ${result.validKeys.join(', ')}`,
      );
    }

    const output = { kind: 'ok' as const, ...result.coach, isLastUsed: result.isLastUsed };
    return typedToolResult(
      output,
      JSON.stringify({ ...result.coach, isLastUsed: result.isLastUsed }, null, 2),
    );
  },
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
  handler: {
    type: 'custom';
    customHandler: string;
  };
}

interface ToolManifest {
  tools: ToolManifestEntry[];
}

export const TYPED_OUTPUT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  nl_coach_view: nlCoachViewResultSchema,
  nl_coaches: nlCoachesResultSchema,
  nl_playlist_delete: nlPlaylistDeleteResultSchema,
  nl_render_start: nlRenderStartResultSchema,
  nl_render_status: nlRenderStatusResultSchema,
  nl_rerender: nlRenderStartResultSchema,
  nl_share: nlShareResultSchema,
  nl_unshare: nlUnshareResultSchema,
};

// ── Server Builder ────────────────────────────────────────────────────────

/**
 * buildUserServer() is instantiated per-test (see `tool-manifest.test.ts`),
 * so anything wired here runs N times per test run — not once per process.
 *
 * Do NOT register process-singleton side effects here: init loggers, cron
 * jobs, one-time metrics emits, boot-state logs. Those belong in `main()`
 * below, where the stdio transport also lives.
 *
 * Same rule as `apps/api/src/server.ts:buildServer()`. Reference issue: #868
 * (from #856 / PR #867 retrospective).
 */
export function buildUserServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const tools = (manifest as ToolManifest).tools;

  for (const tool of tools) {
    const inputSchema = jsonSchemaToInputSchema(tool.parameters as JsonSchema);
    // TYPED_OUTPUT_SCHEMAS holds the precise discriminated-union result schema for our own
    // handler code and tests; the SDK's registerTool() only accepts an object-shaped schema
    // (see toMcpOutputSchema's header for why a bare union silently breaks both tools/list
    // advertisement and the SDK's own output validation).
    const resultSchema = TYPED_OUTPUT_SCHEMAS[tool.name];
    const registration = {
      description: tool.description,
      inputSchema,
      ...(resultSchema ? { outputSchema: toMcpOutputSchema(resultSchema) } : {}),
    };

    const handlerFn = CUSTOM_HANDLERS[tool.handler.customHandler];
    if (!handlerFn) {
      throw new Error(
        `Missing custom handler "${tool.handler.customHandler}" for tool "${tool.name}"`,
      );
    }

    server.registerTool(
      tool.name,
      registration,
      async (params: Record<string, unknown>) => handlerFn(params),
    );
  }

  return server;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  // Install the MCP failure telemetry sink (#2867). Defaults to stderr so a
  // user-visible read failure (e.g. the Railway Postgres ETIMEDOUT class,
  // #2828) reaches a sink instead of being invisible. NL_MCP_TELEMETRY=posthog
  // routes to PostHog.
  const { installEnvTelemetrySink } = await import('./mcp-telemetry.js');
  installEnvTelemetrySink('stderr');
  const server = buildUserServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run when executed directly (not when imported in tests). Compare
// resolved real paths rather than raw strings: when invoked through an npm
// bin symlink (e.g. `/opt/homebrew/bin/neuralingual-mcp` -> this file),
// `process.argv[1]` is the symlink path, which neither equals the resolved
// `import.meta.url` nor ends with `/user-mcp.js` (the bin can be named
// anything) — silently skipping `main()` and exiting 0 with no output (#38).
// `realpathSync` resolves the symlink to compare like-for-like; guarded so a
// missing/odd argv[1] can never crash startup.
function resolveMainModuleEntry(argv1: string | undefined): string {
  if (!argv1) return '';
  try {
    return realpathSync(argv1);
  } catch {
    return '';
  }
}

const isMainModule = resolveMainModuleEntry(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
