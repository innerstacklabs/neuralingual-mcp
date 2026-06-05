/**
 * Terminal renderer for `nl create --stream` and `nl resume --stream` (#862).
 *
 * Responsible for translating protocol events (and the resume endpoint's
 * JSON-mode blocking outcomes) into CLI output. Handles two modes:
 *
 *   - **TTY** — phase-line rewriting, progress bar, progressive
 *     framework text at ~4Hz. Uses ANSI cursor control.
 *   - **Non-TTY (pipe)** — plain append-only lines, no ANSI, no progress
 *     bar. Deterministic output suitable for CI capture.
 *
 * This module owns NO side effects other than writing to the `stdout`/
 * `stderr` streams it receives in the constructor. No filesystem, no
 * network, no timers except the throttle interval for framework-text
 * rendering (which `cleanup()` clears).
 */

import type {
  StreamingProtocolEvent,
  PhaseCompleteEvent,
  PhaseFrameworkOnlyEvent,
  PhaseFailedEvent,
} from './protocol-types.js';
import type {
  ResumeBlockingOutcome,
  StreamError,
} from './generation-stream.js';
import {
  parsePartialFramework,
  type PartialFramework,
} from './parse-partial-framework.js';

interface WriteStreamLike {
  isTTY?: boolean;
  write: (chunk: string) => boolean;
  columns?: number;
}

export interface StreamRendererOptions {
  streamText: boolean;
  stdout: WriteStreamLike;
  stderr: WriteStreamLike;
  operation: 'create' | 'resume';
  /** Clock for throttle decisions (testing injection). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Optional telemetry sink. When set, the renderer calls it with a
   * `cli.generation.phase.<name>` event label and durations (ms since
   * stream open). Enabled by the CLI when `NL_STREAM_TELEMETRY=1`.
   * #862 acceptance criterion: "CLI emits its own cli.generation.phase.*
   * events for dev observability". Dev-only, no PostHog ingest.
   */
  telemetry?: (event: string, details: Record<string, unknown>) => void;
}

export interface StreamRendererSummary {
  exitCode: number;
  intentId?: string;
  affirmationSetId?: string;
  /** True if the renderer received a terminal event with `resumed: true`. */
  resumed?: boolean;
}

const ANSI_CLEAR_LINE = '\x1b[2K';
const ANSI_LINE_START = '\r';

/**
 * Stateful renderer. Drive it by calling `onEvent` / `onError` /
 * `onFallback` / `onResumeBlockingOutcome` as the stream consumer
 * invokes those handlers. When the stream settles, call `summary()`
 * for the exit code and IDs.
 *
 * The renderer installs NO signal handlers of its own — the CLI owns
 * SIGINT and calls `cleanup()` in the handler.
 */
export class StreamRenderer {
  private readonly streamText: boolean;
  private readonly stdout: WriteStreamLike;
  private readonly stderr: WriteStreamLike;
  private readonly operation: 'create' | 'resume';
  private readonly ttyOut: boolean;
  private readonly now: () => number;
  private readonly telemetry: (event: string, details: Record<string, unknown>) => void;
  private readonly streamOpenedAt: number;

  // Phase tracking.
  /** Name of the active phase that owns the current TTY line. */
  private activePhase: string | null = null;
  /** True when the active phase line has been written but not yet closed. */
  private phaseLineOpen = false;

  // Framework text (only used when streamText = true).
  private frameworkBuffer = '';
  private frameworkRenderedChars = 0;
  private frameworkThrottleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly THROTTLE_MS = 250;

  // Affirmations.
  private affirmationCount = 0;
  /**
   * Guard so `cli.generation.phase.affirmations_streaming.begin` fires
   * exactly once per stream across both entry paths (framework_streaming.end
   * and the implicit chunk-first fallback). The "Composing affirmations"
   * phase is Pass 2 and is typically the longest phase; measuring its
   * duration requires a single, consistent begin marker.
   */
  private affirmationsTelemetryEmitted = false;

