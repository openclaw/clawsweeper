import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { JsonValue, LooseRecord } from "./json-types.js";
import {
  packageScriptRequirement,
  type PackageScriptRequirement,
} from "./validation-command-utils.js";

export type WorkspacePackageManifest = {
  name: string | null;
  relativeDir: string;
  scriptCommands: ReadonlyMap<string, string>;
  scripts: ReadonlySet<string>;
};

export type WorkspaceScanLimits = {
  maxDirectories: number;
  maxDepth: number;
  maxEntries: number;
  maxMatchOperations: number;
  timeoutMs: number;
};

export type WorkspaceSelectorLimits = {
  maxMatchOperations: number;
  timeoutMs: number;
};

const MAX_WORKSPACE_PATTERNS = 256;
const MAX_WORKSPACE_PATTERN_LENGTH = 1_024;
const MAX_WORKSPACE_PATTERN_OPERATORS = 128;
export const MAX_WORKSPACE_PATH_LENGTH = 4_096;
const MAX_WORKSPACE_METADATA_BYTES = 1024 * 1024;
const DEFAULT_WORKSPACE_SCAN_LIMITS: WorkspaceScanLimits = {
  maxDirectories: 10_000,
  maxDepth: 64,
  maxEntries: 100_000,
  maxMatchOperations: 100_000,
  timeoutMs: 2_000,
};
const MAX_WORKSPACE_SELECTORS = 256;
const DEFAULT_WORKSPACE_SELECTOR_LIMITS: WorkspaceSelectorLimits = {
  maxMatchOperations: 100_000,
  timeoutMs: 2_000,
};

export function targetPackageScriptIsAvailable(
  cwd: string,
  rootScripts: ReadonlySet<string>,
  requirement: PackageScriptRequirement,
) {
  if (!requirement.workspaceScoped) return rootScripts.has(requirement.name);
  const manifests = readWorkspacePackageManifests(cwd, requirement.packageManager);
  if (manifests === null) return false;
  const selected = selectWorkspacePackageManifests(
    manifests,
    requirement.workspaceSelectors,
    requirement.workspaceAll,
  );
  if (selected === null) {
    return (
      requirement.packageManager === "pnpm" &&
      hasDeferredPnpmWorkspaceSelector(requirement.workspaceSelectors) &&
      manifests.some(
        (manifest) => manifest.relativeDir !== "." && manifest.scripts.has(requirement.name),
      )
    );
  }
  if (selected.length === 0) {
    return (
      requirement.packageManager === "pnpm" &&
      !requirement.workspaceAll &&
      fs.existsSync(path.join(cwd, "pnpm-workspace.yaml"))
    );
  }
  if (requirement.packageManager === "npm") {
    return selected.every((manifest) => manifest.scripts.has(requirement.name));
  }
  return selected.some((manifest) => manifest.scripts.has(requirement.name));
}

export function assertNoUnsafeBunLifecycleHooks(cwd: string, parts: readonly string[]) {
  const requirement = packageScriptRequirement(parts);
  const inspection = requirement
    ? unsafeBunLifecycleHook(cwd, requirement)
    : { status: "safe" as const };
  if (inspection.status === "unsafe") {
    throw new Error(
      `unsafe validation command: Bun would execute ${inspection.hook} around ${inspection.command}`,
    );
  }
  if (inspection.status === "inconclusive") {
    throw new Error(
      `unsafe validation command: Bun lifecycle hook inspection was inconclusive for ${inspection.command}: ${inspection.reason}`,
    );
  }
}

