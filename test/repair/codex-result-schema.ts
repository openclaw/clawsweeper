import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

type JsonSchema = Record<string, unknown>;

export function assertCodexActionMatchesSchema(value: unknown): void {
  const schema = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "schema/repair/codex-result.schema.json"), "utf8"),
  ) as JsonSchema;
  const properties = schema.properties as Record<string, JsonSchema>;
  const actions = properties.actions;
  const actionSchema = actions.items as JsonSchema;

  assert.equal(
    schemaAccepts(actionSchema, value),
    true,
    `action does not match codex-result.schema.json: ${JSON.stringify(value)}`,
  );
}

function schemaAccepts(node: JsonSchema, value: unknown): boolean {
  const anyOf = node.anyOf as JsonSchema[] | undefined;
  if (anyOf && !anyOf.some((entry) => schemaAccepts(entry, value))) return false;
  if ("const" in node && JSON.stringify(value) !== JSON.stringify(node.const)) return false;

  const allowed = node.enum as unknown[] | undefined;
  if (allowed && !allowed.some((entry) => JSON.stringify(value) === JSON.stringify(entry))) {
    return false;
  }

  const type = node.type;
  if (typeof type === "string" && !matchesType(type, value)) return false;
  if (Array.isArray(type) && !type.some((entry) => matchesType(String(entry), value))) return false;

  if (typeof value === "string") {
    if (typeof node.maxLength === "number" && value.length > node.maxLength) return false;
    if (typeof node.pattern === "string" && !new RegExp(node.pattern).test(value)) return false;
  }

  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) return false;
    if (typeof node.maxItems === "number" && value.length > node.maxItems) return false;
    const items = node.items as JsonSchema | undefined;
    if (items && !value.every((entry) => schemaAccepts(items, entry))) return false;
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const required = node.required as string[] | undefined;
    if (required && required.some((key) => !Object.hasOwn(record, key))) return false;
    const properties = (node.properties as Record<string, JsonSchema> | undefined) ?? {};
    if (
      node.additionalProperties === false &&
      Object.keys(record).some((key) => !Object.hasOwn(properties, key))
    ) {
      return false;
    }
    for (const [key, entry] of Object.entries(record)) {
      const property = properties[key];
      if (property && !schemaAccepts(property, entry)) return false;
    }
  }

  return true;
}

function matchesType(type: string, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}