  // Intent metadata (captured from phase.intent_metadata so the summary
  // can surface title + emoji, not just the id).
  private capturedTitle: string | undefined;
  private capturedEmoji: string | null | undefined;

  // Terminal state.
  private resultIntentId: string | undefined;
  private resultAffirmationSetId: string | undefined;
  private resultResumed = false;
  private exitCode = 0;
  private cleaned = false;

  constructor(opts: StreamRendererOptions) {
    this.streamText = opts.streamText;
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.operation = opts.operation;
    this.ttyOut = Boolean(opts.stdout.isTTY);
    this.now = opts.now ?? Date.now;
    this.telemetry = opts.telemetry ?? (() => {});
    this.streamOpenedAt = this.now();
  }

  private emitPhaseTelemetry(phaseName: string, extra: Record<string, unknown> = {}): void {
    this.telemetry(`cli.generation.phase.${phaseName}`, {
      elapsedMs: this.now() - this.streamOpenedAt,
      operation: this.operation,
      ...extra,
    });
  }

  /**
   * Emit `cli.generation.phase.affirmations_streaming.begin` exactly
   * once per stream. The affirmations (Pass 2) phase can begin from
   * two places — `framework_streaming.end` or the first
   * `affirmations_streaming.chunk` — and event ordering across those
   * is not guaranteed, so this is guarded by a boolean rather than the
   * `activePhase` string (which `beginPhase` mutates and would defeat
   * an activePhase-based dedupe).
   */
  private emitAffirmationsBeginTelemetryOnce(): void {
    if (this.affirmationsTelemetryEmitted) return;
    this.affirmationsTelemetryEmitted = true;
    this.emitPhaseTelemetry('affirmations_streaming.begin');
  }

  // ───── Stream handlers ─────────────────────────────────────────────

  onEvent(event: StreamingProtocolEvent): void {
    switch (event.event) {
      case 'phase.validation':
        this.beginPhase('Validating intent');
        this.completePhase('ok');
        this.emitPhaseTelemetry('validation');
        return;
      case 'phase.gatekeeper':
        this.beginPhase('Safety check');
        this.completePhase(event.data.passed ? 'ok' : 'rejected');
        this.emitPhaseTelemetry('gatekeeper', { passed: event.data.passed });
        return;
      case 'phase.framework_streaming.begin':
        this.beginPhase('Drafting framework');
        if (this.streamText) {
          this.finishPhaseLineWithoutStatus();
          this.writeOut('\n');
          this.startFrameworkThrottle();
        }
        this.emitPhaseTelemetry('framework_streaming.begin');
        return;
      case 'phase.framework_streaming.chunk':
        if (this.streamText) {
          this.frameworkBuffer += event.data.delta;
        }
        return;
      case 'phase.framework_streaming.end':
        if (this.streamText) {
          this.stopFrameworkThrottle();
          this.writeOut('\n');
        } else {
          this.completePhase('ok');
        }
        this.emitPhaseTelemetry('framework_streaming.end');
        this.beginPhase('Composing affirmations');
        this.emitAffirmationsBeginTelemetryOnce();
        return;
      case 'phase.affirmations_streaming.chunk': {
        // First affirmation arrival implicitly completes the framework phase
        // if framework_streaming.end didn't already.
        if (this.activePhase !== 'Composing affirmations') {
          this.beginPhase('Composing affirmations');
        }
        // Fires once across this and the framework_streaming.end path —
        // the helper is guarded by `affirmationsTelemetryEmitted`.
        this.emitAffirmationsBeginTelemetryOnce();
        this.affirmationCount += 1;
        this.renderAffirmationArrival(event.data.affirmation.text);
        return;
      }
      case 'phase.output_safety':
        if (this.activePhase === 'Composing affirmations') {
          this.completePhase(`${this.affirmationCount} total`);
        }
        this.beginPhase('Output safety check');
        this.completePhase(event.data.flagged ? 'flagged' : 'ok');
        this.emitPhaseTelemetry('output_safety', { flagged: event.data.flagged });
        return;
      case 'phase.intent_metadata':
        this.capturedTitle = event.data.title;
        this.capturedEmoji = event.data.emoji;
        this.emitPhaseTelemetry('intent_metadata');
        return;
      case 'phase.saved':
        this.beginPhase('Saving');
        this.completePhase('ok');
        this.emitPhaseTelemetry('saved', { intentId: event.data.intentId });
        return;
      case 'phase.resume_begin':
        this.beginPhase('Resuming');
        this.completePhase('ok');
        this.emitPhaseTelemetry('resume_begin', { intentId: event.data.intentId });
        return;
      case 'phase.complete':
        this.handleComplete(event);
        this.emitPhaseTelemetry('complete', {
          intentId: event.data.intentId,
          totalDurationMs: event.data.totalDurationMs,
        });
        return;
      case 'phase.framework_only':
        this.handleFrameworkOnly(event);
        this.emitPhaseTelemetry('framework_only', { intentId: event.data.intentId });
        return;
      case 'phase.failed':
        this.handleFailed(event);
        this.emitPhaseTelemetry('failed', {
          code: event.data.code,
          phase: event.data.phase,
        });
        return;
    }
  }

