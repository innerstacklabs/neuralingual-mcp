import { describe, it, expect } from 'vitest';
import manifest from './tool-manifest.json' with { type: 'json' };
import { CUSTOM_HANDLERS, buildUserServer } from './user-mcp.js';
import { jsonSchemaToInputSchema, type JsonSchema } from './json-schema-to-zod.js';
import { UserApiClient } from './user-client.js';

const EXPECTED_TOOL_NAMES = [
  'nl_library',
  'nl_search',
  'nl_info',
  'nl_voices',
  'nl_create',
  'nl_rename',
  'nl_sync_affirmations',
  'nl_delete',
  'nl_render_configure',
  'nl_render_start',
  'nl_render_status',
  'nl_rerender',
  'nl_play',
  'nl_share',
  'nl_unshare',
  'nl_credits',
  'nl_set_export',
  'nl_set_import',
];

describe('tool-manifest.json', () => {
  it('has exactly 18 tools', () => {
    expect(manifest.tools).toHaveLength(18);
  });

  it('contains all expected tool names', () => {
    const names = manifest.tools.map((t) => t.name);
    for (const expected of EXPECTED_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
  });

  it('has no unexpected tool names', () => {
    const names = manifest.tools.map((t) => t.name);
    for (const name of names) {
      expect(EXPECTED_TOOL_NAMES).toContain(name);
    }
  });

  it('every tool has a description', () => {
    for (const tool of manifest.tools) {
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe('string');
    }
  });

  it('every tool has a valid handler type', () => {
    for (const tool of manifest.tools) {
      expect(['custom', 'client-method']).toContain(tool.handler.type);
    }
  });
});

describe('custom handlers', () => {
  it('every custom handler referenced in manifest is implemented', () => {
    const customTools = manifest.tools.filter((t) => t.handler.type === 'custom');
    for (const tool of customTools) {
      const handlerName = (tool.handler as { customHandler: string }).customHandler;
      expect(CUSTOM_HANDLERS).toHaveProperty(handlerName);
      expect(typeof CUSTOM_HANDLERS[handlerName]).toBe('function');
    }
  });

  it('no orphan custom handlers (every handler is referenced by manifest)', () => {
    const referencedHandlers = new Set(
      manifest.tools
        .filter((t) => t.handler.type === 'custom')
        .map((t) => (t.handler as { customHandler: string }).customHandler),
    );
    for (const key of Object.keys(CUSTOM_HANDLERS)) {
      expect(referencedHandlers.has(key)).toBe(true);
    }
  });
});

describe('client-method tools', () => {
  it('all client-method tools map to real UserApiClient methods', () => {
    const clientMethodTools = manifest.tools.filter((t) => t.handler.type === 'client-method');
    const clientProto = UserApiClient.prototype;

    for (const tool of clientMethodTools) {
      const methodName = (tool.handler as { clientMethod: string }).clientMethod;
      expect(typeof (clientProto as unknown as Record<string, unknown>)[methodName]).toBe('function');
    }
  });
});

describe('JSON Schema to Zod conversion', () => {
  it('converts all tool parameter schemas without error', () => {
    for (const tool of manifest.tools) {
      expect(() => {
        jsonSchemaToInputSchema(tool.parameters as unknown as JsonSchema);
      }).not.toThrow();
    }
  });

  it('produces correct shape keys for tools with parameters', () => {
    for (const tool of manifest.tools) {
      const schema = jsonSchemaToInputSchema(tool.parameters as unknown as JsonSchema);
      const expectedKeys = Object.keys(tool.parameters.properties ?? {});
      expect(Object.keys(schema).sort()).toEqual(expectedKeys.sort());
    }
  });
});

describe('buildUserServer', () => {
  it('registers all tools without throwing', () => {
    expect(() => {
      buildUserServer();
    }).not.toThrow();
  });
});
