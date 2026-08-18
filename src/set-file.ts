/**
 * Declarative set file — YAML serialization/deserialization for
 * a complete affirmation set (intent + affirmations + render config).
 *
 * Used by `nl set export`, `nl set apply`, `nl set edit`, `nl set create`.
 */

import { stringify, parse } from 'yaml';
import { z } from 'zod';
import type {
  Affirmation,
  Intent,
  RenderConfig,
  RenderConfigInput,
  SessionContext,
} from './types.js';

// ── Zod schema for parsed YAML ─────────────────────────────────────────────

const setFileAffirmationSchema = z.object({
  id: z.string().min(1).optional(),
  enabled: z.boolean(),
  text: z.string().min(1),
});

const setFileSchema = z.object({
  title: z.string().min(1).optional(),
  slug: z.string().optional(),
  emoji: z.string().nullable().optional(),
  tone: z.enum(['grounded', 'open', 'mystical']).optional(),
  intentContext: z.enum(['general', 'sleep', 'nap', 'meditation', 'workout', 'focus', 'walk', 'chores']).optional(),
  voice: z.string().min(1).nullable().optional(),
  duration: z.number().int().min(1).max(120).optional(),
  durationSeconds: z.number().int().min(0).max(120 * 60).optional(),
  pace: z.number().int().min(90).max(220).optional(),
  pauseMsBetweenAffirmations: z.number().int().min(0).max(10000).optional(),
  renderContext: z.enum(['general', 'sleep', 'nap', 'meditation', 'workout', 'focus', 'walk', 'chores']).optional(),
  background: z.string().nullable().optional(),
  backgroundVolume: z.number().min(0).max(1).optional(),
  normalizeLoudness: z.boolean().optional(),
  binauralPreset: z.enum(['theta', 'alpha', 'beta']).nullable().optional(),
  binauralVolume: z.number().min(0).max(1).nullable().optional(),
  subliminalEnabled: z.boolean().optional(),
  subliminalVolume: z.number().min(0).max(1).nullable().optional(),
  repeats: z.number().int().min(1).max(5).optional(),
  preamble: z.boolean().optional(),
  preambleText: z.string().min(1).max(3000).nullable().optional(),
  postambleText: z.string().min(1).max(3000).nullable().optional(),
  playAll: z.boolean().optional(),
  repetitionModel: z.enum(['sequential', 'shuffle']).optional(),
  category: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  order: z.number().int().positive().optional(),
  intent: z.string().min(1).optional(),
  affirmations: z.array(setFileAffirmationSchema).min(5, 'Minimum 5 affirmations required').optional(),
}).strict();

export type SetFile = z.infer<typeof setFileSchema>;
export type SetFileAffirmation = z.infer<typeof setFileAffirmationSchema>;

// ── Input type for serialization ────────────────────────────────────────────

export interface SetFileData {
  intent: Intent;
  affirmations: Affirmation[];
  renderConfig: RenderConfig | null;
}

// ── Serialization ───────────────────────────────────────────────────────────

export function serializeSetFile(data: SetFileData): string {
  const { intent, affirmations, renderConfig } = data;

  const doc: Record<string, unknown> = {};

  doc['title'] = intent.title;
  if (intent.catalogSlug) doc['slug'] = intent.catalogSlug;
  // Always export emoji for catalog items (even null, for round-trip fidelity).
  // For non-catalog items, only export if set.
  if (intent.isCatalog || intent.emoji) {
    doc['emoji'] = intent.emoji;
  }
  if (intent.tonePreference) doc['tone'] = intent.tonePreference;
  doc['intentContext'] = intent.sessionContext;

  if (renderConfig) {
    doc['voice'] = renderConfig.voiceId;
    // duration is the human-editable value; durationSeconds preserves the exact
    // runtime. On import, changing duration overrides inconsistent stale seconds.
    doc['duration'] = Math.round(renderConfig.durationSeconds / 60);
    doc['durationSeconds'] = renderConfig.durationSeconds;
    doc['pace'] = renderConfig.paceWpm;
    doc['pauseMsBetweenAffirmations'] = renderConfig.pauseMsBetweenAffirmations;
    doc['renderContext'] = renderConfig.sessionContext;
    doc['background'] = renderConfig.backgroundAudioPath;
    doc['backgroundVolume'] = renderConfig.backgroundVolume;
    doc['normalizeLoudness'] = renderConfig.normalizeLoudness;
    doc['binauralPreset'] = renderConfig.binauralPreset;
    doc['binauralVolume'] = renderConfig.binauralVolume;
    doc['subliminalEnabled'] = renderConfig.subliminalEnabled;
    doc['subliminalVolume'] = renderConfig.subliminalVolume;
    doc['repeats'] = renderConfig.affirmationRepeatCount;
    doc['preamble'] = renderConfig.includePreamble;
    // The renderer currently keys off text presence, not includePreamble.
    // Null disabled text so importing an inconsistent legacy row cannot
    // accidentally reactivate narration.
    doc['preambleText'] = renderConfig.includePreamble ? renderConfig.preambleText : null;
    doc['postambleText'] = renderConfig.includePreamble ? renderConfig.postambleText : null;
    doc['playAll'] = renderConfig.playAll;
    doc['repetitionModel'] = renderConfig.repetitionModel;
  }

  // Catalog fields
  if (intent.isCatalog) {
    if (intent.catalogCategory) doc['category'] = intent.catalogCategory;
    if (intent.catalogDescription) doc['description'] = intent.catalogDescription;
    if (intent.catalogOrder != null) doc['order'] = intent.catalogOrder;
  }

  doc['intent'] = intent.rawText;

  // Affirmations array
  if (affirmations.length > 0) {
    doc['affirmations'] = affirmations.map((a) => ({
      id: a.id,
      enabled: a.isEnabled,
      text: a.text,
    }));
  }

  const header = [
    '# Neuralingual Set File',
    '# Edit and apply with: nl set apply <intent-id>',
    '',
  ].join('\n');

  return header + stringify(doc, { lineWidth: 0 });
}