  onError(err: StreamError): void {
    this.closeFrameworkIfOpen();
    this.closeOpenPhaseLineAs('error');
    switch (err.kind) {
      case 'previous_attempt_failed':
        this.writeErr(
          `Error: ${err.message} Re-run without --idempotency-key to submit a fresh attempt.\n`,
        );
        break;
      case 'concurrency_blocked':
        this.writeErr(
          `Error: You have a generation already in progress${
            err.streamId ? ` (id ${err.streamId})` : ''
          }. Wait for it to finish, then retry.\n`,
        );
        break;
      case 'rate_limit': {
        const retry =
          err.retryAfterMs !== undefined
            ? ` Try again in ${Math.ceil(err.retryAfterMs / 1000)}s.`
            : '';
        this.writeErr(
          `Error: Rate limit reached.${retry}${
            err.message ? ` (${err.message})` : ''
          }\n`,
        );
        break;
      }
      case 'auth_expired':
        this.writeErr(
          `Error: Session expired${
            err.message ? ` — ${err.message}` : ''
          }. Run \`nl login\` again.\n`,
        );
        break;
      case 'stream_ended_without_terminal':
        this.writeErr(
          `Error: Stream ended unexpectedly without a terminal event. The server may have completed work; check \`nl library\` before retrying.\n`,
        );
        break;
      case 'transport':
        this.writeErr(`Error: Stream transport failed — ${err.cause.message}\n`);
        break;
    }
    this.exitCode = 1;
  }

  onFallback(): void {
    this.closeFrameworkIfOpen();
    this.closeOpenPhaseLineAs('fallback');
    this.writeErr(
      'Stream endpoint not available; falling back to blocking generation.\n',
    );
  }

