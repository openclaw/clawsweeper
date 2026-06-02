import fs from "node:fs";
import path from "node:path";

import { runCommand as run } from "./command-runner.js";
import {
  ensureMergeBaseAvailable,
  gitChangedFiles,
  gitLsFiles,
  isAncestor,
} from "./git-repo-utils.js";
import { parsePullRequestUrl } from "./github-ref.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import {
  resolveTargetRepoToolchain,
  type TargetChangedGate,
  type TargetRepoToolchain,
} from "./target-toolchain-config.js";
import { compactText } from "./text-utils.js";
import {
  isExpensivePnpmValidation,
  isTestFile,
  looksLikePathArgument,
  packageScriptRequirement,
  parseAllowedValidationCommand,
  stripEnvPrefix,
  uniqueStrings,
} from "./validation-command-utils.js";

const DEFAULT_BASE_BRANCH = "main";
const DEFAULT_TARGET_SETUP_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_TARGET_INSTALL_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_TARGET_VALIDATION_TIMEOUT_MS = 12 * 60 * 1000;

export type TargetValidationOptions = {
  additionalValidationCommands?: string[];
  allowExpensiveValidation: boolean;
  installTimeoutMs?: number;
  installTargetDeps: boolean;
  skipOpenClawChangedGate?: boolean;
  strictTargetValidation: boolean;
  targetRepo: string;
  setupTimeoutMs?: number;
  validationTimeoutMs?: number;
  /**
   * Optional override of the per-repo toolchain (package manager, base validation
   * commands, changed gate). If omitted, it is resolved from
   * config/target-repositories.json via `resolveTargetRepoToolchain(targetRepo)`.
   * Tests inject this directly to avoid touching the config file.
   */
  toolchain?: TargetRepoToolchain;
};

export type RepairDeltaValidationPlan = {
  commands: string[];
  options: TargetValidationOptions;
  scope: "changed-surface" | "repair-delta-docs";
  changed_files: string[];
  reason: string;
};

export function prepareTargetToolchain(cwd: string, options: TargetValidationOptions) {
  if (!options.installTargetDeps) return;
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) return;

  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const toolchain = getToolchain(options);
  const validationEnv = targetValidationEnv();
  const setupTimeoutMs = targetValidationTimeoutMs(
    "CLAWSWEEPER_TARGET_SETUP_TIMEOUT_MS",
    options.setupTimeoutMs ?? DEFAULT_TARGET_SETUP_TIMEOUT_MS,
    options.setupTimeoutMs,
  );
  const installTimeoutMs = targetValidationTimeoutMs(
    "CLAWSWEEPER_TARGET_INSTALL_TIMEOUT_MS",
    options.installTimeoutMs ?? DEFAULT_TARGET_INSTALL_TIMEOUT_MS,
    options.installTimeoutMs,
  );
  run(
    "node",
    [
      "-e",
      "const major = Number(process.versions.node.split('.')[0]); if (major < 22) { console.error(`Node ${process.version} is too old for target validation`); process.exit(1); }",
    ],
    { cwd, env: validationEnv, timeoutMs: setupTimeoutMs },
  );

  if (toolchain.packageManager === "bun") {
    prepareBunToolchain({ cwd, validationEnv, setupTimeoutMs, installTimeoutMs });
    return;
  }
  if (toolchain.packageManager === "npm") {
    prepareNpmToolchain({ cwd, validationEnv, installTimeoutMs });
    return;
  }
  preparePnpmToolchain({
    cwd,
    packageJson,
    validationEnv,
    setupTimeoutMs,
    installTimeoutMs,
  });
}

