import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const DIRECTORY = fs.constants.O_DIRECTORY ?? 0;

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

export function prepareSafeWriteTarget(
  root: string,
  relativePath: string,
  label: string,
): SafeWriteTarget {
  validateRelativePath(relativePath, label);
  const rootPath = ensureDirectoryNoLinks(path.resolve(root), `${label} root`);
  const rootRealPath = fs.realpathSync.native(rootPath);
  const rootIdentity = directoryFileIdentity(rootPath, `${label} root`);
  const target = pathTarget(rootPath, rootRealPath, rootIdentity, relativePath, label);
  assertSafeWriteTarget(target);
  return target;
}

export function prepareSafeReadRoot(root: string, label: string): SafeReadRoot {
  const rootPath = path.resolve(root);
  assertDirectoryNoLinks(rootPath, `${label} root`);
  return {
    path: rootPath,
    realPath: fs.realpathSync.native(rootPath),
    identity: directoryFileIdentity(rootPath, `${label} root`),
  };
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

export function readUtf8FileNoFollow(target: SafeWriteTarget): string {
  const parentChain = captureSafeParentChain(target, false);
  return readUtf8FileWithParentChain(target, parentChain);
}

export function readUtf8FileIfExistsNoFollow(target: SafeWriteTarget): string | null {
  const parentChain = captureSafeParentChain(target, false);
  try {
    return readUtf8FileWithParentChain(target, parentChain);
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
): fs.Dirent[] {
  const target = prepareSafeDirectoryReadTarget(root, relativePath, label);
  const chain = captureSafeDirectoryChain(target);
  const first = sortedDirectoryEntries(target.path);
  assertStableDirectoryChain(target, chain);
  const second = sortedDirectoryEntries(target.path);
  assertStableDirectoryChain(target, chain);
  if (directoryEntriesSignature(first) !== directoryEntriesSignature(second)) {
    throw new Error(`refusing changed ${label} directory: ${target.path}`);
  }
  return second;
}

export function writeUtf8FileExclusiveNoFollow(target: SafeWriteTarget, content: string): void {
  const parentChain = captureSafeParentChain(target, true);
  let descriptor: number | undefined;
  try {
    assertStableParentChain(target, parentChain);
    descriptor = fs.openSync(
      target.path,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    const createdIdentity = descriptorIdentity(descriptor, target.label);
    assertStableParentChain(target, parentChain);
    assertPathMatchesIdentity(target.path, createdIdentity, target.label);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    assertStableParentChain(target, parentChain);
    assertPathMatchesIdentity(target.path, createdIdentity, target.label);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
      descriptor = undefined;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function writeUtf8FileCreateOnlyNoFollow(
  target: SafeWriteTarget,
  content: string,
): "created" | "exists" {
  const temporary = safeSiblingWriteTarget(
    target,
    `${path.basename(target.path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  writeUtf8FileExclusiveNoFollow(temporary, content);
  try {
    linkFileExclusiveNoFollow(temporary, target);
    return "created";
  } catch (error) {
    if (isAlreadyExistsError(error)) return "exists";
    throw error;
  }
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

function ensureDirectoryNoLinks(directory: string, label: string): string {
  const missing: string[] = [];
  let current = directory;
  while (true) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`refusing symbolic link or junction for ${label}: ${current}`);
      }
      break;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
  for (const segment of missing) {
    current = path.join(current, segment);
    let created = false;
    try {
      fs.mkdirSync(current);
      created = true;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
    const stat = lstatRequired(current, label);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`refusing symbolic link or junction for ${label}: ${current}`);
    }
    if (created) fsyncDirectory(path.dirname(current), label);
  }
  return directory;
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
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(`refusing changed ${label} file: ${filePath}`);
  }
}

function readUtf8FileWithParentChain(
  target: SafeWriteTarget,
  parentChain: ParentChainSnapshot,
): string {
  assertStableParentChain(target, parentChain);
  const expectedIdentity = fileIdentity(target.path, target.label);
  assertStableParentChain(target, parentChain);
  const descriptor = fs.openSync(target.path, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    const openedIdentity = descriptorIdentity(descriptor, target.label);
    if (
      openedIdentity.dev !== expectedIdentity.dev ||
      openedIdentity.ino !== expectedIdentity.ino
    ) {
      throw new Error(`refusing changed ${target.label} file: ${target.path}`);
    }
    assertStableParentChain(target, parentChain);
    assertPathMatchesIdentity(target.path, openedIdentity, target.label);
    const content = fs.readFileSync(descriptor, "utf8");
    assertStableParentChain(target, parentChain);
    assertPathMatchesIdentity(target.path, openedIdentity, target.label);
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
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

function sortedDirectoryEntries(directory: string): fs.Dirent[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
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
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes("..")
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
