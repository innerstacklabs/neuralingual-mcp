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
import type { ApiEnv, Intent, RenderConfigInput, RenderStatus, SessionContext, TonePreference } from './types.js';
import { API_BASE_URLS } from './types.js';
import { serializeSetFile, parseSetFile } from './set-file.js';
import { z } from 'zod';
import type { SetFileData } from './set-file.js';

const VALID_TONES = ['grounded', 'open', 'mystical'];
const VALID_CONTEXTS = ['general', 'sleep', 'nap', 'meditation', 'workout', 'focus', 'walk', 'chores'];

const program = new Command();

program
  .name('neuralingual')
  .description('Neuralingual — AI-powered affirmation practice sets')
  .version('0.2.0')
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

// ─── render ──────────────────────────────────────────────────────────────────

const renderCmd = program.command('render').description('Render audio for an intent');

renderCmd
  .command('configure <intent-id>')
  .description('Configure render settings for an intent')
  .requiredOption('--voice <name>', 'Voice ID (externalId) to use for rendering')
  .requiredOption('--context <context>', `Session context: ${VALID_CONTEXTS.join(', ')}`)
  .requiredOption('--duration <minutes>', 'Duration in minutes', parseInt)
  .option('--pace <wpm>', 'Pace in words per minute (uses context default if omitted)', parseInt)
  .option('--background <key>', 'Background sound storageKey (use neuralingual voices list; omit to disable)')
  .option('--background-volume <level>', 'Background volume 0–1 (uses context default if omitted)', parseFloat)
  .option('--repeats <n>', 'Number of times each affirmation repeats (uses context default if omitted)', parseInt)
  .option('--preamble <on|off>', 'Include intro/outro preamble: on or off (preserves existing setting if omitted)')
  .option('--play-all <on|off>', 'Play all affirmations instead of fitting within duration: on or off (preserves existing setting if omitted)')
  .action(async (
    intentId: string,
    opts: {
      voice: string;
      context: string;
      duration: number;
      pace?: number;
      background?: string;
      backgroundVolume?: number;
      repeats?: number;
      preamble?: string;
      playAll?: string;
    },
  ) => {
    if (!VALID_CONTEXTS.includes(opts.context)) {
      console.error(`Error: --context must be one of: ${VALID_CONTEXTS.join(', ')}`);
      process.exit(1);
    }
    if (isNaN(opts.duration) || opts.duration < 1) {
      console.error('Error: --duration must be a positive integer');
      process.exit(1);
    }
    if (opts.pace !== undefined && (isNaN(opts.pace) || opts.pace < 90 || opts.pace > 220)) {
      console.error('Error: --pace must be between 90 and 220');
      process.exit(1);
    }
    if (
      opts.backgroundVolume !== undefined &&
      (isNaN(opts.backgroundVolume) || opts.backgroundVolume < 0 || opts.backgroundVolume > 1)
    ) {
      console.error('Error: --background-volume must be between 0 and 1');
      process.exit(1);
    }
    if (opts.repeats !== undefined && (isNaN(opts.repeats) || opts.repeats < 1 || opts.repeats > 5)) {
      console.error('Error: --repeats must be between 1 and 5');
      process.exit(1);
    }
    if (opts.preamble !== undefined && opts.preamble !== 'on' && opts.preamble !== 'off') {
      console.error('Error: --preamble must be "on" or "off"');
      process.exit(1);
    }
    if (opts.playAll !== undefined && opts.playAll !== 'on' && opts.playAll !== 'off') {
      console.error('Error: --play-all must be "on" or "off"');
      process.exit(1);
    }

    try {
      const client = getUserClient();
      const resolvedId = await resolveIntentId(client, intentId);
      const input: Parameters<typeof client.configureRender>[1] = {
        voiceId: opts.voice,
        sessionContext: opts.context as SessionContext,
        durationMinutes: opts.duration,
      };
      if (opts.pace !== undefined) input.paceWpm = opts.pace;
      if (opts.background !== undefined) input.backgroundAudioPath = opts.background;
      if (opts.backgroundVolume !== undefined) input.backgroundVolume = opts.backgroundVolume;
      if (opts.repeats !== undefined) input.affirmationRepeatCount = opts.repeats;
      if (opts.preamble !== undefined) input.includePreamble = opts.preamble === 'on';
      if (opts.playAll !== undefined) input.playAll = opts.playAll === 'on';
      const result = await client.configureRender(resolvedId, input);
      printResult(result);
    } catch (err: unknown) {
      printResult(err instanceof Error ? err.message : String(err), true);
    }
  });