function preparePnpmToolchain({
  cwd,
  packageJson,
  validationEnv,
  setupTimeoutMs,
  installTimeoutMs,
}: {
  cwd: string;
  packageJson: LooseRecord;
  validationEnv: NodeJS.ProcessEnv;
  setupTimeoutMs: number;
  installTimeoutMs: number;
}) {
  const packageManager = String(packageJson.packageManager ?? "pnpm@10.33.0");
  if (!packageManager.startsWith("pnpm@")) {
    throw new Error(`unsupported target package manager: ${packageManager}`);
  }
  run("corepack", ["enable"], { cwd, env: validationEnv, timeoutMs: setupTimeoutMs });
  run("corepack", ["prepare", packageManager, "--activate"], {
    cwd,
    env: validationEnv,
    timeoutMs: setupTimeoutMs,
  });
  const installArgs = [
    "install",
    "--frozen-lockfile",
    "--prefer-offline",
    "--config.engine-strict=false",
    "--config.enable-pre-post-scripts=true",
  ];
  try {
    run("pnpm", installArgs, { cwd, env: validationEnv, timeoutMs: installTimeoutMs });
  } catch (error) {
    if (!/ERR_PNPM_OUTDATED_LOCKFILE/i.test(String(error.message))) throw error;
    run(
      "pnpm",
      installArgs.map((arg) => (arg === "--frozen-lockfile" ? "--no-frozen-lockfile" : arg)),
      {
        cwd,
        env: validationEnv,
        timeoutMs: installTimeoutMs,
      },
    );
    restoreTargetLockfile(cwd, "pnpm-lock.yaml");
  }
}

function prepareBunToolchain({
  cwd,
  validationEnv,
  setupTimeoutMs,
  installTimeoutMs,
}: {
  cwd: string;
  validationEnv: NodeJS.ProcessEnv;
  setupTimeoutMs: number;
  installTimeoutMs: number;
}) {
  // The repair execution workflow provisions pinned Bun before this path runs.
  // Keep a clear fail-fast probe so local/manual runners surface setup gaps early.
  //
  // ClawSweeper itself runs under pnpm (e.g. `pnpm run repair:execute-fix`), so
  // process.env carries pnpm-injected `npm_config_user_agent=pnpm/...`. When we
  // shell out to `bun install` for a target repo whose package.json has a
  // preinstall hook like `bunx only-allow bun` (e.g. openclaw/clawhub), bun
  // forwards the parent env to the preinstall script and `only-allow` reads the
  // pnpm user-agent and refuses to run. Strip caller identity/lifecycle metadata
  // from pnpm, but preserve npm-compatible install configuration such as
  // registry, auth, proxy, userconfig, and cache settings for the target repo.
  const bunEnv = sanitizeEnvForBun(validationEnv);
  run("bun", ["--version"], { cwd, env: bunEnv, timeoutMs: setupTimeoutMs });
  const installArgs = ["install", "--frozen-lockfile"];
  try {
    run("bun", installArgs, { cwd, env: bunEnv, timeoutMs: installTimeoutMs });
  } catch (error) {
    const message = String(error?.message ?? "");
    if (!/lockfile|frozen|out of date|out-of-date/i.test(message)) throw error;
    run("bun", ["install", "--no-frozen-lockfile"], {
      cwd,
      env: bunEnv,
      timeoutMs: installTimeoutMs,
    });
    for (const lockfile of ["bun.lock", "bun.lockb"]) {
      restoreTargetLockfile(cwd, lockfile);
    }
  }
}

function sanitizeEnvForBun(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (shouldStripBunInstallEnv(key)) continue;
    out[key] = value;
  }
  // Declare bun as the active package manager so target preinstall hooks
  // such as `bunx only-allow bun` recognise the caller.
  out.npm_config_user_agent = `bun/unknown npm/? node/${process.versions.node} ${process.platform} ${process.arch}`;
  return out;
}

function shouldStripBunInstallEnv(key: string): boolean {
  return (
    /^PNPM_/i.test(key) ||
    /^npm_config_user_agent$/i.test(key) ||
    /^npm_execpath$/i.test(key) ||
    /^npm_node_execpath$/i.test(key) ||
    /^npm_lifecycle_/i.test(key) ||
    /^npm_package_/i.test(key)
  );
}

function prepareNpmToolchain({
  cwd,
  validationEnv,
  installTimeoutMs,
}: {
  cwd: string;
  validationEnv: NodeJS.ProcessEnv;
  installTimeoutMs: number;
}) {
  const installArgs = fs.existsSync(path.join(cwd, "package-lock.json")) ? ["ci"] : ["install"];
  run("npm", installArgs, { cwd, env: validationEnv, timeoutMs: installTimeoutMs });
}