export function unsafeBunLifecycleHook(
  cwd: string,
  requirement: PackageScriptRequirement,
):
  | { status: "safe" }
  | { status: "unsafe"; command: string; hook: string }
  | { status: "inconclusive"; command: string; reason: string } {
  if (requirement.packageManager !== "bun") return { status: "safe" };
  const command = requirement.command;
  const manifests = readWorkspacePackageManifests(cwd, requirement.packageManager);
  if (manifests === null) {
    return { status: "inconclusive", command, reason: "workspace metadata or traversal failed" };
  }
  const selected = requirement.workspaceScoped
    ? selectWorkspacePackageManifests(
        manifests,
        requirement.workspaceSelectors,
        requirement.workspaceAll,
      )
    : manifests.filter((manifest) => manifest.relativeDir === ".");
  if (selected === null) {
    return { status: "inconclusive", command, reason: "workspace selector could not be inspected" };
  }
  if (!requirement.workspaceScoped && selected.length !== 1) {
    return { status: "inconclusive", command, reason: "root manifest could not be selected" };
  }
  for (const manifest of selected) {
    for (const hook of [`pre${requirement.name}`, `post${requirement.name}`]) {
      if (manifest.scripts.has(hook)) {
        return { status: "unsafe", command, hook };
      }
    }
  }
  return { status: "safe" };
}

export function readWorkspacePackageManifests(
  cwd: string,
  packageManager: JsonValue,
): WorkspacePackageManifest[] | null {
  const deadlineAt = Date.now() + DEFAULT_WORKSPACE_SCAN_LIMITS.timeoutMs;
  const rootManifest = readWorkspacePackageManifest(cwd, "package.json", deadlineAt);
  const patterns = readWorkspacePatterns(cwd, packageManager, deadlineAt);
  if (!rootManifest || patterns === null) return null;
  let workspacePaths: string[];
  try {
    workspacePaths = workspacePackagePaths(cwd, patterns, {
      timeoutMs: Math.max(1, deadlineAt - Date.now()),
    });
  } catch {
    return null;
  }
  const manifests: WorkspacePackageManifest[] = [];
  for (const workspacePath of workspacePaths) {
    try {
      assertWorkspaceDeadline(deadlineAt, "manifest reading");
    } catch {
      return null;
    }
    const manifestPath = path.posix.join(workspacePath, "package.json");
    const manifest = readWorkspacePackageManifest(cwd, manifestPath, deadlineAt);
    if (!manifest) return null;
    manifests.push(manifest);
  }
  manifests.unshift(rootManifest);
  return manifests;
}

export function readWorkspacePatterns(
  cwd: string,
  packageManager: JsonValue,
  deadlineAt: number,
): string[] | null {
  if (packageManager === "pnpm") {
    const workspacePath = path.join(cwd, "pnpm-workspace.yaml");
    if (!fs.existsSync(workspacePath)) return [];
    try {
      const workspace = parseYaml(
        readWorkspaceMetadataText(workspacePath, deadlineAt),
      ) as LooseRecord;
      if (workspace?.packages === undefined) return [];
      if (!Array.isArray(workspace.packages)) return null;
      if (workspace.packages.some((value: JsonValue) => typeof value !== "string")) return null;
      return workspace.packages;
    } catch {
      return null;
    }
  }
  try {
    const pkg = JSON.parse(
      readWorkspaceMetadataText(path.join(cwd, "package.json"), deadlineAt),
    ) as LooseRecord;
    const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
    return Array.isArray(workspaces)
      ? workspaces.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return null;
  }
}