  /**
   * Render a resume-endpoint JSON-mode precheck outcome. Each outcome
   * maps to a distinct human-readable line and exit code.
   */
  onResumeBlockingOutcome(outcome: ResumeBlockingOutcome): void {
    this.closeOpenPhaseLineAs('fallback');
    switch (outcome.kind) {
      case 'resumed': {
        this.resultResumed = true;
        this.resultIntentId = outcome.intent.id;
        this.resultAffirmationSetId = outcome.affirmationSet.id;
        if (outcome.generationStatus === 'complete') {
          this.renderSummary({
            label: 'Resumed',
            intent: outcome.intent,
            affirmationCount: outcome.affirmationSet.affirmations?.length ?? 0,
          });
        } else if (outcome.generationStatus === 'framework_only') {
          this.renderFrameworkOnlyMessage({
            intentId: outcome.intent.id,
            asResume: true,
          });
        } else {
          this.writeErr('Resume returned failed status.\n');
          this.exitCode = 1;
        }
        return;
      }
      case 'cached_completed':
        this.resultResumed = true;
        this.resultIntentId = outcome.intent.id;
        this.resultAffirmationSetId = outcome.affirmationSet.id;
        this.writeOut('(cached)\n');
        this.renderSummary({
          label: 'Resumed',
          intent: outcome.intent,
          affirmationCount: outcome.affirmationSet.affirmations?.length ?? 0,
        });
        return;
      case 'already_complete':
        this.writeErr('This playlist is already complete.\n');
        if (outcome.intent) {
          this.writeErr(`Intent ID: ${outcome.intent.id}\n`);
        }
        this.exitCode = 0;
        return;
      case 'already_failed':
        this.writeErr(
          'This playlist is in a failed state. Create a new one with `nl create`.\n',
        );
        this.exitCode = 1;
        return;
      case 'previous_attempt_framework_only':
        this.writeErr(
          'A previous attempt with this idempotency key reached framework_only. Re-run `nl resume <id>` with a new --idempotency-key to try Pass 2 again.\n',
        );
        this.exitCode = 1;
        return;
      case 'previous_attempt_failed_post_commit':
        this.writeErr(
          'A previous attempt with this idempotency key failed after being charged. Re-run with a new --idempotency-key.\n',
        );
        this.exitCode = 1;
        return;
      case 'idempotency_key_reuse_across_intents':
        this.writeErr(
          'This idempotency key was already used on a different intent. Re-run with a fresh --idempotency-key (or omit it to auto-generate one).\n',
        );
        this.exitCode = 1;
        return;
      case 'intent_not_found':
        this.writeErr('Intent not found.\n');
        this.exitCode = 1;
        return;
      case 'set_not_found':
        this.writeErr('Affirmation set not found on this intent.\n');
        this.exitCode = 1;
        return;
      case 'insufficient_credits': {
        const bal =
          outcome.creditBalance !== undefined
            ? `Balance: ${outcome.creditBalance}.`
            : '';
        const req =
          outcome.required !== undefined ? ` Required: ${outcome.required}.` : '';
        this.writeErr(`Not enough credits.${bal ? ' ' + bal : ''}${req}\n`);
        this.exitCode = 1;
        return;
      }
      case 'stream_in_progress':
        this.writeErr(
          `A generation stream is already in progress${
            outcome.streamId ? ` (id ${outcome.streamId})` : ''
          }. Wait for it to finish, then retry.\n`,
        );
        this.exitCode = 1;
        return;
      case 'resume_in_progress':
        this.writeErr(
          'A resume is already in progress for this intent. Wait for it to finish, then retry.\n',
        );
        this.exitCode = 1;
        return;
      case 'upstream_error':
        this.writeErr(
          `Upstream error${outcome.message ? ` — ${outcome.message}` : ''}.\n`,
        );
        this.exitCode = 1;
        return;
      case 'auth_expired':
        this.writeErr(
          `Error: Session expired${
            outcome.message ? ` — ${outcome.message}` : ''
          }. Run \`nl login\` again.\n`,
        );
        this.exitCode = 1;
        return;
      case 'unknown':
        this.writeErr(
          `Unexpected response (HTTP ${outcome.status}${
            outcome.code ? `, code ${outcome.code}` : ''
          })${outcome.message ? `: ${outcome.message}` : '.'}\n`,
        );
        this.exitCode = 1;
        return;
    }
  }

  // ───── Terminal event handlers ─────────────────────────────────────

