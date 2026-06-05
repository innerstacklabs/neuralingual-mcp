/**
 * SSE stream consumer for `POST /affirmations/generate/stream` and
 * `POST /intents/:id/resume` (#862 CLI).
 *
 * Adapted from `apps/web/lib/streaming/generation-stream.ts`. The SSE
 * framing and event coercion are identical; what's different for Node/CLI:
 *
 *   - No browser auth refresh — the caller (CLI) owns pre-flight refresh
 *     via `UserApiClient.refreshIfExpiringSoon()` and passes the fresh
 *     token in via `getAccessToken()`.
 *   - Extended to handle the resume endpoint, which returns JSON bodies
 *     (with blocking semantics) in response to `Accept: text/event-stream`
 *     for precheck outcomes (cached replay, already_complete, not_found,
 *     etc.). For resume, a JSON body is protocol-valid — NOT an SSE
 *     failure. The stream module surfaces these as `ResumeBlockingOutcome`.
 *   - Fallback to the blocking endpoint is narrowed to the single safe
 *     case: HTTP 404 on the stream endpoint (old-server signal). Any
 *     other pre-stream failure surfaces as a typed `StreamError` — the
 *     caller must not auto-retry because the legacy blocking endpoint
 *     does NOT accept `X-Idempotency-Key`, and we can't prove the server
 *     didn't already start work + debit.
 *
 * This module is client-only. Do not import from `@neuralingual/llm` or
 * from server code.
 */

import { KNOWN_EVENT_NAMES, isTerminalEvent } from './protocol-types.js';
import type {
  StreamingProtocolEvent,
  TerminalStreamingEvent,
} from './protocol-types.js';
import type { McpErrorShape } from '../mcp-error.js';
import { emitMcpFailure } from '../mcp-telemetry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** Request kind — selects endpoint and body shape. */
export type GenerationStreamRequest =
  | {
      kind: 'generate';
      intentText?: string;
      tonePreference?: string | null;
      voicePerspective?: string;
      source?: { type: string; text?: string; url?: string; title?: string; author?: string };
    }
  | {
      kind: 'resume';
      resumeIntentId: string;
    };

export interface GenerationStreamInput {
  request: GenerationStreamRequest;
  clientIdempotencyKey: string;
  apiBaseUrl: string;
  /** Called each time we need a token (allows mid-run refresh if the CLI implements it). */
  getAccessToken: () => string;
}

/** Minimal shape we surface from resume's JSON precheck replies. */
export interface IntentLite {
  id: string;
  title?: string;
  emoji?: string | null;
  sessionContext?: string;
}

export interface AffirmationSetLite {
  id: string;
  intentId?: string;
  affirmations?: Array<{
    id: string;
    text: string;
    tone?: string;
    isEnabled?: boolean;
  }>;
}

/**
 * Resume endpoint precheck and JSON-mode outcomes. See
 * `apps/api/src/lib/resume-pass2-pipeline.ts` for the server-side
 * mapping. These are emitted when `POST /intents/:id/resume` returns a
 * JSON body in response to `Accept: text/event-stream`; for the SSE
 * pipeline path the terminal events (`phase.complete`, etc.) are
 * surfaced via the usual `onEvent` channel.
 */
export type ResumeBlockingOutcome =
  | {
      kind: 'resumed';
      status: 200 | 201;
      intent: IntentLite;
      affirmationSet: AffirmationSetLite;
      generationStatus: 'complete' | 'framework_only' | 'failed';
      retryAction?: { action: 'resume_pass2'; intentId: string };
    }
  | {
      kind: 'cached_completed';
      intent: IntentLite;
      affirmationSet: AffirmationSetLite;
    }
  | { kind: 'already_complete'; intent?: IntentLite; affirmationSet?: AffirmationSetLite }
  | { kind: 'already_failed'; intent?: IntentLite; affirmationSet?: AffirmationSetLite }
  | {
      kind: 'previous_attempt_framework_only';
      intent?: IntentLite;
      affirmationSet?: AffirmationSetLite;
    }
  | { kind: 'previous_attempt_failed_post_commit' }
  | { kind: 'idempotency_key_reuse_across_intents' }
  | { kind: 'intent_not_found' }
  | { kind: 'set_not_found' }
  | { kind: 'insufficient_credits'; creditBalance?: number; required?: number }
  | { kind: 'stream_in_progress'; streamId?: string }
  | { kind: 'resume_in_progress' }
  | { kind: 'upstream_error'; message?: string }
  /** HTTP 401/403 on the resume endpoint — expired/revoked token. */
  | { kind: 'auth_expired'; message?: string }
  | { kind: 'unknown'; status: number; code?: string; message?: string };

