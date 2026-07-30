/**
 * Unit tests for the StreamRenderer (#862). Exercises phase-line
 * rendering, affirmation numbering, terminal events, resume-endpoint
 * blocking outcomes, and TTY vs non-TTY differences.
 */

import { describe, it, expect, vi } from 'vitest';
import { StreamRenderer } from './render.js';
import type { StreamingProtocolEvent } from './protocol-types.js';
import type { ResumeBlockingOutcome, StreamError } from './generation-stream.js';

interface MockStream {
  isTTY?: boolean;
  buffer: string;
  columns?: number;
  write: (chunk: string) => boolean;
}

function makeStream(isTTY: boolean): MockStream {
  const s: MockStream = {
    isTTY,
    columns: 100,
    buffer: '',
    write(chunk: string): boolean {
      this.buffer += chunk;
      return true;
    },
  };
  return s;
}

function ev(
  event: string,
  data: Record<string, unknown> = {},
): StreamingProtocolEvent {
  return { event, data } as StreamingProtocolEvent;
}

describe('StreamRenderer — non-TTY phase + affirmations + complete', () => {
  it('renders sequential phase lines + per-affirmation numbered lines + a summary', () => {
    const out = makeStream(false);
    const err = makeStream(false);
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'create',
    });

    r.onEvent(ev('phase.validation'));
    r.onEvent(ev('phase.gatekeeper', { passed: true }));
    r.onEvent(ev('phase.framework_streaming.begin'));
    r.onEvent(ev('phase.framework_streaming.end', { framework: {} }));
    r.onEvent(
      ev('phase.affirmations_streaming.chunk', {
        affirmation: { text: 'a1', grouping: 'g', rationale: 'r' },
      }),
    );
    r.onEvent(
      ev('phase.affirmations_streaming.chunk', {
        affirmation: { text: 'a2', grouping: 'g', rationale: 'r' },
      }),
    );
    r.onEvent(ev('phase.output_safety', { flagged: false, concerns: [] }));
    r.onEvent(ev('phase.saved', { intentId: 'i1', affirmationSetId: 's1' }));
    r.onEvent(
      ev('phase.complete', {
        intentId: 'i1',
        affirmationSetId: 's1',
        totalDurationMs: 12345,
      }),
    );

    expect(out.buffer).toContain('→ Validating intent…');
    expect(out.buffer).toContain('→ Safety check…');
    expect(out.buffer).toContain('→ Drafting framework…');
    expect(out.buffer).toContain('→ Composing affirmations…');
    expect(out.buffer).toContain('  1: a1');
    expect(out.buffer).toContain('  2: a2');
    expect(out.buffer).toContain('→ Output safety check…');
    expect(out.buffer).toContain('→ Saving…');
    expect(out.buffer).toContain('Created:');
    expect(out.buffer).toContain('Intent ID: i1');
    expect(out.buffer).toContain('Duration: 12.3s');
    r.cleanup();
    expect(r.summary().exitCode).toBe(0);
    expect(r.summary().intentId).toBe('i1');
  });

  it('does NOT emit ANSI cursor codes in non-TTY mode', () => {
    const out = makeStream(false);
    const err = makeStream(false);
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'create',
    });

    for (let i = 0; i < 3; i++) {
      r.onEvent(
        ev('phase.affirmations_streaming.chunk', {
          affirmation: { text: `a${i}`, grouping: 'g', rationale: 'r' },
        }),
      );
    }
    expect(out.buffer).not.toContain('\x1b[');
    r.cleanup();
  });
});

describe('StreamRenderer — TTY mode uses cursor control for affirmations', () => {
  it('rewrites the affirmations phase line with progress on each chunk', () => {
    const out = makeStream(true);
    const err = makeStream(false);
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'create',
    });

    for (let i = 0; i < 3; i++) {
      r.onEvent(
        ev('phase.affirmations_streaming.chunk', {
          affirmation: { text: `a${i}`, grouping: 'g', rationale: 'r' },
        }),
      );
    }
    // ANSI clear-line + progress should be present.
    expect(out.buffer).toContain('\x1b[2K');
    expect(out.buffer).toContain('→ Composing affirmations…');
    r.cleanup();
  });
});

