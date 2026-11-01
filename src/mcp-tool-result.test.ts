import { describe, expect, it } from 'vitest';
import { McpError } from './mcp-error.js';
import {
  mcpToolErrorSchema,
  nlCoachesResultSchema,
  nlRenderStatusResultSchema,
  nlUnshareResultSchema,
  toMcpToolError,
  typedToolResult,
} from './mcp-tool-result.js';

const errorResult = {
  kind: 'error' as const,
  code: 'server_error',
  message: 'Service unavailable',
  status: 503,
  retryable: true,
};

describe('toMcpToolError', () => {
  it('preserves the canonical fields from McpError', () => {
    const error = new McpError({
      code: 'rate_limited',
      message: 'Try again later',
      status: 429,
      retryable: true,
    });

    expect(toMcpToolError(error)).toEqual({
      kind: 'error',
      code: error.code,
      message: error.message,
      status: error.status,
      retryable: error.retryable,
    });
  });

  it('maps a plain Error to an unknown non-retryable error', () => {
    expect(toMcpToolError(new Error('plain failure'))).toEqual({
      kind: 'error',
      code: 'unknown',
      message: 'plain failure',
      status: null,
      retryable: false,
    });
  });

  it('stringifies a non-Error thrown value', () => {
    expect(toMcpToolError('string failure')).toEqual({
      kind: 'error',
      code: 'unknown',
      message: 'string failure',
      status: null,
      retryable: false,
    });
  });
});

describe('typedToolResult', () => {
  it('marks the error branch and preserves data and fallback text', () => {
    const result = typedToolResult(errorResult, 'fallback error');

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBe(errorResult);
    expect(result.content[0]?.text).toBe('fallback error');
  });

  it('leaves isError falsy for non-error branches', () => {
    const data = { kind: 'ok' as const, value: 1 };
    const result = typedToolResult(data, 'fallback success');

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBe(data);
    expect(result.content[0]?.text).toBe('fallback success');
  });
});

describe('typed MCP result schemas', () => {
  it.each([
    { kind: 'ok', lastCoachKey: 'cole', coaches: [{ key: 'cole' }] },
    { kind: 'feature_gated', message: 'Feature unavailable' },
    errorResult,
  ])('nlCoachesResultSchema parses the $kind branch', (value) => {
    expect(() => nlCoachesResultSchema.parse(value)).not.toThrow();
  });

  it.each([
    {
      kind: 'ok',
      status: 'processing',
      progress: 40,
      outputKey: null,
      errorMessage: null,
      jobId: 'job-1',
    },
    { kind: 'no_render_job' },
    { kind: 'unknown_status', raw: 'future_status' },
    errorResult,
  ])('nlRenderStatusResultSchema parses the $kind branch', (value) => {
    expect(() => nlRenderStatusResultSchema.parse(value)).not.toThrow();
  });

  it('nlUnshareResultSchema parses its error branch', () => {
    expect(() => nlUnshareResultSchema.parse(errorResult)).not.toThrow();
    expect(() => mcpToolErrorSchema.parse(errorResult)).not.toThrow();
  });
});