/** Typed errors surfaced via `handlers.onError`. */
export type StreamError =
  /** HTTP 409 `previous_attempt_failed_post_commit` on the generate endpoint. */
  | { kind: 'previous_attempt_failed'; message: string }
  /** HTTP 429 `stream_in_progress` — generate concurrency guard hit. */
  | { kind: 'concurrency_blocked'; streamId?: string; message?: string }
  /** HTTP 429 other — rate limit, with Retry-After if available. */
  | { kind: 'rate_limit'; retryAfterMs?: number; message?: string }
  /** HTTP 401/403 pre-stream. */
  | { kind: 'auth_expired'; message?: string }
  /** Reader returned done=true without a terminal event. */
  | { kind: 'stream_ended_without_terminal' }
  /** Mid-stream crash, bad transport, or wrong content-type (non-404 pre-stream). */
  | { kind: 'transport'; cause: Error };

/**
 * Normalize a streaming `StreamError` into the canonical `McpErrorShape`
 * (#2867 / FIX-13). The SSE consumer keeps its ergonomic discriminated union
 * for `switch(kind)` handling, but every streaming failure maps to the one
 * MCP error model at the failure boundary so classification + telemetry see a
 * single shape across admin client, user client, and streaming.
 */
export function streamErrorToMcpShape(error: StreamError): McpErrorShape {
  switch (error.kind) {
    case 'previous_attempt_failed':
      return { code: 'conflict', message: error.message, status: 409, retryable: false };
    case 'concurrency_blocked':
      return {
        code: 'conflict',
        message: error.message ?? 'A generation is already in progress',
        status: 409,
        retryable: false,
      };
    case 'rate_limit':
      return {
        code: 'rate_limited',
        message: error.message ?? 'HTTP 429 (rate limited)',
        status: 429,
        retryable: true,
      };
    case 'auth_expired':
      return {
        code: 'unauthorized',
        message: error.message ?? 'Authentication expired',
        status: 401,
        retryable: false,
      };
    case 'stream_ended_without_terminal':
      return {
        code: 'server_error',
        message: 'Stream ended without a terminal event',
        status: null,
        retryable: true,
      };
    case 'transport':
      return {
        code: 'network',
        message: error.cause.message || 'Stream transport failure',
        status: null,
        retryable: true,
      };
  }
}

export interface GenerationStreamHandlers {
  /** Called for every well-formed protocol event from the SSE stream. */
  onEvent: (event: StreamingProtocolEvent) => void;
  /**
   * Pre-stream SSE capability failure — caller should switch to the
   * blocking endpoint. Only fires on HTTP 404 on the stream endpoint
   * (old-server signal) or when fetching returned a 2xx without a
   * readable body (configured proxy misrouted to a static 200). Any
   * other pre-stream failure is surfaced via `onError` instead.
   */
  onFallback: (reason: 'sse_failed') => void;
  /**
   * Typed non-fallback errors. `error` is the ergonomic discriminated union
   * (for `switch(error.kind)` rendering); `mcpError` is the SAME failure
   * normalized to the canonical `McpErrorShape` (#2867), so a caller that
   * wants to handle MCP failures uniformly by `code`/`status`/`retryable` —
   * interoperably with the admin/user API clients — can use that instead.
   */
  onError: (error: StreamError, mcpError: McpErrorShape) => void;
  /**
   * Resume endpoint's JSON-mode precheck outcome. Only fires when
   * `request.kind === 'resume'` and the response is a JSON body. The
   * SSE pipeline path bypasses this handler entirely.
   */
  onResumeBlockingOutcome?: (outcome: ResumeBlockingOutcome) => void;
}