describe('StreamRenderer — phase.failed', () => {
  it('writes error to stderr and sets exitCode=1', () => {
    const out = makeStream(false);
    const err = makeStream(false);
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'create',
    });
    r.onEvent(ev('phase.validation'));
    r.onEvent(
      ev('phase.failed', {
        code: 'gatekeeper_rejected',
        message: 'too spicy',
        retryable: false,
        phase: 'gatekeeper',
      }),
    );
    expect(err.buffer).toContain('Error: too spicy');
    expect(err.buffer).toContain('gatekeeper_rejected');
    r.cleanup();
    expect(r.summary().exitCode).toBe(1);
  });
});

describe('StreamRenderer — phase.framework_only', () => {
  it('writes a resume hint and exit code 0 (partial success)', () => {
    const out = makeStream(false);
    const err = makeStream(false);
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'create',
    });
    r.onEvent(
      ev('phase.framework_only', {
        intentId: 'i1',
        framework: {},
        retryAction: { action: 'resume_pass2', intentId: 'i1' },
      }),
    );
    expect(err.buffer).toContain('nl resume i1');
    expect(err.buffer).toContain('framework saved');
    r.cleanup();
    expect(r.summary().exitCode).toBe(0);
    expect(r.summary().intentId).toBe('i1');
  });

  it('uses "Pass 2 failed again" wording when resumed=true', () => {
    const out = makeStream(false);
    const err = makeStream(false);
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'resume',
    });
    r.onEvent(
      ev('phase.framework_only', {
        intentId: 'i1',
        framework: {},
        retryAction: { action: 'resume_pass2', intentId: 'i1' },
        resumed: true,
      }),
    );
    expect(err.buffer).toContain('Pass 2 failed again');
    r.cleanup();
  });
});

describe('StreamRenderer — intent_metadata is used in summary', () => {
  it('captures title + emoji from phase.intent_metadata and renders them on complete', () => {
    const out = makeStream(false);
    const err = makeStream(false);
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'create',
    });
    r.onEvent(
      ev('phase.intent_metadata', {
        title: 'Meeting Anxiety With Steadiness',
        emoji: '🌊',
        sessionContext: 'general',
      }),
    );
    r.onEvent(
      ev('phase.complete', {
        intentId: 'i1',
        affirmationSetId: 's1',
        totalDurationMs: 100,
      }),
    );
    expect(out.buffer).toContain('Created: 🌊 Meeting Anxiety With Steadiness');
    r.cleanup();
  });
});

describe('StreamRenderer — phase.complete with resumed:true', () => {
  it('labels the summary as "Resumed:" on create operation with resumed=true', () => {
    const out = makeStream(false);
    const err = makeStream(false);
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'create',
    });
    r.onEvent(
      ev('phase.complete', {
        intentId: 'i1',
        affirmationSetId: 's1',
        totalDurationMs: 100,
        resumed: true,
      }),
    );
    expect(out.buffer).toContain('Resumed:');
    expect(out.buffer).not.toContain('Created:');
    r.cleanup();
  });

  it('labels as "Resumed:" when operation=resume regardless of resumed flag', () => {
    const out = makeStream(false);
    const err = makeStream(false);
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'resume',
    });
    r.onEvent(
      ev('phase.complete', {
        intentId: 'i1',
        affirmationSetId: 's1',
        totalDurationMs: 100,
      }),
    );
    expect(out.buffer).toContain('Resumed:');
    r.cleanup();
  });
});

