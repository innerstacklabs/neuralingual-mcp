/**
 * Progressive JSON parser for streaming framework tokens (#862 CLI).
 *
 * Port of `apps/web/lib/streaming/parse-partial-framework.ts` — Pass 1 of
 * the framework-first pipeline streams *tokens*, not parsed structure, so
 * the client needs to try-parse an accumulating buffer that is almost
 * always syntactically incomplete (open brackets, half-written strings).
 * This module returns the deepest valid subset of a partial JSON buffer
 * without throwing.
 *
 * Strategy:
 *
 *   1. Try `JSON.parse(buffer)` — happy path for complete frames.
 *   2. Otherwise walk the buffer character by character, tracking:
 *        - bracket/brace depth,
 *        - whether we're inside a string and whether the previous char
 *          was the escape char `\`,
 *        - positions where we last closed a complete top-level key:value
 *          pair (comma or `}` at depth 1).
 *   3. If we're mid-string at EOF, capture the in-progress string up to
 *      the last position *before* an incomplete `\u` escape, then
 *      synthesize a closing quote + close-brackets so JSON.parse succeeds.
 *   4. If we're between pairs, truncate to the last complete pair
 *      boundary, then synthesize closing brackets.
 *   5. On ANY failure along the way, return `{}`.
 *
 * **Replacement semantics:** when `phase.framework_streaming.end` arrives,
 * the consumer should discard the salvaged partial and use the
 * authoritative framework payload from that event. This parser is only
 * for the `.chunk` delta stream.
 */

export interface PartialFramework {
  schemaVersion?: number;
  methodology?: string;
  principles?: Array<{ name: string; description: string }>;
  sources?: Array<{ name: string; work?: string | null; contribution: string }>;
  groupings?: Array<{ name: string; purpose: string }>;
  terminology?: Array<{ term: string; definition: string }> | null;
  practical_application?: string;
  takeaway?: string;
}

const EMPTY: PartialFramework = Object.freeze({});

interface ScanState {
  inString: boolean;
  escapePending: boolean;
  lastSafeStringEnd: number;
  lastPairBoundary: number;
  lastOpenStringStart: number;
  topLevelKey: string | null;
  depth: number;
}

function scan(buffer: string): ScanState {
  let depth = 0;
  let inString = false;
  let escapePending = false;
  let openStringStart = -1;
  let lastSafeEnd = -1;
  let lastPairBoundary = -1;
  let topLevelKey: string | null = null;
  let currentKeyBuffer = '';
  let expectingKey = true;

  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];

    if (inString) {
      if (escapePending) {
        if (ch === 'u') {
          if (i + 4 < buffer.length) {
            const hex = buffer.slice(i + 1, i + 5);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              i += 4;
              escapePending = false;
              lastSafeEnd = i + 1;
            } else {
              escapePending = false;
            }
          } else {
            escapePending = false;
            break;
          }
        } else {
          escapePending = false;
          lastSafeEnd = i + 1;
        }
        continue;
      }
      if (ch === '\\') {
        escapePending = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        if (expectingKey && depth === 1) {
          topLevelKey = currentKeyBuffer;
          currentKeyBuffer = '';
          expectingKey = false;
        }
        openStringStart = -1;
        lastSafeEnd = i + 1;
        continue;
      }
      if (expectingKey && depth === 1) {
        currentKeyBuffer += ch;
      }
      lastSafeEnd = i + 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      openStringStart = i;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth++;
      if (ch === '{' && depth === 1) {
        expectingKey = true;
        topLevelKey = null;
      }
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth = Math.max(0, depth - 1);
      if (depth === 1) {
        lastPairBoundary = i;
        expectingKey = true;
        topLevelKey = null;
      }
      continue;
    }
    if (ch === ',') {
      if (depth === 1) {
        lastPairBoundary = i;
        expectingKey = true;
        topLevelKey = null;
      }
      continue;
    }
    if (ch === ':') {
      if (depth === 1) expectingKey = false;
      continue;
    }
  }

  return {
    inString,
    escapePending,
    lastSafeStringEnd: lastSafeEnd,
    lastPairBoundary,
    lastOpenStringStart: openStringStart,
    topLevelKey,
    depth,
  };
}

/** Safely parse a possibly-partial JSON buffer. Returns `{}` on any failure. */
export function parsePartialFramework(buffer: string): PartialFramework {
  if (!buffer || buffer.length === 0) return EMPTY;

  try {
    const parsed = JSON.parse(buffer) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PartialFramework;
    }
    return EMPTY;
  } catch {
    // Fall through to recovery.
  }

  const state = scan(buffer);

  // Strategy A: in-string recovery for scalar top-level string keys.
  if (
    state.inString &&
    state.topLevelKey &&
    state.lastOpenStringStart > 0 &&
    isScalarStringKey(state.topLevelKey) &&
    !state.escapePending
  ) {
    const stringStart = state.lastOpenStringStart + 1;
    const safeEnd = Math.max(state.lastSafeStringEnd, stringStart);
    if (safeEnd > stringStart) {
      const candidate = buffer.slice(0, safeEnd) + '"}';
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as PartialFramework;
        }
      } catch {
        // fall through
      }
    }
  }

  // Strategy B: truncate to last complete pair boundary at depth 1.
  if (state.lastPairBoundary > 0) {
    let truncated = buffer.slice(0, state.lastPairBoundary + 1);
    if (truncated.endsWith(',')) {
      truncated = truncated.slice(0, -1);
    }
    let attempt = truncated;
    if (!attempt.trimEnd().endsWith('}')) {
      attempt = attempt + '}';
    }
    try {
      const parsed = JSON.parse(attempt) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as PartialFramework;
      }
    } catch {
      // fall through
    }
  }

  return EMPTY;
}

/**
 * Keys whose top-level value is a string scalar. When the in-progress
 * string is under one of these keys, we can safely salvage it as a
 * partial string value.
 */
function isScalarStringKey(key: string): boolean {
  return (
    key === 'methodology' ||
    key === 'practical_application' ||
    key === 'takeaway'
  );
}