  private handleComplete(event: PhaseCompleteEvent): void {
    this.closeFrameworkIfOpen();
    // Ensure any still-open phase line (e.g. "Saving…") is closed cleanly
    // so the summary doesn't append on the same line.
    if (this.phaseLineOpen) {
      this.completePhase('ok');
    }
    this.resultIntentId = event.data.intentId;
    this.resultAffirmationSetId = event.data.affirmationSetId;
    this.resultResumed = event.data.resumed === true;
    this.writeOut('\n');
    this.renderSummary({
      label: this.resultResumed || this.operation === 'resume' ? 'Resumed' : 'Created',
      intent: {
        id: event.data.intentId,
        ...(this.capturedTitle !== undefined ? { title: this.capturedTitle } : {}),
        ...(this.capturedEmoji !== undefined ? { emoji: this.capturedEmoji } : {}),
      },
      affirmationCount: this.affirmationCount,
      durationMs: event.data.totalDurationMs,
    });
  }

  private handleFrameworkOnly(event: PhaseFrameworkOnlyEvent): void {
    this.closeFrameworkIfOpen();
    this.closeOpenPhaseLineAs('partial');
    this.resultIntentId = event.data.intentId;
    this.resultResumed = event.data.resumed === true;
    this.renderFrameworkOnlyMessage({
      intentId: event.data.intentId,
      asResume: this.resultResumed || this.operation === 'resume',
    });
  }

  private handleFailed(event: PhaseFailedEvent): void {
    this.closeFrameworkIfOpen();
    this.closeOpenPhaseLineAs('error');
    this.resultIntentId = event.data.intentId;
    this.writeErr(
      `Error: ${event.data.message} (code: ${event.data.code}, phase: ${event.data.phase})\n`,
    );
    if (event.data.retryable) {
      this.writeErr('This error is retryable — re-run the command.\n');
    }
    this.exitCode = 1;
  }

  // ───── Summary + lifecycle ─────────────────────────────────────────

  summary(): StreamRendererSummary {
    const result: StreamRendererSummary = { exitCode: this.exitCode };
    if (this.resultIntentId !== undefined) result.intentId = this.resultIntentId;
    if (this.resultAffirmationSetId !== undefined)
      result.affirmationSetId = this.resultAffirmationSetId;
    if (this.resultResumed) result.resumed = true;
    return result;
  }

