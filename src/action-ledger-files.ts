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
  assertSafeWriteTarget(target);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      target.path,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    fs.writeFileSync(descriptor, content, "utf8");
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.rmSync(target.path, { force: true });
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
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
