/**
 * Unit tests for the unified MCP error model (#2867 / FIX-13).
 */
import { describe, expect, it } from 'vitest';
import {
  McpError,
  classifyStatus,
  isRetryableTransient,
  networkErrorToMcpError,
  toMcpError,
} from './mcp-error.js';

describe('classifyStatus (#2867)', () => {
  it('classifies 429 as rate_limited + retryable hint', () => {
    expect(classifyStatus(429)).toEqual({ code: 'rate_limited', retryable: true });
  });
  it('classifies 402 as insufficient_credits, not retryable', () => {
    expect(classifyStatus(402)).toEqual({ code: 'insufficient_credits', retryable: false });
  });
  it('classifies 401/403 as unauthorized, not retryable', () => {
    expect(classifyStatus(401)).toEqual({ code: 'unauthorized', retryable: false });
    expect(classifyStatus(403)).toEqual({ code: 'unauthorized', retryable: false });
  });
  it('classifies 409 as conflict, not retryable', () => {
    expect(classifyStatus(409)).toEqual({ code: 'conflict', retryable: false });
  });
  it('classifies other 4xx as http_<status>, not retryable', () => {
    expect(classifyStatus(400)).toEqual({ code: 'http_400', retryable: false });
    expect(classifyStatus(404)).toEqual({ code: 'http_404', retryable: false });
    expect(classifyStatus(422)).toEqual({ code: 'http_422', retryable: false });
  });
  it('classifies 5xx as server_error + retryable', () => {
    expect(classifyStatus(500)).toEqual({ code: 'server_error', retryable: true });
    expect(classifyStatus(502)).toEqual({ code: 'server_error', retryable: true });
    expect(classifyStatus(503)).toEqual({ code: 'server_error', retryable: true });
  });
  it('classifies null as unknown, not retryable', () => {
    expect(classifyStatus(null)).toEqual({ code: 'unknown', retryable: false });
  });
});

describe('McpError', () => {
  it('is an Error and carries the unified shape', () => {
    const err = new McpError({ code: 'server_error', message: 'boom', status: 503, retryable: true });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('boom');
    expect(err.code).toBe('server_error');
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(true);
  });
  it('preserves 429 extras for back-compat', () => {
    const err = new McpError(
      { code: 'rate_limited', message: 'slow down', status: 429, retryable: true },
      { resetAt: 123, retryAfterMs: 5000, source: 'generation' },
    );
    expect(err.status).toBe(429);
    expect(err.resetAt).toBe(123);
    expect(err.retryAfterMs).toBe(5000);
    expect(err.source).toBe('generation');
  });
  it('leaves extras undefined when not provided', () => {
    const err = new McpError({ code: 'http_400', message: 'bad', status: 400, retryable: false });
    expect(err.resetAt).toBeUndefined();
    expect(err.source).toBeUndefined();
    expect(err.data).toBeUndefined();
    expect(err.retryAfterMs).toBeUndefined();
  });
});

describe('networkErrorToMcpError', () => {
  it('maps ETIMEDOUT to timeout, retryable, null status', () => {
    const cause = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const err = networkErrorToMcpError(cause);
    expect(err.code).toBe('timeout');
    expect(err.status).toBeNull();
    expect(err.retryable).toBe(true);
  });
  it('maps ECONNRESET to network, retryable', () => {
    const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const err = networkErrorToMcpError(cause);
    expect(err.code).toBe('network');
    expect(err.retryable).toBe(true);
  });
  it('unwraps undici cause errno', () => {
    const cause = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
    });
    const err = networkErrorToMcpError(cause);
    expect(err.code).toBe('network');
    expect(err.status).toBeNull();
  });
  it('treats a "timed out" message as timeout even without errno', () => {
    const err = networkErrorToMcpError(new Error('The operation timed out'));
    expect(err.code).toBe('timeout');
  });
});

describe('isRetryableTransient (#2867 — GET loop gate)', () => {
  it('returns true for 5xx', () => {
    expect(isRetryableTransient(new McpError({ code: 'server_error', message: '', status: 500, retryable: true }))).toBe(true);
  });
  it('returns true for network/timeout', () => {
    expect(isRetryableTransient(new McpError({ code: 'network', message: '', status: null, retryable: true }))).toBe(true);
    expect(isRetryableTransient(new McpError({ code: 'timeout', message: '', status: null, retryable: true }))).toBe(true);
  });
  it('returns FALSE for 429 (rate limits are honored, not retried)', () => {
    expect(isRetryableTransient(new McpError({ code: 'rate_limited', message: '', status: 429, retryable: true }))).toBe(false);
  });
  it('returns false for 4xx', () => {
    expect(isRetryableTransient(new McpError({ code: 'http_404', message: '', status: 404, retryable: false }))).toBe(false);
    expect(isRetryableTransient(new McpError({ code: 'insufficient_credits', message: '', status: 402, retryable: false }))).toBe(false);
  });
  it('returns true for a raw transient network errno', () => {
    expect(isRetryableTransient(Object.assign(new Error(), { code: 'ETIMEDOUT' }))).toBe(true);
  });
  it('returns false for non-error values', () => {
    expect(isRetryableTransient('nope')).toBe(false);
    expect(isRetryableTransient(undefined)).toBe(false);
  });
});

describe('toMcpError', () => {
  it('returns McpError unchanged (idempotent)', () => {
    const err = new McpError({ code: 'http_400', message: 'x', status: 400, retryable: false });
    expect(toMcpError(err)).toBe(err);
  });
  it('normalizes a plain Error-with-status (legacy shape)', () => {
    const legacy = Object.assign(new Error('boom'), { status: 502 });
    const err = toMcpError(legacy);
    expect(err).toBeInstanceOf(McpError);
    expect(err.status).toBe(502);
    expect(err.code).toBe('server_error');
    expect(err.retryable).toBe(true);
  });
  it('normalizes a bare network rejection', () => {
    const err = toMcpError(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }));
    expect(err.code).toBe('network');
    expect(err.status).toBeNull();
  });
});
