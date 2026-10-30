import { gzip, Inflate } from "pako";

export const STORED_JSON_MAX_BYTES = 8 * 1024 * 1024;
export const STORED_JSON_PREFIX = "!cs-json:gzip:1:";
export const STORED_JSON_PLACEHOLDER = "ClawSweeper status: review started.";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class StoredJsonCorruptionError extends Error {
  constructor() {
    super("stored_json_corrupt");
    this.name = "StoredJsonCorruptionError";
  }
}

// The envelope is not JSON. Its only searchable fact is copied from the raw
// text, preserving the retention owner's SQL instr predicate without inflation.
export function encodeStoredJson(text: string): string {
  if (text.length > STORED_JSON_MAX_BYTES) return text;
  const bytes = encoder.encode(text);
  if (bytes.length > STORED_JSON_MAX_BYTES || bytes.length < 128) return text;
  const compressed = gzip(bytes);
  let binary = "";
  for (let offset = 0; offset < compressed.length; offset += 32768)
    binary += String.fromCharCode(...compressed.subarray(offset, offset + 32768));
  const marker = text.includes(STORED_JSON_PLACEHOLDER) ? STORED_JSON_PLACEHOLDER : "-";
  const envelope = `${STORED_JSON_PREFIX}${bytes.length}:${marker}:${btoa(binary)}`;
  return envelope.length < bytes.length ? envelope : text;
}

export function decodeStoredJson(text: string): string {
  if (!text.startsWith("!cs-json:")) return text;
  try {
    if (text.length > STORED_JSON_MAX_BYTES) throw new StoredJsonCorruptionError();
    const match =
      /^!cs-json:gzip:1:([1-9][0-9]*):(-|ClawSweeper status: review started\.):([A-Za-z0-9+/]+={0,2})$/.exec(
        text,
      );
    const size = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(size) || size > STORED_JSON_MAX_BYTES)
      throw new StoredJsonCorruptionError();
    const binary = atob(match[3]!);
    if (btoa(binary) !== match[3]) throw new StoredJsonCorruptionError();
    const compressed = Uint8Array.from(binary, (value) => value.charCodeAt(0));
    const output = new Uint8Array(size);
    let offset = 0;
    let consumed = () => false;
    const inflate = new Inflate({ windowBits: 31, chunkSize: 16384 });
    // pako's public onStart hook exposes input consumption; success alone also
    // accepts trailing padding. Never accept a truncated stream or hidden tail.
    inflate.onStart = (stream) => {
      consumed = () => stream.avail_in === 0;
    };
    inflate.onData = (chunk) => {
      if (offset + chunk.length > size) throw new StoredJsonCorruptionError();
      output.set(chunk, offset);
      offset += chunk.length;
    };
    if (!inflate.push(compressed, true) || !inflate.ended || !consumed() || offset !== size)
      throw new StoredJsonCorruptionError();
    const result = decoder.decode(output);
    if (result.includes(STORED_JSON_PLACEHOLDER) !== (match[2] === STORED_JSON_PLACEHOLDER))
      throw new StoredJsonCorruptionError();
    return result;
  } catch (error) {
    if (error instanceof StoredJsonCorruptionError) throw error;
    throw new StoredJsonCorruptionError();
  }
}
