import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeRepo } from "../repository-profiles.js";
import { repoRoot } from "./paths.js";

export type TargetPackageManager = "pnpm" | "bun" | "npm";

export interface TargetChangedGate {
  /** Full command string the gate should resolve to, e.g. "pnpm check:changed". */
  command: string;
  /** package.json#scripts key the command shells out to, e.g. "check:changed". */
  requiredScript: string;
}

export interface TargetRepoToolchain {
  packageManager: TargetPackageManager;
  /** Base validation commands to always include before fixArtifact-supplied ones. */
  baseValidationCommands: readonly string[];
  /** Optional incremental gate (e.g. OpenClaw's pnpm check:changed). */
  changedGate: TargetChangedGate | null;
  /** Exact, repository-owned proof contracts. Arbitrary test commands are never inferred redundant. */
  proofSubsumptions?: readonly TargetProofSubsumption[];
}

export interface TargetProofSubsumption {
  command: string;
  subsumes: readonly string[];
}

interface ToolchainConfigEntry {
  package_manager?: unknown;
  validation_commands?: unknown;
  changed_gate?: unknown;
  proof_subsumptions?: unknown;
}

const SUPPORTED_PACKAGE_MANAGERS: ReadonlySet<TargetPackageManager> = new Set([
  "pnpm",
  "bun",
  "npm",
]);

const DEFAULT_TOOLCHAIN: TargetRepoToolchain = {
  packageManager: "pnpm",
  baseValidationCommands: [],
  changedGate: null,
};

const OPENCLAW_OPENCLAW_FALLBACK_TOOLCHAIN: TargetRepoToolchain = {
  packageManager: "pnpm",
  baseValidationCommands: [],
  changedGate: { command: "pnpm check:changed", requiredScript: "check:changed" },
};

interface ResolvedToolchainTable {
  byRepo: Map<string, TargetRepoToolchain>;
  byOwner: Map<string, TargetRepoToolchain>;
}

let cached: ResolvedToolchainTable | null = null;
let cachedFilePath: string | null = null;

export function resolveTargetRepoToolchain(
  targetRepo: string,
  filePath: string = defaultConfigPath(),
): TargetRepoToolchain {
  const table = loadTable(filePath);
  const normalized = normalizeRepo(targetRepo);
  const explicit = table.byRepo.get(normalized);
  if (explicit) return explicit;

  // Hard safety net for the OpenClaw monorepo MUST be checked before the
  // owner-level fallback. Otherwise removing `core_target_overrides.openclaw/openclaw`
  // while keeping the generic `openclaw` fallback (which carries `changed_gate: null`)
  // would silently drop the `pnpm check:changed` gate for the core repo.
  if (normalized === "openclaw/openclaw") return OPENCLAW_OPENCLAW_FALLBACK_TOOLCHAIN;

  const [owner] = normalized.split("/");
  const ownerFallback = owner ? table.byOwner.get(owner) : undefined;
  if (ownerFallback) return ownerFallback;

  return DEFAULT_TOOLCHAIN;
}

/** Test-only: drop the in-memory cache so a fresh config can be observed. */
export function __resetTargetRepoToolchainCache(): void {
  cached = null;
  cachedFilePath = null;
  warnedMessages.clear();
}

function loadTable(filePath: string): ResolvedToolchainTable {
  if (cached && cachedFilePath === filePath) return cached;
  // Resolver MUST be a total function: any unexpected I/O or parse error here
  // would otherwise propagate up through requiredValidationCommands /
  // prepareTargetToolchain and block automerge across ALL target repositories.
  // Fall back to an empty table (≡ DEFAULT_TOOLCHAIN for every repo, plus the
  // openclaw/openclaw hard safety net) so a transient FS race or unexpected
  // schema can never globally brick the repair pipeline.
  let table: ResolvedToolchainTable;
  try {
    table = readToolchainTable(filePath);
  } catch (error) {
    warnOnce(
      `failed to load ${filePath}, falling back to default toolchain: ${formatError(error)}`,
    );
    table = { byRepo: new Map(), byOwner: new Map() };
  }
  cached = table;
  cachedFilePath = filePath;
  return table;
}

