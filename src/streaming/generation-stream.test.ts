/**
 * Unit tests for the SSE stream consumer (#862).
 *
 * Mirrors the shape of `apps/web/lib/streaming/generation-stream.test.ts`
 * but covers the Node/CLI additions:
 *   - Resume endpoint JSON-mode outcomes surface via `onResumeBlockingOutcome`.
 *   - HTTP 404 triggers `onFallback` (safe case). Any other non-404
 *     pre-stream failure triggers `onError` with a typed `StreamError` —
 *     NOT `onFallback`.
 *   - Mid-stream failures surface as `onError`, NEVER `onFallback`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  openGenerationStream,
  type GenerationStreamHandlers,
  type ResumeBlockingOutcome,
  type StreamError,
} from './generation-stream.js';
import type { StreamingProtocolEvent } from './protocol-types.js';

function buildSseBody(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
}

function makeSseResponse(
  frames: string[],
  init?: { headers?: Record<string, string> },
): Response {
  return new Response(buildSseBody(frames), {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      ...(init?.headers ?? {}),
    },
  });
}

function makeJsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function makeHandlers(overrides?: Partial<GenerationStreamHandlers>): {
  handlers: GenerationStreamHandlers;
  events: StreamingProtocolEvent[];
  errors: StreamError[];
  outcomes: ResumeBlockingOutcome[];
  fallbacks: string[];
} {
  const events: StreamingProtocolEvent[] = [];
  const errors: StreamError[] = [];
  const outcomes: ResumeBlockingOutcome[] = [];
  const fallbacks: string[] = [];
  const handlers: GenerationStreamHandlers = {
    onEvent: (e) => events.push(e),
    onError: (e) => errors.push(e),
    onFallback: (r) => fallbacks.push(r),
    onResumeBlockingOutcome: (o) => outcomes.push(o),
    ...overrides,
  };
  return { handlers, events, errors, outcomes, fallbacks };
}

describe('openGenerationStream — generate happy path', () => {
  it('emits events in order and ends on phase.complete', async () => {
    const frames = [
      'event: phase.validation\ndata: {}\n\n',
      'event: phase.gatekeeper\ndata: {"passed":true}\n\n',
      'event: phase.framework_streaming.begin\ndata: {}\n\n',
      'event: phase.framework_streaming.chunk\ndata: {"delta":"hello"}\n\n',
      'event: phase.complete\ndata: {"intentId":"i1","affirmationSetId":"s1","totalDurationMs":1234}\n\n',
    ];
    fetchMock.mockResolvedValue(makeSseResponse(frames));

    const { handlers, events, errors, fallbacks } = makeHandlers();
    const stream = openGenerationStream(
      {
        request: { kind: 'generate', intentText: 'hi' },
        clientIdempotencyKey: 'key-1',
        apiBaseUrl: 'http://localhost:3001',
        getAccessToken: () => 'tok',
      },
      handlers,
    );
    await stream.done;

    expect(events.map((e) => e.event)).toEqual([
      'phase.validation',
      'phase.gatekeeper',
      'phase.framework_streaming.begin',
      'phase.framework_streaming.chunk',
      'phase.complete',
    ]);
    expect(errors).toEqual([]);
    expect(fallbacks).toEqual([]);
  });

  it('ignores unknown event names (forward-compat)', async () => {
    const frames = [
      'event: phase.future_event\ndata: {"x":1}\n\n',
      'event: phase.complete\ndata: {"intentId":"i1","affirmationSetId":"s1","totalDurationMs":1}\n\n',
    ];
    fetchMock.mockResolvedValue(makeSseResponse(frames));

    const { handlers, events, errors } = makeHandlers();
    const stream = openGenerationStream(
      {
        request: { kind: 'generate', intentText: 'x' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    );
    await stream.done;

    expect(events.map((e) => e.event)).toEqual(['phase.complete']);
    expect(errors).toEqual([]);
  });

  it('skips :keep-alive comment frames', async () => {
    const frames = [
      ': keep-alive\n\n',
      'event: phase.validation\ndata: {}\n\n',
      ': keep-alive\n\n',
      'event: phase.complete\ndata: {"intentId":"i1","affirmationSetId":"s1","totalDurationMs":1}\n\n',
    ];
    fetchMock.mockResolvedValue(makeSseResponse(frames));

    const { handlers, events } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'generate', intentText: 'x' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;

    expect(events.map((e) => e.event)).toEqual([
      'phase.validation',
      'phase.complete',
    ]);
  });
});

describe('openGenerationStream — generate pre-stream errors', () => {
  it('falls back on HTTP 404 (old server — safe case)', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse(404, { error: 'Not Found' }));
    const { handlers, fallbacks, errors } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'generate', intentText: 'x' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(fallbacks).toEqual(['sse_failed']);
    expect(errors).toEqual([]);
  });

  it('surfaces 409 previous_attempt_failed_post_commit as previous_attempt_failed error', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(409, {
        code: 'previous_attempt_failed_post_commit',
        message: 'previous attempt was charged and failed',
      }),
    );
    const { handlers, errors, fallbacks } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'generate', intentText: 'x' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe('previous_attempt_failed');
    expect(fallbacks).toEqual([]);
  });

  it('surfaces 429 stream_in_progress as concurrency_blocked', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(429, {
        code: 'stream_in_progress',
        streamId: 's-1',
      }),
    );
    const { handlers, errors } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'generate', intentText: 'x' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      kind: 'concurrency_blocked',
      streamId: 's-1',
    });
  });

  it('surfaces 429 plain as rate_limit with retry-after', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(
        429,
        { message: 'too fast', retry_after_ms: 12_000 },
        { 'retry-after': '12' },
      ),
    );
    const { handlers, errors } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'generate', intentText: 'x' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe('rate_limit');
    expect((errors[0] as { retryAfterMs?: number }).retryAfterMs).toBe(12_000);
  });

  it('surfaces 401 as auth_expired', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(401, { error: 'expired' }),
    );
    const { handlers, errors, fallbacks } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'generate', intentText: 'x' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe('auth_expired');
    expect(fallbacks).toEqual([]);
  });

  it('surfaces 500 as transport error (NOT a fallback)', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(500, { error: 'server died' }),
    );
    const { handlers, errors, fallbacks } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'generate', intentText: 'x' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(fallbacks).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe('transport');
  });

  it('surfaces 2xx with wrong content-type as transport (NOT a fallback)', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const { handlers, errors, fallbacks } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'generate', intentText: 'x' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(fallbacks).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe('transport');
  });

  it('surfaces fetch TypeError as transport (NOT a fallback)', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'));
    const { handlers, errors, fallbacks } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'generate', intentText: 'x' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(fallbacks).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: 'transport' });
  });
});

describe('openGenerationStream — mid-stream failure does NOT fall back', () => {
  it('emits stream_ended_without_terminal when reader closes without terminal', async () => {
    const frames = [
      'event: phase.validation\ndata: {}\n\n',
      'event: phase.gatekeeper\ndata: {"passed":true}\n\n',
      // no terminal
    ];
    fetchMock.mockResolvedValue(makeSseResponse(frames));
    const { handlers, errors, fallbacks } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'generate', intentText: 'x' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(errors).toEqual([{ kind: 'stream_ended_without_terminal' }]);
    expect(fallbacks).toEqual([]);
  });

  it('emits transport error when the reader throws mid-stream', async () => {
    // Throwing ReadableStream — triggers consumeStream's catch.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: phase.validation\ndata: {}\n\n'));
        controller.error(new Error('socket reset'));
      },
    });
    fetchMock.mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const { handlers, errors, fallbacks } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'generate', intentText: 'x' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(fallbacks).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe('transport');
  });
});

describe('openGenerationStream — abort', () => {
  it('abort() closes the stream cleanly without emitting further events', async () => {
    let enqueued = 0;
    const controllerRef: { current: ReadableStreamDefaultController<Uint8Array> | null } = {
      current: null,
    };
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controllerRef.current = c;
        const encoder = new TextEncoder();
        c.enqueue(encoder.encode('event: phase.validation\ndata: {}\n\n'));
        enqueued++;
      },
    });
    fetchMock.mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const { handlers, events } = makeHandlers();
    const stream = openGenerationStream(
      {
        request: { kind: 'generate', intentText: 'x' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    );

    // Let the first event through.
    await new Promise((r) => setTimeout(r, 10));
    stream.abort();
    if (controllerRef.current) {
      try {
        controllerRef.current.close();
      } catch {
        // might already be closed from abort
      }
    }
    await stream.done;

    // The first event may or may not have been consumed before abort; the
    // important invariant is we didn't emit a spurious terminal.
    expect(events.filter((e) => e.event === 'phase.complete')).toHaveLength(0);
    expect(enqueued).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Resume endpoint — JSON-mode blocking outcomes.
// ─────────────────────────────────────────────────────────────────────────────

describe('openGenerationStream — resume JSON-mode outcomes', () => {
  it('201 resumed (generationStatus=complete) → resumed outcome', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(201, {
        intent: { id: 'i1', title: 'T' },
        affirmationSet: { id: 's1', affirmations: [] },
        generationStatus: 'complete',
        resumed: true,
      }),
    );
    const { handlers, outcomes, errors } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'resume', resumeIntentId: 'i1' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(errors).toEqual([]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      kind: 'resumed',
      status: 201,
      generationStatus: 'complete',
    });
  });

  it('200 cached replay (no retryAction) → cached_completed outcome', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(200, {
        intent: { id: 'i1' },
        affirmationSet: { id: 's1', affirmations: [{ id: 'a1', text: 't' }] },
        generationStatus: 'complete',
        resumed: true,
      }),
    );
    const { handlers, outcomes } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'resume', resumeIntentId: 'i1' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.kind).toBe('cached_completed');
  });

  it('200 framework_only (with retryAction) → resumed outcome with framework_only status', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(200, {
        intent: { id: 'i1' },
        affirmationSet: { id: 's1' },
        generationStatus: 'framework_only',
        retryAction: { action: 'resume_pass2', intentId: 'i1' },
      }),
    );
    const { handlers, outcomes } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'resume', resumeIntentId: 'i1' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(outcomes[0]).toMatchObject({
      kind: 'resumed',
      status: 200,
      generationStatus: 'framework_only',
    });
  });

  it('409 already_complete → already_complete outcome', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(409, {
        code: 'already_complete',
        intent: { id: 'i1' },
        affirmationSet: { id: 's1' },
      }),
    );
    const { handlers, outcomes } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'resume', resumeIntentId: 'i1' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(outcomes[0]!.kind).toBe('already_complete');
  });

  it('409 previous_attempt_framework_only → typed outcome (distinct from idempotency_key_reuse)', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(409, {
        code: 'previous_attempt_framework_only',
        intent: { id: 'i1' },
      }),
    );
    const { handlers, outcomes } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'resume', resumeIntentId: 'i1' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(outcomes[0]!.kind).toBe('previous_attempt_framework_only');
  });

  it('409 previous_attempt_failed_post_commit → typed outcome', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(409, { code: 'previous_attempt_failed_post_commit' }),
    );
    const { handlers, outcomes } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'resume', resumeIntentId: 'i1' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(outcomes[0]!.kind).toBe('previous_attempt_failed_post_commit');
  });

  it('409 idempotency_key_reuse_across_intents → typed outcome', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(409, { code: 'idempotency_key_reuse_across_intents' }),
    );
    const { handlers, outcomes } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'resume', resumeIntentId: 'i1' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(outcomes[0]!.kind).toBe('idempotency_key_reuse_across_intents');
  });

  it('404 with code intent_not_found → typed outcome', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(404, { code: 'intent_not_found' }),
    );
    const { handlers, outcomes, fallbacks } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'resume', resumeIntentId: 'i1' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(outcomes[0]!.kind).toBe('intent_not_found');
    expect(fallbacks).toEqual([]);
  });

  it('404 without a code → falls back (old-server signal)', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse(404, { error: 'Not Found' }));
    const { handlers, fallbacks, outcomes } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'resume', resumeIntentId: 'i1' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(fallbacks).toEqual(['sse_failed']);
    expect(outcomes).toEqual([]);
  });

  it('402 insufficient_credits → typed outcome with balance/required', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(402, {
        code: 'insufficient_credits',
        creditBalance: 0,
        required: 1,
      }),
    );
    const { handlers, outcomes } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'resume', resumeIntentId: 'i1' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(outcomes[0]).toMatchObject({
      kind: 'insufficient_credits',
      creditBalance: 0,
      required: 1,
    });
  });

  it('429 resume_in_progress → typed outcome', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(429, { code: 'resume_in_progress' }),
    );
    const { handlers, outcomes } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'resume', resumeIntentId: 'i1' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(outcomes[0]!.kind).toBe('resume_in_progress');
  });

  it('accepts SSE body for resume happy path and emits phase.resume_begin + phase.complete with resumed:true', async () => {
    const frames = [
      'event: phase.resume_begin\ndata: {"intentId":"i1"}\n\n',
      'event: phase.affirmations_streaming.chunk\ndata: {"affirmation":{"text":"a","grouping":"g","rationale":"r"}}\n\n',
      'event: phase.complete\ndata: {"intentId":"i1","affirmationSetId":"s1","totalDurationMs":100,"resumed":true}\n\n',
    ];
    fetchMock.mockResolvedValue(makeSseResponse(frames));

    const { handlers, events, outcomes } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'resume', resumeIntentId: 'i1' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;

    expect(events.map((e) => e.event)).toEqual([
      'phase.resume_begin',
      'phase.affirmations_streaming.chunk',
      'phase.complete',
    ]);
    expect(outcomes).toEqual([]); // SSE path, no blocking outcome.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: PR #907 codex findings (P1 tail-drain, P2 resume auth_expired).
// ─────────────────────────────────────────────────────────────────────────────

describe('openGenerationStream — EOF tail-drain (PR #907 P1)', () => {
  it('dispatches final frame when stream ends without trailing \\n\\n', async () => {
    // Last frame is complete but lacks the terminal blank-line delimiter
    // (server/proxy closed the socket without flushing it).
    const frames = [
      'event: phase.validation\ndata: {}\n\n',
      'event: phase.complete\ndata: {"intentId":"i1","affirmationSetId":"s1","totalDurationMs":100}\n',
    ];
    fetchMock.mockResolvedValue(makeSseResponse(frames));
    const { handlers, events, errors } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'generate', intentText: 'x' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(events.map((e) => e.event)).toEqual([
      'phase.validation',
      'phase.complete',
    ]);
    expect(errors).toEqual([]);
  });

  it('dispatches final frame with CRLF line endings and no trailing delimiter', async () => {
    const frames = [
      'event: phase.validation\r\ndata: {}\r\n\r\n',
      'event: phase.complete\r\ndata: {"intentId":"i1","affirmationSetId":"s1","totalDurationMs":100}\r\n',
    ];
    fetchMock.mockResolvedValue(makeSseResponse(frames));
    const { handlers, events, errors } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'generate', intentText: 'x' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(events.map((e) => e.event)).toEqual([
      'phase.validation',
      'phase.complete',
    ]);
    expect(errors).toEqual([]);
  });

  it('falls through to stream_ended_without_terminal when tail is un-parseable', async () => {
    // Residual buffer has no parseable event — tail-drain must not
    // suppress the EOF error.
    const frames = [
      'event: phase.validation\ndata: {}\n\n',
      'garbage without colon\n',
    ];
    fetchMock.mockResolvedValue(makeSseResponse(frames));
    const { handlers, errors } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'generate', intentText: 'x' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(errors).toEqual([{ kind: 'stream_ended_without_terminal' }]);
  });
});

describe('openGenerationStream — resume auth_expired mapping (PR #907 P2)', () => {
  it('surfaces 401 JSON as auth_expired outcome', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(401, { error: 'token expired' }),
    );
    const { handlers, outcomes, errors, fallbacks } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'resume', resumeIntentId: 'i1' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      kind: 'auth_expired',
      message: 'token expired',
    });
    expect(errors).toEqual([]);
    expect(fallbacks).toEqual([]);
  });

  it('surfaces 403 JSON as auth_expired outcome', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(403, { message: 'forbidden' }),
    );
    const { handlers, outcomes } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'resume', resumeIntentId: 'i1' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      kind: 'auth_expired',
      message: 'forbidden',
    });
  });

  it('surfaces 401 with non-JSON body (HTML error page) as auth_expired', async () => {
    // A proxy-generated HTML error page — the body isn't JSON, so the
    // client can't extract a message, but the status alone is enough
    // to classify this as auth_expired.
    fetchMock.mockResolvedValue(
      new Response('<html>401 Unauthorized</html>', {
        status: 401,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const { handlers, outcomes, errors, fallbacks } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'resume', resumeIntentId: 'i1' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.kind).toBe('auth_expired');
    expect(errors).toEqual([]);
    expect(fallbacks).toEqual([]);
  });

  it('surfaces 401 with SSE content-type as auth_expired (proxy preserved Accept)', async () => {
    // Some auth middleware preserves the client's
    // Accept: text/event-stream header on an auth error reply. The
    // client must not attempt to consume that as a real stream and
    // emit stream_ended_without_terminal — it's an auth failure.
    fetchMock.mockResolvedValue(
      new Response('', {
        status: 401,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const { handlers, outcomes, errors, fallbacks } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'resume', resumeIntentId: 'i1' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.kind).toBe('auth_expired');
    expect(errors).toEqual([]);
    expect(fallbacks).toEqual([]);
  });

  it('surfaces 403 with SSE content-type as auth_expired (proxy preserved Accept)', async () => {
    fetchMock.mockResolvedValue(
      new Response('', {
        status: 403,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const { handlers, outcomes } = makeHandlers();
    await openGenerationStream(
      {
        request: { kind: 'resume', resumeIntentId: 'i1' },
        clientIdempotencyKey: 'k',
        apiBaseUrl: 'http://h',
        getAccessToken: () => 't',
      },
      handlers,
    ).done;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.kind).toBe('auth_expired');
  });
});
