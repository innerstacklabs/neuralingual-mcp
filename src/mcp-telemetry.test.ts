/**
 * Unit tests for the MCP failure telemetry tap (#2867 / FIX-13).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emitMcpFailure,
  getMcpTelemetrySink,
  installEnvTelemetrySink,
  setMcpTelemetrySink,
  type McpFailureEvent,
} from './mcp-telemetry.js';

describe('mcp-telemetry sink (#2867)', () => {
  afterEach(() => {
    setMcpTelemetrySink(null);
    delete process.env['NL_MCP_TELEMETRY'];
    delete process.env['POSTHOG_API_KEY'];
    vi.restoreAllMocks();
  });

  it('defaults to a no-op sink (no side effects on bare import)', () => {
    // No sink installed → emit must not throw.
    expect(() => emitMcpFailure({ method: 'GET', path: '/x', code: 'network', status: null, retryable: true })).not.toThrow();
  });

  it('routes events to an installed sink', () => {
    const events: McpFailureEvent[] = [];
    setMcpTelemetrySink((e) => events.push(e));
    emitMcpFailure({ method: 'GET', path: '/library', code: 'server_error', status: 503, retryable: true, attempt: 2 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ method: 'GET', code: 'server_error', status: 503, attempt: 2 });
  });

  it('strips the query string from the path (no token/param leakage)', () => {
    const events: McpFailureEvent[] = [];
    setMcpTelemetrySink((e) => events.push(e));
    emitMcpFailure({ method: 'GET', path: '/auth/username/available?username=secret', code: 'http_400', status: 400, retryable: false });
    expect(events[0]?.path).toBe('/auth/username/available');
  });

  it('never throws even if the sink throws', () => {
    setMcpTelemetrySink(() => {
      throw new Error('sink blew up');
    });
    expect(() => emitMcpFailure({ method: 'GET', path: '/x', code: 'network', status: null, retryable: true })).not.toThrow();
  });

  describe('installEnvTelemetrySink', () => {
    it('installs nothing by default with fallback=none', () => {
      const kind = installEnvTelemetrySink('none');
      expect(kind).toBe('none');
    });

    it('installs stderr when fallback=stderr and env unset', () => {
      const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const kind = installEnvTelemetrySink('stderr');
      expect(kind).toBe('stderr');
      emitMcpFailure({ method: 'GET', path: '/x', code: 'timeout', status: null, retryable: true });
      expect(writeSpy).toHaveBeenCalledOnce();
      expect(String(writeSpy.mock.calls[0]?.[0])).toContain('mcp_call_failed');
    });

    it('installs stderr when NL_MCP_TELEMETRY=stderr regardless of fallback', () => {
      process.env['NL_MCP_TELEMETRY'] = 'stderr';
      expect(installEnvTelemetrySink('none')).toBe('stderr');
    });

    it('falls back to stderr when posthog requested but no API key', () => {
      process.env['NL_MCP_TELEMETRY'] = 'posthog';
      expect(installEnvTelemetrySink('none')).toBe('stderr');
    });

    it('installs posthog when requested with an API key present', () => {
      process.env['NL_MCP_TELEMETRY'] = 'posthog';
      process.env['POSTHOG_API_KEY'] = 'phc_test';
      expect(installEnvTelemetrySink('none')).toBe('posthog');
      // The posthog sink is installed; emitting must not throw even though the
      // posthog client loads lazily.
      expect(() => emitMcpFailure({ method: 'GET', path: '/x', code: 'server_error', status: 500, retryable: true })).not.toThrow();
      expect(getMcpTelemetrySink()).not.toBeUndefined();
    });
  });
});