function readToolchainTable(filePath: string): ResolvedToolchainTable {
  const byRepo = new Map<string, TargetRepoToolchain>();
  const byOwner = new Map<string, TargetRepoToolchain>();

  if (!existsSync(filePath)) {
    return { byRepo, byOwner };
  }

  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));

  if (!isObject(parsed)) return { byRepo, byOwner };

  const repositories = arrayValue(parsed.repositories);
  for (const entry of repositories) {
    if (!isObject(entry)) continue;
    const repo = stringOrEmpty(entry.target_repo);
    if (!repo) continue;
    const toolchain = parseToolchainEntry(entry, DEFAULT_TOOLCHAIN);
    byRepo.set(normalizeRepo(repo), toolchain);
  }

  const fallbacks = arrayValue(parsed.generic_fallbacks);
  for (const entry of fallbacks) {
    if (!isObject(entry)) continue;
    const owner = stringOrEmpty(entry.owner);
    if (!owner) continue;
    byOwner.set(owner.toLowerCase(), parseToolchainEntry(entry, DEFAULT_TOOLCHAIN));
  }

  if (isObject(parsed.core_target_overrides)) {
    for (const [repo, value] of Object.entries(parsed.core_target_overrides)) {
      if (!isObject(value)) continue;
      byRepo.set(normalizeRepo(repo), parseToolchainEntry(value, DEFAULT_TOOLCHAIN));
    }
  }

  return { byRepo, byOwner };
}

function parseToolchainEntry(
  entry: ToolchainConfigEntry,
  defaults: TargetRepoToolchain,
): TargetRepoToolchain {
  const packageManager = parsePackageManager(entry.package_manager) ?? defaults.packageManager;
  const baseValidationCommands = stringArray(entry.validation_commands);
  const changedGate = parseChangedGate(entry.changed_gate);
  return {
    packageManager,
    baseValidationCommands,
    changedGate,
    proofSubsumptions: parseProofSubsumptions(entry.proof_subsumptions),
  };
}

function parsePackageManager(value: unknown): TargetPackageManager | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    warnOnce(`package_manager must be a string, got ${typeof value}; ignoring`);
    return null;
  }
  const normalized = value.trim().toLowerCase() as TargetPackageManager;
  if (!SUPPORTED_PACKAGE_MANAGERS.has(normalized)) {
    warnOnce(
      `unsupported package_manager ${JSON.stringify(value)}, expected one of pnpm|bun|npm; ignoring`,
    );
    return null;
  }
  return normalized;
}

function parseChangedGate(value: unknown): TargetChangedGate | null {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) {
    warnOnce(`changed_gate must be an object or null, got ${typeof value}`);
    return null;
  }
  const command = stringOrEmpty(value.command);
  const requiredScript = stringOrEmpty(value.required_script);
  if (!command || !requiredScript) {
    warnOnce(`changed_gate is missing required fields (command, required_script); ignoring entry`);
    return null;
  }
  return { command, requiredScript };
}

function parseProofSubsumptions(value: unknown): readonly TargetProofSubsumption[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    warnOnce(`proof_subsumptions must be an array; ignoring entry`);
    return [];
  }
  const out: TargetProofSubsumption[] = [];
  for (const entry of value) {
    if (!isObject(entry)) {
      warnOnce(`proof_subsumptions entries must be objects; ignoring entry`);
      continue;
    }
    const command = stringOrEmpty(entry.command);
    const subsumes = stringArray(entry.subsumes);
    if (!command || subsumes.length === 0) {
      warnOnce(`proof_subsumptions entry requires command and non-empty subsumes`);
      continue;
    }
    out.push({ command, subsumes });
  }
  return out;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function defaultConfigPath(): string {
  return join(repoRoot(), "config", "target-repositories.json");
}

/** Tracks already-emitted warning strings so a misconfigured config does not flood stderr. */
const warnedMessages = new Set<string>();

function warnOnce(message: string): void {
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  // Use console.warn (stderr) so this surfaces in CI/worker logs without
  // affecting stdout-based artifacts that the worker emits.
  console.warn(`[clawsweeper] target-toolchain-config: ${message}`);
}

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** Test-only: clear the per-message warning suppression cache. */
export function __resetTargetRepoToolchainWarnings(): void {
  warnedMessages.clear();
}
