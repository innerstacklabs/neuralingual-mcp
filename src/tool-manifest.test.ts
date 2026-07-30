import { describe, it, expect } from 'vitest';
import manifest from './tool-manifest.json' with { type: 'json' };
import { UserApiClient } from './user-client.js';
import { buildUserServer, CUSTOM_HANDLERS } from './user-mcp.js';
import { jsonSchemaToInputSchema, type JsonSchema } from './json-schema-to-zod.js';

const EXPECTED_TOOL_NAMES = [
  'nl_search',
  'nl_voices',
  'nl_sync_affirmations',
  'nl_render_configure',
  'nl_render_start',
  'nl_render_status',
  'nl_rerender',
  'nl_play',
  'nl_share',
  'nl_unshare',
  'nl_credits',
  'nl_guide',
  'nl_user_profile',
  'nl_user_set_username',
  'nl_user_check_username',
  'nl_catalog_browse',
  'nl_catalog_view',
  'nl_catalog_copy',
  'nl_affirmations_feedback',
  'nl_affirmations_toggle',
  'nl_context_settings_list',
  'nl_context_settings_update',
  'nl_context_settings_reset',
  'nl_wizard_defaults',
  'nl_source_extract',
  'nl_source_youtube',
  'nl_source_twitter',
  'nl_source_pdf',
  'nl_playback_start',
  'nl_playback_complete',
  'nl_generate_more',
  'nl_affirmation_add',
  'nl_affirmation_delete',
  'nl_coaches',
  'nl_coach_view',
  'nl_user_settings_update',
  // Canonical nl_playlist_* family (#42/#40/#41).
  'nl_playlist_list',
  'nl_playlist_view',
  'nl_playlist_create',
  'nl_playlist_delete',
  'nl_playlist_update',
  'nl_playlist_export',
  'nl_playlist_import',
];

/**
 * Pre-#42 names, permanently retired (Dave, 2026-07-30 — "we don't need the
 * old names to work, we don't have any users yet"). No aliases were ever
 * published externally (zero programmatic consumers across LifeOS skills,
 * agent configs, and the obsidian vault at the time of removal), so these
 * are deleted outright rather than deprecated. This list exists so a future
 * accidental re-add is caught immediately instead of silently reintroducing
 * the exact naming ambiguity #42 was filed to fix.
 */
const RETIRED_NAMES = [
  'nl_library',
  'nl_library_list',
  'nl_info',
  'nl_library_view',
  'nl_create',
  'nl_delete',
  'nl_intent_delete',
  'nl_rename',
  'nl_intent_update',
  'nl_set_export',
  'nl_set_import',
];

describe('MCP Tool Manifest', () => {
  it('should have exactly 43 tools', () => {
    expect(manifest.tools).toHaveLength(43);
  });

  it('should contain all expected tool names', () => {
    const toolNames = manifest.tools.map((t) => t.name);
    expect(toolNames).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('each tool should have required fields', () => {
    for (const tool of manifest.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters.type).toBe('object');
      expect(tool.handler).toBeDefined();
      expect(['client-method', 'custom']).toContain(tool.handler.type);
    }
  });

  it('each tool parameter schema should be valid JSON Schema that converts to Zod', () => {
    for (const tool of manifest.tools) {
      // Should not throw when converting to Zod
      const schema = jsonSchemaToInputSchema(tool.parameters as JsonSchema);
      expect(typeof schema).toBe('object');
    }
  });

  it('all client-method tools should map to existing UserApiClient methods', () => {
    // Create a client instance to check method existence
    const client = Object.getOwnPropertyNames(UserApiClient.prototype);
    for (const tool of manifest.tools) {
      if (tool.handler.type === 'client-method') {
        expect(
          client,
          `Tool "${tool.name}" references clientMethod "${tool.handler.clientMethod}" which does not exist on UserApiClient`,
        ).toContain(tool.handler.clientMethod);
      }
    }
  });

  it('all custom tools should have implemented handlers', () => {
    for (const tool of manifest.tools) {
      if (tool.handler.type === 'custom') {
        const handlerName = tool.handler.customHandler;
        expect(handlerName).toBeTruthy();
        expect(
          CUSTOM_HANDLERS,
          `Tool "${tool.name}" references customHandler "${handlerName ?? ''}" which is not implemented`,
        ).toHaveProperty(handlerName ?? '');
      }
    }
  });

  it('no duplicate tool names', () => {
    const names = manifest.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('each tool should have an endpoint definition with method, path, and auth', () => {
    const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    const validAuth = ['jwt', 'none'];
    for (const tool of manifest.tools) {
      const endpoint = (tool as Record<string, unknown>)['endpoint'] as Record<string, unknown> | undefined;
      expect(endpoint, `Tool "${tool.name}" is missing endpoint definition`).toBeDefined();
      expect(validMethods, `Tool "${tool.name}" has invalid HTTP method "${String(endpoint?.['method'])}"`).toContain(
        endpoint?.['method'],
      );
      expect(endpoint?.['path'], `Tool "${tool.name}" is missing endpoint path`).toBeTruthy();
      expect(validAuth, `Tool "${tool.name}" has invalid auth type "${String(endpoint?.['auth'])}"`).toContain(
        endpoint?.['auth'],
      );
    }
  });

  it('all required parameters are listed in the properties', () => {
    for (const tool of manifest.tools) {
      const required = tool.parameters.required ?? [];
      const properties = Object.keys(tool.parameters.properties ?? {});
      for (const req of required) {
        expect(
          properties,
          `Tool "${tool.name}" requires "${req}" but it is not in properties`,
        ).toContain(req);
      }
    }
  });

  it('buildUserServer should register all 43 tools without error', () => {
    // buildUserServer iterates the manifest and registers tools.
    // If any handler is missing, it throws.
    const server = buildUserServer();
    expect(server).toBeDefined();
  });

  it('no tool description references a retired name (steer text must point at canonical names only)', () => {
    for (const tool of manifest.tools) {
      for (const retired of RETIRED_NAMES) {
        expect(
          tool.description,
          `Tool "${tool.name}" description references retired name "${retired}"`,
        ).not.toContain(retired);
      }
    }
  });

  it('none of the 11 retired pre-#42 names resolve (they are gone, not aliased)', () => {
    const toolNames = new Set(manifest.tools.map((t) => t.name));
    for (const retired of RETIRED_NAMES) {
      expect(toolNames.has(retired), `Retired name "${retired}" should NOT be registered`).toBe(false);
    }
    // Their handlers should also be gone — a lingering unused CUSTOM_HANDLERS
    // entry is dead code and a re-registration risk.
    expect(CUSTOM_HANDLERS).not.toHaveProperty('library');
    expect(CUSTOM_HANDLERS).not.toHaveProperty('info');
    expect(CUSTOM_HANDLERS).not.toHaveProperty('rename');
  });

  it('the canonical nl_playlist_* family is fully present', () => {
    const canonicalNames = [
      'nl_playlist_list',
      'nl_playlist_view',
      'nl_playlist_create',
      'nl_playlist_delete',
      'nl_playlist_update',
      'nl_playlist_export',
      'nl_playlist_import',
    ];
    const toolNames = new Set(manifest.tools.map((t) => t.name));
    for (const name of canonicalNames) {
      expect(toolNames.has(name), `Canonical tool "${name}" is missing`).toBe(true);
    }
  });
});
