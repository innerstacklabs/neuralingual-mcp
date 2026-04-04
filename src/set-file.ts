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
  subtitle: z.string().optional(),
  emoji: z.string().nullable().optional(),
  tone: z.enum(['grounded', 'open', 'mystical']).optional(),
  intentContext: z.enum(['general', 'sleep', 'nap', 'meditation', 'workout', 'focus', 'walk', 'chores']).optional(),
  voice: z.string().min(1).nullable().optional(),
  duration: z.number().int().min(1).max(120).optional(),
  pace: z.number().int().min(90).max(220).optional(),
  renderContext: z.enum(['general', 'sleep', 'nap', 'meditation', 'workout', 'focus', 'walk', 'chores']).optional(),
  background: z.string().nullable().optional(),
  backgroundVolume: z.number().min(0).max(1).optional(),
  repeats: z.number().int().min(1).max(5).optional(),
  preamble: z.boolean().optional(),
  playAll: z.boolean().optional(),
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
  if (intent.catalogSubtitle) doc['subtitle'] = intent.catalogSubtitle;
  // Always export emoji for catalog items (even null, for round-trip fidelity).
  // For non-catalog items, only export if set.
  if (intent.isCatalog || intent.emoji) {
    doc['emoji'] = intent.emoji;
  }
  if (intent.tonePreference) doc['tone'] = intent.tonePreference;
  doc['intentContext'] = intent.sessionContext;

  if (renderConfig) {
    doc['voice'] = renderConfig.voiceId;
    doc['duration'] = Math.round(renderConfig.durationSeconds / 60);
    doc['pace'] = renderConfig.paceWpm;
    doc['renderContext'] = renderConfig.sessionContext;
    doc['background'] = renderConfig.backgroundAudioPath;
    doc['backgroundVolume'] = renderConfig.backgroundVolume;
    doc['repeats'] = renderConfig.affirmationRepeatCount;
    doc['preamble'] = renderConfig.includePreamble;
    doc['playAll'] = renderConfig.playAll;
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