export interface GenerationStream {
  abort: () => void;
  /** Settled when the stream ends (terminal event, abort, fallback, error, or blocking outcome). */
  done: Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE frame parser
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedFrame {
  event: string;
  data: string;
}

function sliceFirstFrame(
  buffer: string,
): { frame: string; rest: string } | null {
  const a = buffer.indexOf('\n\n');
  const b = buffer.indexOf('\r\n\r\n');
  if (a === -1 && b === -1) return null;
  let cut: number;
  let boundaryLen: number;
  if (a === -1) {
    cut = b;
    boundaryLen = 4;
  } else if (b === -1) {
    cut = a;
    boundaryLen = 2;
  } else if (a < b) {
    cut = a;
    boundaryLen = 2;
  } else {
    cut = b;
    boundaryLen = 4;
  }
  return {
    frame: buffer.slice(0, cut),
    rest: buffer.slice(cut + boundaryLen),
  };
}

function parseFrame(raw: string): ParsedFrame {
  const lines = raw.split(/\r?\n/);
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith(':')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const field = line.slice(0, colonIdx);
    let value = line.slice(colonIdx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }
  return { event, data: dataLines.join('\n') };
}

function coerceProtocolEvent(
  frame: ParsedFrame,
): StreamingProtocolEvent | null {
  if (!KNOWN_EVENT_NAMES.has(frame.event)) return null;
  let data: unknown;
  try {
    data = frame.data.length === 0 ? {} : JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object') return null;
  return {
    event: frame.event,
    data: data as Record<string, never>,
  } as unknown as StreamingProtocolEvent;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP error / body handling
// ─────────────────────────────────────────────────────────────────────────────

function parseRetryAfterMs(
  res: Response,
  body: Record<string, unknown>,
): number | undefined {
  const header = res.headers.get('retry-after');
  if (header !== null) {
    const asInt = parseInt(header, 10);
    if (Number.isFinite(asInt) && asInt > 0) return asInt * 1000;
    const asDate = Date.parse(header);
    if (!Number.isNaN(asDate)) {
      const delta = asDate - Date.now();
      if (delta > 0) return delta;
    }
  }
  const retry =
    typeof body['retry_after_ms'] === 'number'
      ? (body['retry_after_ms'] as number)
      : typeof body['retryAfterMs'] === 'number'
      ? (body['retryAfterMs'] as number)
      : undefined;
  if (typeof retry === 'number' && retry > 0) return retry;
  return undefined;
}

/**
 * Interpret the initial HTTP response for the *generate* endpoint.
 * Returns what the caller should do next.
 */
type GenerateInitialHandling =
  | { kind: 'stream'; body: ReadableStream<Uint8Array> }
  | { kind: 'fallback' }
  | { kind: 'error'; error: StreamError };

async function handleGenerateResponse(
  res: Response,
): Promise<GenerateInitialHandling> {
  if (res.status === 404) {
    // Old server — stream endpoint doesn't exist. Safe to fall back to
    // the blocking endpoint because no handler ran, no debit happened.
    return { kind: 'fallback' };
  }
  if (!res.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // no body
    }
    const code =
      typeof body['code'] === 'string' ? (body['code'] as string) : undefined;
    const message =
      typeof body['message'] === 'string'
        ? (body['message'] as string)
        : typeof body['error'] === 'string'
        ? (body['error'] as string)
        : undefined;

    if (res.status === 409 && code === 'previous_attempt_failed_post_commit') {
      return {
        kind: 'error',
        error: {
          kind: 'previous_attempt_failed',
          message: message ?? 'The previous attempt failed after being charged.',
        },
      };
    }
    if (res.status === 429 && code === 'stream_in_progress') {
      return {
        kind: 'error',
        error: {
          kind: 'concurrency_blocked',
          ...(typeof body['streamId'] === 'string'
            ? { streamId: body['streamId'] as string }
            : {}),
          ...(message !== undefined ? { message } : {}),
        },
      };
    }
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res, body);
      return {
        kind: 'error',
        error: {
          kind: 'rate_limit',
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          ...(message !== undefined ? { message } : {}),
        },
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        kind: 'error',
        error: {
          kind: 'auth_expired',
          ...(message !== undefined ? { message } : {}),
        },
      };
    }
    // Any other pre-stream failure: transport error (server may have
    // done work, must not auto-fallback).
    return {
      kind: 'error',
      error: {
        kind: 'transport',
        cause: new Error(`HTTP ${res.status}: ${message ?? 'Stream open failed'}`),
      },
    };
  }

