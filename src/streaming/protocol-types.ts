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
    /**
     * nl#416 — `true` on the post-Pass-2 catch-up burst: members of the FINAL
     * set that were never streamed live (top-up items above all).
     *
     * ⛔ It marks a different DUPLICATE rule, not "do not count me". Live chunks
     * are emitted per parsed item, before the batch dedup, so they can repeat and
     * must be counted by DISTINCT text. A `final` chunk cannot repeat — the burst
     * emits only rows absent from the server's streamed set — so each one counts.
     * Counting every frame reported a 100-line playlist as 130; skipping every
     * `final` frame under-reports the top-up round instead. See
     * `docs/STREAMING_PROTOCOL.md` → "Counting affirmations".
     *
     * Optional: absent from pre-nl#416 servers, and absent means "live".
     */
    final?: boolean;
  };
}

/**
 * nl#416 — a bounded top-up round is starting: a BLOCKING Anthropic call that
 * emits no chunks. Before this event that round was ~21 s of total SSE silence,
 * so the counter froze and a working generation read as a hang. The client
 * lights the "Final review" stage for its duration.
 */
export interface PhaseAffirmationsTopUpEvent {
  event: 'phase.affirmations_topup';
  data: { round: number; deficit: number };
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
  data: {
    intentId: string;
    affirmationSetId: string;
    /**
     * nl#416 — AUTHORITATIVE persisted affirmation count. A running chunk count
     * is provisional (a line surviving the per-item filter can still be dropped
     * by the batch derive), so the client replaces its count with this. Absent
     * from older servers: then there is no authoritative total and the client
     * bounds its display by the `targetCount` it requested.
     */
    deliveredCount?: number;
  };
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
    /**
     * nl#329 — server-minted correlation ref (`internal_error-7d62937f`). The same string is
     * the Sentry tag and the api error log field for that failure, so a user quoting it hands
     * support a search term. Optional: older API builds emit none.
     *
     * ⚠️ Mirrored here as well as in `apps/web` because BOTH clients render the failure. The
     * first cut of nl#329 updated only the web mirror, which would have left CLI users with no
     * ref to quote — the exact correlation gap the issue was filed to close, still open on one
     * of the two surfaces, in the commit that closes it.
     */
    ref?: string;
  };
}

export type StreamingProtocolEvent =
  | PhaseValidationEvent
  | PhaseGatekeeperEvent
  | PhaseFrameworkStreamingBeginEvent
  | PhaseFrameworkStreamingChunkEvent
  | PhaseFrameworkStreamingEndEvent
  | PhaseAffirmationsStreamingChunkEvent
  | PhaseAffirmationsTopUpEvent
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
  'phase.affirmations_topup',
  'phase.output_safety',
  'phase.intent_metadata',
  'phase.saved',
  'phase.resume_begin',
  'phase.complete',
  'phase.framework_only',
  'phase.failed',
]);