export function workspacePackagePaths(
  cwd: string,
  patterns: readonly string[],
  overrides: Partial<WorkspaceScanLimits> = {},
) {
  if (patterns.length === 0) return [];
  if (patterns.length > MAX_WORKSPACE_PATTERNS) {
    throw new Error("workspace pattern count exceeds the supported budget");
  }
  const limits = workspaceScanLimits(overrides);
  const includedPatterns = patterns
    .filter((pattern) => !pattern.startsWith("!"))
    .map(normalizeWorkspacePattern);
  const excludedPatterns = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => normalizeWorkspacePattern(pattern.slice(1)));
  if (includedPatterns.length === 0) return [];

  const deadlineAt = Date.now() + limits.timeoutMs;
  const matches: string[] = [];
  const pending = [{ directory: cwd, relativeDirectory: "", depth: 0 }];
  let visitedDirectories = 0;
  let visitedEntries = 0;
  let matchOperations = 0;
  const matchesPattern = (relativePath: string, candidates: readonly string[]) =>
    candidates.some((pattern) => {
      assertWorkspaceDeadline(deadlineAt, "glob evaluation");
      matchOperations += 1;
      if (matchOperations > limits.maxMatchOperations) {
        throw new Error("workspace glob evaluation exceeded the supported work budget");
      }
      return workspacePatternMatches(pattern, relativePath);
    });

  while (pending.length > 0) {
    assertWorkspaceDeadline(deadlineAt, "discovery");
    const { directory, relativeDirectory, depth } = pending.pop()!;
    const handle = fs.opendirSync(directory);
    try {
      let entry: fs.Dirent | null;
      while ((entry = handle.readSync()) !== null) {
        assertWorkspaceDeadline(deadlineAt, "discovery");
        visitedEntries += 1;
        if (visitedEntries > limits.maxEntries) {
          throw new Error("workspace discovery exceeded the supported entry budget");
        }
        if (
          !entry.isDirectory() ||
          [".git", ".hg", ".svn", ".venv", "node_modules", "venv"].includes(entry.name)
        ) {
          continue;
        }
        const relativePath = relativeDirectory
          ? path.posix.join(relativeDirectory, entry.name)
          : entry.name;
        validateWorkspacePath(relativePath);
        const childDepth = depth + 1;
        if (childDepth > limits.maxDepth) {
          throw new Error("workspace discovery exceeded the supported depth budget");
        }
        visitedDirectories += 1;
        if (visitedDirectories > limits.maxDirectories) {
          throw new Error("workspace discovery exceeded the supported directory budget");
        }
        const absolutePath = path.join(directory, entry.name);
        if (
          fs.existsSync(path.join(absolutePath, "package.json")) &&
          matchesPattern(relativePath, includedPatterns) &&
          !matchesPattern(relativePath, excludedPatterns)
        ) {
          matches.push(relativePath);
        }
        pending.push({
          directory: absolutePath,
          relativeDirectory: relativePath,
          depth: childDepth,
        });
      }
    } finally {
      handle.closeSync();
    }
  }
  return [...new Set(matches)].sort();
}

export function workspacePatternMatches(pattern: string, relativePath: string) {
  const boundedPattern = normalizeWorkspacePattern(pattern);
  validateWorkspacePath(relativePath);
  try {
    return path.posix.matchesGlob(relativePath, boundedPattern);
  } catch {
    throw new Error("workspace pattern is not a valid supported glob");
  }
}

function normalizeWorkspacePattern(pattern: string) {
  const normalized = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  if (
    !normalized ||
    normalized.length > MAX_WORKSPACE_PATTERN_LENGTH ||
    path.isAbsolute(normalized) ||
    normalized.split("/").includes("..") ||
    normalized.includes(String.fromCharCode(0)) ||
    /[\r\n\\]/.test(normalized)
  ) {
    throw new Error("workspace pattern is outside the supported bounds");
  }
  const operators = [...normalized].filter((character) => "*?[]{}(),".includes(character)).length;
  if (operators > MAX_WORKSPACE_PATTERN_OPERATORS) {
    throw new Error("workspace pattern exceeds the supported operator budget");
  }
  return normalized;
}

function validateWorkspacePath(relativePath: string) {
  if (relativePath.length > MAX_WORKSPACE_PATH_LENGTH) {
    throw new Error("workspace path exceeds the maximum supported length");
  }
}

function workspaceScanLimits(overrides: Partial<WorkspaceScanLimits>) {
  const limits = { ...DEFAULT_WORKSPACE_SCAN_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`workspace ${name} must be a positive integer`);
    }
  }
  return limits;
}

export function assertWorkspaceDeadline(deadlineAt: number, operation: string) {
  if (Date.now() >= deadlineAt) {
    throw new Error(`workspace ${operation} exceeded the supported deadline`);
  }
}

