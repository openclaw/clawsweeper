import { constants as bufferConstants, isUtf8 } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
const NON_BLOCKING = fs.constants.O_NONBLOCK ?? 0;
const PROCESS_IDENTITY_CACHE_MS = 100;
const processIdentityCache = new Map<number, { expiresAt: number; identity: string | null }>();
const DARWIN_PROCESS_INFO_SCRIPT = String.raw`
import ctypes
import struct
import sys

size = 136
buffer = ctypes.create_string_buffer(size)
libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
written = libc.proc_pidinfo(int(sys.argv[1]), 3, 0, buffer, size)
if written != size:
    raise SystemExit(1)
status = struct.unpack_from("=I", buffer, 4)[0]
reported_pid = struct.unpack_from("=I", buffer, 12)[0]
started_sec, started_usec = struct.unpack_from("=QQ", buffer, 120)
print(f"{status}:{reported_pid}:{started_sec}:{started_usec}")
`;

export type SafeWriteTarget = {
  path: string;
  rootPath: string;
  rootRealPath: string;
  rootIdentity: FileIdentity;
  parentPath: string;
  label: string;
};

export type SafeReadRoot = {
  path: string;
  realPath: string;
  identity: FileIdentity;
};

type FileIdentity = {
  dev: bigint;
  ino: bigint;
};

type ParentChainEntry = FileIdentity & {
  path: string;
};

type ParentChainSnapshot = {
  entries: ParentChainEntry[];
};

class FileIdentityMismatchError extends Error {}

export function prepareSafeWriteTarget(
  root: string,
  relativePath: string,
  label: string,
): SafeWriteTarget {
  validateRelativePath(relativePath, label);
  const safeRoot = prepareCanonicalRoot(root, `${label} root`);
  const rootPath = safeRoot.path;
  const rootRealPath = safeRoot.realPath;
  const rootIdentity = safeRoot.identity;
  const target = pathTarget(rootPath, rootRealPath, rootIdentity, relativePath, label);
  assertSafeWriteTarget(target);
  return target;
}

export function prepareSafeReadRoot(root: string, label: string): SafeReadRoot {
  return prepareCanonicalRoot(root, `${label} root`);
}

export function prepareSafeReadTarget(
  root: string | SafeReadRoot,
  relativePath: string,
  label: string,
): SafeWriteTarget {
  validateRelativePath(relativePath, label);
  const safeRoot = typeof root === "string" ? prepareSafeReadRoot(root, label) : root;
  assertSafeReadRoot(safeRoot, label);
  const target = pathTarget(
    safeRoot.path,
    safeRoot.realPath,
    safeRoot.identity,
    relativePath,
    label,
  );
  assertSafeReadTarget(target);
  return target;
}

export function safeSiblingWriteTarget(target: SafeWriteTarget, filename: string): SafeWriteTarget {
  const siblingPath = path.join(target.parentPath, filename);
  if (path.dirname(siblingPath) !== target.parentPath) {
    throw new Error(`invalid ${target.label} temporary filename`);
  }
  return { ...target, path: siblingPath };
}

export function assertSafeWriteTarget(target: SafeWriteTarget): void {
  assertSafeRoot(target);
  ensureDescendantDirectory(target);
}

export function assertSafeReadTarget(target: SafeWriteTarget): void {
  assertSafeRoot(target);
  assertDescendantDirectory(target);
}

export function assertDirectoryNoLinks(directory: string, label: string): void {
  const stat = lstatRequired(directory, label);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`refusing symbolic link or junction for ${label}: ${directory}`);
  }
}

export function readUtf8FileNoFollow(target: SafeWriteTarget, maxBytes?: number): string {
  const parentChain = captureSafeParentChain(target, false);
  return readUtf8FileWithParentChain(target, parentChain, maxBytes);
}

export function readUtf8FileIfExistsNoFollow(
  target: SafeWriteTarget,
  maxBytes?: number,
): string | null {
  const parentChain = captureSafeParentChain(target, false);
  try {
    return readUtf8FileWithParentChain(target, parentChain, maxBytes);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    assertStableParentChain(target, parentChain);
    return null;
  }
}

