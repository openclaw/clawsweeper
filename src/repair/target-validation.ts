import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand as run } from "./command-runner.js";
import {
  currentHead,
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
  buildStagedProofPlan,
  executeStagedProofPlan,
  stagedProofPlanArtifact,
  type StagedProofCommandInput,
  type StagedProofExecutionResult,
  type StagedProofPlan,
  type StagedProofSubsumptionContract,
} from "./staged-proof-gates.js";
import {
  isTestFile,
  looksLikePathArgument,
  packageScriptRequirement,
  parseAllowedValidationCommand,
  resolveValidationCommandEnvironment,
  stripEnvPrefix,
  uniqueStrings,
  validateAllowedValidationCommandParts,
  vitestPathFilterIndexes,
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
  proofBudgetMs?: number;
  proofSurfacePaths?: string[];
  pinnedBaseRef?: string;
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

export type ExternalBaseValidationBlocker = {
  paths: string[];
  reason: string;
};

export type TargetValidationProofResult = StagedProofExecutionResult & {
  plan: StagedProofPlan;
};

type RequiredValidationCommand = {
  command: LooseRecord;
  source: StagedProofCommandInput["source"];
  canonical: boolean;
  required: boolean;
};

export function classifyExternalBaseValidationFailure({
  targetDir,
  pinnedBaseRef,
  repairBaseRef,
  repairDeltaPaths,
  error,
  baseError,
}: {
  targetDir: string;
  pinnedBaseRef: string;
  repairBaseRef: string | null;
  repairDeltaPaths?: string[];
  error: unknown;
  baseError: unknown;
}): ExternalBaseValidationBlocker | null {
  if (!repairBaseRef || !baseError) return null;
  const trackedAtBase = new Set(
    splitGitLines(run("git", ["ls-tree", "-r", "--name-only", pinnedBaseRef], { cwd: targetDir })),
  );
  const referencedPaths = referencedTrackedPaths(String((error as Error)?.message ?? error), {
    targetDir,
    trackedAtBase,
  });
  if (referencedPaths.length === 0) return null;
  const baseReferencedPaths = referencedTrackedPaths(
    String((baseError as Error)?.message ?? baseError),
    { targetDir, trackedAtBase },
  );
  if (
    baseReferencedPaths.length !== referencedPaths.length ||
    referencedPaths.some((file) => !baseReferencedPaths.includes(file))
  ) {
    return null;
  }
  if (
    normalizedValidationFailure(String((error as Error)?.message ?? error), trackedAtBase) !==
    normalizedValidationFailure(String((baseError as Error)?.message ?? baseError), trackedAtBase)
  ) {
    return null;
  }

  const changedFromBase = new Set(
    splitGitLines(
      run("git", ["diff", "--name-only", `${pinnedBaseRef}..HEAD`], { cwd: targetDir }),
    ),
  );
  const repairDelta = new Set(
    repairDeltaPaths ??
      splitGitLines(
        run("git", ["diff", "--name-only", `${repairBaseRef}..HEAD`], { cwd: targetDir }),
      ),
  );
  if (referencedPaths.some((file) => changedFromBase.has(file) || repairDelta.has(file))) {
    return null;
  }

  return {
    paths: referencedPaths,
    reason: "validation failed only in base-identical files outside the repair delta",
  };
}

export function reproduceValidationFailureAtPinnedBase({
  commands,
  targetDir,
  options,
  baseBranch = DEFAULT_BASE_BRANCH,
}: {
  commands: LooseRecord[];
  targetDir: string;
  options: TargetValidationOptions;
  baseBranch?: string;
}): unknown | null {
  if (!options.pinnedBaseRef) return null;
  let changedFromPinnedBase: string[];
  try {
    changedFromPinnedBase = gitChangedFilesFromRef(targetDir, options.pinnedBaseRef);
  } catch {
    return null;
  }
  if (changedFromPinnedBase.some(isDependencyOrToolchainInputPath)) return null;
  if (fs.existsSync(path.join(targetDir, "node_modules")) && !options.installTargetDeps)
    return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-base-validation-"));
  const checkout = path.join(root, "target");
  try {
    run("git", ["clone", "--shared", "--no-checkout", targetDir, checkout]);
    run("git", ["checkout", "--detach", options.pinnedBaseRef], { cwd: checkout });
    try {
      prepareTargetToolchain(checkout, options);
    } catch {
      return null;
    }
    try {
      runAllowedValidationCommands(
        commands,
        checkout,
        { ...options, installTargetDeps: false },
        baseBranch,
      );
      return null;
    } catch (error) {
      return error;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function isDependencyOrToolchainInputPath(filePath: string) {
  const name = path.posix.basename(filePath);
  return (
    /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|deno\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(?:\.lock)?|Gemfile(?:\.lock)?|composer\.(?:json|lock)|requirements(?:-[^.]+)?\.txt)$/i.test(
      name,
    ) || /^(?:\.nvmrc|\.node-version|\.tool-versions|mise\.toml)$/i.test(name)
  );
}

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
  return runStagedValidationProof(commands, cwd, options, baseBranch).commands;
}

export function buildTargetValidationProofPlan(
  commands: LooseRecord[],
  cwd: string,
  options: TargetValidationOptions,
  baseBranch: string = DEFAULT_BASE_BRANCH,
) {
  const validationEnv = targetValidationEnv();
  return stagedProofPlanArtifact(
    createTargetValidationProofPlan(commands, cwd, options, baseBranch, validationEnv).plan,
  );
}

export function runStagedValidationProof(
  commands: LooseRecord[],
  cwd: string,
  options: TargetValidationOptions,
  baseBranch: string = DEFAULT_BASE_BRANCH,
): TargetValidationProofResult {
  const validationEnv = targetValidationEnv();
  const { baseRef, plan } = createTargetValidationProofPlan(
    commands,
    cwd,
    options,
    baseBranch,
    validationEnv,
  );
  const checkoutIdentity = validationCheckoutIdentity(cwd, baseRef);
  if (checkoutIdentity.status) {
    throw new Error("staged proof requires a clean validation checkout");
  }
  const validationTimeoutMs = targetValidationTimeoutMs(
    "CLAWSWEEPER_TARGET_VALIDATION_TIMEOUT_MS",
    options.validationTimeoutMs ?? DEFAULT_TARGET_VALIDATION_TIMEOUT_MS,
    options.validationTimeoutMs,
  );
  const defaultProofBudgetMs = Math.max(
    validationTimeoutMs,
    validationTimeoutMs * plan.commands.length,
  );
  const proofBudgetMs = targetValidationTimeoutMs(
    "CLAWSWEEPER_TARGET_PROOF_BUDGET_MS",
    options.proofBudgetMs ?? defaultProofBudgetMs,
    options.proofBudgetMs,
  );
  const executed = new Set<string>();
  const attempts = new Map<string, number>();
  const result = executeStagedProofPlan(plan, {
    commandTimeoutMs: validationTimeoutMs,
    budgetMs: proofBudgetMs,
    validatedHeadSha: checkoutIdentity.headSha,
    validatedBaseSha: checkoutIdentity.baseSha,
    runCommand: (command, timeoutMs) =>
      runValidationPlanCommand({
        parts: command.parts,
        displayParts: command.display_parts,
        timeoutMs,
        cwd,
        validationEnv,
        options,
        attempts,
        executed,
        baseRef,
        checkoutIdentity,
      }),
  });
  return { ...result, plan };
}

function createTargetValidationProofPlan(
  commands: LooseRecord[],
  cwd: string,
  options: TargetValidationOptions,
  baseBranch: string,
  validationEnv: NodeJS.ProcessEnv,
) {
  const baseRef = validationBaseRef(cwd, baseBranch, options);
  const changedFiles = gitChangedFilesFromRef(cwd, baseRef);
  const surfaceHints = options.proofSurfacePaths ?? [];
  const toolchain = getToolchain(options);
  const resolved: StagedProofCommandInput[] = [
    {
      parts: ["git", "diff", "--check", `${baseRef}...HEAD`],
      source: "configured",
      canonical: false,
      required: true,
      originalIndex: -2,
    },
    {
      parts: ["git", "diff", "--check"],
      source: "configured",
      canonical: false,
      required: true,
      originalIndex: -1,
    },
  ];

  for (const command of resolvedRequiredValidationCommandEntries(
    commands,
    cwd,
    baseBranch,
    options,
    validationEnv,
  )) {
    resolved.push(command);
  }

  if (resolved.length === 0) {
    throw new Error(
      "validation_command_missing: no configured or artifact validation command is available",
    );
  }
  return {
    baseRef,
    plan: buildStagedProofPlan({
      commands: resolved,
      changedFiles,
      surfaceHints,
      subsumptionContracts: proofSubsumptionContracts(toolchain, validationEnv),
    }),
  };
}

function runValidationPlanCommand({
  parts,
  displayParts,
  timeoutMs,
  cwd,
  validationEnv,
  options,
  attempts,
  executed,
  baseRef,
  checkoutIdentity,
}: {
  parts: string[];
  displayParts: string[];
  timeoutMs: number;
  cwd: string;
  validationEnv: NodeJS.ProcessEnv;
  options: TargetValidationOptions;
  attempts: Map<string, number>;
  executed: Set<string>;
  baseRef: string;
  checkoutIdentity: ValidationCheckoutIdentity;
}) {
  const rendered = displayParts.join(" ");
  if (executed.has(rendered)) {
    return { executedCommands: [], reason: "exact command already passed" };
  }
  const startedAt = Date.now();
  while (true) {
    try {
      run(parts[0]!, parts.slice(1), {
        cwd,
        env: validationEnv,
        timeoutMs: remainingCommandBudget(timeoutMs, startedAt),
      });
      assertValidationCheckoutIdentity(cwd, baseRef, checkoutIdentity);
      executed.add(rendered);
      return {
        executedCommands: [rendered],
        reason:
          (attempts.get(rendered) ?? 0) > 0
            ? `passed after ${(attempts.get(rendered) ?? 0) + 1} attempts`
            : "passed",
      };
    } catch (error) {
      assertValidationCheckoutIdentity(cwd, baseRef, checkoutIdentity);
      if (
        shouldRetryValidationCommand({
          parts,
          error,
          attempts,
          options,
          attemptKey: rendered,
        })
      ) {
        continue;
      }
      throw new Error(
        `validation command failed (${rendered}): ${compactText(error.message, 12000)}`,
        { cause: error },
      );
    }
  }
}

type ValidationCheckoutIdentity = {
  headSha: string;
  baseSha: string;
  status: string;
};

function validationCheckoutIdentity(cwd: string, baseRef: string): ValidationCheckoutIdentity {
  return {
    headSha: currentHead(cwd),
    baseSha: run("git", ["rev-parse", baseRef], { cwd }).trim(),
    status: run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd }),
  };
}

