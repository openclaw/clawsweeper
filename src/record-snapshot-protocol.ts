export const RECORD_SNAPSHOT_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
export const SNAPSHOT_UPLOAD_PART_BYTES = 6 * 1024 * 1024;
export const SNAPSHOT_UPLOAD_JSON_MAX_BYTES = (SNAPSHOT_UPLOAD_PART_BYTES / 3) * 4 + 16 * 1024;
export const SNAPSHOT_MAX_IDENTITIES = 250_000;
export const SNAPSHOT_MANIFEST_CHUNK_IDENTITIES = 10_000;
export type SnapshotIdentity = [section: string, id: string];

export function snapshotIdentityKey([section, id]: SnapshotIdentity) {
  return `${section}/${id}`;
}

const TAR_BLOCK_BYTES = 512;
const encoder = new TextEncoder();

export function tarHeader(relativePath: string, size: number) {
  const header = new Uint8Array(TAR_BLOCK_BYTES);
  const { name, prefix } = splitTarPath(relativePath);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar\0");
  writeTarString(header, 263, 2, "00");
  writeTarString(header, 265, 32, "clawsweeper");
  writeTarString(header, 297, 32, "clawsweeper");
  writeTarString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  writeTarString(header, 148, 6, checksumText);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function splitTarPath(relativePath: string) {
  if (encoder.encode(relativePath).byteLength <= 100) return { name: relativePath, prefix: "" };
  for (
    let index = relativePath.lastIndexOf("/");
    index > 0;
    index = relativePath.lastIndexOf("/", index - 1)
  ) {
    const prefix = relativePath.slice(0, index);
    const name = relativePath.slice(index + 1);
    if (encoder.encode(prefix).byteLength <= 155 && encoder.encode(name).byteLength <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`snapshot tar path is too long: ${relativePath}`);
}

function writeTarString(target: Uint8Array, offset: number, length: number, value: string) {
  const bytes = encoder.encode(value);
  if (bytes.byteLength > length) throw new Error(`tar header value exceeds ${length} bytes`);
  target.set(bytes, offset);
}

function writeTarOctal(target: Uint8Array, offset: number, length: number, value: number) {
  const octal = value.toString(8).padStart(length - 1, "0");
  if (octal.length >= length) throw new Error(`tar numeric value exceeds ${length} bytes`);
  writeTarString(target, offset, length - 1, octal);
  target[offset + length - 1] = 0;
}

export function recordExtension(section: string) {
  return section === "decision-packets" ? ".json" : ".md";
}
