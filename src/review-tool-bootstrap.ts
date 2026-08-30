import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { arch, platform } from "node:process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

export const TRUFFLEHOG_VERSION = "3.97.1";
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_TAR_BYTES = 512 * 1024 * 1024;

export type ReviewToolArtifact = {
  platform: string;
  executable: string;
  url: string;
  sha256: string;
};

const ARTIFACTS: Readonly<Record<string, ReviewToolArtifact>> = {
  "darwin-arm64": {
    platform: "darwin-arm64",
    executable: "trufflehog",
    url: "https://github.com/trufflesecurity/trufflehog/releases/download/v3.97.1/trufflehog_3.97.1_darwin_arm64.tar.gz",
    sha256: "1af86cf30c1cc5c1735ec6af9292b399ec9bed3ff1b30be13fcbfd4a30ab449a",
  },
  "darwin-x64": {
    platform: "darwin-x64",
    executable: "trufflehog",
    url: "https://github.com/trufflesecurity/trufflehog/releases/download/v3.97.1/trufflehog_3.97.1_darwin_amd64.tar.gz",
    sha256: "1515710bb16be5653ca9986c27ecd1a0e7536fc6e53ad46f7100992692f6a05f",
  },
  "linux-arm64": {
    platform: "linux-arm64",
    executable: "trufflehog",
    url: "https://github.com/trufflesecurity/trufflehog/releases/download/v3.97.1/trufflehog_3.97.1_linux_arm64.tar.gz",
    sha256: "57bfcc0988aae3f2ef97e74abe1138cf37a8fbd84dd26299062c77a6a6b125dd",
  },
  "linux-x64": {
    platform: "linux-x64",
    executable: "trufflehog",
    url: "https://github.com/trufflesecurity/trufflehog/releases/download/v3.97.1/trufflehog_3.97.1_linux_amd64.tar.gz",
    sha256: "f863ea3a8d786f7d097870496c977944cce7372a2fe1e56707d965016e543ece",
  },
  "win32-arm64": {
    platform: "win32-arm64",
    executable: "trufflehog.exe",
    url: "https://github.com/trufflesecurity/trufflehog/releases/download/v3.97.1/trufflehog_3.97.1_windows_arm64.tar.gz",
    sha256: "7b87a1f1590c66bf45045de29a354d8a1386d5ce094205bcb371e1ae805cb4ee",
  },
  "win32-x64": {
    platform: "win32-x64",
    executable: "trufflehog.exe",
    url: "https://github.com/trufflesecurity/trufflehog/releases/download/v3.97.1/trufflehog_3.97.1_windows_amd64.tar.gz",
    sha256: "dc1759892a41d64ee0d46cd5d4391dad7f916f54257154aa1b0732f9c50901b2",
  },
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function boundedResponseBytes(response: Response): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_ARCHIVE_BYTES)
    throw new Error("Trusted scanner download exceeds the archive limit.");
  if (!response.body) throw new Error("Trusted scanner download has no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ARCHIVE_BYTES)
        throw new Error("Trusted scanner download exceeds the archive limit.");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function tarString(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}

function tarSize(bytes: Buffer): number {
  const value = tarString(bytes).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("Trusted scanner archive has an invalid size.");
  const size = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(size) || size < 0)
    throw new Error("Trusted scanner archive has an invalid size.");
  return size;
}

export function extractTarExecutable(archive: Buffer, executable: string): Buffer {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_TAR_BYTES });
  } catch {
    throw new Error("Trusted scanner archive could not be decompressed.");
  }
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const prefix = tarString(header.subarray(345, 500));
    const name = tarString(header.subarray(0, 100));
    const path = prefix ? `${prefix}/${name}` : name;
    const size = tarSize(header.subarray(124, 136));
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error("Trusted scanner archive is truncated.");
    if (path === executable) {
      if (!["\0", "0"].includes(String.fromCharCode(header[156]!)))
        throw new Error("Trusted scanner archive has an unsafe executable entry.");
      return Buffer.from(tar.subarray(dataStart, dataEnd));
    }
    offset = dataEnd + ((512 - (size % 512)) % 512);
  }
  throw new Error("Trusted scanner archive does not contain the expected executable.");
}

