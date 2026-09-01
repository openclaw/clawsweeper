import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import { publishStateBlob } from "../dist/state-blob-client.js";
import { downloadStateBlob } from "./worker-blobs.ts";
import { signedPost } from "./worker-records.ts";

const ARCHIVE_MAGIC = Buffer.from("clawsweeper-exact-review-bundle-v1\n", "utf8");
const ARCHIVE_MANIFEST_MAX_BYTES = 1024 * 1024;
const ARCHIVE_FILE_MAX_COUNT = 512;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const CACHE_PREFIX = "artifacts/exact-review/v1/";

export function exactReviewArtifactReceiptTuple(item) {
  const decision = objectValue(item?.decision);
  const publication = objectValue(decision.publication);
  const tuple = {
    producer_run_id: String(publication.producerRunId || "").trim(),
    producer_run_attempt: Number(publication.producerRunAttempt),
    artifact_name: String(publication.artifactName || "").trim(),
    canonical_item_key: String(publication.itemKey || "").trim(),
    lease_revision: Number(publication.leaseRevision),
    protocol_version: Number(publication.protocolVersion),
  };
  if (
    !/^\d+$/.test(tuple.producer_run_id) ||
    !Number.isSafeInteger(tuple.producer_run_attempt) ||
    tuple.producer_run_attempt < 1 ||
    !/^[A-Za-z0-9_.-]{1,200}$/.test(tuple.artifact_name) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/.test(tuple.canonical_item_key) ||
    !Number.isSafeInteger(tuple.lease_revision) ||
    tuple.lease_revision < 1 ||
    !Number.isSafeInteger(tuple.protocol_version) ||
    tuple.protocol_version < 1
  ) {
    throw new Error("exact-review artifact cache tuple is invalid");
  }
  return tuple;
}

