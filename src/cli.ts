#!/usr/bin/env node
import { Command } from 'commander';
import { spawn, spawnSync, exec } from 'child_process';
import { createServer } from 'http';
import { randomBytes, randomUUID } from 'crypto';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { createInterface } from 'readline';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import {
  openGenerationStream,
  type GenerationStreamHandlers,
  type ResumeBlockingOutcome,
  type StreamError,
} from './streaming/generation-stream.js';
import { StreamRenderer } from './streaming/render.js';
import type { StreamingProtocolEvent } from './streaming/protocol-types.js';
import { UserApiClient } from './user-client.js';
import { installEnvTelemetrySink } from './mcp-telemetry.js';
import { loadAuth, clearAuth } from './auth-store.js';
import type { ApiEnv, Intent, LibraryFilter, LibraryQueryParams, RenderConfigInput, RenderStatus, SessionContext, TonePreference } from './types.js';
import { API_BASE_URLS } from './types.js';
import { serializeSetFile, parseSetFile } from './set-file.js';
import {
  renderFrameworkMarkdown,
  extractFrameworkSchemaVersion,
  extractFrameworkTakeaway,
  hasFramework,
} from './framework-render.js';
import { z } from 'zod';
import type { SetFileData } from './set-file.js';

const VALID_TONES = ['grounded', 'open', 'mystical'];
const VALID_CONTEXTS = ['general', 'sleep', 'nap', 'meditation', 'workout', 'focus', 'walk', 'chores'];

const program = new Command();

program
  .name('neuralingual')
  .description('Neuralingual CLI — playlist management (admin + user commands)')
  .version('0.1.0')
  .option('--env <env>', 'API environment: dev or production (default: production)', 'production');


function printResult(data: unknown, isError = false): void {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (isError) {
    console.error(text);
    process.exit(1);
  } else {
    console.log(text);
  }
}

/** Format a byte count as a human-readable string (e.g. "1.23 GB"). */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

/** Render a simple text table with left-aligned columns. */
function printTable(rows: string[][], headers: string[]): void {
  const allRows = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...allRows.map((r) => (r[i] ?? '').length)));
  const line = (row: string[]) => row.map((cell, i) => (cell ?? '').padEnd(widths[i] ?? 0)).join('  ');
  const separator = widths.map((w) => '-'.repeat(w)).join('  ');
  console.log(line(headers));
  console.log(separator);
  for (const row of rows) {
    console.log(line(row));
  }
}

/**
 * Read all of stdin and return as a string.
 *
 * Defined here (outside the @public-strip block) so the user-facing
 * `create --source-text -` handler can call it in the public CLI — the admin
 * commands inside the strip block use it too. Keeping it before the strip marker
 * means it survives admin-code stripping during the public sync (#3068).
 */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}


/** Build a RenderConfigInput from parsed YAML fields. Used by set create and set apply. */
function buildRenderInputFromParsed(
  parsed: ReturnType<typeof parseSetFile>,
  fallback?: { voiceId?: string | null; sessionContext?: string; durationSeconds?: number },
): RenderConfigInput {
  const input: RenderConfigInput = {
    voiceId: parsed.voice ?? fallback?.voiceId ?? '',
    sessionContext: (parsed.renderContext ?? fallback?.sessionContext ?? parsed.intentContext ?? 'general') as SessionContext,
    durationMinutes: parsed.duration ?? (fallback?.durationSeconds ? Math.round(fallback.durationSeconds / 60) : 10),
  };
  if (parsed.pace !== undefined) input.paceWpm = parsed.pace;
  if (parsed.background !== undefined) input.backgroundAudioPath = parsed.background;
  if (parsed.backgroundVolume !== undefined) input.backgroundVolume = parsed.backgroundVolume;
  if (parsed.repeats !== undefined) input.affirmationRepeatCount = parsed.repeats;
  if (parsed.preamble !== undefined) input.includePreamble = parsed.preamble;
  if (parsed.playAll !== undefined) input.playAll = parsed.playAll;
  if (parsed.repetitionModel !== undefined) input.repetitionModel = parsed.repetitionModel;
  return input;
}


// ═══════════════════════════════════════════════════════════════════════════════
// User-facing commands (JWT auth, not admin key)
// ═══════════════════════════════════════════════════════════════════════════════

/** Get a user client from stored auth. Exits with helpful message if not logged in. */
function getUserClient(): UserApiClient {
  try {
    return UserApiClient.fromAuth();
  } catch {
    console.error('Not logged in. Run `nl login` first.');
    process.exit(1);
  }
}


/**
 * Resolve a short/truncated intent ID to the full ID by fetching the user's library.
 * Handles exact match, prefix match, and ambiguous matches (multiple prefix hits).
 * Only works for user-authenticated clients (UserApiClient has getLibrary()).
 */
async function resolveIntentId(client: UserApiClient, shortId: string): Promise<string> {
  const { items } = await client.getLibrary();
  const exact = items.find((i) => i.intent.id === shortId);
  if (exact) return exact.intent.id;

  const prefixMatches = items.filter((i) => i.intent.id.startsWith(shortId));
  if (prefixMatches.length === 1) return prefixMatches[0]!.intent.id;
  if (prefixMatches.length > 1) {
    console.error(`Error: ambiguous ID "${shortId}" matches ${prefixMatches.length} intents:`);
    for (const m of prefixMatches) {
      console.error(`  ${m.intent.id.slice(0, 12)}  ${m.intent.title ?? '(untitled)'}`);
    }
    process.exit(1);
  }

  console.error(`Error: no playlist found matching "${shortId}"`);
  process.exit(1);
}


/**
 * Fetch set file data using user API.
 * Maps the user intent detail shape to SetFileData.
 */