export function runAllowedValidationCommands(
  commands: LooseRecord[],
  cwd: string,
  options: TargetValidationOptions,
  baseBranch: string = DEFAULT_BASE_BRANCH,
) {
  ensureMergeBaseAvailable({ targetDir: cwd, baseBranch });
  const validationEnv = targetValidationEnv();
  const validationTimeoutMs = targetValidationTimeoutMs(
    "CLAWSWEEPER_TARGET_VALIDATION_TIMEOUT_MS",
    options.validationTimeoutMs ?? DEFAULT_TARGET_VALIDATION_TIMEOUT_MS,
    options.validationTimeoutMs,
  );
  const executed: string[] = [];
  const attempts = new Map<string, number>();
  for (const command of requiredValidationCommands(commands, cwd, options)) {
    const resolvedCommands = resolveAllowedValidationCommands(command, cwd, baseBranch, options);
    for (const parts of resolvedCommands) {
      const executable = parts[0]!;
      const rendered = parts.join(" ");
      if (executed.includes(rendered)) continue;
      while (true) {
        try {
          run(executable, parts.slice(1), {
            cwd,
            env: validationEnv,
            timeoutMs: validationTimeoutMs,
          });
          executed.push(rendered);
          break;
        } catch (error) {
          const fallbackCommands = validationFallbackCommands({
            parts,
            error,
            cwd,
            baseBranch,
            options,
          });
          if (fallbackCommands.length > 0) {
            for (const fallbackParts of fallbackCommands) {
              const fallbackExecutable = fallbackParts[0]!;
              const fallbackRendered = fallbackParts.join(" ");
              if (executed.includes(fallbackRendered)) continue;
              run(fallbackExecutable, fallbackParts.slice(1), {
                cwd,
                env: validationEnv,
                timeoutMs: validationTimeoutMs,
              });
              executed.push(fallbackRendered);
            }
            break;
          }
          if (shouldRetryValidationCommand({ parts, error, attempts, options })) continue;
          throw new Error(
            `validation command failed (${parts.join(" ")}): ${compactText(error.message, 12000)}`,
          );
        }
      }
    }
  }
  return executed;
}

export function preflightTargetValidationPlan(
  { fixArtifact, targetDir, baseBranch = DEFAULT_BASE_BRANCH }: LooseRecord,
  options: TargetValidationOptions,
) {
  const scripts = readPackageScriptSet(targetDir);
  const availableScripts = [...scripts].sort();
  const resolved: string[] = [];
  const requiredScripts: LooseRecord[] = [];
  for (const command of requiredValidationCommands(
    fixArtifact.validation_commands ?? [],
    targetDir,
    options,
  )) {
    const resolvedCommands = resolveAllowedValidationCommands(
      command,
      targetDir,
      baseBranch,
      options,
    );
    for (const parts of resolvedCommands) {
      const rendered = parts.join(" ");
      if (!resolved.includes(rendered)) resolved.push(rendered);
      const script = packageScriptRequirement(parts);
      if (script) requiredScripts.push(script);
    }
  }

  const missing = requiredScripts.find((script: JsonValue) => !scripts.has(script.name));
  if (!missing) {
    return {
      status: "passed",
      resolved_commands: resolved,
      available_scripts: availableScripts,
    };
  }

  const sourcePr =
    (fixArtifact.source_prs ?? []).find(
      (source: JsonValue) => parsePullRequestUrl(source)?.repo === options.targetRepo,
    ) ?? null;
  return {
    status: "blocked",
    code: "validation_script_missing",
    required: missing.command,
    missing_script: missing.name,
    available_scripts: availableScripts,
    target_branch: fixArtifact.branch ?? fixArtifact.head_branch ?? null,
    source_pr: sourcePr,
    resolved_commands: resolved,
    reason: `validation_script_missing: required ${missing.command} is unavailable in target checkout`,
  };
}