describe('StreamRenderer — errors', () => {
  it.each<[StreamError, string, number]>([
    [
      { kind: 'previous_attempt_failed', message: 'charged and failed' },
      'without --idempotency-key',
      1,
    ],
    [
      { kind: 'concurrency_blocked', streamId: 'sX', message: 'busy' },
      'already in progress',
      1,
    ],
    [
      { kind: 'rate_limit', retryAfterMs: 30000, message: 'slow down' },
      'Try again in 30s',
      1,
    ],
    [
      { kind: 'auth_expired', message: 'expired' },
      '`nl login`',
      1,
    ],
    [
      { kind: 'stream_ended_without_terminal' },
      'Stream ended unexpectedly',
      1,
    ],
    [
      { kind: 'transport', cause: new Error('boom') },
      'Stream transport failed',
      1,
    ],
  ])('formats %s correctly', (errArg, expectedText, expectedExit) => {
    const out = makeStream(false);
    const err = makeStream(false);
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'create',
    });
    r.onError(errArg);
    expect(err.buffer).toContain(expectedText);
    expect(r.summary().exitCode).toBe(expectedExit);
  });
});

describe('StreamRenderer — resume blocking outcomes', () => {
  it.each<[ResumeBlockingOutcome, string, number]>([
    [
      {
        kind: 'already_complete',
        intent: { id: 'i1' },
      },
      'already complete',
      0,
    ],
    [
      {
        kind: 'already_failed',
      },
      'failed state',
      1,
    ],
    [
      {
        kind: 'previous_attempt_framework_only',
      },
      'new --idempotency-key',
      1,
    ],
    [
      { kind: 'previous_attempt_failed_post_commit' },
      'failed after being charged',
      1,
    ],
    [
      { kind: 'idempotency_key_reuse_across_intents' },
      'different intent',
      1,
    ],
    [{ kind: 'intent_not_found' }, 'Intent not found', 1],
    [{ kind: 'set_not_found' }, 'set not found', 1],
    [
      {
        kind: 'insufficient_credits',
        creditBalance: 0,
        required: 1,
      },
      'Not enough credits',
      1,
    ],
    [
      { kind: 'stream_in_progress', streamId: 's1' },
      'already in progress',
      1,
    ],
    [{ kind: 'resume_in_progress' }, 'resume is already in progress', 1],
    [{ kind: 'upstream_error', message: 'LLM down' }, 'Upstream error', 1],
    [
      { kind: 'unknown', status: 500, message: 'something' },
      'Unexpected response',
      1,
    ],
  ])('formats %j correctly', (outcome, expectedText, expectedExit) => {
    const out = makeStream(false);
    const err = makeStream(false);
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'resume',
    });
    r.onResumeBlockingOutcome(outcome);
    // The 'already_complete' happy-ish path writes to stderr; others do too.
    const combined = out.buffer + err.buffer;
    expect(combined).toContain(expectedText);
    expect(r.summary().exitCode).toBe(expectedExit);
  });

  it('cached_completed emits "(cached)" and a summary to stdout', () => {
    const out = makeStream(false);
    const err = makeStream(false);
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'resume',
    });
    r.onResumeBlockingOutcome({
      kind: 'cached_completed',
      intent: { id: 'i1', title: 'T' },
      affirmationSet: { id: 's1', affirmations: [{ id: 'a1', text: 'x' }] },
    });
    expect(out.buffer).toContain('(cached)');
    expect(out.buffer).toContain('Resumed:');
    expect(out.buffer).toContain('Intent ID: i1');
    expect(r.summary().exitCode).toBe(0);
    expect(r.summary().resumed).toBe(true);
  });

  it('resumed with generationStatus=framework_only prints retry hint, exit 0', () => {
    const out = makeStream(false);
    const err = makeStream(false);
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'resume',
    });
    r.onResumeBlockingOutcome({
      kind: 'resumed',
      status: 200,
      intent: { id: 'i1' },
      affirmationSet: { id: 's1' },
      generationStatus: 'framework_only',
      retryAction: { action: 'resume_pass2', intentId: 'i1' },
    });
    expect(err.buffer).toContain('Pass 2 failed again');
    expect(r.summary().exitCode).toBe(0);
  });
});

