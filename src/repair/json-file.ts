import fs from "node:fs";
import path from "node:path";

import type { JsonValue } from "./json-types.js";

export function readJsonFile(filePath: string): JsonValue {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function readJsonFileIfExists(filePath: string): JsonValue | null {
  return fs.existsSync(filePath) ? readJsonFile(filePath) : null;
}

export function writeJsonFile(filePath: string, value: JsonValue): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
