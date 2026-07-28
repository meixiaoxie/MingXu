import { ZodArray, ZodBoolean, ZodEnum, ZodNumber, ZodObject, ZodOptional, ZodString } from "zod";
import type { ZodTypeAny } from "zod";

/**
 * Converts the small Zod subset used by mingxu's built-in tools into plain JSON Schema.
 *
 * v0.1 only needs enough coverage for current tool definitions and provider-facing
 * tool metadata. We intentionally fail fast on shapes we do not yet serialize safely.
 */
export function zodToJsonSchema(schema: ZodTypeAny | Record<string, unknown>): Record<string, unknown> {
  if (isPlainSchemaObject(schema)) {
    return schema;
  }

  if (schema instanceof ZodOptional) {
    return zodToJsonSchema(schema.unwrap());
  }

  if (schema instanceof ZodString) {
    return { type: "string" };
  }

  if (schema instanceof ZodNumber) {
    return { type: "number" };
  }

  if (schema instanceof ZodBoolean) {
    return { type: "boolean" };
  }

  if (schema instanceof ZodEnum) {
    return {
      type: "string",
      enum: [...schema.options],
    };
  }

  if (schema instanceof ZodArray) {
    return {
      type: "array",
      items: zodToJsonSchema(schema.element),
    };
  }

  if (schema instanceof ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value as ZodTypeAny);
      if (!(value instanceof ZodOptional)) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  throw new Error("Unsupported Zod schema for provider tool metadata");
}

function isPlainSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !(value instanceof ZodOptional)
    && !(value instanceof ZodString)
    && !(value instanceof ZodNumber)
    && !(value instanceof ZodBoolean)
    && !(value instanceof ZodEnum)
    && !(value instanceof ZodArray)
    && !(value instanceof ZodObject);
}