describe('StreamRenderer — telemetry hook (#862 acceptance)', () => {
  it('emits cli.generation.phase.* events with elapsedMs + operation', () => {
    const out = makeStream(false);
    const err = makeStream(false);
    const captured: Array<{ event: string; details: Record<string, unknown> }> = [];
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'create',
      telemetry: (event, details) => captured.push({ event, details }),
    });

    r.onEvent(ev('phase.validation'));
    r.onEvent(ev('phase.gatekeeper', { passed: true }));
    r.onEvent(
      ev('phase.complete', {
        intentId: 'i1',
        affirmationSetId: 's1',
        totalDurationMs: 100,
      }),
    );

    const events = captured.map((c) => c.event);
    expect(events).toEqual([
      'cli.generation.phase.validation',
      'cli.generation.phase.gatekeeper',
      'cli.generation.phase.complete',
    ]);
    for (const c of captured) {
      expect(typeof c.details['elapsedMs']).toBe('number');
      expect(c.details['operation']).toBe('create');
    }
    expect(captured[1]!.details['passed']).toBe(true);
    expect(captured[2]!.details['intentId']).toBe('i1');
    r.cleanup();
  });

  it('is a no-op when telemetry callback is not provided', () => {
    const out = makeStream(false);
    const err = makeStream(false);
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'create',
    });
    // Should not throw.
    r.onEvent(ev('phase.validation'));
    r.onEvent(
      ev('phase.complete', {
        intentId: 'i1',
        affirmationSetId: 's1',
        totalDurationMs: 100,
      }),
    );
    r.cleanup();
  });
});

describe('StreamRenderer — fallback', () => {
  it('prints a fallback note to stderr', () => {
    const out = makeStream(false);
    const err = makeStream(false);
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'create',
    });
    r.onFallback();
    expect(err.buffer).toContain('falling back to blocking');
  });
});

