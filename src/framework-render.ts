/**
 * Framework markdown renderer — shared between `nl_guide` MCP tool,
 * `nl_set_export --with-framework`, and their CLI equivalents.
 *
 * The framework JSON is persisted on `AffirmationSet.framework` as `Json?`
 * (see `packages/llm/src/framework-first/schemas/framework.zod.ts` for the
 * source-of-truth shape, `FrameworkV1`). We intentionally do NOT import the
 * zod schema from `@neuralingual/llm` here — this module ships in the CLI
 * bundle and must stay free of LLM dependencies. Instead we shape-guard
 * defensively: every field is treated as potentially missing or malformed
 * so future schema bumps don't crash existing CLI builds.
 */

// ── Shape-tolerant type ────────────────────────────────────────────────────
// The runtime shape matches FrameworkV1 but every field is optional + unknown
// at the input boundary. Callers (the mcp handlers) pass the raw DB JSON
// straight in; we render what's present.

export interface FrameworkLike {
  schemaVersion?: unknown;
  methodology?: unknown;
  principles?: unknown;
  sources?: unknown;
  groupings?: unknown;
  terminology?: unknown;
  practical_application?: unknown;
  takeaway?: unknown;
  [key: string]: unknown;
}

export const NO_FRAMEWORK_MESSAGE =
  'No framework available for this practice set. Legacy and second-person sets do not carry a framework.';

// ── Utilities ──────────────────────────────────────────────────────────────

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function fieldString(record: Record<string, unknown>, key: string): string | null {
  const v = record[key];
  return isNonEmptyString(v) ? v : null;
}

// ── Public helpers ─────────────────────────────────────────────────────────

/**
 * Extract the schema version from a framework JSON blob. Prefers the
 * framework's own `schemaVersion` over any sibling column — a framework
 * without its own schemaVersion is considered unversioned (returns null).
 */
export function extractFrameworkSchemaVersion(framework: unknown): number | null {
  if (!framework || typeof framework !== 'object') return null;
  const v = (framework as Record<string, unknown>)['schemaVersion'];
  return typeof v === 'number' ? v : null;
}

/**
 * Extract the single-sentence takeaway from a framework JSON blob.
 * Returns null when framework is absent or the takeaway is missing/empty.
 */
export function extractFrameworkTakeaway(framework: unknown): string | null {
  if (!framework || typeof framework !== 'object') return null;
  const v = (framework as Record<string, unknown>)['takeaway'];
  return isNonEmptyString(v) ? v : null;
}

/**
 * Does this framework JSON blob carry any content? Used by `nl_info`
 * to set `hasFramework`. Returns false for null / undefined / non-object.
 */
export function hasFramework(framework: unknown): boolean {
  return Boolean(framework) && typeof framework === 'object';
}

// ── Markdown renderer ──────────────────────────────────────────────────────

/**
 * Render a framework JSON blob to markdown.
 *
 * Shape-tolerant: missing fields are skipped rather than crashing. If the
 * framework is null / not an object, returns the NO_FRAMEWORK_MESSAGE
 * fallback so callers don't need to pre-check.
 *
 * Sections (in order, each omitted when its data is absent):
 *   # Framework
 *   ## Methodology
 *   ## Principles
 *   ## Sources
 *   ## Groupings
 *   ## Terminology          (only when non-empty)
 *   ## Practical Application
 *   ## Takeaway
 */
export function renderFrameworkMarkdown(framework: unknown): string {
  if (!hasFramework(framework)) {
    return NO_FRAMEWORK_MESSAGE;
  }

  const f = framework as FrameworkLike;
  const lines: string[] = ['# Framework', ''];

  const methodology = fieldString(f as Record<string, unknown>, 'methodology');
  if (methodology) {
    lines.push('## Methodology', '', methodology, '');
  }

  const principles = asArray(f.principles);
  if (principles.length > 0) {
    lines.push('## Principles', '');
    for (const entry of principles) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const name = fieldString(rec, 'name');
      const description = fieldString(rec, 'description');
      if (name && description) {
        lines.push(`- **${name}** — ${description}`);
      } else if (name) {
        lines.push(`- **${name}**`);
      } else if (description) {
        lines.push(`- ${description}`);
      }
    }
    lines.push('');
  }

  const sources = asArray(f.sources);
  if (sources.length > 0) {
    lines.push('## Sources', '');
    for (const entry of sources) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const name = fieldString(rec, 'name');
      const contribution = fieldString(rec, 'contribution');
      const work = rec['work']; // string | null per schema; optional in legacy
      const workLabel = isNonEmptyString(work) ? ` _(from ${work})_` : '';
      if (name && contribution) {
        lines.push(`- **${name}**${workLabel} — ${contribution}`);
      } else if (name) {
        lines.push(`- **${name}**${workLabel}`);
      } else if (contribution) {
        lines.push(`- ${contribution}`);
      }
    }
    lines.push('');
  }

  const groupings = asArray(f.groupings);
  if (groupings.length > 0) {
    lines.push('## Groupings', '');
    for (const entry of groupings) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const name = fieldString(rec, 'name');
      const purpose = fieldString(rec, 'purpose');
      if (name && purpose) {
        lines.push(`- **${name}** — ${purpose}`);
      } else if (name) {
        lines.push(`- **${name}**`);
      } else if (purpose) {
        lines.push(`- ${purpose}`);
      }
    }
    lines.push('');
  }

  const terminology = asArray(f.terminology);
  if (terminology.length > 0) {
    lines.push('## Terminology', '');
    for (const entry of terminology) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const term = fieldString(rec, 'term');
      const definition = fieldString(rec, 'definition');
      if (term && definition) {
        lines.push(`- **${term}** — ${definition}`);
      } else if (term) {
        lines.push(`- **${term}**`);
      } else if (definition) {
        lines.push(`- ${definition}`);
      }
    }
    lines.push('');
  }

  const practicalApplication = fieldString(f as Record<string, unknown>, 'practical_application');
  if (practicalApplication) {
    lines.push('## Practical Application', '', practicalApplication, '');
  }

  const takeaway = fieldString(f as Record<string, unknown>, 'takeaway');
  if (takeaway) {
    lines.push('## Takeaway', '', `> ${takeaway}`, '');
  }

  // Trim trailing blank lines, ensure trailing newline for pipe-friendliness.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return `${lines.join('\n')}\n`;
}