  const ct = res.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('text/event-stream')) {
    // 2xx with wrong content-type. Server handler likely ran — do NOT
    // auto-fall-back. Surface as transport error.
    return {
      kind: 'error',
      error: {
        kind: 'transport',
        cause: new Error(
          `Expected text/event-stream, got ${ct || '(empty content-type)'}`,
        ),
      },
    };
  }
  if (res.body === null) {
    // 2xx with no body — treat as pre-stream fallback case: handler may
    // or may not have run; without a body we have no stream to parse,
    // but we also have no evidence of partial server work. Match the
    // "only 404 falls back" rule by surfacing transport instead.
    return {
      kind: 'error',
      error: {
        kind: 'transport',
        cause: new Error('Stream response has no body'),
      },
    };
  }
  return { kind: 'stream', body: res.body };
}

/**
 * Interpret the initial HTTP response for the *resume* endpoint. Maps
 * status + body.code → typed `ResumeBlockingOutcome` for JSON replies,
 * or hands off to the SSE parser when the response is a stream.
 */
type ResumeInitialHandling =
  | { kind: 'stream'; body: ReadableStream<Uint8Array> }
  | { kind: 'fallback' }
  | { kind: 'error'; error: StreamError }
  | { kind: 'blocking'; outcome: ResumeBlockingOutcome };

async function handleResumeResponse(
  res: Response,
): Promise<ResumeInitialHandling> {
  if (res.status === 404) {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // no body
    }
    const code =
      typeof body['code'] === 'string' ? (body['code'] as string) : undefined;
    if (code === 'intent_not_found') {
      return { kind: 'blocking', outcome: { kind: 'intent_not_found' } };
    }
    if (code === 'set_not_found') {
      return { kind: 'blocking', outcome: { kind: 'set_not_found' } };
    }
    // No code body + 404 → this might be "endpoint doesn't exist on an
    // old server". Fall back to blocking for that case.
    if (code === undefined) return { kind: 'fallback' };
    return {
      kind: 'blocking',
      outcome: {
        kind: 'unknown',
        status: 404,
        code,
        ...(typeof body['message'] === 'string'
          ? { message: body['message'] as string }
          : {}),
      },
    };
  }

  // Auth failures short-circuit BEFORE any content-type sniffing.
  // A proxy / auth middleware may preserve the client's
  // `Accept: text/event-stream` header on a 401/403 reply — but an
  // expired-token response is never a real stream. Route by status
  // through the same mapper as JSON replies so both paths surface
  // the typed `auth_expired` outcome (and the `nl login` guidance).
  if (res.status === 401 || res.status === 403) {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON / empty body — the mapper still returns
      // `auth_expired` by status.
    }
    return {
      kind: 'blocking',
      outcome: mapResumeJsonToOutcome(res.status, body),
    };
  }

  const ct = res.headers.get('content-type') ?? '';
  const isJson = ct.toLowerCase().includes('application/json');
  const isSse = ct.toLowerCase().includes('text/event-stream');

  if (isJson || !isSse) {
    // Resume endpoint returned JSON (or non-SSE) — this is a precheck
    // outcome per the protocol; it's NOT an SSE failure.
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON / empty body — let the status-based mapper handle it.
      // (401/403 is already intercepted above; this catches any other
      // unparseable non-SSE reply — the mapper's `unknown` branch takes
      // it from there.)
    }
    return { kind: 'blocking', outcome: mapResumeJsonToOutcome(res.status, body) };
  }

  if (res.body === null) {
    return {
      kind: 'error',
      error: {
        kind: 'transport',
        cause: new Error('Stream response has no body'),
      },
    };
  }
  return { kind: 'stream', body: res.body };
}

