import { closeSync, ftruncateSync, openSync, writeSync } from "node:fs";

export const DEFAULT_CODEX_OUTPUT_FILE_BYTES = 128 * 1024 * 1024;
export const DEFAULT_CODEX_OUTPUT_TAIL_BYTES = 64 * 1024;

const TRUNCATION_MARKER = Buffer.from(
  "\n...[Codex output truncated; final tail follows]...\n",
  "utf8",
);

export interface CodexOutputCapture {
  file: number;
  maxFileBytes: number;
  tailBytes: number;
  writtenBytes: number;
  truncated: boolean;
  tail: Buffer<ArrayBufferLike>;
}

export function openCodexOutputCapture(
  filePath: string,
  options: { maxFileBytes?: number; tailBytes?: number } = {},
): CodexOutputCapture {
  return {
    file: openSync(filePath, "w"),
    maxFileBytes: normalizedMaxFileBytes(options.maxFileBytes),
    tailBytes: normalizedTailBytes(options.tailBytes),
    writtenBytes: 0,
    truncated: false,
    tail: Buffer.alloc(0),
  };
}

export function appendCodexOutputCapture(capture: CodexOutputCapture, chunk: Buffer): void {
  capture.tail = appendTail(capture.tail, chunk, capture.tailBytes);
  const remaining = capture.maxFileBytes - capture.writtenBytes;
  const retained = chunk.subarray(0, Math.max(0, remaining));
  writeAll(capture.file, retained);
  capture.writtenBytes += retained.length;
  if (chunk.length > retained.length) capture.truncated = true;
}

export function closeCodexOutputCapture(capture: CodexOutputCapture): void {
  try {
    if (capture.truncated) {
      const tail = capture.tail.subarray(
        Math.max(0, capture.tail.length - availableTailBytes(capture.maxFileBytes)),
      );
      const headBytes = capture.maxFileBytes - TRUNCATION_MARKER.length - tail.length;
      ftruncateSync(capture.file, headBytes);
      writeAll(capture.file, TRUNCATION_MARKER, headBytes);
      writeAll(capture.file, tail, headBytes + TRUNCATION_MARKER.length);
    }
  } finally {
    closeSync(capture.file);
  }
}

export function codexOutputTail(capture: CodexOutputCapture): string {
  return capture.tail.toString("utf8");
}

function appendTail(current: Buffer, chunk: Buffer, maxBytes: number): Buffer {
  if (maxBytes <= 0) return Buffer.alloc(0);
  if (chunk.length >= maxBytes) return chunk.subarray(chunk.length - maxBytes);
  const combined = Buffer.concat([current, chunk]);
  return combined.length > maxBytes ? combined.subarray(combined.length - maxBytes) : combined;
}

function normalizedMaxFileBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CODEX_OUTPUT_FILE_BYTES;
  const normalized = Number.isFinite(value) ? Math.floor(value) : DEFAULT_CODEX_OUTPUT_FILE_BYTES;
  return Math.max(TRUNCATION_MARKER.length, normalized);
}

function normalizedTailBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CODEX_OUTPUT_TAIL_BYTES;
  return Math.max(0, Number.isFinite(value) ? Math.floor(value) : DEFAULT_CODEX_OUTPUT_TAIL_BYTES);
}

function availableTailBytes(maxFileBytes: number): number {
  return Math.max(0, maxFileBytes - TRUNCATION_MARKER.length);
}

function writeAll(file: number, value: Buffer, position?: number): void {
  let offset = 0;
  while (offset < value.length) {
    const written = writeSync(
      file,
      value,
      offset,
      value.length - offset,
      position === undefined ? undefined : position + offset,
    );
    if (written === 0) throw new Error("Codex output file write made no progress.");
    offset += written;
  }
}