// ── Deserialization ─────────────────────────────────────────────────────────

export function parseSetFile(yamlContent: string): SetFile {
  const raw = parse(yamlContent) as unknown;
  return setFileSchema.parse(raw);
}

const RENDER_SETTING_KEYS = [
  'voice', 'duration', 'durationSeconds', 'pace', 'pauseMsBetweenAffirmations',
  'renderContext', 'intentContext', 'background', 'backgroundVolume',
  'normalizeLoudness', 'binauralPreset', 'binauralVolume', 'subliminalEnabled',
  'subliminalVolume', 'repeats', 'preamble', 'preambleText', 'postambleText',
  'playAll', 'repetitionModel',
] as const satisfies ReadonlyArray<keyof SetFile>;

export function hasRenderSettings(parsed: SetFile): boolean {
  return RENDER_SETTING_KEYS.some((key) => parsed[key] !== undefined);
}

function resolveExactDurationSeconds(
  parsed: SetFile,
  fallback?: RenderConfig,
): number | undefined {
  if (parsed.durationSeconds !== undefined) {
    const matchesDisplayedDuration = parsed.duration === undefined
      || Math.round(parsed.durationSeconds / 60) === parsed.duration;
    return matchesDisplayedDuration ? parsed.durationSeconds : undefined;
  }
  return parsed.duration === undefined ? fallback?.durationSeconds : undefined;
}

/**
 * Build the complete audio-affecting input used by set create/apply.
 * Exported values win; a persisted fallback preserves fields omitted by
 * legacy or hand-authored set files.
 */
export function buildRenderInputFromSetFile(
  parsed: SetFile,
  fallback?: RenderConfig,
): RenderConfigInput {
  const exactDurationSeconds = resolveExactDurationSeconds(parsed, fallback);
  const input: RenderConfigInput = {
    voiceId: parsed.voice ?? fallback?.voiceId ?? '',
    sessionContext: (parsed.renderContext ?? parsed.intentContext ?? fallback?.sessionContext ?? 'general') as SessionContext,
    durationMinutes: parsed.duration ?? Math.max(1, Math.round((exactDurationSeconds ?? 10 * 60) / 60)),
  };
  if (exactDurationSeconds !== undefined) input.durationSeconds = exactDurationSeconds;

  const paceWpm = parsed.pace ?? fallback?.paceWpm;
  if (paceWpm !== undefined) input.paceWpm = paceWpm;
  const pauseMs = parsed.pauseMsBetweenAffirmations ?? fallback?.pauseMsBetweenAffirmations;
  if (pauseMs !== undefined) input.pauseMsBetweenAffirmations = pauseMs;

  const backgroundAudioPath = parsed.background !== undefined ? parsed.background : fallback?.backgroundAudioPath;
  if (backgroundAudioPath !== undefined) input.backgroundAudioPath = backgroundAudioPath;
  const backgroundVolume = parsed.backgroundVolume ?? fallback?.backgroundVolume;
  if (backgroundVolume !== undefined) input.backgroundVolume = backgroundVolume;
  const normalizeLoudness = parsed.normalizeLoudness ?? fallback?.normalizeLoudness;
  if (normalizeLoudness !== undefined) input.normalizeLoudness = normalizeLoudness;

  const binauralPreset = parsed.binauralPreset !== undefined ? parsed.binauralPreset : fallback?.binauralPreset;
  if (binauralPreset !== undefined) input.binauralPreset = binauralPreset as 'theta' | 'alpha' | 'beta' | null;
  const binauralVolume = parsed.binauralVolume !== undefined ? parsed.binauralVolume : fallback?.binauralVolume;
  if (binauralVolume !== undefined) input.binauralVolume = binauralVolume;
  const subliminalEnabled = parsed.subliminalEnabled ?? fallback?.subliminalEnabled;
  if (subliminalEnabled !== undefined) input.subliminalEnabled = subliminalEnabled;
  const subliminalVolume = parsed.subliminalVolume !== undefined ? parsed.subliminalVolume : fallback?.subliminalVolume;
  if (subliminalVolume !== undefined) input.subliminalVolume = subliminalVolume;

  const repeatCount = parsed.repeats ?? fallback?.affirmationRepeatCount;
  if (repeatCount !== undefined) input.affirmationRepeatCount = repeatCount;
  const includePreamble = parsed.preamble ?? fallback?.includePreamble;
  if (includePreamble !== undefined) input.includePreamble = includePreamble;
  const preambleText = parsed.preambleText !== undefined ? parsed.preambleText : fallback?.preambleText;
  if (preambleText !== undefined) input.preambleText = preambleText;
  const postambleText = parsed.postambleText !== undefined ? parsed.postambleText : fallback?.postambleText;
  if (postambleText !== undefined) input.postambleText = postambleText;
  const playAll = parsed.playAll ?? fallback?.playAll;
  if (playAll !== undefined) input.playAll = playAll;
  const repetitionModel = parsed.repetitionModel
    ?? (fallback?.repetitionModel as 'sequential' | 'shuffle' | undefined);
  if (repetitionModel !== undefined) input.repetitionModel = repetitionModel;

  return input;
}