renderCmd
  .command('start <intent-id>')
  .description('Start a render job for an intent')
  .option('--wait', 'Wait for the render to complete, showing progress')
  .action(async (intentId: string, opts: { wait?: boolean }) => {
    const client = getUserClient();
    const resolvedId = await resolveIntentId(client, intentId);

    try {
      const result = await client.startRender(resolvedId);
      if (!opts.wait) {
        printResult(result);
        return;
      }

      const { jobId } = result;
      console.error(`Render queued (job: ${jobId}). Waiting for completion...`);

      // Poll until the specific job we started completes or fails
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

        // Guard: if status has no jobId at all, the render config was likely reconfigured
        // and the job we started is no longer the current one — exit to avoid infinite loop
        if (status.jobId === undefined) {
          console.error(`Warning: render status has no active job (config may have been reconfigured). Exiting --wait.`);
          printResult(status);
          return;
        }

        // Guard: if the status is tracking a different job (concurrent start), stop waiting
        if (status.jobId !== jobId) {
          console.error(`Warning: render status is now tracking a different job (${status.jobId}). Exiting --wait.`);
          printResult(status);
          return;
        }

        console.error(`  [${Math.round(elapsedMs / 1000)}s] status=${status.status} progress=${status.progress}%`);

        if (status.status === 'completed') {
          printResult(status);
          return;
        }
        if (status.status === 'failed') {
          console.error(`Render failed: ${status.errorMessage ?? 'unknown error'}`);
          process.exit(1);
        }
      }
    } catch (err: unknown) {
      printResult(err instanceof Error ? err.message : String(err), true);
    }
  });

renderCmd
  .command('status <intent-id>')
  .description('Get the current render status for an intent')
  .action(async (intentId: string) => {
    const client = getUserClient();
    try {
      const resolvedId = await resolveIntentId(client, intentId);
      const result = await client.getRenderStatus(resolvedId);
      printResult(result);
    } catch (err: unknown) {
      printResult(err instanceof Error ? err.message : String(err), true);
    }
  });

// ─── voices ──────────────────────────────────────────────────────────────────

const voicesCmd = program.command('voices').description('Browse and preview available voices');

/** Resolve API env: explicit --env flag wins, then stored auth, then default 'production'. */
function resolveApiEnv(): ApiEnv {
  const opts = program.opts();
  const explicitEnv = process.argv.some((a) => a === '--env' || a.startsWith('--env='));
  const env = (explicitEnv ? opts['env'] : loadAuth()?.env ?? opts['env'] ?? 'production') as string;
  if (env !== 'dev' && env !== 'production') {
    console.error(`Error: --env must be "dev" or "production", got "${env}"`);
    process.exit(1);
  }
  return env;
}

/** Resolve the API base URL using resolveApiEnv(). */
function getApiBaseUrl(): string {
  return API_BASE_URLS[resolveApiEnv()];
}

const voiceDtoSchema = z.object({
  id: z.string(),
  provider: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  gender: z.string(),
  accent: z.string(),
  tier: z.string(),
  category: z.string().nullable(),
  playCount: z.number(),
});

const voicesResponseSchema = z.object({
  voices: z.array(voiceDtoSchema),
});