function readWorkspacePackageManifest(
  cwd: string,
  relativePath: string,
  deadlineAt: number,
): WorkspacePackageManifest | null {
  const absolutePath = path.resolve(cwd, relativePath);
  if (!absolutePath.startsWith(`${path.resolve(cwd)}${path.sep}`)) return null;
  try {
    const realPath = fs.realpathSync(absolutePath);
    if (!realPath.startsWith(`${fs.realpathSync(cwd)}${path.sep}`)) return null;
    const pkg = JSON.parse(readWorkspaceMetadataText(absolutePath, deadlineAt)) as LooseRecord;
    const scriptCommands =
      pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)
        ? new Map(
            Object.entries(pkg.scripts)
              .filter((entry): entry is [string, string] => typeof entry[1] === "string")
              .map(([name, command]) => [name, command]),
          )
        : new Map<string, string>();
    const scripts =
      pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)
        ? Object.keys(pkg.scripts)
        : [];
    return {
      name: typeof pkg.name === "string" ? pkg.name : null,
      relativeDir: path.posix.dirname(relativePath.split(path.sep).join("/")),
      scriptCommands,
      scripts: new Set(scripts),
    };
  } catch {
    return null;
  }
}

function readWorkspaceMetadataText(filePath: string, deadlineAt: number) {
  assertWorkspaceDeadline(deadlineAt, "metadata reading");
  const file = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fs.fstatSync(file);
    if (!stat.isFile()) throw new Error("workspace metadata must be a regular file");
    if (stat.size > MAX_WORKSPACE_METADATA_BYTES) {
      throw new Error("workspace metadata exceeds the supported size budget");
    }
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      assertWorkspaceDeadline(deadlineAt, "metadata reading");
      const bytesRead = fs.readSync(file, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_WORKSPACE_METADATA_BYTES) {
        throw new Error("workspace metadata exceeds the supported size budget");
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    assertWorkspaceDeadline(deadlineAt, "metadata reading");
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    fs.closeSync(file);
  }
}

export function selectWorkspacePackageManifests(
  manifests: readonly WorkspacePackageManifest[],
  selectorsValue: JsonValue,
  workspaceAll: JsonValue,
  overrides: Partial<WorkspaceSelectorLimits> = {},
): WorkspacePackageManifest[] | null {
  const selectors = Array.isArray(selectorsValue)
    ? selectorsValue.filter((value): value is string => typeof value === "string")
    : [];
  const parsedSelectors = selectors.map((selector) =>
    parseSupportedWorkspaceSelector(selector.replace(/^!/, "")),
  );
  if (
    selectors.length > MAX_WORKSPACE_SELECTORS ||
    parsedSelectors.some((selector) => selector === null) ||
    parsedSelectors.some((selector) => selector?.deferred)
  ) {
    return null;
  }
  const limits = workspaceSelectorLimits(overrides);
  const budget = {
    deadlineAt: Date.now() + limits.timeoutMs,
    maxOperations: limits.maxMatchOperations,
    operations: 0,
  };
  const workspaceManifests = manifests.filter((manifest) => manifest.relativeDir !== ".");
  if (selectors.length === 0) return workspaceAll ? workspaceManifests : [];
  const positiveSelectors = selectors.filter((selector) => !selector.startsWith("!"));
  const selected = new Set<WorkspacePackageManifest>(
    positiveSelectors.length === 0 ? workspaceManifests : [],
  );
  try {
    for (const selector of positiveSelectors) {
      const matches = manifests.filter((manifest) =>
        workspaceSelectorMatches(manifest, selector, budget),
      );
      for (const manifest of matches) selected.add(manifest);
    }
    for (const selector of selectors.filter((value) => value.startsWith("!"))) {
      const positive = selector.slice(1);
      for (const manifest of manifests) {
        if (workspaceSelectorMatches(manifest, positive, budget)) selected.delete(manifest);
      }
    }
  } catch {
    return null;
  }
  return [...selected];
}

function workspaceSelectorLimits(overrides: Partial<WorkspaceSelectorLimits>) {
  const limits = { ...DEFAULT_WORKSPACE_SELECTOR_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`workspace selector ${name} must be a positive integer`);
    }
  }
  return limits;
}