async function fetchSetFileDataUser(client: UserApiClient, intentId: string): Promise<SetFileData> {
  const { intent } = await client.getIntent(intentId);
  if (!intent) {
    throw new Error(`Intent not found: ${intentId}`);
  }

  // Get latest affirmation set (first in the desc-ordered array)
  const latestSet = intent.affirmationSets[0];
  const affirmations: SetFileData['affirmations'] = (latestSet?.affirmations ?? []).map((a, idx) => ({
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

  // Get render config scoped to the latest affirmation set (matching the info command pattern).
  // Without scoping, we could export a stale config from an older set.
  const latestSetId = latestSet?.id;
  const latestConfig = (latestSetId
    ? intent.renderConfigs.find((rc) => rc.affirmationSetId === latestSetId)
    : intent.renderConfigs[0]) ?? null;
  const renderConfig: SetFileData['renderConfig'] = latestConfig ? {
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
    repetitionModel: latestConfig.repetitionModel,
    binauralPreset: latestConfig.binauralPreset ?? null,
    binauralVolume: latestConfig.binauralVolume ?? null,
    subliminalEnabled: latestConfig.subliminalEnabled ?? false,
    subliminalVolume: latestConfig.subliminalVolume ?? null,
    includePreamble: latestConfig.includePreamble,
    playAll: latestConfig.playAll,
    createdAt: latestConfig.createdAt,
    updatedAt: latestConfig.updatedAt,
  } : null;

  // Map user intent detail to the Intent type expected by SetFileData.
  // User intents don't have catalog fields — default them.
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

  return { intent: mappedIntent, affirmations, renderConfig };
}

/**
 * Apply a parsed set file using user API.
 * Silently skips admin-only fields (catalog, sessionContext on intent).
 */
async function applySetFileUser(
  client: UserApiClient,
  intentId: string,
  content: string,
  originalData: SetFileData,
): Promise<void> {
  let parsed;
  try {
    parsed = parseSetFile(content);
  } catch (err: unknown) {
    console.error(`Error: invalid YAML — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const changes: string[] = [];

  // 1. Intent metadata updates (user API uses intentText, not rawText)
  const intentUpdates: { title?: string; emoji?: string | null; intentText?: string; tonePreference?: string | null } = {};
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
  // Note: intentContext/sessionContext changes silently skipped for user auth
  // (user update API doesn't support sessionContext)

  if (Object.keys(intentUpdates).length > 0) {
    await client.updateIntent(intentId, intentUpdates);
    changes.push(`intent: updated ${Object.keys(intentUpdates).join(', ')}`);
  }

  // 2. Affirmation sync (declarative)
  if (parsed.affirmations && parsed.affirmations.length > 0) {
    const missingIds = parsed.affirmations.filter((a) => !a.id);
    if (missingIds.length > 0 && originalData.affirmations.length > 0) {
      console.error(
        `Warning: ${missingIds.length} affirmation(s) are missing an ID. ` +
        'They will be treated as new additions. If this was unintentional, ' +
        're-export the set to get the current IDs.',
      );
    }

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
  const hasRenderFields = parsed.voice !== undefined ||
    parsed.duration !== undefined ||
    parsed.pace !== undefined ||
    parsed.renderContext !== undefined ||
    parsed.background !== undefined ||
    parsed.backgroundVolume !== undefined ||
    parsed.repeats !== undefined ||
    parsed.preamble !== undefined ||
    parsed.playAll !== undefined;

  if (hasRenderFields) {
    if (!originalData.renderConfig) {
      console.error('Warning: no render config exists yet — skipping render settings. Run nl render configure first.');
    } else {
      const rc = originalData.renderConfig;
      await client.configureRender(intentId, buildRenderInputFromParsed(parsed, rc));
      changes.push('render config: updated');
    }
  }

  // 4. Catalog fields silently skipped for user auth
  const hasCatalogFields = parsed.slug !== undefined ||
    parsed.category !== undefined ||
    parsed.description !== undefined ||
    parsed.order !== undefined;

  if (hasCatalogFields) {
    console.error('Note: catalog fields (slug, category, description, etc.) are admin-only and were skipped.');
  }

  if (changes.length === 0) {
    console.error('No changes detected.');
  } else {
    console.error(`Applied ${changes.length} change(s):`);
    for (const c of changes) {
      console.error(`  - ${c}`);
    }
  }
}

// ─── login ──────────────────────────────────────────────────────────────────

const WEB_BASE_URLS: Record<ApiEnv, string> = {
  dev: 'http://localhost:3010',
  production: 'https://neuralingual.com',
};

const LOGIN_TIMEOUT_MS = 120_000;

const callbackPayloadSchema = z.object({
  state: z.string().min(1),
  idToken: z.string().min(1),
  displayName: z.string().max(200).optional(),
});

/** Open a URL in the default browser. */
function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start ""'
    : 'xdg-open';
  exec(`${cmd} ${JSON.stringify(url)}`, () => { /* best-effort */ });
}

/** Browser-based Apple Sign-In flow for regular users. */
async function browserLogin(env: ApiEnv): Promise<void> {
  const state = randomBytes(32).toString('hex');

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const server = createServer(async (req, res) => {
      // CORS preflight for the web page POST
      // Includes Private Network Access header for Chromium PNA enforcement
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Private-Network': 'true',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }

      if (req.method !== 'POST' || req.url !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      // Read POST body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer);
      }
      const body = Buffer.concat(chunks).toString('utf8');

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const result = callbackPayloadSchema.safeParse(parsed);
      if (!result.success) {
        res.writeHead(400, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ error: 'Invalid callback payload' }));
        return;
      }

      const payload = result.data;

      // Validate state to prevent CSRF
      if (payload.state !== state) {
        res.writeHead(403, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ error: 'State mismatch' }));
        return;
      }

      try {
        const { user } = await UserApiClient.loginWithApple(env, payload.idToken, payload.displayName);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ ok: true }));

        console.log(`\nLogged in as ${user.displayName ?? user.email ?? user.id} (${env})`);
        console.log(`Credits: ${user.creditBalance}`);
        settled = true;
        server.close();
        resolve();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ error: msg }));
        settled = true;
        server.close();
        reject(new Error(`Login failed: ${msg}`));
      }
    });

    // Bind to loopback IP (RFC 8252), OS-assigned port
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        settled = true;
        reject(new Error('Failed to start local server'));
        return;
      }

      const port = addr.port;
      const webBase = WEB_BASE_URLS[env];
      const loginUrl = `${webBase}/auth/cli?port=${port}&state=${encodeURIComponent(state)}`;

      console.log('Opening browser for Apple Sign-In...');
      console.log(`If the browser does not open, visit: ${loginUrl}`);
      openBrowser(loginUrl);
    });

    // Timeout to prevent orphaned servers
    setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        reject(new Error('Login timed out. Please try again.'));
      }
    }, LOGIN_TIMEOUT_MS);
  });
}

program
  .command('login')
  .description('Log in to Neuralingual (Apple Sign-In via browser)')
  .option('--env <env>', 'API environment: dev or production', 'production')
  .action(async (opts: { env: string }) => {
    const env = opts.env as ApiEnv;
    if (env !== 'dev' && env !== 'production') {
      console.error('Error: --env must be "dev" or "production"');
      process.exit(1);
    }
    try {
      await browserLogin(env);
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── logout ─────────────────────────────────────────────────────────────────

program
  .command('logout')
  .description('Log out and clear stored tokens')
  .action(async () => {
    const auth = loadAuth();
    if (!auth) {
      console.log('Not logged in.');
      return;
    }
    try {
      const client = getUserClient();
      await client.logout();
    } catch {
      // Best-effort server logout; always clear local tokens
      clearAuth();
    }
    console.log('Logged out.');
  });

// ─── whoami ─────────────────────────────────────────────────────────────────

program
  .command('whoami')
  .description('Show current user info')
  .action(async () => {
    const client = getUserClient();
    try {
      const { user } = await client.getMe();
      const lines = [
        `User:    ${user.displayName ?? '(no name)'}`,
        `Username:${user.username ? ` @${user.username}` : ' (not set)'}`,
        `Email:   ${user.email ?? '(none)'}`,
        `ID:      ${user.id}`,
        `Tier:    ${user.subscriptionTier ?? 'free'}`,
        `Credits: ${user.creditBalance}`,
        `Role:    ${user.role}`,
      ];
      console.log(lines.join('\n'));
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── username (#2138) ──────────────────────────────────────────────────────

const usernameCmd = program.command('username').description('Check or set your username');

usernameCmd
  .command('check <name>')
  .description('Check if a username is available')
  .action(async (name: string) => {
    const client = getUserClient();
    try {
      const result = await client.checkUsername(name);
      if (result.available) {
        console.log(`Username "${name}" is available.`);
      } else {
        console.log(`Username "${name}" is not available.`);
        if (result.suggestion) {
          console.log(`Suggestion: ${result.suggestion}`);
        }
        if (result.error) {
          console.log(`Reason: ${result.error}`);
        }
      }
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

usernameCmd
  .command('set <name>')
  .description('Set or update your username')
  .action(async (name: string) => {
    const client = getUserClient();
    try {
      const { user } = await client.setUsername(name);
      console.log(`Username set to @${user.username ?? name}`);
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── library ────────────────────────────────────────────────────────────────

program
  .command('library')
  .description('List your playlists')
  .option('--context <ctx>', `Filter by context: ${VALID_CONTEXTS.join(', ')}`)
  .option('--status <status>', 'Filter by render status: rendered, pending, failed')
  .option('--sort <order>', 'Sort order: newest, oldest, title (default: newest)', 'newest')
  .option('--limit <n>', 'Limit number of results', parseInt)
  .action(async (opts: { context?: string; status?: string; sort: string; limit?: number }) => {
    if (opts.context && !VALID_CONTEXTS.includes(opts.context)) {
      console.error(`Error: --context must be one of: ${VALID_CONTEXTS.join(', ')}`);
      process.exit(1);
    }
    const validStatuses = ['rendered', 'pending', 'failed'];
    if (opts.status && !validStatuses.includes(opts.status)) {
      console.error(`Error: --status must be one of: ${validStatuses.join(', ')}`);
      process.exit(1);
    }
    const validSorts = ['newest', 'oldest', 'title'];
    if (!validSorts.includes(opts.sort)) {
      console.error(`Error: --sort must be one of: ${validSorts.join(', ')}`);
      process.exit(1);
    }

    const client = getUserClient();
    try {
      const { items } = await client.getLibrary();
      let filtered = items;

      // Filter by context
      if (opts.context) {
        filtered = filtered.filter((item) => item.intent?.sessionContext === opts.context);
      }

      // Filter by render status — use latestRenderJob which matches the displayed Render column
      if (opts.status) {
        filtered = filtered.filter((item) => {
          const jobStatus = item.latestRenderJob?.status;
          if (opts.status === 'rendered') return jobStatus === 'completed';
          if (opts.status === 'failed') return jobStatus === 'failed';
          // pending = not completed and not failed (includes no job, queued, processing)
          return jobStatus !== 'completed' && jobStatus !== 'failed';
        });
      }

      // Sort
      if (opts.sort === 'oldest') {
        filtered.sort((a, b) =>
          new Date(a.intent?.createdAt ?? 0).getTime() - new Date(b.intent?.createdAt ?? 0).getTime(),
        );
      } else if (opts.sort === 'title') {
        filtered.sort((a, b) =>
          (a.intent?.title ?? '').localeCompare(b.intent?.title ?? ''),
        );
      } else {
        // newest (default) — reverse chronological
        filtered.sort((a, b) =>
          new Date(b.intent?.createdAt ?? 0).getTime() - new Date(a.intent?.createdAt ?? 0).getTime(),
        );
      }

      // Limit
      if (opts.limit && opts.limit > 0) {
        filtered = filtered.slice(0, opts.limit);
      }

      if (filtered.length === 0) {
        console.log('No matching playlists found.');
        return;
      }

      const rows = filtered.map((item) => {
        const hasAudio =
          item.configs?.some((c) => c.latestRenderJob?.status === 'completed') ??
          item.latestRenderJob?.status === 'completed';
        return [
          item.intent?.id?.slice(0, 8) ?? '?',
          item.intent?.emoji ?? '',
          item.intent?.title ?? '(untitled)',
          item.intent?.sessionContext ?? '',
          String(item.latestAffirmationSet?.affirmationCount ?? 0),
          hasAudio ? 'yes' : 'no',
          item.latestRenderJob?.status ?? '-',
        ];
      });
      printTable(rows, ['ID', '', 'Title', 'Context', 'Affirmations', 'Audio', 'Render']);
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── info ───────────────────────────────────────────────────────────────────

program
  .command('info <intent-id>')
  .description('Show detailed info for a playlist')
  .action(async (intentId: string) => {
    const client = getUserClient();
    try {
      const resolvedId = await resolveIntentId(client, intentId);
      const { intent } = await client.getIntent(resolvedId);
      if (!intent) {
        console.error('Error: playlist not found');
        process.exit(1);
      }

      // Header
      console.log(`${intent.emoji ?? ''} ${intent.title}`.trim());
      console.log(`ID: ${intent.id}`);
      console.log(`Context: ${intent.sessionContext}`);
      if (intent.tonePreference) console.log(`Tone: ${intent.tonePreference}`);
      console.log(`Intent: ${intent.rawText}`);

      // Source metadata (#930, #993)
      if (intent.sourceType) {
        console.log();
        console.log('Source:');
        if (intent.sourceTitle) console.log(`  Title: ${intent.sourceTitle}`);
        if (intent.sourceAuthor) console.log(`  Author: ${intent.sourceAuthor}`);
        console.log(`  Type: ${intent.sourceType}`);
        if (intent.sourceUrl) console.log(`  URL: ${intent.sourceUrl}`);
        if (intent.sourceSummary) console.log(`  Summary: ${intent.sourceSummary}`);
      }
      console.log();

      // Affirmations
      const latestSet = intent.affirmationSets[0];
      if (latestSet) {
        const enabled = latestSet.affirmations.filter((a) => a.isEnabled).length;
        const total = latestSet.affirmations.length;
        console.log(`Affirmations: ${enabled} enabled / ${total} total`);
        const display = latestSet.affirmations.slice(0, 10);
        for (const a of display) {
          console.log(`  ${a.isEnabled ? '[x]' : '[ ]'} ${a.text}`);
        }
        if (total > 10) {
          console.log(`  ... and ${total - 10} more`);
        }
        console.log();
      }

      // Render config — scope to latest affirmation set to avoid showing stale configs
      const latestSetId = latestSet?.id;
      const scopedConfigs = latestSetId
        ? intent.renderConfigs.filter((c) => c.affirmationSetId === latestSetId)
        : intent.renderConfigs;
      const latestConfig = scopedConfigs[0] ?? intent.renderConfigs[0];
      if (latestConfig) {
        console.log('Render Config:');
        console.log(`  Voice: ${latestConfig.voiceId ?? latestConfig.voiceProvider}`);
        console.log(`  Duration: ${Math.round(latestConfig.durationSeconds / 60)} min`);
        console.log(`  Pace: ${latestConfig.paceWpm} wpm`);
        console.log(`  Preamble: ${latestConfig.includePreamble ? 'on' : 'off'}`);
        console.log(`  Repeats: ${latestConfig.affirmationRepeatCount}`);
        console.log(`  Play all: ${latestConfig.playAll ? 'on' : 'off'}`);
        if (latestConfig.backgroundAudioPath) {
          console.log(`  Background: ${latestConfig.backgroundAudioPath} (vol: ${latestConfig.backgroundVolume})`);
        }
        console.log();
      } else {
        console.log('Render Config: not configured');
        console.log(`  Configure with: nl render configure ${intent.id.slice(0, 8)} --voice <id> --context ${intent.sessionContext} --duration <min>`);
        console.log();
      }

      // Render status — check via render-status endpoint
      try {
        const status = await client.getRenderStatus(resolvedId);
        console.log(`Render Status: ${status.status}`);
        if (status.status === 'processing') console.log(`  Progress: ${status.progress}%`);
        if (status.errorMessage) console.log(`  Error: ${status.errorMessage}`);
      } catch (statusErr: unknown) {
        const msg = statusErr instanceof Error ? statusErr.message : String(statusErr);
        // 404 means no render config/job exists — expected for unconfigured sets
        if (msg.includes('404') || msg.includes('not found') || msg.includes('Not found')) {
          console.log('Render Status: none');
        } else {
          console.log(`Render Status: unknown (${msg})`);
        }
      }

      // Framework (#749) — one-liner status, full render via `nl guide <id>`.
      const framework = latestSet?.framework ?? null;
      if (hasFramework(framework)) {
        const schemaV = extractFrameworkSchemaVersion(framework);
        const takeaway = extractFrameworkTakeaway(framework);
        const schemaLabel = schemaV !== null ? `schema v${schemaV}` : 'schema unversioned';
        if (takeaway) {
          console.log(`Framework: yes (${schemaLabel}) — "${takeaway}"`);
        } else {
          console.log(`Framework: yes (${schemaLabel})`);
        }
        console.log(`  Full render: nl guide ${intent.id.slice(0, 8)}`);
      } else {
        console.log('Framework: none (legacy or second-person set)');
      }

      // Timestamps
      console.log(`Created: ${new Date(intent.createdAt).toLocaleString()}`);
      console.log(`Updated: ${new Date(intent.updatedAt).toLocaleString()}`);
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── guide ──────────────────────────────────────────────────────────────────

program
  .command('guide <intent-id>')
  .description('Print the framework (methodology, principles, sources, groupings, practical application, takeaway) as markdown. Returns a clean fallback for legacy sets that have no framework.')
  .action(async (intentId: string) => {
    const client = getUserClient();
    try {
      const resolvedId = await resolveIntentId(client, intentId);
      const { intent } = await client.getIntent(resolvedId);
      if (!intent) {
        console.error('Error: playlist not found');
        process.exit(1);
      }
      const framework = intent.affirmationSets[0]?.framework ?? null;
      process.stdout.write(renderFrameworkMarkdown(framework));
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── rename ─────────────────────────────────────────────────────────────────

program
  .command('rename <intent-id>')
  .description('Rename a playlist')
  .option('--title <title>', 'New title')
  .option('--emoji <emoji>', 'New emoji')
  .action(async (intentId: string, opts: { title?: string; emoji?: string }) => {
    if (!opts.title && !opts.emoji) {
      console.error('Error: at least one of --title or --emoji must be provided');
      process.exit(1);
    }

    const client = getUserClient();
    try {
      const resolvedId = await resolveIntentId(client, intentId);
      const input: { title?: string; emoji?: string | null } = {};
      if (opts.title) input.title = opts.title;
      if (opts.emoji !== undefined) input.emoji = opts.emoji;
      const { intent } = await client.updateIntent(resolvedId, input);
      console.log(`Updated: ${intent.emoji ?? ''} ${intent.title}`.trim());
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── rerender ───────────────────────────────────────────────────────────────

program
  .command('rerender <intent-id>')
  .description('Re-render a playlist with its current config')
  .option('--wait', 'Wait for the render to complete')
  .action(async (intentId: string, opts: { wait?: boolean }) => {
    const client = getUserClient();
    try {
      const resolvedId = await resolveIntentId(client, intentId);

      // Check if render config exists
      const { intent } = await client.getIntent(resolvedId);
      if (!intent) {
        console.error('Error: playlist not found');
        process.exit(1);
      }
      if (!intent.renderConfigs || intent.renderConfigs.length === 0) {
        console.error('Error: no render config found. Configure first with:');
        console.error(`  nl render configure ${intent.id.slice(0, 8)} --voice <id> --context ${intent.sessionContext} --duration <min>`);
        process.exit(1);
      }

      console.error(`Re-rendering: ${intent.emoji ?? ''} ${intent.title}`.trim());
      const result = await client.startRender(resolvedId);

      if (!opts.wait) {
        console.log(`Render queued (job: ${result.jobId})`);
        return;
      }

      const { jobId } = result;
      console.error(`Render queued (job: ${jobId}). Waiting for completion...`);

      let elapsedMs = 0;
      const POLL_INITIAL_MS = 3000;
      const POLL_BACKOFF_AFTER_MS = 30000;
      const POLL_BACKOFF_MS = 6000;

      for (;;) {
        const intervalMs = elapsedMs >= POLL_BACKOFF_AFTER_MS ? POLL_BACKOFF_MS : POLL_INITIAL_MS;
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
        elapsedMs += intervalMs;

        let status: RenderStatus;
        try {
          status = await client.getRenderStatus(resolvedId);
        } catch (pollErr: unknown) {
          console.error(`Warning: status poll failed — ${pollErr instanceof Error ? pollErr.message : String(pollErr)}`);
          continue;
        }

        if (status.jobId === undefined) {
          console.error('Warning: render status has no active job. Exiting --wait.');
          printResult(status);
          return;
        }

        if (status.jobId !== jobId) {
          console.error(`Warning: render status is now tracking a different job (${status.jobId}). Exiting --wait.`);
          printResult(status);
          return;
        }

        console.error(`  [${Math.round(elapsedMs / 1000)}s] status=${status.status} progress=${status.progress}%`);

        if (status.status === 'completed') {
          console.log('Render complete.');
          return;
        }
        if (status.status === 'failed') {
          console.error(`Render failed: ${status.errorMessage ?? 'unknown error'}`);
          process.exit(1);
        }
      }
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── create ─────────────────────────────────────────────────────────────────

program
  .command('create [text]')
  .description('Create a new playlist. Provide intent text, source material (--source-text, --source-url, --source-pdf, or --source-youtube), or both.')
  .option('--tone <tone>', 'Tone preference: grounded, open, or mystical')
  .option('--source-text <text>', 'Source material text (book excerpt, article, etc.). Use "-" to read from stdin.')
  .option('--source-url <url>', 'URL of a web article. Server extracts the text automatically.')
  .option('--source-pdf <path>', 'Path to a PDF file. Server extracts text automatically.')
  .option('--source-youtube <url>', 'YouTube video URL. Extracts the transcript (captions) automatically.')
  .option('--source-title <title>', 'Title of the source material')
  .option('--source-author <author>', 'Author of the source material')
  .option('--no-stream', 'Use the blocking endpoint (legacy behavior)')
  .option('--stream-text', 'Render the framework text progressively (alias: --verbose)')
  .option('--verbose', 'Alias for --stream-text')
  .option('--idempotency-key <uuid>', 'Client idempotency key (auto-generated if omitted)')
  .action(async (text: string | undefined, opts: {
    tone?: string;
    sourceText?: string;
    sourceUrl?: string;
    sourcePdf?: string;
    sourceYoutube?: string;
    sourceTitle?: string;
    sourceAuthor?: string;
    stream: boolean;
    streamText?: boolean;
    verbose?: boolean;
    idempotencyKey?: string;
  }) => {
    if (opts.tone && !VALID_TONES.includes(opts.tone)) {
      console.error(`Error: --tone must be one of: ${VALID_TONES.join(', ')}`);
      process.exit(1);
    }

    // #993/#999/#1001 — source options are mutually exclusive
    const sourceFlags = [opts.sourceText, opts.sourceUrl, opts.sourcePdf, opts.sourceYoutube].filter(Boolean);
    if (sourceFlags.length > 1) {
      console.error('Error: --source-text, --source-url, --source-pdf, and --source-youtube are mutually exclusive. Use one at a time.');
      process.exit(1);
    }

    // Read source text from stdin if "-" is specified
    let sourceText = opts.sourceText;
    if (sourceText === '-') {
      if (process.stdin.isTTY) {
        console.error('Error: --source-text - requires piped input (e.g. cat file.txt | nl create --source-text -)');
        process.exit(1);
      }
      sourceText = await readStdin();
    }

    // Validate: at least one of text, sourceText, sourceUrl, sourcePdf, or sourceYoutube required
    if (!text && !sourceText && !opts.sourceUrl && !opts.sourcePdf && !opts.sourceYoutube) {
      console.error('Error: provide intent text, --source-text, --source-url, --source-pdf, --source-youtube, or a combination.');
      console.error('  Usage: nl create "my intent"');
      console.error('         nl create --source-text "source material..."');
      console.error('         nl create --source-url "https://example.com/article"');
      console.error('         nl create --source-pdf chapter.pdf');
      console.error('         nl create --source-youtube "https://youtube.com/watch?v=..."');
      console.error('         cat file.txt | nl create --source-text -');
      process.exit(1);
    }

    // Validate source text length
    if (sourceText && sourceText.length > 16_000) {
      console.error(`Error: source text is too long (${sourceText.length.toLocaleString()} chars). Maximum is 16,000 characters.`);
      process.exit(1);
    }

    // Validate URL format
    if (opts.sourceUrl) {
      try {
        const url = new URL(opts.sourceUrl);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          console.error('Error: --source-url must be an HTTP or HTTPS URL.');
          process.exit(1);
        }
      } catch {
        console.error('Error: --source-url is not a valid URL.');
        process.exit(1);
      }
    }

    // #1001 — Validate YouTube URL format (must be a video URL, not channel/playlist)
    if (opts.sourceYoutube) {
      try {
        const url = new URL(opts.sourceYoutube);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          console.error('Error: --source-youtube must be an HTTP or HTTPS URL.');
          process.exit(1);
        }
        const validHosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'];
        if (!validHosts.includes(url.hostname)) {
          console.error('Error: --source-youtube must be a YouTube URL (youtube.com or youtu.be).');
          process.exit(1);
        }
        // Check that the URL points to a video (watch?v=, youtu.be/ID, shorts/ID)
        const videoIdPattern = /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|watch\?[^#]*v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        if (!videoIdPattern.test(opts.sourceYoutube)) {
          console.error('Error: --source-youtube must be a YouTube video URL (e.g. youtube.com/watch?v=..., youtu.be/..., or youtube.com/shorts/...).');
          console.error('Channel, playlist, and other YouTube URLs are not supported.');
          process.exit(1);
        }
      } catch {
        console.error('Error: --source-youtube is not a valid URL.');
        process.exit(1);
      }
    }

    // #999 — Validate and upload PDF file
    let pdfExtractedText: string | undefined;
    if (opts.sourcePdf) {
      const { readFileSync, statSync: fsStat, existsSync: fsExists } = await import('node:fs');
      const pdfPath = opts.sourcePdf;
      if (!fsExists(pdfPath)) {
        console.error(`Error: file not found: ${pdfPath}`);
        process.exit(1);
      }
      const stats = fsStat(pdfPath);
      if (stats.size > 10 * 1024 * 1024) {
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
        console.error(`Error: PDF file is too large (${sizeMB} MB). Maximum is 10 MB.`);
        process.exit(1);
      }

      const pdfBuffer = readFileSync(pdfPath);
      const pdfClient = getUserClient();
      try {
        console.log(`\nExtracting text from PDF...`);
        const preview = await pdfClient.uploadPdf(pdfBuffer);
        console.log(`  Pages:  ${preview.pageCount}`);
        console.log(`  Length: ${preview.charCount.toLocaleString()} chars`);
        if (preview.truncated) {
          console.log(`  Text was truncated to 16,000 characters.`);
        }
        console.log('');
        pdfExtractedText = preview.text;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: could not extract text from PDF — ${msg}`);
        process.exit(1);
      }
    }

    // Build source object
    const source: { type: string; text?: string; url?: string; title?: string; author?: string } | undefined =
      sourceText
        ? {
            type: 'text' as const,
            text: sourceText,
            ...(opts.sourceTitle ? { title: opts.sourceTitle } : {}),
            ...(opts.sourceAuthor ? { author: opts.sourceAuthor } : {}),
          }
        : opts.sourceUrl
          ? {
              type: 'url' as const,
              url: opts.sourceUrl,
              ...(opts.sourceTitle ? { title: opts.sourceTitle } : {}),
              ...(opts.sourceAuthor ? { author: opts.sourceAuthor } : {}),
            }
          : opts.sourceYoutube
            ? {
                type: 'youtube' as const,
                url: opts.sourceYoutube,
                ...(opts.sourceTitle ? { title: opts.sourceTitle } : {}),
                ...(opts.sourceAuthor ? { author: opts.sourceAuthor } : {}),
              }
            : pdfExtractedText
              ? {
                  type: 'pdf' as const,
                  text: pdfExtractedText,
                  ...(opts.sourceTitle ? { title: opts.sourceTitle } : {}),
                  ...(opts.sourceAuthor ? { author: opts.sourceAuthor } : {}),
                }
              : undefined;

    const client = getUserClient();

    // #993 — Show extraction preview for URL sources before generating.
    if (source?.type === 'url' && source.url) {
      try {
        console.log(`\nFetching article from URL...`);
        const preview = await client.extractUrlPreview(source.url);
        console.log(`  Title:  ${preview.title || '(untitled)'}`);
        if (preview.author) console.log(`  Author: ${preview.author}`);
        console.log(`  Length: ${preview.charCount.toLocaleString()} chars`);
        if (preview.truncated) {
          console.log(`  Article was truncated to 16,000 characters.`);
        }
        console.log('');
      } catch (err) {
        // Preview failure is not fatal — the generate endpoint will also
        // validate the URL. Surface the error and let the user decide.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Warning: could not preview URL — ${msg}`);
        console.error('Proceeding with generation...\n');
      }
    }

    // #1001 — Show extraction preview for YouTube sources before generating.
    if (source?.type === 'youtube' && source.url) {
      try {
        console.log(`\nExtracting transcript from YouTube...`);
        const preview = await client.extractYoutubePreview(source.url);
        console.log(`  Title:   ${preview.title || '(untitled)'}`);
        if (preview.channelName) console.log(`  Channel: ${preview.channelName}`);
        console.log(`  Length:  ${preview.charCount.toLocaleString()} chars`);
        if (preview.truncated) {
          console.log(`  Transcript was truncated to 16,000 characters.`);
        }
        console.log('');
      } catch (err) {
        // Preview failure is not fatal — the generate endpoint will also
        // extract the transcript. Surface the error and let the user decide.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Warning: could not preview YouTube transcript — ${msg}`);
        console.error('Proceeding with generation...\n');
      }
    }

    // Commander's --no-stream flag sets opts.stream = false; default is true.
    if (opts.stream === false) {
      await runBlockingCreate(client, text, opts.tone, source);
      return;
    }

    const code = await runStreamingCreate(client, text, {
      ...opts,
      ...(source ? { source } : {}),
    });
    if (code !== 0) process.exit(code);
  });

/**
 * Optional dev-observability telemetry sink for the StreamRenderer.
 * When `NL_STREAM_TELEMETRY=1` is set, the renderer emits
 * `cli.generation.phase.*` lines to stderr (#862 acceptance:
 * "CLI emits its own cli.generation.phase.* events for dev observability").
 * Returns `undefined` when the env var isn't set so the CLI can spread
 * `...streamTelemetrySink()` without wrapping each call.
 */
function streamTelemetrySink():
  | { telemetry: (event: string, details: Record<string, unknown>) => void }
  | Record<string, never> {
  if (process.env['NL_STREAM_TELEMETRY'] !== '1') return {};
  return {
    telemetry: (event: string, details: Record<string, unknown>): void => {
      process.stderr.write(`[telemetry] ${event} ${JSON.stringify(details)}\n`);
    },
  };
}

/**
 * Blocking-create path — same behavior as before streaming shipped. Kept
 * in its own function so `--no-stream` and the 404-fallback path can
 * both reach it.
 */
async function runBlockingCreate(
  client: UserApiClient,
  text: string | undefined,
  tone: string | undefined,
  source?: { type: string; text?: string; url?: string; title?: string; author?: string },
): Promise<void> {
  console.error('Creating playlist (this may take 10-30 seconds)...');
  try {
    const result = await runCreateWithRateLimitRetry(() =>
      client.createAndGenerateWithMeta(text, tone, source),
    );
    const { intent, affirmationSet } = result.data;
    console.log(`\nCreated: ${intent.emoji ?? ''} ${intent.title}`);
    console.log(`Intent ID: ${intent.id}`);
    console.log(`Context: ${intent.sessionContext}`);
    console.log(`\nAffirmations (${affirmationSet.affirmations.length}):`);
    for (const a of affirmationSet.affirmations) {
      console.log(`  ${a.isEnabled ? '[x]' : '[ ]'} ${a.text}`);
    }
    if (result.rateLimit !== undefined) {
      console.log(
        `\nQuota: ${result.rateLimit.remaining}/${result.rateLimit.limit} remaining this hour.`,
      );
    }
    console.log(`\nNext: configure and render with \`nl render ${intent.id}\``);
  } catch (err: unknown) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Streaming-create path — opens the SSE endpoint, renders progressive
 * phase events. Returns the exit code.
 */
async function runStreamingCreate(
  client: UserApiClient,
  text: string | undefined,
  opts: {
    tone?: string;
    source?: { type: string; text?: string; url?: string; title?: string; author?: string };
    streamText?: boolean;
    verbose?: boolean;
    idempotencyKey?: string;
  },
): Promise<number> {
  // Pre-flight auth refresh — cheap JWT decode; refresh only if expiring soon.
  await client.refreshIfExpiringSoon();

  const idempotencyKey = opts.idempotencyKey ?? randomUUID();
  const streamText = Boolean(opts.streamText || opts.verbose);
  const renderer = new StreamRenderer({
    streamText,
    stdout: process.stdout,
    stderr: process.stderr,
    operation: 'create',
    ...streamTelemetrySink(),
  });

  let fallbackTriggered = false;

  const handlers: GenerationStreamHandlers = {
    onEvent: (event: StreamingProtocolEvent) => renderer.onEvent(event),
    onFallback: () => {
      fallbackTriggered = true;
      renderer.onFallback();
    },
    onError: (err: StreamError) => renderer.onError(err),
  };

  const stream = openGenerationStream(
    {
      request: {
        kind: 'generate',
        ...(text ? { intentText: text } : {}),
        ...(opts.tone ? { tonePreference: opts.tone } : {}),
        ...(opts.source ? { source: opts.source } : {}),
      },
      clientIdempotencyKey: idempotencyKey,
      apiBaseUrl: client.getBaseUrl(),
      getAccessToken: () => client.getAccessToken(),
    },
    handlers,
  );

  const sigintHandler = (): void => {
    stream.abort();
    renderer.cleanup();
    process.exit(130);
  };
  process.once('SIGINT', sigintHandler);

  try {
    await stream.done;
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    renderer.cleanup();
  }

  if (fallbackTriggered) {
    await runBlockingCreate(client, text, opts.tone, opts.source);
    return 0;
  }
  return renderer.summary().exitCode;
}

/**
 * Retry wrapper for `nl create`. Retries exactly once on 429 using the
 * server-suggested wait. Per #855 the CLI honors whatever the server says
 * via `Retry-After` rather than inventing its own backoff math.
 *
 * For short waits (< 60s, burst-cap hit) a single sleep is fine. For long
 * waits (hourly-cap hit), we print a heads-up at the start plus a
 * heartbeat every 30s so the user sees the CLI is alive — they can
 * Ctrl-C at any time if they'd rather come back later. The retry is
 * "once": if the second attempt also gets 429, the error propagates.
 */
async function runCreateWithRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (!isRateLimitedError(err)) throw err;
    // Only auto-retry honest rate-limit 429s. Other 429 paths on the same
    // endpoint (e.g. abuse soft-ban) are not time-boxed — retrying just
    // loses another minute and hides the real message. Propagate them so
    // the CLI's top-level error handler shows the server's error string.
    if (err.source !== 'rate_limit') throw err;
    const waitSec = Math.ceil(err.retryAfterMs / 1000);
    const resetLocal =
      err.resetAt !== null ? new Date(err.resetAt).toLocaleTimeString() : 'shortly';

    if (waitSec > 60) {
      const minutes = Math.ceil(waitSec / 60);
      console.error(
        `  Rate limit hit. Capacity returns around ${resetLocal} (in ${minutes} minutes).`,
      );
      console.error(
        `  Waiting for the server-suggested cooldown. Press Ctrl-C to cancel and retry later.`,
      );
    } else {
      console.error(`  Rate limit hit — retrying in ${waitSec}s (server-suggested wait)...`);
    }

    await sleepWithHeartbeat(err.retryAfterMs, 30_000);
    return fn();
  }
}