voicesCmd
  .command('show', { isDefault: true })
  .description('List available voices')
  .option('--gender <gender>', 'Filter by gender (e.g. Male, Female)')
  .option('--accent <accent>', 'Filter by accent (e.g. US, UK, AU)')
  .option('--tier <tier>', 'Filter by tier (e.g. free, premium)')
  .option('--json', 'Output raw JSON')
  .action(async (opts: { gender?: string; accent?: string; tier?: string; json?: boolean }) => {
    try {
      const baseUrl = getApiBaseUrl();
      const res = await fetch(`${baseUrl}/voices`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let { voices } = voicesResponseSchema.parse(await res.json());
      if (opts.gender) {
        const g = opts.gender.toLowerCase();
        voices = voices.filter((v) => v.gender.toLowerCase() === g);
      }
      if (opts.accent) {
        const a = opts.accent.toLowerCase();
        voices = voices.filter((v) => v.accent.toLowerCase() === a);
      }
      if (opts.tier) {
        const t = opts.tier.toLowerCase();
        voices = voices.filter((v) => v.tier.toLowerCase() === t);
      }
      if (opts.json) {
        console.log(JSON.stringify(voices, null, 2));
        return;
      }
      if (voices.length === 0) {
        console.log('No voices found matching your filters.');
        return;
      }
      const truncate = (s: string | null, max: number) => {
        if (!s) return '';
        return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
      };
      printTable(
        voices.map((v) => [v.id, v.displayName, v.gender, v.accent, v.tier, truncate(v.description, 50)]),
        ['ID', 'NAME', 'GENDER', 'ACCENT', 'TIER', 'DESCRIPTION'],
      );
      console.log(`\nUse --voice <ID> with 'neuralingual render configure' to select a voice.`);
      console.log(`Use 'neuralingual voices preview <ID>' to hear a voice sample.`);
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

voicesCmd
  .command('preview <voice-id>')
  .description('Play a short audio preview of a voice')
  .option('--no-cache', 'Skip cache, always re-download')
  .action(async (voiceId: string, opts: { cache: boolean }) => {
    try {
      const baseUrl = getApiBaseUrl();
      const env = resolveApiEnv();
      // Sanitize voiceId for safe use as a filename component
      const safeVoiceId = voiceId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const cacheFile = join(AUDIO_CACHE_DIR, `preview-${env}-${safeVoiceId}.mp3`);
      if (opts.cache && existsSync(cacheFile)) {
        console.log(`Playing preview for '${voiceId}' (cached)`);
      } else {
        console.log(`Downloading preview for '${voiceId}'...`);
        const res = await fetch(`${baseUrl}/voices/${encodeURIComponent(voiceId)}/preview`);
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
          throw new Error(data && typeof data['error'] === 'string' ? data['error'] : `HTTP ${res.status}`);
        }
        const ab = await res.arrayBuffer();
        mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
        writeFileSync(cacheFile, Buffer.from(ab));
        console.log(`Playing preview for '${voiceId}'`);
      }
      const player = process.platform === 'darwin' ? 'afplay' : 'xdg-open';
      const result = spawnSync(player, [cacheFile], { stdio: 'inherit' });
      if (result.status !== 0) {
        console.error('Playback failed. Try opening the file manually:');
        console.log(cacheFile);
      }
      // Report play count (fire-and-forget, same as web client)
      fetch(`${baseUrl}/voices/${encodeURIComponent(voiceId)}/play`, { method: 'POST' }).catch(() => {});
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── set (declarative YAML file) ────────────────────────────────────────────

const setCmd = program.command('set').description('Export/import a complete affirmation set as a YAML file');

/** Read all of stdin and return as a string. */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/** Read content from --file <path>, --file - (stdin), or piped stdin. */
async function readContentFromFileOrStdin(opts: { file?: string }): Promise<string> {
  if (opts.file === '-') {
    return readStdin();
  }
  if (opts.file) {
    try {
      return readFileSync(opts.file, 'utf8');
    } catch (err: unknown) {
      console.error(`Error: could not read file '${opts.file}': ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
  if (process.stdin.isTTY) {
    console.error('Error: provide YAML via --file <path> or pipe to stdin (--file -)');
    process.exit(1);
  }
  return readStdin();
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
  return input;
}

setCmd
  .command('export <intent-id>')
  .description('Export an affirmation set to YAML (stdout)')
  .action(async (intentId: string) => {
    const client = getUserClient();
    try {
      const resolvedId = await resolveIntentId(client, intentId);
      const data = await fetchSetFileData(client, resolvedId);
      process.stdout.write(serializeSetFile(data));
    } catch (err: unknown) {
      printResult(err instanceof Error ? err.message : String(err), true);
    }
  });

setCmd
  .command('edit <intent-id>')
  .description('Open a set file in $EDITOR, then apply changes')
  .action(async (intentId: string) => {
    const client = getUserClient();

    const resolvedId = await resolveIntentId(client, intentId);

    let originalData: SetFileData;
    try {
      originalData = await fetchSetFileData(client, resolvedId);
    } catch (err: unknown) {
      printResult(err instanceof Error ? err.message : String(err), true);
      return;
    }

    const yaml = serializeSetFile(originalData);
    const isTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);

    if (!isTTY) {
      console.error(
        'Error: no TTY available for interactive editor. Use one of:\n' +
        '  neuralingual set export <id>                     Print YAML to stdout\n' +
        '  neuralingual set apply <id> --file <path>        Apply from a file\n' +
        '  neuralingual set apply <id> --file -             Apply from stdin',
      );
      process.exit(1);
    }

    const editorEnv = (process.env['EDITOR'] ?? 'vi').trim();
    if (!editorEnv) {
      console.error('Error: $EDITOR is empty. Set it to your preferred editor.');
      process.exit(1);
    }

    const tmpFile = join(tmpdir(), `nl-set-${resolvedId}-${Date.now()}.yaml`);
    writeFileSync(tmpFile, yaml, 'utf8');

    const spawnResult = spawnSync(`${editorEnv} ${JSON.stringify(tmpFile)}`, { stdio: 'inherit', shell: true });
    if (spawnResult.error) {
      unlinkSync(tmpFile);
      console.error(`Error: could not open editor '${editorEnv}': ${spawnResult.error.message}`);
      process.exit(1);
    }
    if (spawnResult.status !== 0) {
      unlinkSync(tmpFile);
      console.error(`Editor exited with status ${spawnResult.status ?? 'unknown'}. No changes applied.`);
      process.exit(1);
    }

    let editedContent: string;
    try {
      editedContent = readFileSync(tmpFile, 'utf8');
    } finally {
      unlinkSync(tmpFile);
    }

    try {
      await applySetFile(client, resolvedId, editedContent, originalData);
    } catch (err: unknown) {
      printResult(err instanceof Error ? err.message : String(err), true);
    }
  });

setCmd
  .command('apply <intent-id>')
  .description('Apply a YAML set file to an existing intent')
  .option('--file <path>', 'Read YAML from a file (use "-" for stdin)')
  .action(async (intentId: string, opts: { file?: string }) => {
    const client = getUserClient();
    const content = await readContentFromFileOrStdin(opts);

    const resolvedId = await resolveIntentId(client, intentId);

    try {
      const originalData = await fetchSetFileData(client, resolvedId);
      await applySetFile(client, resolvedId, content, originalData);
    } catch (err: unknown) {
      printResult(err instanceof Error ? err.message : String(err), true);
    }
  });

setCmd
  .command('create')
  .description('Create a new intent from a YAML set file (full round-trip)')
  .option('--file <path>', 'Read YAML from a file (use "-" for stdin)')
  .action(async (opts: { file?: string }) => {
    const client = getUserClient();
    const content = await readContentFromFileOrStdin(opts);

    let parsed;
    try {
      parsed = parseSetFile(content);
    } catch (err: unknown) {
      console.error(`Error: invalid YAML — ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    if (!parsed.intent) {
      console.error('Error: "intent" field is required to create a new set');
      process.exit(1);
    }

    await createSetFromFile(client, parsed);
  });

/** Create a new intent from a parsed set file using user API. */
async function createSetFromFile(client: UserApiClient, parsed: ReturnType<typeof parseSetFile>): Promise<void> {
  if (!parsed.affirmations || parsed.affirmations.length === 0) {
    console.error('Error: "affirmations" are required to create a new set');
    process.exit(1);
  }

  let createdIntentId: string | undefined;
  try {
    const steps: string[] = [];

    // 1. Create intent + affirmations together via POST /intents/manual
    const title = parsed.title ?? parsed.intent!.slice(0, 120);
    const result = await client.createManualIntent({
      title,
      rawText: parsed.intent!,
      tonePreference: parsed.tone ?? null,
      sessionContext: parsed.intentContext,
      affirmations: parsed.affirmations.map((a) => ({ text: a.text })),
    });
    createdIntentId = result.intent.id;
    steps.push(`intent: created with ${result.affirmationSet.affirmations.length} affirmations`);

    // 2. Update emoji if specified (not part of manual create)
    if (parsed.emoji !== undefined) {
      await client.updateIntent(result.intent.id, { emoji: parsed.emoji });
      steps.push('intent: updated emoji');
    }

    // 3. Sync affirmations to set enabled/disabled state
    // The manual create endpoint doesn't support per-affirmation enabled state,
    // so we sync to apply the exact desired state from the YAML.
    const hasDisabled = parsed.affirmations.some((a) => !a.enabled);
    if (hasDisabled) {
      await client.syncAffirmations(result.intent.id, {
        affirmations: parsed.affirmations.map((a) => ({
          text: a.text,
          enabled: a.enabled,
        })),
      });
      steps.push('affirmations: synced enabled/disabled state');
    }

    // 4. Configure render (if voice is specified)
    if (parsed.voice) {
      await client.configureRender(result.intent.id, buildRenderInputFromParsed(parsed));
      steps.push('render config: created');
    }

    console.log(`Created intent: ${result.intent.id}`);
    for (const s of steps) {
      console.error(`  - ${s}`);
    }
  } catch (err: unknown) {
    if (createdIntentId) {
      console.error(`Error during set create. Partial intent was created: ${createdIntentId}`);
      console.error(`Clean up with: neuralingual delete ${createdIntentId}`);
    }
    printResult(err instanceof Error ? err.message : String(err), true);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// User-facing commands (JWT auth)
// ═══════════════════════════════════════════════════════════════════════════════

/** Get a user client from stored auth. Exits with helpful message if not logged in. */
function getUserClient(): UserApiClient {
  try {
    return UserApiClient.fromAuth();
  } catch {
    console.error('Not logged in. Run `neuralingual login` first.');
    process.exit(1);
  }
}

/**
 * Resolve a short/truncated intent ID to the full ID by fetching the user's library.
 * Handles exact match, prefix match, and ambiguous matches (multiple prefix hits).
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
async function fetchSetFileData(client: UserApiClient, intentId: string): Promise<SetFileData> {
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
 */
async function applySetFile(
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
      console.error('Warning: no render config exists yet — skipping render settings. Run neuralingual render configure first.');
    } else {
      const rc = originalData.renderConfig;
      await client.configureRender(intentId, buildRenderInputFromParsed(parsed, rc));
      changes.push('render config: updated');
    }
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

      let bodyParsed: unknown;
      try {
        bodyParsed = JSON.parse(body);
      } catch {
        res.writeHead(400, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const result = callbackPayloadSchema.safeParse(bodyParsed);
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
  .description('Log in to Neuralingual via Apple Sign-In (opens browser)')
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
        console.log(`  Configure with: neuralingual render configure ${intent.id.slice(0, 8)} --voice <id> --context ${intent.sessionContext} --duration <min>`);
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
        console.error(`  neuralingual render configure ${intent.id.slice(0, 8)} --voice <id> --context ${intent.sessionContext} --duration <min>`);
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
      console.log(`\nNext: configure and render with \`neuralingual render configure ${intent.id.slice(0, 8)} --voice <id> --context ${intent.sessionContext} --duration <min>\``);
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
        console.error('Error: no rendered audio available. Run `neuralingual render start` first.');
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

program
  .command('delete <intent-id>')
  .description('Delete a practice set from your library')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(async (intentId: string, opts: { force?: boolean }) => {
    const client = getUserClient();

    try {
      const resolvedId = await resolveIntentId(client, intentId);
      // Look up the title for the confirmation prompt
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

program.parse(process.argv);