function assertValidationCheckoutIdentity(
  cwd: string,
  baseRef: string,
  expected: ValidationCheckoutIdentity,
) {
  const actual = validationCheckoutIdentity(cwd, baseRef);
  if (
    actual.headSha !== expected.headSha ||
    actual.baseSha !== expected.baseSha ||
    actual.status !== expected.status
  ) {
    throw new Error("unsafe validation command mutated checkout or proof identity");
  }
}

function remainingCommandBudget(timeoutMs: number, startedAt: number) {
  return Math.max(1, timeoutMs - Math.max(0, Date.now() - startedAt));
}

export function preflightTargetValidationPlan(
  { fixArtifact, targetDir, baseBranch = DEFAULT_BASE_BRANCH }: LooseRecord,
  options: TargetValidationOptions,
) {
  const scripts = readPackageScriptSet(targetDir);
  const availableScripts = [...scripts].sort();
  const resolved: string[] = [];
  const requiredScripts: LooseRecord[] = [];
  const validationEnv = targetValidationEnv();
  for (const command of resolvedRequiredValidationCommandEntries(
    fixArtifact.validation_commands ?? [],
    targetDir,
    baseBranch,
    options,
    validationEnv,
  )) {
    const rendered = (command.displayParts ?? command.parts).join(" ");
    if (!resolved.includes(rendered)) resolved.push(rendered);
    const script = packageScriptRequirement(command.parts);
    if (script) requiredScripts.push(script);
  }

  if (resolved.length === 0) {
    return {
      status: "blocked",
      code: "validation_command_missing",
      available_scripts: availableScripts,
      resolved_commands: [],
      reason:
        "validation_command_missing: no configured or artifact validation command is available",
    };
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
  return uniqueStrings(
    requiredValidationCommandEntries(commands ?? [], cwd, options).map((entry) => entry.command),
  );
}

function requiredValidationCommandEntries(
  commands: LooseRecord[],
  cwd: string,
  options: TargetValidationOptions,
): RequiredValidationCommand[] {
  const toolchain = getToolchain(options);
  const additionalCommands = options.additionalValidationCommands ?? [];
  const replacementCommands = [...additionalCommands, ...toolchain.baseValidationCommands];
  const sanitized = sanitizeStaleChangedGateCommands(commands, toolchain, replacementCommands);
  const out: RequiredValidationCommand[] = [
    ...sanitized.map((command) => ({
      command,
      source: "artifact" as const,
      canonical: false,
      required: true,
    })),
    ...additionalCommands.map((command) => ({
      command,
      source: "configured" as const,
      canonical: false,
      required: true,
    })),
    ...toolchain.baseValidationCommands.map((command) => ({
      command,
      source: "repository_profile" as const,
      canonical: false,
      required: true,
    })),
  ];
  const gate = toolchain.changedGate;
  if (gate && !options.skipOpenClawChangedGate && requiresChangedGate(cwd, toolchain)) {
    out.push({
      command: gate.command,
      source: "changed_gate",
      canonical: true,
      required: true,
    });
  }
  const unique = new Map<string, RequiredValidationCommand>();
  for (const entry of out) {
    const key = String(entry.command);
    const previous = unique.get(key);
    if (!previous) {
      unique.set(key, entry);
      continue;
    }
    unique.set(key, {
      ...previous,
      source: entry.canonical ? entry.source : previous.source,
      canonical: previous.canonical || entry.canonical,
      required: previous.required || entry.required,
    });
  }
  return [...unique.values()];
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
 * toolchain has no gate of its own. If no repository-specific replacement
 * exists, fall back to `git diff --check`; unrelated commands still pass
 * through so genuinely missing scripts remain visible.
 */
function sanitizeStaleChangedGateCommands(
  commands: readonly LooseRecord[],
  toolchain: TargetRepoToolchain,
  replacementCommands: readonly string[],
): LooseRecord[] {
  if (toolchain.changedGate) return [...commands];
  const filtered = commands.filter((command) => !looksLikeStaleChangedGateCommand(command));
  if (
    filtered.length === 0 &&
    commands.some((command) => looksLikeStaleChangedGateCommand(command)) &&
    replacementCommands.length === 0
  ) {
    return ["git diff --check"];
  }
  return filtered;
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

function isChangedGateStall(error: JsonValue) {
  return /no output for \d+ms|terminating stalled Vitest|stalled Vitest process/i.test(
    String(error?.message ?? ""),
  );
}

function shouldRetryValidationCommand({
  parts,
  error,
  attempts,
  options,
  attemptKey,
}: LooseRecord) {
  if (options.strictTargetValidation) return false;
  if (!isChangedGateCommand(parts, options)) return false;
  if (isChangedGateStall(error)) return false;

  const configuredRetries = Number.parseInt(process.env.CLAWSWEEPER_VALIDATION_RETRIES ?? "1", 10);
  const maxRetries = Number.isFinite(configuredRetries) ? Math.max(0, configuredRetries) : 1;
  const rendered = String(attemptKey ?? parts.join(" "));
  const used = attempts.get(rendered) ?? 0;
  if (used >= maxRetries) return false;
  attempts.set(rendered, used + 1);
  return true;
}

function targetValidationEnv() {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: process.env.CI ?? "true",
    OPENCLAW_LOCAL_CHECK: process.env.OPENCLAW_LOCAL_CHECK ?? "0",
  };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CLAWSWEEPER_INTERNAL_MODEL;
  delete env.CODEX_HOME;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
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
  const toolchain = getToolchain(options);
  if (toolchain.packageManager === "pnpm" && commandParts[0] === "pnpm") {
    const commandStart = commandParts[1] === "-s" || commandParts[1] === "--silent" ? 2 : 1;
    const pnpmScript = commandParts[commandStart];
    const vitestArgsStart =
      pnpmScript === "vitest" && commandParts[commandStart + 1] === "run"
        ? commandStart + 2
        : pnpmScript === "exec" &&
            commandParts[commandStart + 1] === "vitest" &&
            commandParts[commandStart + 2] === "run"
          ? commandStart + 3
          : -1;
    if (vitestArgsStart >= 0) {
      const vitestArgs = commandParts.slice(vitestArgsStart);
      const pathIndexes = vitestPathFilterIndexes(vitestArgs);
      return withEnvPrefix(
        envPrefix,
        normalizePathValidationCommand(
          ["pnpm", "exec", "vitest", "run", ...vitestArgs],
          cwd,
          baseBranch,
          4,
          new Set(pathIndexes),
          options,
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
          2,
          undefined,
          options,
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
  pathArgStart: number = 2,
  testPathIndexes?: ReadonlySet<number>,
  options?: TargetValidationOptions,
) {
  const args = parts.slice(pathArgStart);
  const shouldNormalize = (arg: string, index: number) =>
    testPathIndexes ? testPathIndexes.has(index) : looksLikePathArgument(arg);
  if (!args.some(shouldNormalize)) return [parts];

  const normalizedArgs: string[] = [];
  const missing: string[] = [];
  for (const [index, arg] of args.entries()) {
    if (!shouldNormalize(arg, index)) {
      normalizedArgs.push(arg);
      continue;
    }
    const mapped = resolveRepoPathArgument(arg, cwd);
    if (mapped) normalizedArgs.push(mapped);
    else missing.push(arg);
  }

  if (missing.length === 0) {
    return [[...parts.slice(0, pathArgStart), ...normalizedArgs]];
  }

  const changedTests = changedTestFiles(cwd, baseBranch, options);
  if (changedTests.length > 0) {
    return [[...parts.slice(0, pathArgStart), ...normalizedArgs, ...changedTests]];
  }

  return [["pnpm", "check:changed"]];
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

function changedTestFiles(
  cwd: string,
  baseBranch: string = DEFAULT_BASE_BRANCH,
  options?: TargetValidationOptions,
) {
  const changedFiles = options?.pinnedBaseRef
    ? gitChangedFilesFromRef(cwd, validationBaseRef(cwd, baseBranch, options))
    : gitChangedFiles(cwd, baseBranch);
  return changedFiles.filter((file) => isTestFile(file) && fs.existsSync(path.join(cwd, file)));
}

function validationBaseRef(cwd: string, baseBranch: string, options: TargetValidationOptions) {
  if (!options.pinnedBaseRef) {
    ensureMergeBaseAvailable({ targetDir: cwd, baseBranch });
    return `origin/${baseBranch}`;
  }
  run("git", ["merge-base", options.pinnedBaseRef, "HEAD"], { cwd });
  return options.pinnedBaseRef;
}

function gitChangedFilesFromRef(cwd: string, baseRef: string) {
  const committed = run("git", ["diff", "--name-only", `${baseRef}...HEAD`], { cwd })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const uncommitted = run("git", ["status", "--porcelain"], { cwd })
    .split("\n")
    .map((line) => line.replace(/\r$/, "").slice(3))
    .map((line) => line.split(" -> ").pop())
    .filter((line): line is string => Boolean(line));
  return uniqueStrings([...committed, ...uncommitted]);
}

function referencedTrackedPaths(
  message: string,
  { targetDir, trackedAtBase }: { targetDir: string; trackedAtBase: ReadonlySet<string> },
) {
  const normalized = message.split(`${path.resolve(targetDir)}${path.sep}`).join("");
  const candidates = normalized.match(/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g) ?? [];
  const paths: string[] = [];
  for (const rawCandidate of uniqueStrings(candidates)) {
    const candidate = rawCandidate.replace(/^\.\//, "");
    if (trackedAtBase.has(candidate)) {
      paths.push(candidate);
      continue;
    }
    for (const trackedPath of trackedAtBase) {
      if (candidate.endsWith(`/${trackedPath}`)) paths.push(trackedPath);
    }
  }
  return uniqueStrings(paths);
}

function normalizedValidationFailure(message: string, trackedAtBase: ReadonlySet<string>) {
  const ansiCsi = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  let normalized = message.replace(ansiCsi, "").replace(/\r\n/g, "\n");
  const candidates = normalized.match(/\/?[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g) ?? [];
  for (const candidate of uniqueStrings(candidates).sort(
    (left, right) => right.length - left.length,
  )) {
    const withoutLeadingSlash = candidate.replace(/^\//, "");
    const trackedPath = trackedAtBase.has(withoutLeadingSlash)
      ? withoutLeadingSlash
      : [...trackedAtBase].find((tracked) => withoutLeadingSlash.endsWith(`/${tracked}`));
    if (trackedPath) normalized = normalized.split(candidate).join(trackedPath);
  }
  return normalized.trim();
}

function splitGitLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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

function proofSubsumptionContracts(
  toolchain: TargetRepoToolchain,
  validationEnv: NodeJS.ProcessEnv,
): StagedProofSubsumptionContract[] {
  const out: StagedProofSubsumptionContract[] = [];
  for (const contract of toolchain.proofSubsumptions ?? []) {
    try {
      const command = parseAllowedValidationCommand(contract.command);
      out.push({
        command: validateAllowedValidationCommandParts(
          resolveValidationCommandEnvironment(command, validationEnv),
          contract.command,
        ),
        subsumes: contract.subsumes.map((subsumedCommand) => {
          const parsed = parseAllowedValidationCommand(subsumedCommand);
          return validateAllowedValidationCommandParts(
            resolveValidationCommandEnvironment(parsed, validationEnv),
            subsumedCommand,
          );
        }),
      });
    } catch {
      // Invalid repository metadata cannot weaken or block proof; ignore the contract.
    }
  }
  return out;
}

function resolvedRequiredValidationCommandEntries(
  commands: LooseRecord[],
  cwd: string,
  baseBranch: string,
  options: TargetValidationOptions,
  validationEnv: NodeJS.ProcessEnv,
): StagedProofCommandInput[] {
  const toolchain = getToolchain(options);
  return requiredValidationCommandEntries(commands, cwd, options).flatMap(
    (command, originalIndex) =>
      resolveAllowedValidationCommands(command.command, cwd, baseBranch, options).map((parts) => {
        const concreteParts = validateAllowedValidationCommandParts(
          resolveValidationCommandEnvironment(parts, validationEnv),
          command.command,
        );
        const canonical =
          command.canonical ||
          changedGateCommandParts(toolchain.changedGate, concreteParts) !== null;
        return {
          parts: concreteParts,
          displayParts: parts,
          source:
            canonical && command.source === "artifact" ? ("changed_gate" as const) : command.source,
          canonical,
          required: command.required,
          originalIndex,
        };
      }),
  );
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
