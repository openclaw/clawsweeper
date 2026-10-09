import { isRecord } from "../value-coerce.js";

export type JsonPrimitive = string | number | boolean | null;
export type StrictJsonObject = { [key: string]: StrictJsonValue | undefined };
export type StrictJsonArray = StrictJsonValue[];
export type StrictJsonValue = JsonPrimitive | StrictJsonObject | StrictJsonArray;

export type JsonValue = ReturnType<typeof JSON.parse>;
export type JsonObject = Record<string, JsonValue>;
export type JsonArray = JsonValue[];
export type LooseRecord = JsonValue;

export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

export function asJsonObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}