export function requiredValidationCommands(
  commands: LooseRecord[] | undefined,
  cwd: string,
  options: TargetValidationOptions,
) {
  const toolchain = getToolchain(options);
  const replacementCommands = [
    ...(options.additionalValidationCommands ?? []),
    ...toolchain.baseValidationCommands,
  ];
  const sanitized = sanitizeStaleChangedGateCommands(
    commands ?? [],
    toolchain,
    replacementCommands,
  );
  const out = [...sanitized, ...replacementCommands];
  const gate = toolchain.changedGate;
  if (gate && !options.skipOpenClawChangedGate && requiresChangedGate(cwd, toolchain)) {
    out.push(gate.command);
  }
  return uniqueStrings(out);
}

/**
 * Drop validation commands that look like "some other repo's changed gate"
 * when the current target repo does not have one. This protects against stale
 * fixArtifacts (most notably deterministic automerge artifacts authored before
 * per-repo toolchain config landed) that ship `pnpm check:changed` even when
 * the target is bun-based and has no `check:changed` script. Without this
 * guard preflight terminates with `validation_script_missing` and the
 * executor never tries the project's real validation command.
 *
 * We are deliberately conservative: we only drop commands that match the
 * fingerprint of a known changed-gate command and only when the active
 * toolchain has no gate of its own. Other unrelated commands are passed
 * through untouched so `validation_script_missing` still fires for genuinely
 * missing scripts (e.g. a typo'd `pnpm test:repair-typo`).
 */
function sanitizeStaleChangedGateCommands(
  commands: readonly LooseRecord[],
  toolchain: TargetRepoToolchain,
  replacementCommands: readonly string[],
): LooseRecord[] {
  if (toolchain.changedGate) return [...commands];
  if (replacementCommands.length === 0) return [...commands];
  return commands.filter((command) => !looksLikeStaleChangedGateCommand(command));
}

