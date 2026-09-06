import { COMMAND_PROOF_ARCHIVE_MAX_BYTES, proofSafePath } from "../src/command-proof-contract.ts";

/** Read bounded ordinary ZIP files without extracting any path onto disk. */
export async function readReviewProofZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  if (bytes.length > COMMAND_PROOF_ARCHIVE_MAX_BYTES || bytes.length < 22)
    throw new Error("invalid_proof_zip_size");
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (u32(p) === 0x06054b50 && p + 22 + u16(p + 20) === bytes.length) {
      end = p;
      break;
    }
  }
  if (end < 0 || u16(end + 4) !== 0 || u16(end + 6) !== 0) throw new Error("invalid_proof_zip_end");
  const entries = u16(end + 10),
    size = u32(end + 12),
    offset = u32(end + 16);
  if (entries < 1 || entries > 64 || entries !== u16(end + 8) || offset + size !== end)
    throw new Error("invalid_proof_zip_directory");
  const files = new Map<string, Uint8Array>(),
    names = new Set<string>(),
    ranges: Array<[number, number]> = [];
  let p = offset,
    total = 0;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > end || u32(p) !== 0x02014b50) throw new Error("invalid_proof_zip_entry");
    const flags = u16(p + 8),
      method = u16(p + 10),
      crc = u32(p + 16);
    const compressed = u32(p + 20),
      expanded = u32(p + 24);
    const nameLength = u16(p + 28),
      extra = u16(p + 30),
      comment = u16(p + 32);
    const attributes = u32(p + 38),
      local = u32(p + 42);
    const next = p + 46 + nameLength + extra + comment;
    if (
      next > end ||
      u16(p + 34) !== 0 ||
      (flags & ~0x080e) !== 0 ||
      ![0, 8].includes(method) ||
      compressed === 0xffffffff ||
      expanded > COMMAND_PROOF_ARCHIVE_MAX_BYTES ||
      local + 30 > offset
    )
      throw new Error("unsupported_proof_zip_entry");
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLength);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    const directory = name.endsWith("/");
    const path = directory ? name.slice(0, -1) : name;
    const type = (attributes >>> 16) & 0xf000;
    if (
      !proofSafePath(path) ||
      names.has(path.toLowerCase()) ||
      (type !== 0 && type !== (directory ? 0x4000 : 0x8000))
    )
      throw new Error("unsafe_proof_zip_path");
    names.add(path.toLowerCase());
    if (u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method)
      throw new Error("inconsistent_proof_zip_header");
    const localNameLength = u16(local + 26),
      localExtra = u16(local + 28);
    const start = local + 30 + localNameLength + localExtra,
      finish = start + compressed;
    if (
      finish > offset ||
      !(
        localNameLength === nameBytes.length &&
        nameBytes.every((byte, index) => bytes[local + 30 + index] === byte)
      ) ||
      ranges.some(([a, b]) => local < b && finish > a)
    )
      throw new Error("overlapping_proof_zip_entry");
    ranges.push([local, finish]);
    if (
      !(flags & 8) &&
      (u32(local + 14) !== crc || u32(local + 18) !== compressed || u32(local + 22) !== expanded)
    )
      throw new Error("inconsistent_proof_zip_sizes");
    total += expanded;
    if (total > 32 * 1024 * 1024) throw new Error("proof_zip_inflation_limit");
    const compressedBytes = bytes.subarray(start, finish);
    const content =
      method === 0 ? compressedBytes.slice() : await inflateBounded(compressedBytes, expanded);
    if (content.length !== expanded || crc32(content) !== crc || (directory && expanded !== 0))
      throw new Error("corrupt_proof_zip_entry");
    if (!directory) files.set(path, content);
    p = next;
  }
  if (p !== end) throw new Error("trailing_proof_zip_directory");
  return files;
}

function crc32(content: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflateBounded(bytes: Uint8Array, expected: number): Promise<Uint8Array> {
  // Workers supports deflate-raw natively; read incrementally to bound zip bombs.
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(Uint8Array.from(bytes));
      controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.length;
    if (total > expected) {
      await reader.cancel();
      throw new Error("proof_zip_inflation_limit");
    }
    chunks.push(chunk.value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