describe('StreamRenderer — framework text throttling (TTY, stream_text)', () => {
  it('renders methodology incrementally as chunks arrive', () => {
    vi.useFakeTimers();
    try {
      const out = makeStream(true);
      const err = makeStream(false);
      const r = new StreamRenderer({
        streamText: true,
        stdout: out,
        stderr: err,
        operation: 'create',
      });

      r.onEvent(ev('phase.framework_streaming.begin'));

      // Feed a JSON body char-by-char, advance timers, assert increments.
      const jsonBody = '{"methodology":"Hello world this is streaming"}';
      for (const ch of jsonBody) {
        r.onEvent(
          ev('phase.framework_streaming.chunk', { delta: ch }),
        );
      }
      // Advance the throttle timer to trigger at least one flush.
      vi.advanceTimersByTime(500);

      // After the flush, methodology characters should be in stdout.
      expect(out.buffer).toContain('Hello world this is streaming');

      r.onEvent(ev('phase.framework_streaming.end', { framework: {} }));
      r.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: PR #907 codex findings (P2 resume auth_expired, P2 Pass 2
// telemetry).
// ─────────────────────────────────────────────────────────────────────────────

describe('StreamRenderer — resume auth_expired outcome (PR #907 P2)', () => {
  it('renders Session expired with nl login guidance and exit code 1', () => {
    const out = makeStream(false);
    const err = makeStream(false);
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'resume',
    });
    r.onResumeBlockingOutcome({
      kind: 'auth_expired',
      message: 'token expired',
    } as ResumeBlockingOutcome);
    r.cleanup();
    expect(err.buffer).toContain('Session expired');
    expect(err.buffer).toContain('token expired');
    expect(err.buffer).toContain('nl login');
    expect(r.summary().exitCode).toBe(1);
  });

  it('renders Session expired without message when outcome has none', () => {
    const out = makeStream(false);
    const err = makeStream(false);
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'resume',
    });
    r.onResumeBlockingOutcome({
      kind: 'auth_expired',
    } as ResumeBlockingOutcome);
    r.cleanup();
    expect(err.buffer).toContain('Session expired');
    expect(err.buffer).toContain('nl login');
    expect(r.summary().exitCode).toBe(1);
  });
});

describe('StreamRenderer — Pass 2 (affirmations_streaming) telemetry (PR #907 P2)', () => {
  it('emits cli.generation.phase.affirmations_streaming.begin after framework_streaming.end', () => {
    const out = makeStream(false);
    const err = makeStream(false);
    const captured: Array<{ event: string; details: Record<string, unknown> }> = [];
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'create',
      telemetry: (event, details) => captured.push({ event, details }),
    });
    r.onEvent(ev('phase.framework_streaming.begin'));
    r.onEvent(ev('phase.framework_streaming.end', { framework: {} }));
    r.onEvent(
      ev('phase.affirmations_streaming.chunk', {
        affirmation: { text: 'x', grouping: 'g', rationale: 'r' },
      }),
    );
    const names = captured.map((c) => c.event);
    expect(names).toContain('cli.generation.phase.affirmations_streaming.begin');
    // Fires exactly once even though both the end-of-framework path and
    // the chunk path would normally trigger it.
    expect(
      names.filter((n) => n === 'cli.generation.phase.affirmations_streaming.begin')
        .length,
    ).toBe(1);
    r.cleanup();
  });

  it('emits cli.generation.phase.affirmations_streaming.begin on implicit phase start (chunk without framework.end)', () => {
    const out = makeStream(false);
    const err = makeStream(false);
    const captured: Array<{ event: string; details: Record<string, unknown> }> = [];
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'create',
      telemetry: (event, details) => captured.push({ event, details }),
    });
    // No framework_streaming.end — chunk alone implicitly starts the phase.
    r.onEvent(
      ev('phase.affirmations_streaming.chunk', {
        affirmation: { text: 'x', grouping: 'g', rationale: 'r' },
      }),
    );
    expect(captured.map((c) => c.event)).toContain(
      'cli.generation.phase.affirmations_streaming.begin',
    );
    r.cleanup();
  });

  it('emits cli.generation.phase.affirmations_streaming.begin exactly once when chunk precedes framework_streaming.end (out-of-order)', () => {
    const out = makeStream(false);
    const err = makeStream(false);
    const captured: Array<{ event: string; details: Record<string, unknown> }> = [];
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'create',
      telemetry: (event, details) => captured.push({ event, details }),
    });
    // Chunk first (implicit phase start), then framework_streaming.end.
    // The activePhase check in the chunk handler would set activePhase
    // to 'Composing affirmations'; without the boolean guard, the later
    // framework_streaming.end would re-emit the telemetry.
    r.onEvent(ev('phase.framework_streaming.begin'));
    r.onEvent(
      ev('phase.affirmations_streaming.chunk', {
        affirmation: { text: 'x', grouping: 'g', rationale: 'r' },
      }),
    );
    r.onEvent(ev('phase.framework_streaming.end', { framework: {} }));
    const beginCount = captured
      .map((c) => c.event)
      .filter((n) => n === 'cli.generation.phase.affirmations_streaming.begin')
      .length;
    expect(beginCount).toBe(1);
    r.cleanup();
  });

  it('affirmations_streaming.begin event carries elapsedMs and operation', () => {
    const out = makeStream(false);
    const err = makeStream(false);
    const captured: Array<{ event: string; details: Record<string, unknown> }> = [];
    const r = new StreamRenderer({
      streamText: false,
      stdout: out,
      stderr: err,
      operation: 'resume',
      telemetry: (event, details) => captured.push({ event, details }),
    });
    r.onEvent(ev('phase.framework_streaming.end', { framework: {} }));
    const begin = captured.find(
      (c) => c.event === 'cli.generation.phase.affirmations_streaming.begin',
    );
    expect(begin).toBeDefined();
    expect(typeof begin!.details['elapsedMs']).toBe('number');
    expect(begin!.details['operation']).toBe('resume');
    r.cleanup();
  });
});
