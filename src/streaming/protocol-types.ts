/**
 * Streaming protocol types — CLI mirror (#862).
 *
 * This file is a *local copy* of the discriminated union shipped in
 * `packages/llm/src/streaming-protocol.ts` (#873). We cannot import from
 * `@neuralingual/llm` in `@neuralingual/mcp` because that package is
 * server-only (Anthropic SDK, DB side-effects, filesystem concerns) and
 * the CLI is synced to the public `neuralingual-mcp` repo, where a
 * transitive dep on `@neuralingual/llm` is inappropriate. The web app
 * has an identical mirror at `apps/web/lib/streaming/protocol-types.ts`
 * for the same reason.
 *
 * **Rule:** when the upstream types change, mirror them here in the same
 * PR. The protocol is versioned and frozen between changes (see
 * `docs/STREAMING_PROTOCOL.md` "frozen contract" note).
 *
 * The CLI is tolerant of unknown `event` values — it logs and skips —
 * so a new event added upstream before this mirror is updated does not
 * break the stream consumer; it just won't be rendered until the mirror
 * catches up.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Error codes — carried on `phase.failed.code`.
// ─────────────────────────────────────────────────────────────────────────────

export type StreamingErrorCode =
  | 'rate_limit'
  | 'auth_expired'
  | 'gatekeeper_rejected'
  /** Transient gatekeeper failure — retryable, no soft-ban (#2835/FIX-6). */
  | 'gatekeeper_unavailable'
  | 'safety_terminated'
  | 'upstream_timeout'
  /** Out of credits — carries balance/required (#2835/FIX-2). */
  | 'insufficient_credits'
  | 'internal_error'
  | 'previous_attempt_failed_post_commit';

// ─────────────────────────────────────────────────────────────────────────────
// Phase names — carried on `phase.failed.phase`.
// ─────────────────────────────────────────────────────────────────────────────

export type PhaseName =
  | 'validation'
  | 'gatekeeper'
  | 'framework_streaming'
  | 'affirmations_streaming'
  | 'output_safety'
  | 'intent_metadata'
  | 'saved'
  /** Present on `phase.failed` events emitted from the resume endpoint (#877). */
  | 'resume_begin';

// ─────────────────────────────────────────────────────────────────────────────
// Phase event discriminated union.
// ─────────────────────────────────────────────────────────────────────────────

export interface PhaseValidationEvent {
  event: 'phase.validation';
  data: Record<string, never>;
}

export interface PhaseGatekeeperEvent {
  event: 'phase.gatekeeper';
  data: { passed: boolean };
}

export interface PhaseFrameworkStreamingBeginEvent {
  event: 'phase.framework_streaming.begin';
  data: Record<string, never>;
}

export interface PhaseFrameworkStreamingChunkEvent {
  event: 'phase.framework_streaming.chunk';
  data: { delta: string };
}

export interface PhaseFrameworkStreamingEndEvent {
  event: 'phase.framework_streaming.end';
  data: { framework: unknown };
}

export interface PhaseAffirmationsStreamingChunkEvent {
  event: 'phase.affirmations_streaming.chunk';
  data: {
    affirmation: {
      text: string;
      grouping: string;
      rationale: string;
    };
  };
}

export interface PhaseOutputSafetyEvent {
  event: 'phase.output_safety';
  data: { flagged: boolean; concerns: string[] };
}

export interface PhaseIntentMetadataEvent {
  event: 'phase.intent_metadata';
  data: {
    title: string;
    emoji: string | null;
    sessionContext: string;
  };
}

export interface PhaseSavedEvent {
  event: 'phase.saved';
  data: { intentId: string; affirmationSetId: string };
}

/**
 * Non-terminal: resume endpoint has accepted the request and locked the
 * target intent (#877). Fires as the first event on the resume SSE stream
 * in place of the full pipeline's validation/gatekeeper/framework_streaming
 * events.
 */
export interface PhaseResumeBeginEvent {
  event: 'phase.resume_begin';
  data: { intentId: string };
}

export interface PhaseCompleteEvent {
  event: 'phase.complete';
  data: {
    intentId: string;
    affirmationSetId: string;
    totalDurationMs: number;
    /** True when emitted from the resume endpoint. */
    resumed?: boolean;
  };
}

export interface PhaseFrameworkOnlyEvent {
  event: 'phase.framework_only';
  data: {
    intentId: string;
    framework: unknown;
    retryAction: { action: 'resume_pass2'; intentId: string };
    /** True when emitted from the resume endpoint. */
    resumed?: boolean;
  };
}

export interface PhaseFailedEvent {
  event: 'phase.failed';
  data: {
    code: StreamingErrorCode;
    message: string;
    retryable: boolean;
    intentId?: string;
    phase: PhaseName;
    /** True when emitted from the resume endpoint. */
    resumed?: boolean;
    /** Remaining credit balance — present only on `insufficient_credits`
     *  failures (#2835/FIX-2). */
    balance?: number;
    /** Credits required — present only on `insufficient_credits` failures
     *  (#2835/FIX-2). */
    required?: number;
  };
}

export type StreamingProtocolEvent =
  | PhaseValidationEvent
  | PhaseGatekeeperEvent
  | PhaseFrameworkStreamingBeginEvent
  | PhaseFrameworkStreamingChunkEvent
  | PhaseFrameworkStreamingEndEvent
  | PhaseAffirmationsStreamingChunkEvent
  | PhaseOutputSafetyEvent
  | PhaseIntentMetadataEvent
  | PhaseSavedEvent
  | PhaseResumeBeginEvent
  | PhaseCompleteEvent
  | PhaseFrameworkOnlyEvent
  | PhaseFailedEvent;

export type TerminalStreamingEvent =
  | PhaseCompleteEvent
  | PhaseFrameworkOnlyEvent
  | PhaseFailedEvent;

/** True iff `e` is one of the three terminal events. */
export function isTerminalEvent(
  e: StreamingProtocolEvent,
): e is TerminalStreamingEvent {
  return (
    e.event === 'phase.complete' ||
    e.event === 'phase.framework_only' ||
    e.event === 'phase.failed'
  );
}

/** True iff `e` is the `phase.failed` terminal event. */
export function isPhaseFailed(
  e: StreamingProtocolEvent,
): e is PhaseFailedEvent {
  return e.event === 'phase.failed';
}

/** Event names the CLI knows how to handle. Unknown names are dropped. */
export const KNOWN_EVENT_NAMES: ReadonlySet<string> = new Set([
  'phase.validation',
  'phase.gatekeeper',
  'phase.framework_streaming.begin',
  'phase.framework_streaming.chunk',
  'phase.framework_streaming.end',
  'phase.affirmations_streaming.chunk',
  'phase.output_safety',
  'phase.intent_metadata',
  'phase.saved',
  'phase.resume_begin',
  'phase.complete',
  'phase.framework_only',
  'phase.failed',
]);
