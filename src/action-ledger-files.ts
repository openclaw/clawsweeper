import fs from "node:fs";
import path from "node:path";

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export type SafeWriteTarget = {
  path: string;
  rootPath: string;
  rootRealPath: string;
  parentPath: string;
  label: string;
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
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`refusing to write ${label} outside root: ${relativePath}`);
  }
  const rootPath = ensureDirectoryNoLinks(path.resolve(root), `${label} root`);
  const rootRealPath = fs.realpathSync.native(rootPath);
  const destination = path.resolve(rootPath, relativePath);
  if (destination === rootPath || !destination.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`refusing to write ${label} outside root: ${relativePath}`);
  }
  const target = {
    path: destination,
    rootPath,
    rootRealPath,
    parentPath: path.dirname(destination),
    label,
  };
  assertSafeWriteTarget(target);
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
  const rootStat = lstatRequired(target.rootPath, `${target.label} root`);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(
      `refusing symbolic link or junction in ${target.label} root: ${target.rootPath}`,
    );
  }
  if (fs.realpathSync.native(target.rootPath) !== target.rootRealPath) {
    throw new Error(`refusing changed ${target.label} root: ${target.rootPath}`);
  }
  ensureDescendantDirectory(target);
}

export function assertDirectoryNoLinks(directory: string, label: string): void {
  const stat = lstatRequired(directory, label);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`refusing symbolic link or junction for ${label}: ${directory}`);
  }
}

export function readUtf8FileNoFollow(filePath: string, label: string): string {
  const stat = lstatRequired(filePath, label);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`refusing symbolic link or non-file for ${label}: ${filePath}`);
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(`refusing non-file for ${label}: ${filePath}`);
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readUtf8FileIfExistsNoFollow(filePath: string, label: string): string | null {
  try {
    return readUtf8FileNoFollow(filePath, label);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export function writeUtf8FileExclusiveNoFollow(target: SafeWriteTarget, content: string): void {
  const parentChain = captureSafeParentChain(target);
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
      fs.closeSync(descriptor);
      descriptor = undefined;
    }
    if (createdIdentity) removeCreatedFileIfStable(target, createdIdentity, parentChain);
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
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
  const parentChain = captureSafeParentChain(destination);
  const sourceIdentity = fileIdentity(source.path, `${source.label} source`);
  assertStableParentChain(destination, parentChain);
  assertPathMatchesIdentity(source.path, sourceIdentity, `${source.label} source`);
  try {
    fs.linkSync(source.path, destination.path);
  } catch (error) {
    assertStableParentChain(destination, parentChain);
    throw error;
  }
  try {
    assertStableParentChain(destination, parentChain);
    assertPathMatchesIdentity(source.path, sourceIdentity, `${source.label} source`);
    assertPathMatchesIdentity(destination.path, sourceIdentity, destination.label);
  } catch (error) {
    removeCreatedFileIfStable(destination, sourceIdentity, parentChain);
    throw error;
  }
}

export function removeFileNoFollow(target: SafeWriteTarget): void {
  const parentChain = captureSafeParentChain(target);
  let identity: FileIdentity;
  try {
    identity = fileIdentity(target.path, target.label);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  assertStableParentChain(target, parentChain);
  assertPathMatchesIdentity(target.path, identity, target.label);
  fs.unlinkSync(target.path);
  assertStableParentChain(target, parentChain);
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
    try {
      fs.mkdirSync(current);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
    const stat = lstatRequired(current, label);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`refusing symbolic link or junction for ${label}: ${current}`);
    }
  }
  return directory;
}

function ensureDescendantDirectory(target: SafeWriteTarget): void {
  const relative = path.relative(target.rootPath, target.parentPath);
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes("..")) {
    throw new Error(`refusing invalid ${target.label} parent: ${target.parentPath}`);
  }
  let current = target.rootPath;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current);
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
  }
}

function captureSafeParentChain(target: SafeWriteTarget): ParentChainSnapshot {
  assertSafeWriteTarget(target);
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
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes("..")) {
    throw new Error(`refusing invalid ${target.label} parent: ${target.parentPath}`);
  }
  const entries = [target.rootPath];
  let current = target.rootPath;
  for (const segment of relative.split(path.sep)) {
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

function removeCreatedFileIfStable(
  target: SafeWriteTarget,
  identity: FileIdentity,
  parentChain: ParentChainSnapshot,
): void {
  try {
    assertStableParentChain(target, parentChain);
    assertPathMatchesIdentity(target.path, identity, target.label);
    fs.unlinkSync(target.path);
    assertStableParentChain(target, parentChain);
  } catch {
    // An unsafe cleanup is worse than leaving an untrusted empty or partial file behind.
  }
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