  /** Clean up any open TTY state. Called by the CLI on SIGINT and on normal exit. */
  cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    this.stopFrameworkThrottle();
    // Close any open phase line so the prompt doesn't land mid-line.
    if (this.phaseLineOpen) {
      if (this.ttyOut) {
        this.writeOut('\n');
      }
      this.phaseLineOpen = false;
    }
  }

  // ───── Internal rendering helpers ──────────────────────────────────

  private beginPhase(label: string): void {
    // Complete any still-open phase line first.
    if (this.phaseLineOpen) {
      this.completePhase('ok');
    }
    this.activePhase = label;
    this.phaseLineOpen = true;
    this.writeOut(`→ ${label}… `);
    if (!this.ttyOut) {
      // Non-TTY: flush what we have so far as a partial line. We'll
      // print the status suffix when the phase completes.
    }
  }

  private completePhase(status: string): void {
    if (!this.phaseLineOpen) return;
    this.writeOut(`${status}\n`);
    this.phaseLineOpen = false;
    this.activePhase = null;
  }

  /** Close the current phase's trailing ellipsis without a status word. */
  private finishPhaseLineWithoutStatus(): void {
    if (!this.phaseLineOpen) return;
    // Just newline-terminate the "→ phase… " line (no "ok" suffix).
    this.writeOut('\n');
    this.phaseLineOpen = false;
  }

  private closeOpenPhaseLineAs(
    outcome: 'error' | 'fallback' | 'partial',
  ): void {
    if (!this.phaseLineOpen) return;
    const label =
      outcome === 'error' ? 'error' : outcome === 'fallback' ? '...' : 'partial';
    this.writeOut(`${label}\n`);
    this.phaseLineOpen = false;
    this.activePhase = null;
  }

  private renderAffirmationArrival(text: string): void {
    if (this.ttyOut && this.phaseLineOpen) {
      // Overwrite the "→ Composing affirmations… " line with progress.
      const progress = this.affirmationCount;
      const bar = this.renderProgressBar(progress);
      this.writeOut(
        `${ANSI_LINE_START}${ANSI_CLEAR_LINE}→ Composing affirmations… ${bar} ${progress}`,
      );
      // Don't close the phase line; next chunk rewrites it.
    } else {
      // Non-TTY: dump each affirmation as its own line for parseability.
      // Truncate long texts for readability.
      const shortText = text.length > 80 ? text.slice(0, 77) + '…' : text;
      this.writeOut(`  ${this.affirmationCount}: ${shortText}\n`);
    }
  }

  private renderProgressBar(count: number): string {
    const width = 28;
    const filled = Math.min(width, count);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
  }

  private renderSummary(args: {
    label: string;
    intent: IntentLikeForSummary;
    affirmationCount: number;
    durationMs?: number;
  }): void {
    const { label, intent, affirmationCount, durationMs } = args;
    const emoji = intent.emoji ? `${intent.emoji} ` : '';
    const title = intent.title ?? '(untitled)';
    this.writeOut(`\n${label}: ${emoji}${title}\n`);
    this.writeOut(`Intent ID: ${intent.id}\n`);
    this.writeOut(`Affirmations: ${affirmationCount}\n`);
    if (durationMs !== undefined) {
      this.writeOut(`Duration: ${(durationMs / 1000).toFixed(1)}s\n`);
    }
    this.writeOut(`\nNext: configure and render with \`nl render ${intent.id}\`\n`);
  }

  private renderFrameworkOnlyMessage(args: {
    intentId: string;
    asResume: boolean;
  }): void {
    if (args.asResume) {
      this.writeErr(
        `Pass 2 failed again for intent ${args.intentId}. The framework is preserved — run \`nl resume ${args.intentId}\` later to retry.\n`,
      );
    } else {
      this.writeErr(
        `Pass 2 failed for intent ${args.intentId} (framework saved). Run \`nl resume ${args.intentId}\` to finish composing affirmations without re-paying for Pass 1.\n`,
      );
    }
    this.exitCode = 0; // partial success — user can resume
  }

  // ───── Framework text throttling ───────────────────────────────────

  private startFrameworkThrottle(): void {
    if (this.frameworkThrottleTimer !== null) return;
    if (!this.ttyOut) return; // Only throttle-render in TTY mode.
    this.frameworkThrottleTimer = setInterval(() => {
      this.flushFrameworkTextIncrement();
    }, this.THROTTLE_MS);
  }

  private stopFrameworkThrottle(): void {
    if (this.frameworkThrottleTimer !== null) {
      clearInterval(this.frameworkThrottleTimer);
      this.frameworkThrottleTimer = null;
    }
    // Final flush — dump anything not yet written.
    this.flushFrameworkTextIncrement();
  }

  private flushFrameworkTextIncrement(): void {
    if (!this.streamText) return;
    const partial: PartialFramework = parsePartialFramework(this.frameworkBuffer);
    const methodology = partial.methodology ?? '';
    if (methodology.length > this.frameworkRenderedChars) {
      const delta = methodology.slice(this.frameworkRenderedChars);
      this.writeOut(delta);
      this.frameworkRenderedChars = methodology.length;
    }
  }

  private closeFrameworkIfOpen(): void {
    this.stopFrameworkThrottle();
    // If we're in the middle of framework-text rendering, add a newline
    // so the next output isn't glued to the partial text.
    if (this.frameworkRenderedChars > 0) {
      this.writeOut('\n');
    }
  }

  private writeOut(chunk: string): void {
    this.stdout.write(chunk);
  }

  private writeErr(chunk: string): void {
    this.stderr.write(chunk);
  }
}

interface IntentLikeForSummary {
  id: string;
  title?: string;
  emoji?: string | null;
}