/** Sleep for `totalMs`, emitting a progress line every `heartbeatMs`.
 *  Waits shorter than heartbeatMs sleep once with no heartbeat. */
async function sleepWithHeartbeat(totalMs: number, heartbeatMs: number): Promise<void> {
  if (totalMs <= heartbeatMs) {
    await new Promise((r) => setTimeout(r, totalMs));
    return;
  }
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const chunk = Math.min(remaining, heartbeatMs);
    await new Promise((r) => setTimeout(r, chunk));
    const left = Math.max(0, deadline - Date.now());
    if (left > 0) {
      const mm = Math.ceil(left / 60_000);
      console.error(`  ... still waiting (${mm} min remaining)`);
    }
  }
}

function isRateLimitedError(err: unknown): err is Error & {
  status: 429;
  resetAt: number | null;
  retryAfterMs: number;
  source?: string;
} {
  return err instanceof Error && (err as { status?: number }).status === 429;
}

// ─── resume ─────────────────────────────────────────────────────────────────

program
  .command('resume <intent-id>')
  .description('Resume Pass 2 for a framework-only playlist (or re-run the composition step)')
  .option('--no-stream', 'Use the blocking endpoint')
  .option('--stream-text', 'Render progressive output')
  .option('--verbose', 'Alias for --stream-text')
  .option('--idempotency-key <uuid>', 'Client idempotency key (auto-generated if omitted)')
  .action(async (intentId: string, opts: {
    stream: boolean;
    streamText?: boolean;
    verbose?: boolean;
    idempotencyKey?: string;
  }) => {
    const client = getUserClient();
    const resolvedId = await resolveIntentId(client, intentId);

    if (opts.stream === false) {
      const code = await runBlockingResume(client, resolvedId, opts.idempotencyKey);
      if (code !== 0) process.exit(code);
      return;
    }

    const code = await runStreamingResume(client, resolvedId, opts);
    if (code !== 0) process.exit(code);
  });