function looksLikeStaleChangedGateCommand(command: LooseRecord): boolean {
  const text = String(command ?? "").trim();
  if (!text) return false;
  // Matches the canonical openclaw/openclaw changed gate verbatim, with or
  // without a leading `env` wrapper. Kept narrow on purpose so we only
  // discard things we are confident are the stale gate.
  return /^(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?pnpm\s+(?:-s\s+|--silent\s+)?(?:run\s+)?check:changed$/.test(
    text,
  );
}

export function repairDeltaValidationPlan(
  { fixArtifact, targetDir, sourceHead }: LooseRecord,
  options: TargetValidationOptions,
): RepairDeltaValidationPlan {
  const commands = fixArtifact.validation_commands ?? [];
  const changedSurface = {
    commands,
    options,
    scope: "changed-surface" as const,
    changed_files: [],
    reason: "validate the full changed surface against the target base branch",
  };
  if (options.targetRepo !== "openclaw/openclaw") return changedSurface;
  if (fixArtifact.repair_strategy !== "repair_contributor_branch") return changedSurface;
  const sourceRef = String(sourceHead ?? "");
  if (!/^[0-9a-f]{40}$/i.test(sourceRef)) return changedSurface;
  if (!isAncestor({ targetDir, ancestor: sourceRef, descendant: "HEAD" })) return changedSurface;

  const changedFiles = changedFilesSinceRef(targetDir, sourceRef);
  if (changedFiles.length === 0 || !changedFiles.every(isDocsOnlyRepairDeltaFile)) {
    return { ...changedSurface, changed_files: changedFiles };
  }

  return {
    commands: [`git diff --check ${sourceRef}..HEAD`],
    options: { ...options, skipOpenClawChangedGate: true },
    scope: "repair-delta-docs",
    changed_files: changedFiles,
    reason:
      "adopted PR repair changed only docs/changelog files since the source head; validate the repair delta and let PR checks gate the existing source diff",
  };
}

export function canSkipInternalCodexReviewForRepairDelta(plan: LooseRecord) {
  return String(plan?.scope ?? "") === "repair-delta-docs";
}

function restoreTargetLockfile(cwd: string, lockfile: string) {
  if (!fs.existsSync(path.join(cwd, lockfile))) return;
  run("git", ["checkout", "--", lockfile], { cwd });
}

function validationFallbackCommands({ parts, error, cwd, baseBranch, options }: LooseRecord) {
  if (options.strictTargetValidation) return [];
  if (!isChangedGateCommand(parts, options)) return [];
  if (/no merge base/i.test(String(error?.message ?? ""))) {
    ensureMergeBaseAvailable({ targetDir: cwd, baseBranch });
    return [parts];
  }
  if (!isChangedGateStall(error)) return [];
  const changedTests = changedTestFiles(cwd, baseBranch);
  return [
    ["git", "diff", "--check", `origin/${baseBranch}...HEAD`],
    ...(changedTests.length > 0 ? [["pnpm", "test:serial", ...changedTests]] : []),
  ];
}

function isChangedGateStall(error: JsonValue) {
  return /no output for \d+ms|terminating stalled Vitest|stalled Vitest process/i.test(
    String(error?.message ?? ""),
  );
}

function shouldRetryValidationCommand({ parts, error, attempts, options }: LooseRecord) {
  if (options.strictTargetValidation) return false;
  if (!isChangedGateCommand(parts, options)) return false;
  if (isChangedGateStall(error)) return false;

  const configuredRetries = Number.parseInt(process.env.CLAWSWEEPER_VALIDATION_RETRIES ?? "1", 10);
  const maxRetries = Number.isFinite(configuredRetries) ? Math.max(0, configuredRetries) : 1;
  const rendered = parts.join(" ");
  const used = attempts.get(rendered) ?? 0;
  if (used >= maxRetries) return false;
  attempts.set(rendered, used + 1);
  return true;
}

function targetValidationEnv() {
  return {
    ...process.env,
    CI: process.env.CI ?? "true",
    OPENCLAW_LOCAL_CHECK: process.env.OPENCLAW_LOCAL_CHECK ?? "0",
  };
}

function targetValidationTimeoutMs(name: string, fallback: number, cap?: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  const timeout = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return cap ? Math.min(timeout, cap) : timeout;
}

function resolveAllowedValidationCommands(
  command: LooseRecord,
  cwd: string,
  baseBranch: string = DEFAULT_BASE_BRANCH,
  options: TargetValidationOptions,
) {
  const parts = parseAllowedValidationCommand(command);
  const commandParts = stripEnvPrefix(parts);
  const envPrefix = parts[0] === "env" ? parts.slice(0, parts.length - commandParts.length) : [];
  const scripts = readPackageScriptSet(cwd);
  const toolchain = getToolchain(options);
  const gate = toolchain.changedGate;
  if (
    !options.strictTargetValidation &&
    gate &&
    scripts.has(gate.requiredScript) &&
    commandParts[0] !== "git"
  ) {
    return [gate.command.split(" ")];
  }
  if (commandParts[0] === "npm" && commandParts[1] === "run" && commandParts[2] === "validate") {
    if (!scripts.has("validate") && gate && scripts.has(gate.requiredScript)) {
      return [gate.command.split(" ")];
    }
  }
  if (toolchain.packageManager === "pnpm" && commandParts[0] === "pnpm") {
    const commandStart = commandParts[1] === "-s" || commandParts[1] === "--silent" ? 2 : 1;
    const pnpmScript = commandParts[commandStart];
    if (isExpensivePnpmValidation(commandParts, commandStart, options.allowExpensiveValidation)) {
      return [["pnpm", "check:changed"]];
    }
    if (pnpmScript === "vitest" && commandParts[commandStart + 1] === "run") {
      return withEnvPrefix(
        envPrefix,
        normalizePathValidationCommand(
          ["pnpm", "test:serial", ...commandParts.slice(commandStart + 2)],
          cwd,
          baseBranch,
        ),
      );
    }
    if (pnpmScript === "test" || pnpmScript === "test:serial") {
      return withEnvPrefix(
        envPrefix,
        normalizePathValidationCommand(
          ["pnpm", pnpmScript, ...commandParts.slice(commandStart + 1)],
          cwd,
          baseBranch,
        ),
      );
    }
  }
  return [parts];
}

function withEnvPrefix(envPrefix: string[], commands: string[][]) {
  if (envPrefix.length === 0) return commands;
  return commands.map((command) => [...envPrefix, ...command]);
}

function normalizePathValidationCommand(
  parts: string[],
  cwd: string,
  baseBranch: string = DEFAULT_BASE_BRANCH,
) {
  const pathArgStart = 2;
  const pathArgs = parts.slice(pathArgStart).filter(looksLikePathArgument);
  if (pathArgs.length === 0) return [parts];

  const normalized: string[] = [];
  const missing: string[] = [];
  for (const arg of pathArgs) {
    const mapped = resolveRepoPathArgument(arg, cwd);
    if (mapped) normalized.push(mapped);
    else missing.push(arg);
  }

  if (missing.length === 0) {
    return [[...parts.slice(0, pathArgStart), ...uniqueStrings(normalized)]];
  }

  const changedTests = changedTestFiles(cwd, baseBranch);
  if (changedTests.length > 0) {
    return [["pnpm", "test:serial", ...changedTests]];
  }

  const scripts = readPackageScriptSet(cwd);
  if (scripts.has("check:changed")) {
    return [["pnpm", "check:changed"]];
  }

  return [[...parts.slice(0, pathArgStart), ...uniqueStrings(normalized)]];
}

function resolveRepoPathArgument(arg: JsonValue, cwd: string): string {
  const clean = String(arg ?? "").trim();
  if (!clean || clean.startsWith("-")) return clean;
  if (fs.existsSync(path.join(cwd, clean))) return clean;

  const candidates = candidateRepoPaths(clean, cwd).filter((candidate) =>
    fs.existsSync(path.join(cwd, candidate)),
  );
  return candidates[0] ?? "";
}

function candidateRepoPaths(filePath: string, cwd: string): string[] {
  const out: string[] = [];
  if (filePath.startsWith("src/web/")) {
    out.push(`extensions/whatsapp/src/${filePath.slice("src/web/".length)}`);
  }
  const basename = path.basename(filePath);
  if (basename) {
    const files = gitLsFiles(cwd);
    out.push(...files.filter((file) => path.basename(file) === basename));
  }
  return uniqueStrings(out);
}

function changedTestFiles(cwd: string, baseBranch: string = DEFAULT_BASE_BRANCH) {
  return gitChangedFiles(cwd, baseBranch).filter(
    (file) => isTestFile(file) && fs.existsSync(path.join(cwd, file)),
  );
}

function readPackageScriptSet(cwd: string) {
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) return new Set<string>();
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    return new Set<string>(Object.keys(pkg.scripts ?? {}));
  } catch {
    return new Set<string>();
  }
}

