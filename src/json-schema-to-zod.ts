/**
 * Converts JSON Schema objects to Zod schemas.
 *
 * This is intentionally minimal — it covers only the JSON Schema subset used
 * in tool-manifest.json (strings, numbers, integers, booleans, arrays, objects,
 * nullable types, enums, and basic constraints). It is NOT a general-purpose
 * JSON Schema validator.
 */
import { z, type ZodTypeAny } from 'zod';

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
}

/**
 * Convert a JSON Schema property definition to a Zod schema.
 * Handles nullable types expressed as `type: ["string", "null"]`.
 */
function propertyToZod(schema: JsonSchema): ZodTypeAny {
  // Handle nullable types: { type: ["string", "null"] }
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t) => t !== 'null');
    const isNullable = schema.type.includes('null');
    const innerSchema = propertyToZod({ ...schema, type: types[0] } as JsonSchema);
    return isNullable ? innerSchema.nullable() : innerSchema;
  }

  switch (schema.type) {
    case 'string': {
      if (schema.enum) {
        const values = schema.enum as [string, ...string[]];
        return z.enum(values);
      }
      let s = z.string();
      if (schema.minLength !== undefined) s = s.min(schema.minLength);
      if (schema.maxLength !== undefined) s = s.max(schema.maxLength);
      return s;
    }

    case 'number': {
      let n = z.number();
      if (schema.minimum !== undefined) n = n.min(schema.minimum);
      if (schema.maximum !== undefined) n = n.max(schema.maximum);
      return n;
    }

    case 'integer': {
      let n = z.number().int();
      if (schema.minimum !== undefined) n = n.min(schema.minimum);
      if (schema.maximum !== undefined) n = n.max(schema.maximum);
      return n;
    }

    case 'boolean':
      return z.boolean();

    case 'array': {
      const itemSchema = schema.items ? propertyToZod(schema.items) : z.unknown();
      let arr = z.array(itemSchema);
      if (schema.minItems !== undefined) arr = arr.min(schema.minItems);
      return arr;
    }

    case 'object':
      return jsonSchemaToZod(schema);

    default:
      return z.unknown();
  }
}

/**
 * Convert a JSON Schema object definition to a Zod object schema.
 */
export function jsonSchemaToZod(schema: JsonSchema): z.ZodObject<Record<string, ZodTypeAny>> {
  const shape: Record<string, ZodTypeAny> = {};
  const required = new Set(schema.required ?? []);

  for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
    let zodProp = propertyToZod(propSchema);
    if (propSchema.description) {
      zodProp = zodProp.describe(propSchema.description);
    }
    if (!required.has(key)) {
      zodProp = zodProp.optional();
    }
    shape[key] = zodProp;
  }

  return z.object(shape);
}

/**
 * Convert a JSON Schema object to a flat record of Zod schemas,
 * suitable for the MCP SDK's registerTool inputSchema parameter.
 * The SDK expects { paramName: ZodSchema }, not a ZodObject.
 */
export function jsonSchemaToInputSchema(schema: JsonSchema): Record<string, ZodTypeAny> {
  const shape: Record<string, ZodTypeAny> = {};
  const required = new Set(schema.required ?? []);

  for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
    let zodProp = propertyToZod(propSchema);
    if (propSchema.description) {
      zodProp = zodProp.describe(propSchema.description);
    }
    if (!required.has(key)) {
      zodProp = zodProp.optional();
    }
    shape[key] = zodProp;
  }

  return shape;
}
