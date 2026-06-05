#!/usr/bin/env node
/**
 * Neuralingual User MCP Server (manifest-driven)
 *
 * Registers user-facing MCP tools by iterating tool-manifest.json.
 * This is the single source of truth for tool definitions — the public
 * repo (neuralingual-mcp) will consume this manifest in Phase 2.
 *
 * Handler types:
 * - "client-method": generic pass-through to UserApiClient methods
 * - "custom": tool-specific logic defined in CUSTOM_HANDLERS
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { UserApiClient } from './user-client.js';
import { loadAuth } from './auth-store.js';
import { serializeSetFile, parseSetFile } from './set-file.js';
import { jsonSchemaToInputSchema, type JsonSchema } from './json-schema-to-zod.js';
import {
  renderFrameworkMarkdown,
  extractFrameworkSchemaVersion,
  extractFrameworkTakeaway,
  hasFramework,
} from './framework-render.js';
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
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(msg);
  }
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
        `Affirmation IDs not found in this playlist: ${invalidIds.join(', ')}. Use nl_library_view to see affirmation IDs.`,
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

  throw new Error('Playlist not found. Use nl_library to see available sets.');
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
    throw new Error('Playlist not found. Use nl_library to see available sets.');
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
        repetitionModel: latestConfig.repetitionModel ?? 'shuffle',
        binauralPreset: latestConfig.binauralPreset ?? null,
        binauralVolume: latestConfig.binauralVolume ?? null,
        subliminalEnabled: latestConfig.subliminalEnabled ?? false,
        subliminalVolume: latestConfig.subliminalVolume ?? null,
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
        return errorResult('Playlist not found. Use nl_library to see available sets.');
      }
      // Additive framework surfacing (#749). Spreads existing intent fields
      // unchanged at the top level, adds three framework-metadata fields
      // alongside so current consumers keep working. Per #749 acceptance
      // criteria we must NOT dump the full framework JSON — that's
      // nl_guide's job. Strip `framework` + raw LLM payloads from each
      // affirmation set before stringifying to keep this tool lightweight.
      const latestSet = intent.affirmationSets[0];
      const framework = latestSet?.framework ?? null;
      // Strip framework + raw LLM payloads defensively — they may or may not
      // be present depending on legacy vs framework-first rows. Shallow-copy
      // each set into a plain object so we don't mutate the client response.
      const sanitizedAffirmationSets = intent.affirmationSets.map((set) => {
        const bag: Record<string, unknown> = { ...set };
        delete bag['framework'];
        delete bag['rawFrameworkLlm'];
        delete bag['rawAffirmationsLlm'];
        return bag;
      });
      // Strip sourceText from response — it can be very large (up to 16k
      // chars) and nl_info should show metadata only. sourceText is still
      // available via nl_set_export if needed.
      const intentBag: Record<string, unknown> = { ...intent };
      delete intentBag['sourceText'];
      const response = {
        ...intentBag,
        affirmationSets: sanitizedAffirmationSets,
        hasFramework: hasFramework(framework),
        frameworkSchemaVersion: extractFrameworkSchemaVersion(framework),
        frameworkTakeaway: extractFrameworkTakeaway(framework),
      };
      return textResult(JSON.stringify(response, null, 2));
    }),

  guide: async (params) =>
    withClient(async (client) => {
      const resolvedId = await resolveIntentId(client, params['id'] as string);
      const { intent } = await client.getIntent(resolvedId);
      if (!intent) {
        return errorResult('Playlist not found. Use nl_library to see available sets.');
      }
      const latestSet = intent.affirmationSets[0];
      const framework = latestSet?.framework ?? null;
      return textResult(renderFrameworkMarkdown(framework));
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
          ? `No playlists found matching "${query}".`
          : JSON.stringify(summary, null, 2),
      );
    }),

  voices: async (params) => {
    try {
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
      const text = params['text'] as string | undefined;
      const tone = params['tone'] as string | undefined;
      const sourceText = params['sourceText'] as string | undefined;
      const sourceUrl = params['sourceUrl'] as string | undefined;
      const sourcePdf = params['sourcePdf'] as string | undefined;
      const sourceYoutube = params['sourceYoutube'] as string | undefined;
      const sourceTitle = params['sourceTitle'] as string | undefined;
      const sourceAuthor = params['sourceAuthor'] as string | undefined;
      // #3062 — Optional rhetorical-style steering: a named preset and/or
      // free-form dials. Resolved + validated server-side (unknown preset,
      // over-bounds, or injection → 400).
      const style = params['style'] as string | undefined;
      const styleNotes = params['styleNotes'] as Record<string, unknown> | undefined;

      if (!text && !sourceText && !sourceUrl && !sourcePdf && !sourceYoutube) {
        return errorResult('Please provide intent text, source material (sourceText, sourceUrl, sourcePdf, or sourceYoutube), or both.');
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

      const result = await client.createAndGenerate(text, tone, source, style, styleNotes);
      const output = youtubePreview
        ? { ...result, youtubePreview }
        : result;
      return textResult(JSON.stringify(output, null, 2));
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
        return errorResult('Playlist not found. Use nl_library to see available sets.');
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

  setExport: async (params) =>
    withClient(async (client) => {
      const resolvedId = await resolveIntentId(client, params['id'] as string);
      const withFramework = params['withFramework'] === true;
      const { data, framework } = await fetchSetFileData(client, resolvedId);
      const yaml = serializeSetFile(data);

      if (!withFramework) {
        return textResult(yaml);
      }

      // Prepend framework markdown before the YAML body. Blank-line separator
      // (no standalone `---`) avoids colliding with YAML's document-start
      // marker. The combined output is NOT re-importable via nl_set_import
      // — that's documented in the tool description.
      const markdown = renderFrameworkMarkdown(framework);
      return textResult(`${markdown}\n${yaml}`);
    }),

  setImport: async (params) =>
    withClient(async (client) => {
      const resolvedId = await resolveIntentId(client, params['id'] as string);
      const { data: originalData } = await fetchSetFileData(client, resolvedId);
      const result = await applySetFile(client, resolvedId, params['yaml'] as string, originalData);
      return textResult(result);
    }),

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

  userSetUsername: async (params) =>
    withClient(async (client) => {
      const username = params['username'] as string;
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
    }),

  userCheckUsername: async (params) =>
    withClient(async (client) => {
      const username = params['username'] as string;
      const result = await client.checkUsername(username);
      return textResult(JSON.stringify(result, null, 2));
    }),

  // ── Catalog tools (#2336) ───────────────────────────────────────────

  catalogBrowse: async (params) =>
    withClient(async (client) => {
      const category = params['category'] as string | undefined;
      const context = params['context'] as string | undefined;
      const sort = params['sort'] as string | undefined;
      const filter = params['filter'] as string | undefined;
      const limit = (params['limit'] as number | undefined) ?? 20;
      const offset = (params['offset'] as number | undefined) ?? 0;
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
    }),

  catalogView: async (params) =>
    withClient(async (client) => {
      const slug = params['slug'] as string;
      const data = await client.catalogView(slug);
      return textResult(JSON.stringify(data, null, 2));
    }),

  catalogCopy: async (params) =>
    withClient(async (client) => {
      const slug = params['slug'] as string;
      const result = await client.catalogCopy(slug);
      return textResult(JSON.stringify(result, null, 2));
    }),

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

  libraryView: async (params) =>
    withClient(async (client) => {
      const resolvedId = await resolveIntentId(client, params['id'] as string);
      const { intent, stats } = await client.getIntent(resolvedId);
      if (!intent) {
        return errorResult('Playlist not found. Use nl_library_list to see available sets.');
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

      const response = {
        id: intent.id,
        title: intent.title,
        emoji: intent.emoji,
        context: intent.sessionContext,
        tonePreference: intent.tonePreference,
        affirmationCount: affirmations.length,
        affirmations,
        renderStatus: latestRenderJob?.status ?? 'none',
        renderProgress: latestRenderJob?.progress ?? 0,
        stats: stats ?? null,
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt,
      };
      return textResult(JSON.stringify(response, null, 2));
    }),

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