function requiresChangedGate(cwd: string, toolchain: TargetRepoToolchain) {
  if (!toolchain.changedGate) return false;
  return readPackageScriptSet(cwd).has(toolchain.changedGate.requiredScript);
}

function getToolchain(options: TargetValidationOptions): TargetRepoToolchain {
  return options.toolchain ?? resolveTargetRepoToolchain(options.targetRepo);
}

function isChangedGateCommand(parts: readonly string[], options: TargetValidationOptions) {
  return changedGateCommandParts(getToolchain(options).changedGate, parts) !== null;
}

function changedGateCommandParts(
  gate: TargetChangedGate | null,
  parts: readonly string[],
): readonly string[] | null {
  if (!gate) return null;
  const gateParts = gate.command.split(/\s+/).filter(Boolean);
  if (gateParts.length !== parts.length) return null;
  for (let i = 0; i < gateParts.length; i += 1) {
    if (gateParts[i] !== parts[i]) return null;
  }
  return gateParts;
}

function changedFilesSinceRef(cwd: string, sourceRef: string) {
  const committed = run("git", ["diff", "--name-only", `${sourceRef}..HEAD`], { cwd })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const uncommitted = run("git", ["status", "--porcelain"], { cwd })
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.replace(/^.. /, ""))
    .map((line) => line.split(" -> ").pop())
    .filter(Boolean);
  return uniqueStrings([...committed, ...uncommitted]);
}

function isDocsOnlyRepairDeltaFile(filePath: string) {
  const file = String(filePath ?? "").trim();
  if (!file) return false;
  if (file === "CHANGELOG.md") return true;
  if (file.startsWith("docs/")) return true;
  if (/^(?:README|CONTRIBUTING|SECURITY|SUPPORT|CODE_OF_CONDUCT)\.md$/i.test(file)) return true;
  return /\.(?:md|mdx|txt)$/i.test(file);
}
