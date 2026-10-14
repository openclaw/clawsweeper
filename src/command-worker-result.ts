import type { ContainmentCapabilitySummary } from "./repair/contained-command-worker.js";

export type ContainedCommandResult = {
  backgroundProcesses: number;
  capabilitySummary?: ContainmentCapabilitySummary;
  error?: { code: string | undefined; message: string };
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
};

export function parseWorkerResult(stdout: string): ContainedCommandResult {
  const result = JSON.parse(stdout) as ContainedCommandResult;
  if (
    !result ||
    !Number.isInteger(result.backgroundProcesses) ||
    result.backgroundProcesses < 0 ||
    (result.status !== null && !Number.isInteger(result.status)) ||
    (result.signal !== null && typeof result.signal !== "string") ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    (result.error !== undefined &&
      (!result.error ||
        typeof result.error.message !== "string" ||
        (result.error.code !== undefined && typeof result.error.code !== "string")))
  )
    throw new Error("invalid validation supervisor result");
  return result;
}

export function serializedWorkerMaxBuffer(maxBuffer: number) {
  const overhead = 64 * 1024;
  const maximumExpandedBuffer = Math.floor((Number.MAX_SAFE_INTEGER - overhead) / 12);
  const expanded =
    maxBuffer > maximumExpandedBuffer ? Number.MAX_SAFE_INTEGER : maxBuffer * 12 + overhead;
  return Math.max(expanded, 1024 * 1024);
}
