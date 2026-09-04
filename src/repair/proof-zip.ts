import { inflateRawSync } from "node:zlib";
import { COMMAND_PROOF_ARCHIVE_MAX_BYTES, proofSafePath } from "../command-proof-contract.js";

/** Read bounded ordinary ZIP files without extracting any path onto disk. */
export function readProofZip(bytes: Buffer): Map<string, Buffer> {
  if (bytes.length > COMMAND_PROOF_ARCHIVE_MAX_BYTES || bytes.length < 22)
    throw new Error("invalid_proof_zip_size");
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (
      bytes.readUInt32LE(p) === 0x06054b50 &&
      p + 22 + bytes.readUInt16LE(p + 20) === bytes.length
    ) {
      end = p;
      break;
    }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0)
    throw new Error("invalid_proof_zip_end");
  const entries = bytes.readUInt16LE(end + 10),
    size = bytes.readUInt32LE(end + 12),
    offset = bytes.readUInt32LE(end + 16);
  if (
    entries < 1 ||
    entries > 64 ||
    entries !== bytes.readUInt16LE(end + 8) ||
    offset + size !== end
  )
    throw new Error("invalid_proof_zip_directory");
  const files = new Map<string, Buffer>(),
    names = new Set<string>(),
    ranges: Array<[number, number]> = [];
  let p = offset,
    total = 0;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > end || bytes.readUInt32LE(p) !== 0x02014b50)
      throw new Error("invalid_proof_zip_entry");
    const flags = bytes.readUInt16LE(p + 8),
      method = bytes.readUInt16LE(p + 10),
      crc = bytes.readUInt32LE(p + 16);
    const compressed = bytes.readUInt32LE(p + 20),
      expanded = bytes.readUInt32LE(p + 24);
    const nameLength = bytes.readUInt16LE(p + 28),
      extra = bytes.readUInt16LE(p + 30),
      comment = bytes.readUInt16LE(p + 32);
    const attributes = bytes.readUInt32LE(p + 38),
      local = bytes.readUInt32LE(p + 42);
    const next = p + 46 + nameLength + extra + comment;
    if (
      next > end ||
      bytes.readUInt16LE(p + 34) !== 0 ||
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
    if (
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method
    )
      throw new Error("inconsistent_proof_zip_header");
    const localNameLength = bytes.readUInt16LE(local + 26),
      localExtra = bytes.readUInt16LE(local + 28);
    const start = local + 30 + localNameLength + localExtra,
      finish = start + compressed;
    if (
      finish > offset ||
      !bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes) ||
      ranges.some(([a, b]) => local < b && finish > a)
    )
      throw new Error("overlapping_proof_zip_entry");
    ranges.push([local, finish]);
    if (
      !(flags & 8) &&
      (bytes.readUInt32LE(local + 14) !== crc ||
        bytes.readUInt32LE(local + 18) !== compressed ||
        bytes.readUInt32LE(local + 22) !== expanded)
    )
      throw new Error("inconsistent_proof_zip_sizes");
    total += expanded;
    if (total > 32 * 1024 * 1024) throw new Error("proof_zip_inflation_limit");
    const compressedBytes = bytes.subarray(start, finish);
    const content =
      method === 0
        ? Buffer.from(compressedBytes)
        : inflateRawSync(compressedBytes, { maxOutputLength: Math.max(1, expanded) });
    if (content.length !== expanded || crc32(content) !== crc || (directory && expanded !== 0))
      throw new Error("corrupt_proof_zip_entry");
    if (!directory) files.set(path, content);
    p = next;
  }
  if (p !== end) throw new Error("trailing_proof_zip_directory");
  return files;
}

function crc32(content: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
