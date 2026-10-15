import fs from "node:fs";
import path from "node:path";

import type { JsonValue } from "./json-types.js";

export function writeJsonFile(filePath: string, value: JsonValue): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
