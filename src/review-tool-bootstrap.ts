import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { arch, platform } from "node:process";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

export const TRUFFLEHOG_VERSION = "3.97.1";
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_TAR_BYTES = 512 * 1024 * 1024;
const PRIVATE_CACHE_MODE = 0o077;
const DARWIN_SAFE_ACL_PERMISSIONS = new Set([
  "directory_inherit",
  "execute",
  "file_inherit",
  "limit_inherit",
  "list",
  "only_inherit",
  "read",
  "readattr",
  "readextattr",
  "readsecurity",
  "search",
  "synchronize",
]);
const WINDOWS_CACHE_AUTHORITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:CLAWSWEEPER_CACHE_AUTHORITY_PATH
$check = $env:CLAWSWEEPER_CACHE_AUTHORITY_CHECK
if ([string]::IsNullOrWhiteSpace($target)) { exit 20 }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$currentSid = $identity.User.Value
$allowed = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
[void]$allowed.Add($currentSid)
[void]$allowed.Add('S-1-5-18')
[void]$allowed.Add('S-1-5-32-544')
[void]$allowed.Add('S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$acl = Get-Acl -LiteralPath $target
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
if ($check -eq 'private' -and $owner -ne $currentSid) { exit 21 }
if ($check -ne 'private' -and -not $allowed.Contains($owner)) { exit 21 }
$dangerous = [int64]([Security.AccessControl.FileSystemRights]::CreateFiles -bor
  [Security.AccessControl.FileSystemRights]::CreateDirectories -bor
  [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
  [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
  [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [Security.AccessControl.FileSystemRights]::Delete -bor
  [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [Security.AccessControl.FileSystemRights]::TakeOwnership)
$replaceChild = [int64]([Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [Security.AccessControl.FileSystemRights]::Delete -bor
  [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [Security.AccessControl.FileSystemRights]::TakeOwnership)
$mask = if ($check -eq 'ancestor') { $replaceChild } else { $dangerous }
$rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
foreach ($rule in $rules) {
  if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
  if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
  $sid = $rule.IdentityReference.Value
  if ($allowed.Contains($sid)) { continue }
  if (([int64]$rule.FileSystemRights -band $mask) -ne 0) { exit 22 }
}
exit 0
`;

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
    if (!isAbsolute(configured) || configured.split("").some((value) => value.charCodeAt(0) < 32))
      throw new Error("CLAWSWEEPER_REVIEW_TOOLS_DIR must be a safe absolute path.");
    return resolve(configured);
  }
  return join(homedir(), ".clawsweeper-review-tools");
}

function pathChain(path: string): string[] {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const tail = relative(root, absolute);
  const chain = [root];
  let current = root;
  for (const segment of tail.split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    chain.push(current);
  }
  return chain;
}

function canonicalCacheRoot(root: string): string {
  const tail: string[] = [basename(root)];
  let current = dirname(root);
  for (;;) {
    try {
      return resolve(realpathSync(current), ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current)
        throw new Error("Trusted scanner cache authority could not be verified.", { cause: error });
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

function assertWindowsCacheAuthority(path: string, check: "private" | "parent" | "ancestor"): void {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot))
    throw new Error("Trusted scanner cache authority could not be verified.");
  const canonicalSystemRoot = realpathSync(systemRoot);
  const powershell = realpathSync(
    join(canonicalSystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  );
  const executableRelative = relative(canonicalSystemRoot, powershell);
  const executableStat = lstatSync(powershell);
  if (
    !executableStat.isFile() ||
    executableStat.isSymbolicLink() ||
    executableRelative.startsWith("..") ||
    isAbsolute(executableRelative)
  )
    throw new Error("Trusted scanner cache authority could not be verified.");
  const result = spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_CACHE_AUTHORITY_SCRIPT],
    {
      encoding: "utf8",
      env: {
        SystemRoot: canonicalSystemRoot,
        CLAWSWEEPER_CACHE_AUTHORITY_PATH: path,
        CLAWSWEEPER_CACHE_AUTHORITY_CHECK: check,
      },
      timeout: 30_000,
      maxBuffer: 4096,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error("Trusted scanner cache is not private to the current user.");
}

function currentPosixUid(): number {
  if (typeof process.getuid !== "function")
    throw new Error("Trusted scanner cache authority could not be verified.");
  return process.getuid();
}

export function darwinAclAllowsUnsafeWriter(output: string, currentUser: string): boolean {
  const lines = output.split(/\r?\n/);
  const aclMarked = /^\S*\+/.test(lines[0] ?? "");
  let sawAclEntry = false;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const match = /^\s*\d+:\s+(.+?)\s+(allow|deny)\s+(.+)$/.exec(line);
    if (!match) return true;
    sawAclEntry = true;
    if (match[2] === "deny") continue;
    const principal = match[1]!.trim().split(/\s+/)[0]!.toLowerCase();
    if (
      new Set([`user:${currentUser.toLowerCase()}`, "user:root", "group:admin", "group:wheel"]).has(
        principal,
      )
    )
      continue;
    const permissions = match[3]!
      .toLowerCase()
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (permissions.some((permission) => !DARWIN_SAFE_ACL_PERMISSIONS.has(permission))) return true;
  }
  return aclMarked && !sawAclEntry;
}

function assertDarwinCacheAuthority(path: string): void {
  const ls = "/bin/ls";
  const id = "/usr/bin/id";
  for (const executable of [ls, id]) {
    const stat = lstatSync(executable);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Trusted scanner cache authority could not be verified.");
  }
  const options = {
    encoding: "utf8" as const,
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  };
  const identity = spawnSync(id, ["-un"], options);
  const currentUser = identity.stdout.trim();
  if (identity.error || identity.status !== 0 || !currentUser || /[\r\n:]/.test(currentUser))
    throw new Error("Trusted scanner cache authority could not be verified.");
  const acl = spawnSync(ls, ["-lde", path], options);
  if (acl.error || acl.status !== 0 || darwinAclAllowsUnsafeWriter(acl.stdout, currentUser))
    throw new Error("Trusted scanner cache is not private to the current user.");
}

function assertPrivateCacheEntry(path: string, kind: "directory" | "file"): void {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (kind === "directory" ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
  )
    throw new Error(`Trusted scanner cache has an unsafe ${kind} entry.`);
  if (platform === "win32") {
    assertWindowsCacheAuthority(path, "private");
    return;
  }
  if (stat.uid !== currentPosixUid() || (stat.mode & PRIVATE_CACHE_MODE) !== 0)
    throw new Error("Trusted scanner cache is not private to the current user.");
  if (platform === "darwin") assertDarwinCacheAuthority(path);
}

function assertCacheAncestor(path: string, check: "parent" | "ancestor"): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Trusted scanner cache has an unsafe directory ancestor.");
  if (platform === "win32") {
    assertWindowsCacheAuthority(path, check);
    return;
  }
  if (posixCacheAncestorIsUnsafe(stat.uid, currentPosixUid(), stat.mode))
    throw new Error("Trusted scanner cache has an unsafe directory ancestor.");
  if (platform === "darwin") assertDarwinCacheAuthority(path);
}

export function posixCacheAncestorIsUnsafe(
  ownerUid: number,
  currentUid: number,
  mode: number,
): boolean {
  const trustedOwner = ownerUid === 0 || ownerUid === currentUid;
  const writableByOtherPrincipal = (mode & 0o022) !== 0;
  const replacementProtected = (mode & 0o1000) !== 0;
  return !trustedOwner || (writableByOtherPrincipal && !replacementProtected);
}

function ensurePrivateCacheRoot(root: string): string {
  root = canonicalCacheRoot(root);
  const chain = pathChain(root);
  let existing = chain.length - 1;
  for (let index = 0; index < chain.length; index += 1) {
    try {
      const stat = lstatSync(chain[index]!);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Trusted scanner cache has an unsafe directory ancestor.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existing = index - 1;
      break;
    }
  }
  if (existing < 0) throw new Error("Trusted scanner cache authority could not be verified.");
  if (existing === chain.length - 1) {
    assertPrivateCacheEntry(root, "directory");
    for (let index = existing - 1; index >= 0; index -= 1)
      assertCacheAncestor(chain[index]!, "ancestor");
    return root;
  }
  assertCacheAncestor(chain[existing]!, "parent");
  for (let index = existing - 1; index >= 0; index -= 1)
    assertCacheAncestor(chain[index]!, "ancestor");
  for (let index = existing + 1; index < chain.length; index += 1) {
    const path = chain[index]!;
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    assertPrivateCacheEntry(path, "directory");
  }
  return root;
}

function validCachedArchive(path: string, expectedHash: string): boolean {
  try {
    assertPrivateCacheEntry(path, "file");
    const stat = lstatSync(path);
    if (stat.size <= 0 || stat.size > MAX_ARCHIVE_BYTES) return false;
    return sha256(readFileSync(path)) === expectedHash;
  } catch {
    return false;
  }
}

function cachedBinaryMatches(path: string, expected: Buffer): boolean {
  try {
    assertPrivateCacheEntry(path, "file");
    return readFileSync(path).equals(expected);
  } catch {
    return false;
  }
}

function ensureManagedCacheDirectory(root: string, segments: readonly string[]): string {
  let current = ensurePrivateCacheRoot(root);
  for (const segment of segments) {
    current = join(current, segment);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    assertPrivateCacheEntry(current, "directory");
  }
  return current;
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
  const cacheDir = ensureManagedCacheDirectory(root, [
    "trufflehog",
    `v${TRUFFLEHOG_VERSION}`,
    artifact.platform,
  ]);
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