export function readDirectoryEntriesNoFollow(
  root: string | SafeReadRoot,
  relativePath: string,
  label: string,
  maxEntries?: number,
): fs.Dirent[] {
  const target = prepareSafeDirectoryReadTarget(root, relativePath, label);
  const chain = captureSafeDirectoryChain(target);
  const first = sortedDirectoryEntries(target.path, maxEntries);
  assertStableDirectoryChain(target, chain);
  const second = sortedDirectoryEntries(target.path, maxEntries);
  assertStableDirectoryChain(target, chain);
  if (directoryEntriesSignature(first) !== directoryEntriesSignature(second)) {
    throw new Error(`refusing changed ${label} directory: ${target.path}`);
  }
  return second;
}

export function writeUtf8FileExclusiveNoFollow(target: SafeWriteTarget, content: string): void {
  writeUtf8FileExclusiveNoFollowWithIdentity(target, content, false);
}

function writeUtf8FileExclusiveNoFollowWithIdentity(
  target: SafeWriteTarget,
  content: string,
  cleanupOnFailure: boolean,
): FileIdentity {
  const parentChain = captureSafeParentChain(target, true);
  let descriptor: number | undefined;
  let createdIdentity: FileIdentity | undefined;
  try {
    assertStableParentChain(target, parentChain);
    descriptor = fs.openSync(
      target.path,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    createdIdentity = descriptorIdentity(descriptor, target.label);
    assertStableParentChain(target, parentChain);
    assertPathMatchesIdentity(target.path, createdIdentity, target.label);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    assertStableParentChain(target, parentChain);
    assertPathMatchesIdentity(target.path, createdIdentity, target.label);
  } catch (error) {
    if (descriptor !== undefined) {
      if (createdIdentity === undefined) {
        try {
          createdIdentity = descriptorIdentity(descriptor, target.label);
        } catch {
          // Preserve the original failure; cleanup below remains best effort.
        }
      }
      fs.closeSync(descriptor);
      descriptor = undefined;
    }
    if (cleanupOnFailure && createdIdentity !== undefined) {
      try {
        removeFileNoFollow(target, createdIdentity);
      } catch (cleanupError) {
        if (!isNotFoundError(cleanupError)) {
          throw new AggregateError(
            [error, cleanupError],
            `failed to clean up ${target.label} after lock creation failure`,
          );
        }
      }
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return createdIdentity!;
}

export function tryAcquireUtf8FileLockNoFollow(
  target: SafeWriteTarget,
  content: string,
): (() => void) | null {
  const temporary = safeSiblingWriteTarget(
    target,
    `${path.basename(target.path)}.${process.pid}.${randomUUID()}.lock`,
  );
  let identity: FileIdentity | undefined;
  let published = false;
  let result: "created" | "exists" | undefined;
  let failure: unknown;
  try {
    writeUtf8FileExclusiveNoFollow(temporary, content);
    identity = fileIdentity(temporary.path, `${temporary.label} staging`);
    try {
      linkFileExclusiveNoFollow(temporary, target);
      published = true;
      result = "created";
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        result = "exists";
      } else {
        try {
          published = pathMatchesFileIdentity(target.path, identity, target.label);
        } catch (identityError) {
          throw new AggregateError(
            [error, identityError],
            `failed to determine whether ${target.label} lock was published`,
          );
        }
        throw error;
      }
    }
  } catch (error) {
    failure = error;
  }
  if (!identity) {
    try {
      identity = fileIdentity(temporary.path, `${temporary.label} staging`);
    } catch (error) {
      if (!isNotFoundError(error) && failure === undefined) failure = error;
    }
  }
  if (identity) {
    try {
      removeFileNoFollow(temporary, identity);
    } catch (error) {
      if (!isNotFoundError(error) && failure === undefined) failure = error;
    }
  }
  if (failure !== undefined && published && identity) {
    try {
      removeFileNoFollow(target, identity);
    } catch (cleanupError) {
      if (!isNotFoundError(cleanupError)) {
        failure = new AggregateError(
          [failure, cleanupError],
          `failed to clean up ${target.label} after lock creation failure`,
        );
      }
    }
  }
  if (failure !== undefined) throw failure;
  if (result === "exists") return null;
  const publishedIdentity = identity!;
  let released = false;
  return () => {
    if (released) return;
    const result = claimAndRemoveUtf8FileNoFollow(target, content, publishedIdentity);
    if (result === "changed") {
      throw new Error(`refusing changed ${target.label} lock file: ${target.path}`);
    }
    released = true;
  };
}

export function removeUtf8FileIfContentNoFollow(
  target: SafeWriteTarget,
  expectedContent: string,
): boolean {
  return claimAndRemoveUtf8FileNoFollow(target, expectedContent) === "removed";
}

type ConditionalRemoveResult = "removed" | "missing" | "changed" | "replaced";

function claimAndRemoveUtf8FileNoFollow(
  target: SafeWriteTarget,
  expectedContent: string,
  expectedIdentity?: FileIdentity,
): ConditionalRemoveResult {
  const parentChain = captureSafeParentChain(target, false);
  const claimed = safeSiblingWriteTarget(
    target,
    `${path.basename(target.path)}.${process.pid}.${randomUUID()}.reclaim`,
  );
  let descriptor: number | undefined;
  let removed = false;
  try {
    assertStableParentChain(target, parentChain);
    const pathIdentity = fileIdentity(target.path, `${target.label} stale lock`);
    descriptor = fs.openSync(target.path, fs.constants.O_RDONLY | NO_FOLLOW | NON_BLOCKING);
    const openedIdentity = descriptorIdentity(descriptor, `${target.label} stale lock`);
    if (
      !fileIdentitiesEqual(pathIdentity, openedIdentity) ||
      (expectedIdentity !== undefined && !fileIdentitiesEqual(expectedIdentity, openedIdentity))
    ) {
      return "replaced";
    }
    assertStableParentChain(target, parentChain);
    assertPathMatchesIdentity(target.path, openedIdentity, `${target.label} stale lock`);
    const current = readBoundedUtf8File(
      descriptor,
      Math.max(1, Buffer.byteLength(expectedContent, "utf8")),
      target,
    );
    if (current !== expectedContent) return "changed";
    assertStableParentChain(target, parentChain);
    assertPathMatchesIdentity(target.path, openedIdentity, `${target.label} stale lock`);
    try {
      fs.renameSync(target.path, claimed.path);
    } catch (error) {
      if (isNotFoundError(error)) return "missing";
      throw error;
    }
    fsyncDirectory(target.parentPath, target.label);
    assertStableParentChain(target, parentChain);
    const claimedIdentity = fileIdentity(claimed.path, `${target.label} stale lock claim`);
    if (!fileIdentitiesEqual(claimedIdentity, openedIdentity)) {
      restoreClaimedFileNoFollow(claimed, target, claimedIdentity);
      return "replaced";
    }
    removeFileNoFollow(claimed, openedIdentity);
    removed = true;
  } catch (error) {
    if (isNotFoundError(error)) return "missing";
    if (error instanceof FileIdentityMismatchError) return "replaced";
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  if (!removed) return "replaced";
  try {
    fileIdentity(target.path, `${target.label} successor lock`);
    return "replaced";
  } catch (error) {
    if (isNotFoundError(error)) return "removed";
    throw error;
  }
}

function restoreClaimedFileNoFollow(
  claimed: SafeWriteTarget,
  target: SafeWriteTarget,
  identity: FileIdentity,
): void {
  linkFileExclusiveNoFollow(claimed, target);
  removeFileNoFollow(claimed, identity);
}

export function processIncarnationIdentitySha256(
  pid = process.pid,
  options: { fresh?: boolean } = {},
): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const now = Date.now();
  const cached = processIdentityCache.get(pid);
  if (!options.fresh && cached && cached.expiresAt > now) return cached.identity;
  const rawIdentity = processIncarnationIdentity(pid);
  const identity =
    rawIdentity === null
      ? null
      : createHash("sha256").update(`${process.platform}\0${rawIdentity}`).digest("hex");
  processIdentityCache.set(pid, {
    expiresAt: pid === process.pid ? Number.POSITIVE_INFINITY : now + PROCESS_IDENTITY_CACHE_MS,
    identity,
  });
  return identity;
}

export function processIsDefunct(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1 || process.platform !== "linux") return false;
  const stat = linuxProcessStat(pid);
  return stat?.state === "Z" || stat?.state === "X";
}

export function writeUtf8FileCreateOnlyNoFollow(
  target: SafeWriteTarget,
  content: string,
): "created" | "exists" {
  const temporary = safeSiblingWriteTarget(
    target,
    `${path.basename(target.path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let result: "created" | "exists" | undefined;
  let failure: unknown;
  let temporaryIdentity: FileIdentity | undefined;
  try {
    writeUtf8FileExclusiveNoFollow(temporary, content);
    temporaryIdentity = fileIdentity(temporary.path, `${temporary.label} staging`);
    try {
      linkFileExclusiveNoFollow(temporary, target);
      result = "created";
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      result = "exists";
    }
  } catch (error) {
    failure = error;
  }
  if (!temporaryIdentity) {
    try {
      temporaryIdentity = fileIdentity(temporary.path, `${temporary.label} staging`);
    } catch (error) {
      if (!isNotFoundError(error) && failure === undefined) failure = error;
    }
  }
  if (temporaryIdentity) {
    try {
      removeFileNoFollow(temporary, temporaryIdentity);
    } catch (error) {
      if (failure === undefined) failure = error;
    }
  }
  if (failure !== undefined) throw failure;
  return result!;
}

export function linkFileExclusiveNoFollow(
  source: SafeWriteTarget,
  destination: SafeWriteTarget,
): void {
  if (
    source.rootPath !== destination.rootPath ||
    source.rootRealPath !== destination.rootRealPath ||
    source.parentPath !== destination.parentPath
  ) {
    throw new Error(`refusing cross-directory ${destination.label} link`);
  }
  const parentChain = captureSafeParentChain(destination, true);
  const sourceIdentity = fileIdentity(source.path, `${source.label} source`);
  assertStableParentChain(destination, parentChain);
  assertPathMatchesIdentity(source.path, sourceIdentity, `${source.label} source`);
  try {
    fs.linkSync(source.path, destination.path);
  } catch (error) {
    assertStableParentChain(destination, parentChain);
    throw error;
  }
  assertStableParentChain(destination, parentChain);
  assertPathMatchesIdentity(source.path, sourceIdentity, `${source.label} source`);
  assertPathMatchesIdentity(destination.path, sourceIdentity, destination.label);
  fsyncDirectory(destination.parentPath, destination.label);
  assertStableParentChain(destination, parentChain);
  assertPathMatchesIdentity(destination.path, sourceIdentity, destination.label);
}

function prepareCanonicalRoot(root: string, label: string): SafeReadRoot {
  const rootPath = path.resolve(root);
  if (root !== rootPath) {
    throw new Error(`refusing noncanonical ${label}: ${root}`);
  }
  assertDirectoryNoLinks(rootPath, label);
  const realPath = fs.realpathSync.native(rootPath);
  if (realPath !== rootPath) {
    throw new Error(`refusing link-resolved ${label}: ${rootPath}`);
  }
  return {
    path: rootPath,
    realPath,
    identity: directoryFileIdentity(rootPath, label),
  };
}

function ensureDescendantDirectory(target: SafeWriteTarget): void {
  const relative = path.relative(target.rootPath, target.parentPath);
  if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) {
    throw new Error(`refusing invalid ${target.label} parent: ${target.parentPath}`);
  }
  if (!relative) return;
  let current = target.rootPath;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let created = false;
    try {
      fs.mkdirSync(current);
      created = true;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
    const stat = lstatRequired(current, target.label);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`refusing symbolic link or junction in ${target.label} path: ${current}`);
    }
    const real = fs.realpathSync.native(current);
    if (real !== target.rootRealPath && !real.startsWith(`${target.rootRealPath}${path.sep}`)) {
      throw new Error(`refusing ${target.label} parent outside root: ${current}`);
    }
    if (created) fsyncDirectory(path.dirname(current), target.label);
  }
}

function assertDescendantDirectory(target: SafeWriteTarget): void {
  const relative = path.relative(target.rootPath, target.parentPath);
  if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) {
    throw new Error(`refusing invalid ${target.label} parent: ${target.parentPath}`);
  }
  let current = target.rootPath;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    directoryIdentity(current, target);
  }
}

function captureSafeParentChain(
  target: SafeWriteTarget,
  createParents: boolean,
): ParentChainSnapshot {
  if (createParents) {
    assertSafeWriteTarget(target);
  } else {
    assertSafeReadTarget(target);
  }
  return { entries: parentChainPaths(target).map((entry) => directoryIdentity(entry, target)) };
}

function assertStableParentChain(target: SafeWriteTarget, expected: ParentChainSnapshot): void {
  const actual = parentChainPaths(target).map((entry) => directoryIdentity(entry, target));
  if (
    actual.length !== expected.entries.length ||
    actual.some((entry, index) => {
      const prior = expected.entries[index];
      return (
        prior === undefined ||
        entry.path !== prior.path ||
        entry.dev !== prior.dev ||
        entry.ino !== prior.ino
      );
    })
  ) {
    throw new Error(`refusing changed ${target.label} parent chain: ${target.parentPath}`);
  }
}

function parentChainPaths(target: SafeWriteTarget): string[] {
  const relative = path.relative(target.rootPath, target.parentPath);
  if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) {
    throw new Error(`refusing invalid ${target.label} parent: ${target.parentPath}`);
  }
  const entries = [target.rootPath];
  let current = target.rootPath;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    entries.push(current);
  }
  return entries;
}

function directoryIdentity(directory: string, target: SafeWriteTarget): ParentChainEntry {
  const stat = lstatRequiredBigInt(directory, target.label);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`refusing symbolic link or junction in ${target.label} path: ${directory}`);
  }
  const real = fs.realpathSync.native(directory);
  if (
    (directory === target.rootPath && real !== target.rootRealPath) ||
    (directory !== target.rootPath &&
      real !== target.rootRealPath &&
      !real.startsWith(`${target.rootRealPath}${path.sep}`))
  ) {
    throw new Error(`refusing ${target.label} parent outside root: ${directory}`);
  }
  return { path: directory, dev: stat.dev, ino: stat.ino };
}

function descriptorIdentity(descriptor: number, label: string): FileIdentity {
  const stat = fs.fstatSync(descriptor, { bigint: true });
  if (!stat.isFile()) throw new Error(`refusing non-file for ${label}`);
  return { dev: stat.dev, ino: stat.ino };
}

function fileIdentity(filePath: string, label: string): FileIdentity {
  const stat = lstatRequiredBigInt(filePath, label);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`refusing symbolic link or non-file for ${label}: ${filePath}`);
  }
  return { dev: stat.dev, ino: stat.ino };
}

function assertPathMatchesIdentity(filePath: string, expected: FileIdentity, label: string): void {
  const actual = fileIdentity(filePath, label);
  if (!fileIdentitiesEqual(actual, expected)) {
    throw new FileIdentityMismatchError(`refusing changed ${label} file: ${filePath}`);
  }
}

function pathMatchesFileIdentity(filePath: string, expected: FileIdentity, label: string): boolean {
  try {
    const actual = fileIdentity(filePath, label);
    return fileIdentitiesEqual(actual, expected);
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

function fileIdentitiesEqual(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readUtf8FileWithParentChain(
  target: SafeWriteTarget,
  parentChain: ParentChainSnapshot,
  maxBytes?: number,
): string {
  if (
    maxBytes !== undefined &&
    (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= bufferConstants.MAX_LENGTH)
  ) {
    throw new Error(`invalid ${target.label} byte limit: ${maxBytes}`);
  }
  assertStableParentChain(target, parentChain);
  const expectedIdentity = fileIdentity(target.path, target.label);
  assertStableParentChain(target, parentChain);
  const descriptor = fs.openSync(target.path, fs.constants.O_RDONLY | NO_FOLLOW | NON_BLOCKING);
  try {
    const openedStat = fs.fstatSync(descriptor, { bigint: true });
    if (!openedStat.isFile()) throw new Error(`refusing non-file for ${target.label}`);
    const openedIdentity = { dev: openedStat.dev, ino: openedStat.ino };
    if (
      openedIdentity.dev !== expectedIdentity.dev ||
      openedIdentity.ino !== expectedIdentity.ino
    ) {
      throw new Error(`refusing changed ${target.label} file: ${target.path}`);
    }
    assertStableParentChain(target, parentChain);
    assertPathMatchesIdentity(target.path, openedIdentity, target.label);
    if (maxBytes !== undefined && openedStat.size > BigInt(maxBytes)) {
      throw new Error(`${target.label} file exceeds ${maxBytes} byte limit: ${target.path}`);
    }
    const content =
      maxBytes === undefined
        ? decodeUtf8File(fs.readFileSync(descriptor), target)
        : readBoundedUtf8File(descriptor, maxBytes, target);
    assertStableParentChain(target, parentChain);
    assertPathMatchesIdentity(target.path, openedIdentity, target.label);
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readBoundedUtf8File(
  descriptor: number,
  maxBytes: number,
  target: SafeWriteTarget,
): string {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
    if (count === 0) break;
    bytesRead += count;
  }
  if (bytesRead > maxBytes) {
    throw new Error(`${target.label} file exceeds ${maxBytes} byte limit: ${target.path}`);
  }
  return decodeUtf8File(buffer.subarray(0, bytesRead), target);
}

function decodeUtf8File(buffer: Uint8Array, target: SafeWriteTarget): string {
  if (!isUtf8(buffer)) {
    throw new Error(`invalid UTF-8 in ${target.label} file: ${target.path}`);
  }
  return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).toString("utf8");
}

function removeFileNoFollow(target: SafeWriteTarget, expectedIdentity: FileIdentity): void {
  const parentChain = captureSafeParentChain(target, false);
  assertStableParentChain(target, parentChain);
  assertPathMatchesIdentity(target.path, expectedIdentity, `${target.label} staging`);
  fs.unlinkSync(target.path);
  assertStableParentChain(target, parentChain);
  try {
    fileIdentity(target.path, `${target.label} staging`);
    throw new FileIdentityMismatchError(
      `refusing replaced ${target.label} staging file: ${target.path}`,
    );
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  fsyncDirectory(target.parentPath, target.label);
  assertStableParentChain(target, parentChain);
}

function processIncarnationIdentity(pid: number): string | null {
  if (process.platform === "linux") {
    const bootId = readUtf8Path("/proc/sys/kernel/random/boot_id")?.trim();
    const stat = linuxProcessStat(pid);
    if (
      !bootId ||
      !stat ||
      stat.state === "Z" ||
      stat.state === "X" ||
      !/^\d+$/.test(stat.startTime)
    ) {
      return null;
    }
    return `${bootId}\0${stat.startTime}`;
  }
  if (process.platform === "win32") {
    const startTime = commandOutput("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ]);
    return startTime ? `windows\0${startTime}` : null;
  }
  if (process.platform === "darwin") {
    const processInfo = commandOutput("/usr/bin/python3", [
      "-c",
      DARWIN_PROCESS_INFO_SCRIPT,
      String(pid),
    ]);
    if (processInfo && /^\d+:\d+:\d+:\d+$/.test(processInfo)) {
      const bootTime = commandOutput("/usr/sbin/sysctl", ["-n", "kern.boottime"]);
      return `${bootTime ?? "unknown-boot"}\0${processInfo}`;
    }
  }
  const startTime = commandOutput("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
  if (!startTime) return null;
  const bootTime =
    process.platform === "darwin"
      ? commandOutput("/usr/sbin/sysctl", ["-n", "kern.boottime"])
      : null;
  return `${bootTime ?? "unknown-boot"}\0${startTime}`;
}

function linuxProcessStat(pid: number): { state: string; startTime: string } | null {
  const stat = readUtf8Path(`/proc/${pid}/stat`);
  if (stat === null) return null;
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return null;
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const startTime = fields[19];
  return state && startTime ? { state, startTime } : null;
}

function readUtf8Path(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function commandOutput(command: string, args: readonly string[]): string | null {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 16 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) return null;
  const output = result.stdout.trim();
  return output || null;
}

function prepareSafeDirectoryReadTarget(
  root: string | SafeReadRoot,
  relativePath: string,
  label: string,
): SafeWriteTarget {
  if (
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes("..") ||
    relativePath.split(/[\\/]/).some((segment) => segment === "")
  ) {
    throw new Error(`refusing to read ${label} outside root: ${relativePath}`);
  }
  const safeRoot = typeof root === "string" ? prepareSafeReadRoot(root, label) : root;
  assertSafeReadRoot(safeRoot, label);
  const rootPath = safeRoot.path;
  const rootRealPath = safeRoot.realPath;
  const destination = relativePath === "." ? rootPath : path.resolve(rootPath, relativePath);
  if (destination !== rootPath && !destination.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`refusing to read ${label} outside root: ${relativePath}`);
  }
  const target = {
    path: destination,
    rootPath,
    rootRealPath,
    rootIdentity: safeRoot.identity,
    parentPath: path.dirname(destination),
    label,
  };
  captureSafeDirectoryChain(target);
  return target;
}

function captureSafeDirectoryChain(target: SafeWriteTarget): ParentChainSnapshot {
  assertSafeRoot(target);
  return {
    entries: directoryChainPaths(target).map((entry) => directoryIdentity(entry, target)),
  };
}

function assertStableDirectoryChain(target: SafeWriteTarget, expected: ParentChainSnapshot): void {
  const actual = captureSafeDirectoryChain(target);
  if (
    actual.entries.length !== expected.entries.length ||
    actual.entries.some((entry, index) => {
      const prior = expected.entries[index];
      return (
        prior === undefined ||
        entry.path !== prior.path ||
        entry.dev !== prior.dev ||
        entry.ino !== prior.ino
      );
    })
  ) {
    throw new Error(`refusing changed ${target.label} directory: ${target.path}`);
  }
}

function directoryChainPaths(target: SafeWriteTarget): string[] {
  const relative = path.relative(target.rootPath, target.path);
  if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) {
    throw new Error(`refusing invalid ${target.label} directory: ${target.path}`);
  }
  const entries = [target.rootPath];
  let current = target.rootPath;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    entries.push(current);
  }
  return entries;
}

function sortedDirectoryEntries(directory: string, maxEntries?: number): fs.Dirent[] {
  if (maxEntries === undefined) {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`invalid directory entry limit: ${maxEntries}`);
  }
  const handle = fs.opendirSync(directory);
  const entries: fs.Dirent[] = [];
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      entries.push(entry);
      if (entries.length > maxEntries) {
        throw new Error(`directory exceeds ${maxEntries} entry limit: ${directory}`);
      }
    }
  } finally {
    handle.closeSync();
  }
  return entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

function directoryEntriesSignature(entries: readonly fs.Dirent[]): string {
  return entries.map((entry) => `${entry.name}\0${directoryEntryKind(entry)}`).join("\n");
}

function directoryEntryKind(entry: fs.Dirent): string {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isBlockDevice()) return "block";
  if (entry.isCharacterDevice()) return "character";
  if (entry.isFIFO()) return "fifo";
  if (entry.isSocket()) return "socket";
  return "unknown";
}

function assertSafeRoot(target: SafeWriteTarget): void {
  const actualIdentity = directoryFileIdentity(target.rootPath, `${target.label} root`);
  if (
    actualIdentity.dev !== target.rootIdentity.dev ||
    actualIdentity.ino !== target.rootIdentity.ino
  ) {
    throw new Error(`refusing changed ${target.label} root: ${target.rootPath}`);
  }
  if (fs.realpathSync.native(target.rootPath) !== target.rootRealPath) {
    throw new Error(`refusing changed ${target.label} root: ${target.rootPath}`);
  }
}

function assertSafeReadRoot(root: SafeReadRoot, label: string): void {
  const actualIdentity = directoryFileIdentity(root.path, `${label} root`);
  if (actualIdentity.dev !== root.identity.dev || actualIdentity.ino !== root.identity.ino) {
    throw new Error(`refusing changed ${label} root: ${root.path}`);
  }
  if (fs.realpathSync.native(root.path) !== root.realPath) {
    throw new Error(`refusing changed ${label} root: ${root.path}`);
  }
}

function pathTarget(
  rootPath: string,
  rootRealPath: string,
  rootIdentity: FileIdentity,
  relativePath: string,
  label: string,
): SafeWriteTarget {
  const destination = path.resolve(rootPath, relativePath);
  if (destination === rootPath || !destination.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`refusing to access ${label} outside root: ${relativePath}`);
  }
  return {
    path: destination,
    rootPath,
    rootRealPath,
    rootIdentity,
    parentPath: path.dirname(destination),
    label,
  };
}

function validateRelativePath(relativePath: string, label: string): void {
  const segments = relativePath.split(/[\\/]/);
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`refusing to access ${label} outside root: ${relativePath}`);
  }
}

function fsyncDirectory(directory: string, label: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | DIRECTORY | NO_FOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isDirectory()) {
      throw new Error(`refusing non-directory while syncing ${label}: ${directory}`);
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function directoryFileIdentity(directory: string, label: string): FileIdentity {
  const stat = lstatRequiredBigInt(directory, label);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`refusing symbolic link or junction for ${label}: ${directory}`);
  }
  return { dev: stat.dev, ino: stat.ino };
}

function lstatRequired(filePath: string, label: string): fs.Stats {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    const missing = new Error(`missing ${label}: ${filePath}`) as NodeJS.ErrnoException;
    missing.code = "ENOENT";
    throw missing;
  }
}

function lstatRequiredBigInt(filePath: string, label: string): fs.BigIntStats {
  try {
    return fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    const missing = new Error(`missing ${label}: ${filePath}`) as NodeJS.ErrnoException;
    missing.code = "ENOENT";
    throw missing;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
