import { z } from 'zod';
import { McpError } from './mcp-error.js';

/** Mirrors McpErrorShape exactly (mcp-error.ts). Every typed tool's error branch. */
export const mcpToolErrorSchema = z.object({
  kind: z.literal('error'),
  code: z.string(),
  message: z.string(),
  status: z.number().nullable(),
  retryable: z.boolean(),
});
export type McpToolError = z.infer<typeof mcpToolErrorSchema>;

/** Structured extraction — never string-sniffs.
 * Deliberately does NOT delegate the non-McpError fallback to mcp-error.ts's `toMcpError`:
 * that helper routes a plain Error through `networkErrorToMcpError`, which labels it
 * `code: 'network', retryable: true`. That's wrong here — the most common non-McpError case
 * in this file is `getClient()` throwing a plain `Error('Not logged in...')`, which must
 * never be marked retryable. */
export function toMcpToolError(err: unknown): McpToolError {
  if (err instanceof McpError) {
    return {
      kind: 'error',
      code: err.code,
      message: err.message,
      status: err.status,
      retryable: err.retryable,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'error', code: 'unknown', message, status: null, retryable: false };
}

/** {content, structuredContent} for a typed tool result. Keeps text for clients
 * that ignore structuredContent (back-compat). */
export function typedToolResult<T extends { kind: string }>(
  data: T,
  text: string,
): { content: Array<{ type: 'text'; text: string }>; structuredContent: T; isError?: boolean } {
  return {
    content: [{ type: 'text', text }],
    structuredContent: data,
    isError: data.kind === 'error',
  };
}

/**
 * `@modelcontextprotocol/sdk`'s `registerTool()` only accepts an object-shaped Zod schema
 * for `outputSchema` (its `zod-compat.js`'s `normalizeObjectSchema` returns `undefined` for
 * anything that isn't a plain object schema or raw shape — including `z.discriminatedUnion`,
 * silently). Every per-tool result schema in this file IS a discriminated union — that
 * precision is real and worth keeping for our own type-checked handler code and hermetic
 * tests — but handing one to `registerTool` directly drops `outputSchema` from `tools/list`
 * AND makes the SDK's own output validation throw on every non-error response (`isError:
 * true` on every successful call — verified against `@modelcontextprotocol/sdk` 1.29.0; this
 * bug predates nl#518, already live on `main` for nl#510's 3 tools, undetected because
 * `user-mcp.test.ts` calls handlers directly and never exercises the SDK's registration/call
 * path).
 *
 * This converts a discriminated union into the loosest object shape the SDK will accept:
 * every field that appears on ANY branch becomes optional on the merged object. It still
 * validates real output — every actual response is exactly one branch's exact shape, a
 * subset of the merged optional fields — it just can no longer reject a response carrying the
 * wrong combination of fields for its `kind`. That precision still lives in the discriminated
 * union (used internally to build each branch) and in the handler code; this only widens what
 * the SDK is told to accept at the registration boundary.
 *
 * Non-union schemas (already object-shaped) pass through unchanged.
 *
 * The merged object is returned with an open `catchall(z.unknown())` (round 2, nl#518): a
 * branch that itself carries a catchall — e.g. `nl_coach_view`'s ok branch spreads arbitrary
 * coach fields onto `{ kind, isLastUsed }` — has keys the merge loop can never enumerate ahead
 * of time. A closed `z.object(merged)` advertises `additionalProperties: false` in the
 * generated JSON Schema, so the SDK Client's ajv validation rejects that branch's real
 * response with "must NOT have additional properties" even though the server-side zod check
 * (which strips unknown keys) passes — a narrower failure than the one this function exists to
 * fix, and just as silent unless something actually calls the tool end-to-end. Staying open
 * matches the function's own "loosest shape the SDK will accept" intent.
 */
export function toMcpOutputSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (!(schema instanceof z.ZodDiscriminatedUnion)) {
    return schema;
  }
  const fieldsByKey = new Map<string, z.ZodTypeAny[]>();
  for (const option of schema.options as readonly z.ZodTypeAny[]) {
    if (!(option instanceof z.ZodObject)) continue;
    for (const [key, fieldSchema] of Object.entries(option.shape)) {
      const existing = fieldsByKey.get(key);
      if (existing) {
        existing.push(fieldSchema as z.ZodTypeAny);
      } else {
        fieldsByKey.set(key, [fieldSchema as z.ZodTypeAny]);
      }
    }
  }
  const merged: Record<string, z.ZodTypeAny> = {};
  for (const [key, variants] of fieldsByKey) {
    const [first, ...rest] = variants;
    if (!first) continue; // unreachable: every key's list has at least one entry
    const type = rest.length === 0 ? first : z.union([first, ...rest] as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    merged[key] = type.optional();
  }
  return z.object(merged).catchall(z.unknown());
}

// ---- nl_coaches ----
export const nlCoachesOkSchema = z.object({
  kind: z.literal('ok'),
  lastCoachKey: z.string().nullable(),
  coaches: z.array(z.record(z.string(), z.unknown())),
});
export const nlCoachesFeatureGatedSchema = z.object({
  kind: z.literal('feature_gated'),
  message: z.string(),
});
export const nlCoachesResultSchema = z.discriminatedUnion('kind', [
  nlCoachesOkSchema,
  nlCoachesFeatureGatedSchema,
  mcpToolErrorSchema,
]);

// ---- nl_coach_view ----
export const nlCoachViewOkSchema = z
  .object({
    kind: z.literal('ok'),
    isLastUsed: z.boolean(),
  })
  .catchall(z.unknown());
export const nlCoachViewNotFoundSchema = z.object({
  kind: z.literal('not_found'),
  validKeys: z.array(z.string()),
});
export const nlCoachViewResultSchema = z.discriminatedUnion('kind', [
  nlCoachViewOkSchema,
  nlCoachesFeatureGatedSchema,
  nlCoachViewNotFoundSchema,
  mcpToolErrorSchema,
]);

// ---- nl_render_start / nl_rerender ----
export const nlRenderStartOkSchema = z.object({
  kind: z.literal('ok'),
  jobId: z.string(),
  status: z.string(),
});
export const nlRenderStartResultSchema = z.discriminatedUnion('kind', [
  nlRenderStartOkSchema,
  mcpToolErrorSchema,
]);
/** Validates the raw API response shape before the success branch is built. */
export const startRenderApiSchema = z.object({
  jobId: z.string(),
  status: z.string(),
});

// ---- nl_render_status ----
export const renderJobStatusEnum = z.enum(['queued', 'processing', 'completed', 'failed']);
export const nlRenderStatusOkSchema = z.object({
  kind: z.literal('ok'),
  status: renderJobStatusEnum,
  progress: z.number(),
  outputKey: z.string().nullable(),
  errorMessage: z.string().nullable(),
  jobId: z.string().optional(),
});
export const nlRenderStatusNoJobSchema = z.object({ kind: z.literal('no_render_job') });
export const nlRenderStatusUnknownSchema = z.object({
  kind: z.literal('unknown_status'),
  raw: z.string(),
});
export const nlRenderStatusResultSchema = z.discriminatedUnion('kind', [
  nlRenderStatusOkSchema,
  nlRenderStatusNoJobSchema,
  nlRenderStatusUnknownSchema,
  mcpToolErrorSchema,
]);
/** Validates the raw API response shape before any branch is picked. If this fails,
 * the handler must return an error branch with code 'invalid_response' — never
 * no_render_job or unknown_status. */
export const renderStatusApiSchema = z.object({
  status: z.string(),
  progress: z.number(),
  outputKey: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  jobId: z.string().optional(),
});

// ---- nl_share ----
export const nlShareOkSchema = z.object({
  kind: z.literal('ok'),
  shareToken: z.string(),
  shareUrl: z.string(),
});
export const nlShareResultSchema = z.discriminatedUnion('kind', [
  nlShareOkSchema,
  mcpToolErrorSchema,
]);
/** Validates the raw API response shape before the success branch is built. */
export const shareIntentApiSchema = z.object({
  shareToken: z.string(),
  shareUrl: z.string(),
});

// ---- nl_unshare ----
// The API returns an empty 204 on success, so the handler supplies the typed success branch.
export const nlUnshareOkSchema = z.object({ kind: z.literal('ok') });
export const nlUnshareResultSchema = z.discriminatedUnion('kind', [
  nlUnshareOkSchema,
  mcpToolErrorSchema,
]);

// ---- nl_playlist_delete ----
// The API returns an empty 204 on success, so the handler supplies the typed success branch.
export const nlPlaylistDeleteOkSchema = z.object({ kind: z.literal('ok') });
export const nlPlaylistDeleteResultSchema = z.discriminatedUnion('kind', [
  nlPlaylistDeleteOkSchema,
  mcpToolErrorSchema,
]);
