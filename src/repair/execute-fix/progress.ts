import type { LooseRecord } from "../json-types.js";

// Write one fix executor progress line to the job log.
export function logProgress(message: string, details: LooseRecord = {}) {
  const suffix = Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
  console.log(`[clawsweeper repair] ${new Date().toISOString()} ${message}${suffix}`);
}