async function runBlockingResume(
  client: UserApiClient,
  intentId: string,
  idempotencyKeyOpt: string | undefined,
): Promise<number> {
  const idempotencyKey = idempotencyKeyOpt ?? randomUUID();
  let outcome: ResumeBlockingOutcome;
  try {
    outcome = await client.resumeIntent(intentId, idempotencyKey);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const renderer = new StreamRenderer({
    streamText: false,
    stdout: process.stdout,
    stderr: process.stderr,
    operation: 'resume',
    ...streamTelemetrySink(),
  });
  renderer.onResumeBlockingOutcome(outcome);
  renderer.cleanup();
  return renderer.summary().exitCode;
}

async function runStreamingResume(
  client: UserApiClient,
  intentId: string,
  opts: { streamText?: boolean; verbose?: boolean; idempotencyKey?: string },
): Promise<number> {
  await client.refreshIfExpiringSoon();

  const idempotencyKey = opts.idempotencyKey ?? randomUUID();
  const streamText = Boolean(opts.streamText || opts.verbose);
  const renderer = new StreamRenderer({
    streamText,
    stdout: process.stdout,
    stderr: process.stderr,
    operation: 'resume',
    ...streamTelemetrySink(),
  });

  let fallbackTriggered = false;

  const handlers: GenerationStreamHandlers = {
    onEvent: (event) => renderer.onEvent(event),
    onFallback: () => {
      fallbackTriggered = true;
      renderer.onFallback();
    },
    onError: (err) => renderer.onError(err),
    onResumeBlockingOutcome: (outcome) => renderer.onResumeBlockingOutcome(outcome),
  };

  const stream = openGenerationStream(
    {
      request: { kind: 'resume', resumeIntentId: intentId },
      clientIdempotencyKey: idempotencyKey,
      apiBaseUrl: client.getBaseUrl(),
      getAccessToken: () => client.getAccessToken(),
    },
    handlers,
  );

  const sigintHandler = (): void => {
    stream.abort();
    renderer.cleanup();
    process.exit(130);
  };
  process.once('SIGINT', sigintHandler);

  try {
    await stream.done;
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    renderer.cleanup();
  }

  if (fallbackTriggered) {
    return runBlockingResume(client, intentId, idempotencyKey);
  }
  return renderer.summary().exitCode;
}

// ─── download ───────────────────────────────────────────────────────────────

program
  .command('download <render-job-id>')
  .description('Download rendered audio as MP3')
  .option('-o, --output <path>', 'Output file path (default: nl-<id>.mp3)')
  .action(async (renderJobId: string, opts: { output?: string }) => {
    const client = getUserClient();

    try {
      const audio = await client.getAudio(renderJobId);
      const outPath = opts.output ?? `nl-${renderJobId.slice(0, 8)}.mp3`;
      writeFileSync(outPath, audio);
      console.log(`Saved: ${outPath} (${(audio.length / 1024).toFixed(0)} KB)`);
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── credits ────────────────────────────────────────────────────────────────

program
  .command('credits')
  .description('Show credit balance and recent transactions')
  .action(async () => {
    const client = getUserClient();

    try {
      const [{ user }, { transactions }] = await Promise.all([
        client.getMe(),
        client.getCreditTransactions(10),
      ]);

      console.log(`Credit Balance: ${user.creditBalance}`);
      console.log(`  Subscription: ${user.subscriptionCredits}`);
      console.log(`  Purchased:    ${user.purchasedCredits}`);

      if (transactions.length > 0) {
        console.log(`\nRecent transactions:`);
        const rows = transactions.map((t) => [
          new Date(t.createdAt).toLocaleDateString(),
          t.type,
          t.amount > 0 ? `+${t.amount}` : String(t.amount),
          String(t.balanceAfter),
        ]);
        printTable(rows, ['Date', 'Type', 'Amount', 'Balance']);
      }
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── play ──────────────────────────────────────────────────────────────────

const AUDIO_CACHE_DIR = join(homedir(), '.config', 'neuralingual', 'audio');

program
  .command('play <intent-id>')
  .description('Download rendered audio (prints file path). Use --open to launch in default player.')
  .option('--no-cache', 'Skip cache, always re-download')
  .option('--open', 'Open in the platform default audio player (non-blocking)')
  .action(async (intentId: string, opts: { cache: boolean; open?: boolean }) => {
    const client = getUserClient();

    try {
      // Resolve short/partial ID to full ID, then find the library item for render info
      const resolvedId = await resolveIntentId(client, intentId);
      const { items } = await client.getLibrary();
      const item = items.find((i) => i.intent.id === resolvedId);
      if (!item) {
        console.error('Error: playlist not found in your library');
        process.exit(1);
      }
      const renderJob = item.latestRenderJob;
      if (!renderJob?.id) {
        console.error('Error: no rendered audio available. Run `nl render start` first.');
        process.exit(1);
      }
      if (renderJob.status !== 'completed') {
        console.error(`Error: render is ${renderJob.status ?? 'not started'}, not ready to play`);
        process.exit(1);
      }

      const title = `${item.intent.emoji ?? ''} ${item.intent.title ?? '(untitled)'}`;

      // Check cache
      const cacheFile = join(AUDIO_CACHE_DIR, `${renderJob.id}.mp3`);
      let cached = false;
      if (opts.cache && existsSync(cacheFile)) {
        cached = true;
      } else {
        console.log(`Downloading: ${title}...`);
        const audio = await client.getAudio(renderJob.id);
        mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
        writeFileSync(cacheFile, audio);
      }

      if (opts.open) {
        // Open in platform default audio player, non-blocking
        const opener = process.platform === 'darwin' ? 'open'
          : process.platform === 'win32' ? 'start' : 'xdg-open';
        const args = process.platform === 'win32' ? ['""', cacheFile] : [cacheFile];
        const child = spawn(opener, args, { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
        child.on('error', () => {
          console.error(`Failed to open audio player. File is at: ${cacheFile}`);
        });
        child.unref();
        console.log(`Opened: ${cacheFile}`);
      } else {
        // Default: print the file path and return immediately
        console.log(`${cached ? 'Cached' : 'Downloaded'}: ${cacheFile}`);
      }
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── share ─────────────────────────────────────────────────────────────────

program
  .command('share <intent-id>')
  .description('Generate a share link for a playlist')
  .action(async (intentId: string) => {
    const client = getUserClient();
    try {
      const resolvedId = await resolveIntentId(client, intentId);
      const result = await client.shareIntent(resolvedId);
      console.log(`Share URL: ${result.shareUrl}`);
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── delete ────────────────────────────────────────────────────────────────

/** Prompt the user for input on stdin. */
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Parse a duration string like "7d", "30d", "2w" into an ISO date string
 * representing `now - duration`.
 */
function parseDurationToIsoDate(duration: string): string {
  const match = duration.match(/^(\d+)([dwDW])$/);
  if (!match) {
    throw new Error(`Invalid duration "${duration}". Use format like "7d" (days) or "2w" (weeks).`);
  }
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  const days = unit === 'w' ? value * 7 : value;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return cutoff.toISOString();
}

interface LibraryItemForFilter {
  intent: { id: string; title: string; emoji: string | null; sessionContext: string };
  latestRenderJob: { status: string } | null;
  configs?: Array<{ latestRenderJob: { status: string } | null }>;
  stats?: { playCount: number; lastPlayedAt: string | null };
}

/**
 * Fetch library items matching the given filter criteria.
 * Uses server-side filtering via query params where possible.
 */
async function getFilteredLibraryItems(
  client: UserApiClient,
  filter?: string,
  notPlayedSince?: string,
): Promise<LibraryItemForFilter[]> {
  const params: LibraryQueryParams = {};

  // Map CLI filter names to API filter param
  if (filter === 'no-audio' || filter === 'has-audio' || filter === 'never-played') {
    params.filter = filter as LibraryFilter;
  }

  // Parse duration for not-played-since
  if (notPlayedSince) {
    params.notPlayedSince = parseDurationToIsoDate(notPlayedSince);
  }

  const { items } = await client.getLibrary(params);
  return items;
}

/** Print a table of library items for confirmation display. */
function printFilteredItems(items: LibraryItemForFilter[]): void {
  const rows = items.map((item) => {
    const hasAudio =
      item.configs?.some((c) => c.latestRenderJob?.status === 'completed') ??
      item.latestRenderJob?.status === 'completed';
    return [
      item.intent.id.slice(0, 8),
      item.intent.emoji ?? '',
      item.intent.title ?? '(untitled)',
      item.intent.sessionContext,
      hasAudio ? 'yes' : 'no',
      String(item.stats?.playCount ?? 0),
      item.stats?.lastPlayedAt ? new Date(item.stats.lastPlayedAt).toLocaleDateString() : 'never',
    ];
  });
  printTable(rows, ['ID', '', 'Title', 'Context', 'Audio', 'Plays', 'Last Played']);
}

program
  .command('delete [intent-id]')
  .description('Delete playlists from your library. Pass an ID for single delete, or use filters for bulk delete.')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('--filter <filter>', 'Filter: no-audio, has-audio, never-played')
  .option('--not-played-since <duration>', 'Delete sets not played in N days/weeks (e.g. 7d, 2w)')
  .action(async (intentId: string | undefined, opts: { force?: boolean; filter?: string; notPlayedSince?: string }) => {
    const hasFilters = opts.filter !== undefined || opts.notPlayedSince !== undefined;

    if (intentId && hasFilters) {
      console.error('Error: provide either an intent ID or filter flags, not both.');
      process.exit(1);
    }
    if (!intentId && !hasFilters) {
      console.error('Error: provide an intent ID or use filter flags (--filter, --not-played-since).');
      console.error('  Examples:');
      console.error('    nl delete abc12345');
      console.error('    nl delete --filter no-audio');
      console.error('    nl delete --not-played-since 7d');
      process.exit(1);
    }

    const validFilters = ['no-audio', 'has-audio', 'never-played'];
    if (opts.filter && !validFilters.includes(opts.filter)) {
      console.error(`Error: --filter must be one of: ${validFilters.join(', ')}`);
      process.exit(1);
    }

    const client = getUserClient();

    try {
      // Single-ID delete (backward compatible)
      if (intentId) {
        const resolvedId = await resolveIntentId(client, intentId);
        if (!opts.force) {
          const { items } = await client.getLibrary();
          const item = items.find((i) => i.intent.id === resolvedId);
          const name = item ? `'${item.intent.title ?? '(untitled)'}'` : resolvedId;
          const answer = await prompt(`Delete ${name}? This cannot be undone. (y/N) `);
          if (answer.toLowerCase() !== 'y') {
            console.log('Cancelled.');
            return;
          }
        }
        await client.deleteIntent(resolvedId);
        console.log('Deleted.');
        return;
      }

      // Filter-based bulk delete
      const items = await getFilteredLibraryItems(client, opts.filter, opts.notPlayedSince);

      if (items.length === 0) {
        console.log('No matching playlists found.');
        return;
      }

      console.log(`Found ${items.length} matching playlist(s):\n`);
      printFilteredItems(items);
      console.log();

      if (!opts.force) {
        const answer = await prompt(`Delete ${items.length} set(s)? This cannot be undone. (y/N) `);
        if (answer.toLowerCase() !== 'y') {
          console.log('Cancelled.');
          return;
        }
      }

      // Bulk delete in batches of 50
      const ids = items.map((i) => i.intent.id);
      let totalDeleted = 0;
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        const result = await client.bulkDeleteIntents(batch);
        totalDeleted += result.deleted;
      }
      console.log(`Deleted ${totalDeleted} playlist(s).`);
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── cleanup (dry-run) ────────────────────────────────────────────────────

program
  .command('cleanup')
  .description('Preview which playlists would be deleted by a filter (dry run — does not delete)')
  .option('--filter <filter>', 'Filter: no-audio, has-audio, never-played')
  .option('--not-played-since <duration>', 'Sets not played in N days/weeks (e.g. 7d, 2w)')
  .action(async (opts: { filter?: string; notPlayedSince?: string }) => {
    if (!opts.filter && !opts.notPlayedSince) {
      console.error('Error: provide at least one filter (--filter, --not-played-since).');
      console.error('  Examples:');
      console.error('    nl cleanup --filter no-audio');
      console.error('    nl cleanup --not-played-since 30d');
      console.error('    nl cleanup --filter never-played --not-played-since 7d');
      process.exit(1);
    }

    const validFilters = ['no-audio', 'has-audio', 'never-played'];
    if (opts.filter && !validFilters.includes(opts.filter)) {
      console.error(`Error: --filter must be one of: ${validFilters.join(', ')}`);
      process.exit(1);
    }

    const client = getUserClient();

    try {
      const items = await getFilteredLibraryItems(client, opts.filter, opts.notPlayedSince);

      if (items.length === 0) {
        console.log('No matching playlists found.');
        return;
      }

      console.log(`Found ${items.length} matching playlist(s):\n`);
      printFilteredItems(items);

      // Build the equivalent delete command
      const parts = ['nl delete'];
      if (opts.filter) parts.push(`--filter ${opts.filter}`);
      if (opts.notPlayedSince) parts.push(`--not-played-since ${opts.notPlayedSince}`);
      console.log(`\nTo delete these, run:\n  ${parts.join(' ')}`);
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── settings ──────────────────────────────────────────────────────────────

const settingsCmd = program.command('settings').description('View and update user settings');

settingsCmd
  .command('show', { isDefault: true })
  .description('Show current settings')
  .action(async () => {
    const client = getUserClient();
    try {
      const [{ user }, { settings: ctxSettings }] = await Promise.all([
        client.getMe(),
        client.getContextSettings(),
      ]);

      console.log('User Settings');
      console.log(`  Tone preference: ${user.tonePreference ?? 'default'}`);
      console.log(`  Display name:    ${user.displayName ?? '(not set)'}`);

      if (ctxSettings.length > 0) {
        console.log('\nContext Overrides');
        const rows = ctxSettings.map((s) => [
          s.sessionContext,
          s.paceWpm != null ? String(s.paceWpm) : '-',
          s.pauseMs != null ? String(s.pauseMs) : '-',
          s.durationMinutes != null ? String(s.durationMinutes) : '-',
          s.repeatCount != null ? String(s.repeatCount) : '-',
          s.backgroundVolume != null ? String(s.backgroundVolume) : '-',
        ]);
        printTable(rows, ['Context', 'Pace (wpm)', 'Pause (ms)', 'Duration', 'Repeats', 'BG Volume']);
      }
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

settingsCmd
  .command('set')
  .description('Update settings')
  .option('--tone <tone>', 'Tone preference: grounded, open, or mystical')
  .option('--name <name>', 'Display name')
  .action(async (opts: { tone?: string; name?: string }) => {
    if (!opts.tone && !opts.name) {
      console.error('Error: at least one of --tone or --name must be provided');
      process.exit(1);
    }
    if (opts.tone && !VALID_TONES.includes(opts.tone)) {
      console.error(`Error: --tone must be one of: ${VALID_TONES.join(', ')}`);
      process.exit(1);
    }

    const client = getUserClient();
    try {
      const data: { tonePreference?: string; displayName?: string } = {};
      if (opts.tone) data.tonePreference = opts.tone;
      if (opts.name) data.displayName = opts.name;
      const { user } = await client.updateProfile(data);
      console.log('Settings updated.');
      console.log(`  Tone preference: ${user.tonePreference ?? 'default'}`);
      console.log(`  Display name:    ${user.displayName ?? '(not set)'}`);
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── library search ────────────────────────────────────────────────────────

program
  .command('search <query>')
  .description('Search your library by title or context')
  .action(async (query: string) => {
    const client = getUserClient();
    try {
      const { items } = await client.getLibrary();
      const q = query.toLowerCase();
      const matches = items.filter(
        (item) =>
          (item.intent.title ?? '').toLowerCase().includes(q) ||
          (item.intent.sessionContext ?? '').toLowerCase().includes(q),
      );

      if (matches.length === 0) {
        console.log(`No matches for "${query}".`);
        return;
      }

      const rows = matches.map((item) => [
        item.intent.id?.slice(0, 8) ?? '?',
        item.intent.emoji ?? '',
        item.intent.title ?? '(untitled)',
        item.intent.sessionContext ?? '-',
        String(item.latestAffirmationSet?.affirmationCount ?? 0),
        item.latestRenderJob?.status === 'completed' ? 'yes' : 'no',
        item.latestRenderJob?.status ?? '-',
      ]);
      printTable(rows, ['ID', '', 'Title', 'Context', 'Affirmations', 'Audio', 'Render']);
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── library view (#2209) ──────────────────────────────────────────────────

program
  .command('view <intent-id>')
  .description('View a playlist with affirmations, render status, and play stats')
  .action(async (intentId: string) => {
    const client = getUserClient();
    try {
      const resolvedId = await resolveIntentId(client, intentId);
      const { intent, stats } = await client.getIntent(resolvedId);
      if (!intent) {
        console.error('Error: playlist not found');
        process.exit(1);
      }

      console.log(`${intent.emoji ?? ''} ${intent.title}`.trim());
      console.log(`ID: ${intent.id}`);
      console.log(`Context: ${intent.sessionContext}`);

      const latestSet = intent.affirmationSets[0];
      if (latestSet) {
        const enabled = latestSet.affirmations.filter((a) => a.isEnabled).length;
        const total = latestSet.affirmations.length;
        console.log(`\nAffirmations: ${enabled} enabled / ${total} total`);
        for (const a of latestSet.affirmations) {
          const fb = a.feedback === 'liked' ? ' [liked]' : a.feedback === 'disliked' ? ' [disliked]' : '';
          console.log(`  ${a.isEnabled ? '[x]' : '[ ]'} ${a.text}${fb}`);
        }
      }

      // Render status
      const setId = latestSet?.id;
      const config = setId
        ? intent.renderConfigs.find((c) => c.affirmationSetId === setId)
        : intent.renderConfigs[0];
      const renderJob = config?.renderJobs?.[0];
      console.log(`\nRender: ${renderJob?.status ?? 'none'}`);

      // Play stats
      if (stats) {
        console.log(`\nStats:`);
        console.log(`  Plays: ${stats.playCount}`);
        console.log(`  Completed: ${stats.completedCount}`);
        console.log(`  Listen time: ${Math.round(stats.totalListenSeconds / 60)}min`);
        if (stats.lastPlayedAt) console.log(`  Last played: ${stats.lastPlayedAt}`);
      }
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── affirmation feedback & toggle (#2209) ─────────────────────────────────

program
  .command('feedback <intent-id>')
  .description('Like or dislike affirmations in a playlist')
  .requiredOption('--ids <ids>', 'Comma-separated affirmation IDs')
  .requiredOption('--action <action>', 'Feedback action: liked, disliked, or clear')
  .action(async (intentId: string, opts: { ids: string; action: string }) => {
    const validActions = ['liked', 'disliked', 'clear'];
    if (!validActions.includes(opts.action)) {
      console.error(`Error: --action must be one of: ${validActions.join(', ')}`);
      process.exit(1);
    }
    const feedback = opts.action === 'clear' ? null : (opts.action as 'liked' | 'disliked');
    const affirmationIds = opts.ids.split(',').map((s) => s.trim()).filter(Boolean);
    if (affirmationIds.length === 0) {
      console.error('Error: --ids must contain at least one affirmation ID');
      process.exit(1);
    }

    const client = getUserClient();
    try {
      const resolvedId = await resolveIntentId(client, intentId);
      const { intent } = await client.getIntent(resolvedId);
      if (!intent) {
        console.error('Error: playlist not found');
        process.exit(1);
      }

      let succeeded = 0;
      let failed = 0;
      for (const affId of affirmationIds) {
        try {
          await client.feedbackAffirmation(affId, feedback);
          succeeded++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  Failed for ${affId}: ${msg}`);
          failed++;
        }
      }
      console.log(`Feedback applied: ${succeeded} succeeded, ${failed} failed.`);
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command('toggle <intent-id>')
  .description('Enable or disable affirmations in a playlist')
  .requiredOption('--ids <ids>', 'Comma-separated affirmation IDs')
  .requiredOption('--enabled <bool>', 'true to enable, false to disable')
  .action(async (intentId: string, opts: { ids: string; enabled: string }) => {
    const isEnabled = opts.enabled === 'true';
    if (opts.enabled !== 'true' && opts.enabled !== 'false') {
      console.error('Error: --enabled must be "true" or "false"');
      process.exit(1);
    }
    const affirmationIds = opts.ids.split(',').map((s) => s.trim()).filter(Boolean);
    if (affirmationIds.length === 0) {
      console.error('Error: --ids must contain at least one affirmation ID');
      process.exit(1);
    }

    const client = getUserClient();
    try {
      const resolvedId = await resolveIntentId(client, intentId);
      const { intent } = await client.getIntent(resolvedId);
      if (!intent) {
        console.error('Error: playlist not found');
        process.exit(1);
      }
      const latestSet = intent.affirmationSets[0];
      if (!latestSet) {
        console.error('Error: no affirmation set found');
        process.exit(1);
      }
      await client.batchToggleAffirmations(latestSet.id, affirmationIds, isEnabled);
      console.log(`Toggled ${affirmationIds.length} affirmation(s) to ${isEnabled ? 'enabled' : 'disabled'}.`);
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });


// Install the MCP failure telemetry sink (#2867). The CLI is interactive, so
// it defaults to silent — opt in with NL_MCP_TELEMETRY=stderr|posthog (mirrors
// the existing NL_STREAM_TELEMETRY convention).
installEnvTelemetrySink('none');

program.parse(process.argv);