function parseSupportedWorkspaceSelector(selector: string) {
  if (
    !selector ||
    selector.length > MAX_WORKSPACE_PATTERN_LENGTH ||
    selector.includes("\0") ||
    selector.includes("....") ||
    [...selector].filter((character) => "*?{}[]".includes(character)).length >
      MAX_WORKSPACE_PATTERN_OPERATORS
  ) {
    return null;
  }
  let value = selector;
  let deferred = false;
  if (value.startsWith("...^")) {
    value = value.slice(4);
    deferred = true;
  } else if (value.startsWith("...")) {
    value = value.slice(3);
    deferred = true;
  }
  if (value.endsWith("^...")) {
    value = value.slice(0, -4);
    deferred = true;
  } else if (value.endsWith("...")) {
    value = value.slice(0, -3);
    deferred = true;
  }
  if (value.includes("...")) return null;
  const sinceOpen = value.indexOf("[");
  const sinceClose = value.indexOf("]");
  const hasSince = sinceOpen >= 0 || sinceClose >= 0;
  if (hasSince) {
    if (
      sinceOpen < 0 ||
      sinceClose <= sinceOpen ||
      sinceClose !== value.length - 1 ||
      value.indexOf("[", sinceOpen + 1) >= 0 ||
      value.indexOf("]", sinceClose + 1) >= 0
    ) {
      return null;
    }
    const since = value.slice(sinceOpen + 1, sinceClose);
    if (!/^[A-Za-z0-9_./@:+-]{1,256}$/.test(since)) return null;
    value = `${value.slice(0, sinceOpen)}${value.slice(sinceClose + 1)}`;
    deferred = true;
  }
  if (value.includes("[") || value.includes("]") || value.includes("^")) return null;
  if (!value && !hasSince) return null;
  const braces = value.match(/^(.*?)\{([^{}]+)\}$/);
  if ((value.includes("{") || value.includes("}")) && !braces) return null;
  return value || deferred
    ? {
        deferred,
        selector: value,
      }
    : null;
}

function workspaceSelectorMatches(
  manifest: WorkspacePackageManifest,
  selector: string,
  budget: { deadlineAt: number; maxOperations: number; operations: number },
) {
  const parsed = parseSupportedWorkspaceSelector(selector);
  if (!parsed || parsed.deferred) return false;
  selector = parsed.selector;
  assertWorkspaceDeadline(budget.deadlineAt, "selector evaluation");
  budget.operations += 1;
  if (budget.operations > budget.maxOperations) {
    throw new Error("workspace selector evaluation exceeded the supported work budget");
  }
  const combinedSelector = selector.match(/^(.*?)\{([^{}]+)\}$/);
  if (combinedSelector) {
    const nameSelector = combinedSelector[1] ?? "";
    const pathSelector = combinedSelector[2]!;
    return (
      (!nameSelector ||
        Boolean(manifest.name && workspaceGlobMatches(manifest.name, nameSelector))) &&
      workspaceGlobMatches(manifest.relativeDir, pathSelector)
    );
  }
  const pathSelector = selector.match(/^\{(.+)\}$/)?.[1] ?? null;
  if (pathSelector !== null || selector.startsWith("./")) {
    const pattern = (pathSelector ?? selector.slice(2)).replace(/\/+$/, "") || ".";
    return workspaceGlobMatches(manifest.relativeDir, pattern);
  }
  if (manifest.name && workspaceGlobMatches(manifest.name, selector)) return true;
  if (!selector.startsWith("@") && workspaceGlobMatches(manifest.relativeDir, selector))
    return true;
  return (
    Boolean(manifest.name) &&
    !selector.includes("/") &&
    !selector.includes("*") &&
    manifest.name!.endsWith(`/${selector}`)
  );
}

function hasDeferredPnpmWorkspaceSelector(selectorsValue: JsonValue) {
  if (!Array.isArray(selectorsValue)) return false;
  const selectors = selectorsValue.filter((value): value is string => typeof value === "string");
  return (
    selectors.length > 0 &&
    selectors.every((selector) => parseSupportedWorkspaceSelector(selector.replace(/^!/, ""))) &&
    selectors.some(
      (selector) => parseSupportedWorkspaceSelector(selector.replace(/^!/, ""))?.deferred,
    )
  );
}

function workspaceGlobMatches(value: string, pattern: string) {
  try {
    return path.posix.matchesGlob(value, pattern);
  } catch {
    return false;
  }
}