export async function restoreExactReviewArtifact(options) {
  const response = await signedPost({
    baseUrl: options.baseUrl,
    path: "/internal/exact-review/artifact-cache/receipt/lookup",
    webhookSecret: options.webhookSecret,
    body: options.tuple,
    fetch: options.fetchImpl,
  });
  if (response?.hit !== true) return { hit: false, reason: "receipt_miss" };
  const receipt = validateReceipt(response.receipt, options.tuple);
  if (receipt.bytes > options.maxArchiveBytes) {
    throw new Error("exact-review cached artifact exceeds the bounded archive size");
  }
  const temporaryRoot = mkdtempSync(join(tmpdir(), "clawsweeper-artifact-cache-"));
  const archivePath = join(temporaryRoot, "bundle.bin");
  try {
    const downloaded = await downloadStateBlob({
      baseUrl: options.baseUrl,
      webhookSecret: options.webhookSecret,
      blobPath: receipt.objectKey,
      destination: archivePath,
      expected: { bytes: receipt.bytes, digest: receipt.digest },
      fetch: options.fetchImpl,
    });
    if (downloaded.digest !== receipt.digest) {
      throw new Error("exact-review cached artifact digest does not match its receipt");
    }
    const archive = readFileSync(archivePath);
    unpackExactReviewBundle(archive, options.bundleDir);
    return { hit: true, digest: receipt.digest, bytes: receipt.bytes };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function publishExactReviewArtifact(options) {
  const archive = packExactReviewBundle(options.bundleDir);
  if (archive.byteLength > options.maxArchiveBytes) {
    throw new Error("exact-review artifact archive exceeds the bounded cache size");
  }
  const digest = createHash("sha256").update(archive).digest("hex");
  const objectKey = `${CACHE_PREFIX}${digest}`;
  const published = await publishStateBlob({
    baseUrl: options.baseUrl,
    webhookSecret: options.webhookSecret,
    path: objectKey,
    content: archive,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (published.digest !== digest || published.bytes !== archive.byteLength) {
    throw new Error("exact-review artifact cache upload returned a mismatched digest");
  }
  const response = await signedPost({
    baseUrl: options.baseUrl,
    path: "/internal/exact-review/artifact-cache/receipt/store",
    webhookSecret: options.webhookSecret,
    body: { ...options.tuple, digest, bytes: archive.byteLength },
    fetch: options.fetchImpl,
  });
  const receipt = validateReceipt(response?.receipt, options.tuple);
  if (receipt.digest !== digest || receipt.objectKey !== objectKey) {
    throw new Error("exact-review artifact cache receipt does not match the uploaded object");
  }
  return { digest, bytes: archive.byteLength, objectKey, deduped: response?.deduped === true };
}

export function packExactReviewBundle(bundleDir) {
  const root = resolve(bundleDir);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new Error("exact-review bundle directory is unavailable");
  }
  const paths = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const name of readdirSync(current).sort().reverse()) {
      const absolute = join(current, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error("exact-review bundle contains a symbolic link");
      if (stat.isDirectory()) pending.push(absolute);
      else if (stat.isFile()) paths.push(absolute);
      else throw new Error("exact-review bundle contains a non-regular entry");
    }
  }
  paths.sort((left, right) => left.localeCompare(right));
  if (!paths.length || paths.length > ARCHIVE_FILE_MAX_COUNT) {
    throw new Error("exact-review bundle file count is outside the cache bounds");
  }
  const payloads = [];
  const files = paths.map((absolute) => {
    const path = relative(root, absolute).split(sep).join("/");
    requireSafeArchivePath(path);
    const content = readFileSync(absolute);
    payloads.push(content);
    return {
      path,
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
  const manifest = Buffer.from(JSON.stringify({ version: 1, files }), "utf8");
  if (manifest.byteLength > ARCHIVE_MANIFEST_MAX_BYTES) {
    throw new Error("exact-review bundle manifest exceeds the cache bound");
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(manifest.byteLength);
  return Buffer.concat([ARCHIVE_MAGIC, header, manifest, ...payloads]);
}

export function unpackExactReviewBundle(archive, bundleDir) {
  if (!Buffer.isBuffer(archive)) archive = Buffer.from(archive);
  if (
    archive.byteLength < ARCHIVE_MAGIC.byteLength + 4 ||
    !archive.subarray(0, ARCHIVE_MAGIC.byteLength).equals(ARCHIVE_MAGIC)
  ) {
    throw new Error("exact-review artifact cache archive has an invalid header");
  }
  const manifestBytes = archive.readUInt32BE(ARCHIVE_MAGIC.byteLength);
  if (manifestBytes < 1 || manifestBytes > ARCHIVE_MANIFEST_MAX_BYTES) {
    throw new Error("exact-review artifact cache manifest length is invalid");
  }
  const manifestStart = ARCHIVE_MAGIC.byteLength + 4;
  const payloadStart = manifestStart + manifestBytes;
  if (payloadStart > archive.byteLength) {
    throw new Error("exact-review artifact cache archive is truncated");
  }
  let manifest;
  try {
    manifest = JSON.parse(archive.subarray(manifestStart, payloadStart).toString("utf8"));
  } catch {
    throw new Error("exact-review artifact cache manifest is invalid");
  }
  if (
    manifest?.version !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > ARCHIVE_FILE_MAX_COUNT
  ) {
    throw new Error("exact-review artifact cache manifest schema is invalid");
  }
  const decoded = [];
  const seen = new Set();
  let offset = payloadStart;
  for (const file of manifest.files) {
    const path = String(file?.path || "");
    requireSafeArchivePath(path);
    if (seen.has(path)) throw new Error("exact-review artifact cache contains duplicate paths");
    seen.add(path);
    const bytes = Number(file?.bytes);
    const digest = String(file?.sha256 || "");
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !DIGEST_PATTERN.test(digest)) {
      throw new Error("exact-review artifact cache file descriptor is invalid");
    }
    const end = offset + bytes;
    if (!Number.isSafeInteger(end) || end > archive.byteLength) {
      throw new Error("exact-review artifact cache file payload is truncated");
    }
    const content = archive.subarray(offset, end);
    if (createHash("sha256").update(content).digest("hex") !== digest) {
      throw new Error("exact-review artifact cache file digest mismatch");
    }
    decoded.push({ path, content: Buffer.from(content) });
    offset = end;
  }
  if (offset !== archive.byteLength) {
    throw new Error("exact-review artifact cache archive has trailing bytes");
  }
  const root = resolve(bundleDir);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const file of decoded) {
    const destination = resolve(root, ...file.path.split("/"));
    if (destination === root || !destination.startsWith(`${root}${sep}`)) {
      throw new Error("exact-review artifact cache path escapes the bundle root");
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.content);
  }
}

function validateReceipt(value, tuple) {
  const receipt = objectValue(value);
  const digest = String(receipt.digest || "");
  const bytes = Number(receipt.bytes);
  const objectKey = String(receipt.objectKey || "");
  if (
    String(receipt.producerRunId || "") !== tuple.producer_run_id ||
    Number(receipt.producerRunAttempt) !== tuple.producer_run_attempt ||
    String(receipt.artifactName || "") !== tuple.artifact_name ||
    String(receipt.canonicalItemKey || "") !== tuple.canonical_item_key ||
    Number(receipt.leaseRevision) !== tuple.lease_revision ||
    Number(receipt.protocolVersion) !== tuple.protocol_version ||
    !DIGEST_PATTERN.test(digest) ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    objectKey !== `${CACHE_PREFIX}${digest}`
  ) {
    throw new Error("exact-review artifact cache receipt is invalid");
  }
  return { digest, bytes, objectKey };
}

function requireSafeArchivePath(value) {
  if (
    !value ||
    value.length > 900 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("exact-review artifact cache path is invalid");
  }
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