/**
 * Map a resume endpoint JSON body (or known-empty body) + HTTP status to
 * a typed `ResumeBlockingOutcome`. Exported so `UserApiClient.resumeIntent`
 * (blocking path) and `openGenerationStream` (streaming path that gets a
 * JSON reply back) can share the mapping.
 */
export function mapResumeJsonToOutcome(
  status: number,
  body: Record<string, unknown>,
): ResumeBlockingOutcome {
  const code = typeof body['code'] === 'string' ? (body['code'] as string) : undefined;
  const message =
    typeof body['message'] === 'string'
      ? (body['message'] as string)
      : typeof body['error'] === 'string'
      ? (body['error'] as string)
      : undefined;
  const intent =
    typeof body['intent'] === 'object' && body['intent'] !== null
      ? (body['intent'] as IntentLite)
      : undefined;
  const affirmationSet =
    typeof body['affirmationSet'] === 'object' && body['affirmationSet'] !== null
      ? (body['affirmationSet'] as AffirmationSetLite)
      : undefined;
  const creditBalance =
    typeof body['creditBalance'] === 'number'
      ? (body['creditBalance'] as number)
      : undefined;
  const required =
    typeof body['required'] === 'number'
      ? (body['required'] as number)
      : undefined;
  const generationStatus =
    body['generationStatus'] === 'complete' ||
    body['generationStatus'] === 'framework_only' ||
    body['generationStatus'] === 'failed'
      ? (body['generationStatus'] as 'complete' | 'framework_only' | 'failed')
      : undefined;
  const retryAction =
    typeof body['retryAction'] === 'object' &&
    body['retryAction'] !== null &&
    (body['retryAction'] as { action?: string }).action === 'resume_pass2' &&
    typeof (body['retryAction'] as { intentId?: string }).intentId === 'string'
      ? {
          action: 'resume_pass2' as const,
          intentId: (body['retryAction'] as { intentId: string }).intentId,
        }
      : undefined;

  // Auth failures — short-circuit before the precheck-code switch so an
  // expired/revoked token always maps to the typed `auth_expired`
  // outcome regardless of body shape. Mirrors the generate path's
  // 401/403 → `auth_expired` StreamError in `handleGenerateResponse`.
  if (status === 401 || status === 403) {
    return {
      kind: 'auth_expired',
      ...(message !== undefined ? { message } : {}),
    };
  }

  // Happy paths — 201 (resumed) / 200 (resumed or cached).
  if ((status === 200 || status === 201) && intent && affirmationSet) {
    // Cached replay: server sets `resumed: true` AND generationStatus='complete' on 200.
    // Fresh run: 201. We can't reliably distinguish them without a dedicated field,
    // so key off status code.
    if (status === 201) {
      return {
        kind: 'resumed',
        status: 201,
        intent,
        affirmationSet,
        generationStatus: generationStatus ?? 'complete',
        ...(retryAction !== undefined ? { retryAction } : {}),
      };
    }
    // status === 200 — server's resume handler returns 200 for: cached
    // replays AND for successful runs where generationStatus is
    // framework_only (not 201). Cached replays carry the full
    // `affirmationSet` with all affirmations; framework_only also has
    // the existing affirmationSet. We differentiate via generationStatus
    // + retryAction — retryAction is only present on framework_only.
    if (retryAction !== undefined && generationStatus === 'framework_only') {
      return {
        kind: 'resumed',
        status: 200,
        intent,
        affirmationSet,
        generationStatus: 'framework_only',
        retryAction,
      };
    }
    return { kind: 'cached_completed', intent, affirmationSet };
  }

  // Precheck failures — map by code.
  switch (code) {
    case 'already_complete':
      return {
        kind: 'already_complete',
        ...(intent !== undefined ? { intent } : {}),
        ...(affirmationSet !== undefined ? { affirmationSet } : {}),
      };
    case 'already_failed':
      return {
        kind: 'already_failed',
        ...(intent !== undefined ? { intent } : {}),
        ...(affirmationSet !== undefined ? { affirmationSet } : {}),
      };
    case 'previous_attempt_framework_only':
      return {
        kind: 'previous_attempt_framework_only',
        ...(intent !== undefined ? { intent } : {}),
        ...(affirmationSet !== undefined ? { affirmationSet } : {}),
      };
    case 'previous_attempt_failed_post_commit':
      return { kind: 'previous_attempt_failed_post_commit' };
    case 'idempotency_key_reuse_across_intents':
      return { kind: 'idempotency_key_reuse_across_intents' };
    case 'intent_not_found':
      return { kind: 'intent_not_found' };
    case 'set_not_found':
      return { kind: 'set_not_found' };
    case 'insufficient_credits':
      return {
        kind: 'insufficient_credits',
        ...(creditBalance !== undefined ? { creditBalance } : {}),
        ...(required !== undefined ? { required } : {}),
      };
    case 'stream_in_progress':
      return {
        kind: 'stream_in_progress',
        ...(typeof body['streamId'] === 'string'
          ? { streamId: body['streamId'] as string }
          : {}),
      };
    case 'resume_in_progress':
      return { kind: 'resume_in_progress' };
    case 'upstream_error':
      return {
        kind: 'upstream_error',
        ...(message !== undefined ? { message } : {}),
      };
    default:
      return {
        kind: 'unknown',
        status,
        ...(code !== undefined ? { code } : {}),
        ...(message !== undefined ? { message } : {}),
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open a streaming generation (or resume) request and drive the handler
 * callbacks. Returns an `abort()` function and a `done` promise that
 * settles when the stream ends (terminal event, abort, error, or
 * blocking outcome).
 */
export function openGenerationStream(
  input: GenerationStreamInput,
  rawHandlers: GenerationStreamHandlers,
): GenerationStream {
  const controller = new AbortController();
  let settled = false;

  // Tap every streaming failure for telemetry (#2867 pattern F: streaming
  // MCP failures previously reached no sink). The path is the stream endpoint;
  // the error is normalized to the canonical shape for code/status/retryable.
  const streamPath =
    input.request.kind === 'generate'
      ? '/affirmations/generate/stream'
      : `/intents/${input.request.resumeIntentId}/resume`;
  // Internal handlers: `onError` takes one arg (the ergonomic union). The
  // wrapper normalizes to the canonical shape, emits telemetry, then hands the
  // public caller BOTH the union and the shape (#2867) so streaming failures
  // are interoperable with the HTTP clients.
  const handlers: InternalStreamHandlers = {
    ...rawHandlers,
    onError: (error: StreamError): void => {
      const shape = streamErrorToMcpShape(error);
      emitMcpFailure({
        tool: 'generation_stream',
        method: 'POST',
        path: streamPath,
        code: shape.code,
        status: shape.status,
        retryable: shape.retryable,
      });
      rawHandlers.onError(error, shape);
    },
  };

  const done = (async () => {
    try {
      const token = input.getAccessToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': input.clientIdempotencyKey,
        Accept: 'text/event-stream',
      };
      if (token) headers['X-Access-Token'] = token;

      const url =
        input.request.kind === 'generate'
          ? `${input.apiBaseUrl}/affirmations/generate/stream`
          : `${input.apiBaseUrl}/intents/${encodeURIComponent(input.request.resumeIntentId)}/resume`;

      const body =
        input.request.kind === 'generate'
          ? JSON.stringify({
              ...(input.request.intentText ? { intentText: input.request.intentText } : {}),
              ...(input.request.tonePreference
                ? { tonePreference: input.request.tonePreference }
                : {}),
              ...(input.request.voicePerspective
                ? { voicePerspective: input.request.voicePerspective }
                : {}),
              ...(input.request.source
                ? { source: input.request.source }
                : {}),
            })
          : JSON.stringify({});

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
      } catch (e) {
        if (isAbortError(e)) return;
        // Transport-layer error BEFORE any response — we can't prove
        // the server didn't start work, so we don't auto-fallback. The
        // CLI surfaces this and exits non-zero.
        handlers.onError({
          kind: 'transport',
          cause: e instanceof Error ? e : new Error(String(e)),
        });
        return;
      }

      if (input.request.kind === 'generate') {
        const handling = await handleGenerateResponse(res);
        if (handling.kind === 'fallback') {
          handlers.onFallback('sse_failed');
          return;
        }
        if (handling.kind === 'error') {
          handlers.onError(handling.error);
          return;
        }
        await consumeStream(handling.body, handlers, controller.signal);
        return;
      }

      // request.kind === 'resume'
      const handling = await handleResumeResponse(res);
      if (handling.kind === 'fallback') {
        handlers.onFallback('sse_failed');
        return;
      }
      if (handling.kind === 'error') {
        handlers.onError(handling.error);
        return;
      }
      if (handling.kind === 'blocking') {
        if (handlers.onResumeBlockingOutcome) {
          handlers.onResumeBlockingOutcome(handling.outcome);
        } else {
          // Caller didn't wire the resume-specific handler — surface as
          // transport error so we fail loudly in dev.
          handlers.onError({
            kind: 'transport',
            cause: new Error(
              `resume blocking outcome (${handling.outcome.kind}) received but onResumeBlockingOutcome handler is not set`,
            ),
          });
        }
        return;
      }
      await consumeStream(handling.body, handlers, controller.signal);
    } finally {
      settled = true;
    }
  })();

  return {
    abort: () => {
      if (settled) return;
      controller.abort();
    },
    done,
  };
}

/** Internal handler view: `onError` takes only the ergonomic union — the
 *  canonical-shape mapping is applied at the public boundary in
 *  `openGenerationStream` (#2867). */
type InternalStreamHandlers = Omit<GenerationStreamHandlers, 'onError'> & {
  onError: (error: StreamError) => void;
};

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  handlers: InternalStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  let buffer = '';
  let sawTerminal = false;

  try {
    for (;;) {
      if (signal.aborted) return;
      const { value, done: readerDone } = await reader.read();
      if (readerDone) break;
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: true });

      for (;;) {
        const split = sliceFirstFrame(buffer);
        if (!split) break;
        buffer = split.rest;
        const parsed = parseFrame(split.frame);
        if (parsed.event === 'message' && parsed.data.length === 0) continue;
        const protocolEvent = coerceProtocolEvent(parsed);
        if (!protocolEvent) continue;
        handlers.onEvent(protocolEvent);
        if (isTerminalEvent(protocolEvent as TerminalStreamingEvent)) {
          sawTerminal = true;
        }
      }
    }

    const tail = decoder.decode();
    if (tail.length > 0) buffer += tail;

    // Some servers/proxies close the socket with a complete frame in the
    // buffer but without the final blank-line delimiter. `sliceFirstFrame`
    // needed that delimiter to cut, so the frame is still residual here.
    // Attempt one last parse on the trimmed tail — if it coerces to a
    // known protocol event, dispatch it just like the inner loop would
    // have. Malformed residual data falls through to the error path.
    const trimmed = buffer.replace(/\r?\n+$/, '');
    if (trimmed.length > 0) {
      const parsed = parseFrame(trimmed);
      if (!(parsed.event === 'message' && parsed.data.length === 0)) {
        const protocolEvent = coerceProtocolEvent(parsed);
        if (protocolEvent) {
          handlers.onEvent(protocolEvent);
          if (isTerminalEvent(protocolEvent as TerminalStreamingEvent)) {
            sawTerminal = true;
          }
        }
      }
    }

    if (!sawTerminal) {
      handlers.onError({ kind: 'stream_ended_without_terminal' });
    }
  } catch (e) {
    if (isAbortError(e)) return;
    handlers.onError({
      kind: 'transport',
      cause: e instanceof Error ? e : new Error(String(e)),
    });
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function isAbortError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'AbortError') return true;
  if (e instanceof Error && e.name === 'AbortError') return true;
  return false;
}
