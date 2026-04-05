#!/usr/bin/env node
import { Command } from 'commander';
import { spawn, spawnSync, exec } from 'child_process';
import { createServer } from 'http';
import { randomBytes } from 'crypto';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { createInterface } from 'readline';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { UserApiClient } from './user-client.js';
import { loadAuth, clearAuth } from './auth-store.js';
import type { ApiEnv, Intent, LibraryFilter, LibraryQueryParams, RenderConfigInput, RenderStatus, SessionContext, TonePreference } from './types.js';
import { API_BASE_URLS } from './types.js';
import { serializeSetFile, parseSetFile } from './set-file.js';
import { z } from 'zod';
import type { SetFileData } from './set-file.js';

const VALID_TONES = ['grounded', 'open', 'mystical'];
const VALID_CONTEXTS = ['general', 'sleep', 'nap', 'meditation', 'workout', 'focus', 'walk', 'chores'];

const program = new Command();

program
  .name('neuralingual')
  .description('Neuralingual CLI — AI-powered affirmation practice sets')
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

  console.error(`Error: no practice set found matching "${shortId}"`);
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
    parsed.subtitle !== undefined ||
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

// ─── library ────────────────────────────────────────────────────────────────

program
  .command('library')
  .description('List your practice sets')
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
        console.log('No matching practice sets found.');
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
  .description('Show detailed info for a practice set')
  .action(async (intentId: string) => {
    const client = getUserClient();
    try {
      const resolvedId = await resolveIntentId(client, intentId);
      const { intent } = await client.getIntent(resolvedId);
      if (!intent) {
        console.error('Error: practice set not found');
        process.exit(1);
      }

      // Header
      console.log(`${intent.emoji ?? ''} ${intent.title}`.trim());
      console.log(`ID: ${intent.id}`);
      console.log(`Context: ${intent.sessionContext}`);
      if (intent.tonePreference) console.log(`Tone: ${intent.tonePreference}`);
      console.log(`Intent: ${intent.rawText}`);
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

      // Share status
      if (intent.shareToken) {
        console.log(`Shared: yes (https://neuralingual.com/shared/${intent.shareToken})`);
      } else {
        console.log('Shared: no');
      }

      // Timestamps
      console.log(`Created: ${new Date(intent.createdAt).toLocaleString()}`);
      console.log(`Updated: ${new Date(intent.updatedAt).toLocaleString()}`);
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── rename ─────────────────────────────────────────────────────────────────

program
  .command('rename <intent-id>')
  .description('Rename a practice set')
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
  .description('Re-render a practice set with its current config')
  .option('--wait', 'Wait for the render to complete')
  .action(async (intentId: string, opts: { wait?: boolean }) => {
    const client = getUserClient();
    try {
      const resolvedId = await resolveIntentId(client, intentId);

      // Check if render config exists
      const { intent } = await client.getIntent(resolvedId);
      if (!intent) {
        console.error('Error: practice set not found');
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
  .command('create <text>')
  .description('Create a new practice set from intent text')
  .option('--tone <tone>', 'Tone preference: grounded, open, or mystical')
  .action(async (text: string, opts: { tone?: string }) => {
    if (opts.tone && !VALID_TONES.includes(opts.tone)) {
      console.error(`Error: --tone must be one of: ${VALID_TONES.join(', ')}`);
      process.exit(1);
    }

    const client = getUserClient();
    console.error('Creating practice set (this may take 10-30 seconds)...');

    try {
      const result = await client.createAndGenerate(text, opts.tone);
      const { intent, affirmationSet } = result;
      console.log(`\nCreated: ${intent.emoji ?? ''} ${intent.title}`);
      console.log(`Intent ID: ${intent.id}`);
      console.log(`Context: ${intent.sessionContext}`);
      console.log(`\nAffirmations (${affirmationSet.affirmations.length}):`);
      for (const a of affirmationSet.affirmations) {
        console.log(`  ${a.isEnabled ? '[x]' : '[ ]'} ${a.text}`);
      }
      console.log(`\nNext: configure and render with \`nl render ${intent.id}\``);
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

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
      // Find the render job ID from the library
      const { items } = await client.getLibrary();
      const item = items.find((i) => i.intent.id === intentId || i.intent.id.startsWith(intentId));
      if (!item) {
        console.error('Error: practice set not found in your library');
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
  .description('Generate a share link for a practice set')
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

program
  .command('unshare <intent-id>')
  .description('Revoke a share link for a practice set')
  .action(async (intentId: string) => {
    const client = getUserClient();
    try {
      const resolvedId = await resolveIntentId(client, intentId);
      await client.unshareIntent(resolvedId);
      console.log('Share link revoked.');
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
  .description('Delete practice sets from your library. Pass an ID for single delete, or use filters for bulk delete.')
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
        console.log('No matching practice sets found.');
        return;
      }

      console.log(`Found ${items.length} matching practice set(s):\n`);
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
      console.log(`Deleted ${totalDeleted} practice set(s).`);
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── cleanup (dry-run) ────────────────────────────────────────────────────

program
  .command('cleanup')
  .description('Preview which practice sets would be deleted by a filter (dry run — does not delete)')
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
        console.log('No matching practice sets found.');
        return;
      }

      console.log(`Found ${items.length} matching practice set(s):\n`);
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

// ─── account ───────────────────────────────────────────────────────────────

const accountCmd = program.command('account').description('Account management');

accountCmd
  .command('delete')
  .description('Permanently delete your account')
  .action(async () => {
    console.log('WARNING: This will permanently delete your account and all data.');
    console.log('This action cannot be undone.\n');
    const answer = await prompt('Type DELETE to confirm: ');
    if (answer !== 'DELETE') {
      console.log('Cancelled.');
      return;
    }

    const client = getUserClient();
    try {
      await client.deleteAccount();
      clearAuth();
      console.log('Account deleted. All data has been removed.');
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


program.parse(process.argv);