export function reviewToolArtifact(
  runtimePlatform: string = platform,
  runtimeArch: string = arch,
): ReviewToolArtifact | undefined {
  return ARTIFACTS[`${runtimePlatform}-${runtimeArch}`];
}

export function reviewToolCacheRoot(env: NodeJS.ProcessEnv): string {
  const configured = env.CLAWSWEEPER_REVIEW_TOOLS_DIR?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("CLAWSWEEPER_REVIEW_TOOLS_DIR must be absolute.");
    return resolve(configured);
  }
  return join(homedir(), ".clawsweeper-review-tools");
}

function validCachedArchive(path: string, expectedHash: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_ARCHIVE_BYTES)
      return false;
    return sha256(readFileSync(path)) === expectedHash;
  } catch {
    return false;
  }
}

function cachedBinaryMatches(path: string, expected: Buffer): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && readFileSync(path).equals(expected);
  } catch {
    return false;
  }
}

function assertVersion(path: string): void {
  const result = spawnSync(path, ["--version"], {
    encoding: "utf8",
    env: {
      SystemRoot: process.env.SystemRoot,
      HOME: dirname(path),
      TMP: dirname(path),
      TEMP: dirname(path),
    },
    timeout: 30_000,
    maxBuffer: 4096,
    windowsHide: true,
  });
  if (
    result.error ||
    result.status !== 0 ||
    `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() !== `trufflehog ${TRUFFLEHOG_VERSION}`
  )
    throw new Error("Trusted scanner version check failed.");
}

export async function ensureManagedTruffleHog(options: {
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  runtimePlatform?: string;
  runtimeArch?: string;
}): Promise<string> {
  const env = options.env ?? process.env;
  const artifact = reviewToolArtifact(
    options.runtimePlatform ?? platform,
    options.runtimeArch ?? arch,
  );
  if (!artifact)
    throw new Error("No checksum-pinned trusted scanner is available for this platform.");
  const root = reviewToolCacheRoot(env);
  const cacheDir = join(root, "trufflehog", `v${TRUFFLEHOG_VERSION}`, artifact.platform);
  const archivePath = join(cacheDir, "archive.tar.gz");
  const binary = join(cacheDir, artifact.executable);
  let archive: Buffer;
  if (validCachedArchive(archivePath, artifact.sha256)) {
    archive = readFileSync(archivePath);
  } else {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(artifact.url, {
      signal: AbortSignal.timeout(Math.max(1, options.timeoutMs)),
    });
    if (!response.ok) throw new Error("Trusted scanner download failed.");
    archive = await boundedResponseBytes(response);
    if (
      archive.length === 0 ||
      archive.length > MAX_ARCHIVE_BYTES ||
      sha256(archive) !== artifact.sha256
    )
      throw new Error("Trusted scanner download checksum did not match.");
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const temporaryArchive = `${archivePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryArchive, archive, { mode: 0o600, flag: "wx" });
      rmSync(archivePath, { force: true });
      renameSync(temporaryArchive, archivePath);
    } finally {
      rmSync(temporaryArchive, { force: true });
    }
  }
  const executable = extractTarExecutable(archive, artifact.executable);
  if (executable.length === 0 || executable.length > MAX_ARCHIVE_BYTES)
    throw new Error("Trusted scanner executable is invalid.");
  if (!cachedBinaryMatches(binary, executable)) {
    mkdirSync(dirname(binary), { recursive: true, mode: 0o700 });
    const temporary = `${binary}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, executable, { mode: 0o700, flag: "wx" });
      rmSync(binary, { force: true });
      renameSync(temporary, binary);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  try {
    if (!cachedBinaryMatches(binary, executable))
      throw new Error("Trusted scanner cache verification failed.");
    assertVersion(binary);
    return binary;
  } catch (error) {
    try {
      rmSync(binary, { force: true });
    } catch {
      // The failure remains fail-closed even if a corrupted cache file cannot be removed.
    }
    throw error;
  }
}
