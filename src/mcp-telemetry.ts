/**
 * MCP failure telemetry tap (#2867 / FIX-13, epic #2831 pattern F:
 * "MCP failures reach no sink").
 *
 * Before this, MCP call failures emitted to NO sink — a user-visible read
 * failure (e.g. the Railway Postgres ETIMEDOUT class, #2828) was completely
 * invisible to on-call. This module adds a tiny, injectable telemetry sink so
 * every MCP call failure can reach PostHog and/or stderr with the tool name,
 * HTTP status, and structured error code.
 *
 * Design constraints (this package syncs to a PUBLIC repo, admin code
 * stripped):
 *   - No monorepo imports, no Sentry SDK. Uses `posthog-node` (already a dep),
 *     lazily imported so it never loads unless explicitly enabled.
 *   - The library-level default sink is a no-op, so importing a client never
 *     spawns a PostHog client or writes to stderr in tests / bare usage.
 *   - The long-lived hosts (admin MCP server, user MCP server, CLI) install a
 *     real sink at startup via {@link installEnvTelemetrySink}, so production
 *     failures are never silently dropped.
 */

/** A single MCP call failure, ready to ship to a sink. */
export interface McpFailureEvent {
  /** Tool / operation name, when the caller has one (e.g. 'nl_library'). */
  tool?: string;
  /** HTTP method of the failed request. */
  method: string;
  /** Request path (no query string — avoids leaking tokens/params). */
  path: string;
  /** Structured error code from `McpErrorShape`. */
  code: string;
  /** HTTP status, or `null` for transport/network failures. */
  status: number | null;
  /** Whether the failure was classified transient. */
  retryable: boolean;
  /** 1-based attempt number that failed (for retried GETs). */
  attempt?: number;
}

export type McpTelemetrySink = (event: McpFailureEvent) => void;

const NOOP_SINK: McpTelemetrySink = () => {
  /* no-op default — hosts install a real sink at startup */
};

let installedSink: McpTelemetrySink | null = null;

/**
 * Install (or clear) the process-wide telemetry sink. Used by host startup
 * (`installEnvTelemetrySink`) and by tests for injection. Passing `null`
 * restores the no-op default.
 */
export function setMcpTelemetrySink(sink: McpTelemetrySink | null): void {
  installedSink = sink;
}

/** The active sink (installed sink, or the no-op default). */
export function getMcpTelemetrySink(): McpTelemetrySink {
  return installedSink ?? NOOP_SINK;
}

/**
 * Emit a failure event through the active sink. Never throws — telemetry must
 * not mask the original error. Strips any query string from `path`.
 */
export function emitMcpFailure(event: McpFailureEvent): void {
  try {
    const path = event.path.split('?')[0] ?? event.path;
    getMcpTelemetrySink()({ ...event, path });
  } catch {
    /* swallow — telemetry must never throw into the caller's error path */
  }
}

/** Write a failure as a single stderr line (dev observability). */
function stderrSink(event: McpFailureEvent): void {
  process.stderr.write(`[mcp-telemetry] mcp_call_failed ${JSON.stringify(event)}\n`);
}

/**
 * Build a PostHog sink. Lazily loads `posthog-node` so the dependency is only
 * touched when telemetry is actually enabled. Capture is best-effort and
 * fire-and-forget; a `flush()` is registered on process exit.
 */
function posthogSink(apiKey: string, host: string): McpTelemetrySink {
  // Lazy require via dynamic import kept inside a promise so the sink stays
  // synchronous for callers. The client is created once.
  let clientPromise: Promise<{ capture: (e: { distinctId: string; event: string; properties: Record<string, unknown> }) => void; shutdown: () => Promise<void> } | null> | null = null;

  const getClient = async () => {
    if (clientPromise === null) {
      clientPromise = import('posthog-node')
        .then(({ PostHog }) => {
          const client = new PostHog(apiKey, { host, flushAt: 1, flushInterval: 0 });
          const shutdown = (): void => {
            void client.shutdown();
          };
          process.once('exit', shutdown);
          process.once('beforeExit', shutdown);
          return client as unknown as {
            capture: (e: { distinctId: string; event: string; properties: Record<string, unknown> }) => void;
            shutdown: () => Promise<void>;
          };
        })
        .catch(() => null);
    }
    return clientPromise;
  };

  return (event: McpFailureEvent): void => {
    void getClient().then((client) => {
      if (client === null) return;
      client.capture({
        distinctId: 'mcp-client',
        event: 'mcp_call_failed',
        properties: { ...event },
      });
    });
  };
}

/**
 * Resolve and install a telemetry sink from the environment. Called by the
 * admin MCP server, user MCP server, and CLI at startup.
 *
 *   NL_MCP_TELEMETRY=posthog → PostHog (requires POSTHOG_API_KEY; host from
 *                              POSTHOG_HOST, default https://us.i.posthog.com)
 *   NL_MCP_TELEMETRY=stderr  → stderr line
 *   NL_MCP_TELEMETRY unset   → uses `fallback` ('stderr' | 'none')
 *
 * `fallback` lets long-lived MCP servers default to stderr (their stderr is
 * captured by the host) while the CLI defaults to silent unless opted in.
 * Returns the installed sink kind for logging/tests.
 */
export function installEnvTelemetrySink(
  fallback: 'stderr' | 'none' = 'none',
): 'posthog' | 'stderr' | 'none' {
  const mode = (process.env['NL_MCP_TELEMETRY'] ?? '').toLowerCase();
  if (mode === 'posthog') {
    const apiKey = process.env['POSTHOG_API_KEY'];
    if (apiKey) {
      const host = process.env['POSTHOG_HOST'] ?? 'https://us.i.posthog.com';
      setMcpTelemetrySink(posthogSink(apiKey, host));
      return 'posthog';
    }
    // posthog requested but no key — fall back to stderr so failures are still
    // observable rather than silently dropped.
    setMcpTelemetrySink(stderrSink);
    return 'stderr';
  }
  if (mode === 'stderr' || (mode === '' && fallback === 'stderr')) {
    setMcpTelemetrySink(stderrSink);
    return 'stderr';
  }
  return 'none';
}
