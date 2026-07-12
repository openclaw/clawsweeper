import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

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
  stagedProofPlanFromArtifact,
  stagedProofPlanArtifact,
  type StagedProofCommandInput,
  type StagedProofExecutionResult,
  type StagedProofPlan,
  type StagedProofPlanArtifact,
  type StagedProofSubsumptionContract,
} from "./staged-proof-gates.js";
import {
  isTestFile,
  looksLikePathArgument,
  packageScriptRequirement,
  parseAllowedValidationCommand,
  requireWorkspaceMatchFailure,
  resolveValidationCommandEnvironment,
  stripEnvPrefix,
  uniqueStrings,
  validateAllowedValidationCommandParts,
  validationCommandForExecution,
  vitestPathFilterIndexes,
} from "./validation-command-utils.js";

const DEFAULT_BASE_BRANCH = "main";
const DEFAULT_TARGET_SETUP_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_TARGET_INSTALL_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_TARGET_VALIDATION_TIMEOUT_MS = 12 * 60 * 1000;
const MIN_VALIDATION_RETRY_BUDGET_MS = 1_000;
const ABSENT_PROOF_INPUT = "<absent>";
const PROTECTED_PROOF_INPUT_DIRECTORIES = new Set([
  ".venv",
  ".yarn",
  "node_modules",
  "venv",
  "vendor",
]);
const ROOT_PROOF_INPUT_CANDIDATES = [
  ".env",
  ".env.ci",
  ".env.development",
  ".env.local",
  ".env.production",
  ".env.staging",
  ".env.test",
  ".npmrc",
  ".pnp.cjs",
  ".pnp.loader.mjs",
  ".pnpmfile.cjs",
  ".venv",
  ".yarn",
  ".yarnrc",
  ".yarnrc.yml",
  "node_modules",
  "venv",
];

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
  const sourceIdentity = validationSourceIdentity(cwd);
  if (sourceIdentity.status) {
    throw new Error("target dependency setup requires a clean source checkout");
  }

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
    assertValidationSourceIdentity(cwd, sourceIdentity);
    return;
  }
  if (toolchain.packageManager === "npm") {
    prepareNpmToolchain({ cwd, validationEnv, installTimeoutMs });
    assertValidationSourceIdentity(cwd, sourceIdentity);
    return;
  }
  preparePnpmToolchain({
    cwd,
    packageJson,
    validationEnv,
    setupTimeoutMs,
    installTimeoutMs,
  });
  assertValidationSourceIdentity(cwd, sourceIdentity);
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
    "--ignore-scripts",
    "--config.engine-strict=false",
    "--config.enable-pre-post-scripts=false",
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
  // ClawSweeper runs under pnpm, so strip caller lifecycle identity before Bun
  // while preserving target registry, auth, proxy, userconfig, and cache settings.
  const bunEnv = sanitizeEnvForBun(validationEnv);
  run("bun", ["--version"], { cwd, env: bunEnv, timeoutMs: setupTimeoutMs });
  const installArgs = ["install", "--frozen-lockfile", "--ignore-scripts"];
  try {
    run("bun", installArgs, { cwd, env: bunEnv, timeoutMs: installTimeoutMs });
  } catch (error) {
    const message = String(error?.message ?? "");
    if (!/lockfile|frozen|out of date|out-of-date/i.test(message)) throw error;
    run("bun", ["install", "--no-frozen-lockfile", "--ignore-scripts"], {
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
  const installArgs = fs.existsSync(path.join(cwd, "package-lock.json"))
    ? ["ci", "--ignore-scripts"]
    : ["install", "--no-package-lock", "--ignore-scripts"];
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
  const proofStartedAt = Date.now();
  const checkoutIdentity = validationCheckoutIdentity(cwd, baseRef);
  if (checkoutIdentity.status) {
    throw new Error("staged proof requires a clean validation checkout");
  }
  const proofInputSnapshot = validationProofInputSnapshot(cwd, plan.commands);
  const executed = new Set<string>();
  const attempts = new Map<string, number>();
  const result = executeStagedProofPlan(plan, {
    commandTimeoutMs: validationTimeoutMs,
    budgetMs: remainingProofBudgetMs(proofBudgetMs, proofStartedAt),
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
        proofInputSnapshot,
      }),
  });
  return { ...result, plan };
}

export function replayStagedValidationProof(
  planArtifact: StagedProofPlanArtifact,
  cwd: string,
  options: TargetValidationOptions,
  baseBranch: string = DEFAULT_BASE_BRANCH,
): TargetValidationProofResult {
  const validationEnv = targetValidationEnv();
  const plan = stagedProofPlanFromArtifact(planArtifact);
  const baseRef = validationBaseRef(cwd, baseBranch, options);
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
  const proofStartedAt = Date.now();
  const checkoutIdentity = validationCheckoutIdentity(cwd, baseRef);
  if (checkoutIdentity.status) {
    throw new Error("staged proof replay requires a clean validation checkout");
  }
  const proofInputSnapshot = validationProofInputSnapshot(cwd, plan.commands);
  const executed = new Set<string>();
  const attempts = new Map<string, number>();
  const result = executeStagedProofPlan(plan, {
    commandTimeoutMs: validationTimeoutMs,
    budgetMs: remainingProofBudgetMs(proofBudgetMs, proofStartedAt),
    validatedHeadSha: checkoutIdentity.headSha,
    validatedBaseSha: checkoutIdentity.baseSha,
    runCommand: (command, timeoutMs) => {
      const validatedParts = requireWorkspaceMatchFailure(
        validateAllowedValidationCommandParts(command.parts, command.display_parts.join(" ")),
      );
      if (JSON.stringify(validatedParts) !== JSON.stringify(command.parts)) {
        throw new Error("staged proof replay command differs from current validation policy");
      }
      return runValidationPlanCommand({
        parts: validatedParts,
        displayParts: command.display_parts,
        timeoutMs,
        cwd,
        validationEnv,
        options,
        attempts,
        executed,
        baseRef,
        checkoutIdentity,
        proofInputSnapshot,
      });
    },
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
  const requiredCommands = resolvedRequiredValidationCommandEntries(
    commands,
    cwd,
    baseBranch,
    options,
    validationEnv,
  );
  if (requiredCommands.length === 0) {
    throw new Error(
      "validation_command_missing: no configured or artifact validation command is available",
    );
  }
  const missingScript = missingRequiredPackageScript(
    requiredCommands,
    readPackageScriptInventory(cwd),
  );
  if (missingScript) {
    throw new Error(
      `validation_script_missing: required ${missingScript.command} is unavailable in target checkout`,
    );
  }
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
    ...requiredCommands,
  ];

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
  proofInputSnapshot,
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
  proofInputSnapshot: ValidationProofInputSnapshot;
}) {
  const rendered = displayParts.join(" ");
  const commandIdentity = JSON.stringify(parts);
  if (executed.has(commandIdentity)) {
    return { executedCommands: [], reason: "exact command already passed" };
  }
  assertValidationProofInputSnapshot(cwd, proofInputSnapshot);
  const startedAt = Date.now();
  while (true) {
    const remainingBudgetMs = remainingCommandBudget(timeoutMs, startedAt);
    if (remainingBudgetMs <= 0) {
      throw validationCommandBudgetError(rendered);
    }
    try {
      const executionParts = validationCommandForExecution(parts);
      run(executionParts[0]!, executionParts.slice(1), {
        cwd,
        env: validationEnv,
        timeoutMs: remainingBudgetMs,
      });
      assertValidationCheckoutIdentity(cwd, baseRef, checkoutIdentity);
      assertValidationProofInputSnapshot(cwd, proofInputSnapshot);
      executed.add(commandIdentity);
      return {
        executedCommands: [rendered],
        reason:
          (attempts.get(commandIdentity) ?? 0) > 0
            ? `passed after ${(attempts.get(commandIdentity) ?? 0) + 1} attempts`
            : "passed",
      };
    } catch (error) {
      assertValidationCheckoutIdentity(cwd, baseRef, checkoutIdentity);
      assertValidationProofInputSnapshot(cwd, proofInputSnapshot);
      const remainingBudgetMs = remainingCommandBudget(timeoutMs, startedAt);
      if (
        remainingBudgetMs >= MIN_VALIDATION_RETRY_BUDGET_MS &&
        shouldRetryValidationCommand({
          parts,
          error,
          attempts,
          options,
          attemptKey: commandIdentity,
        })
      ) {
        continue;
      }
      if (remainingBudgetMs <= 0) {
        throw validationCommandBudgetError(rendered, error);
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
  trackedWorktreeSha256: string;
};

type ValidationProofInputSnapshot = {
  entries: Map<string, string>;
};

type ValidationSourceIdentity = {
  headSha: string;
  treeSha: string;
  status: string;
  trackedWorktreeSha256: string;
};

function validationSourceIdentity(cwd: string): ValidationSourceIdentity {
  return {
    headSha: currentHead(cwd),
    treeSha: run("git", ["rev-parse", "HEAD^{tree}"], { cwd }).trim(),
    status: run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd }),
    trackedWorktreeSha256: trackedWorktreeSha256(cwd),
  };
}

function assertValidationSourceIdentity(cwd: string, expected: ValidationSourceIdentity) {
  const actual = validationSourceIdentity(cwd);
  if (
    actual.headSha !== expected.headSha ||
    actual.treeSha !== expected.treeSha ||
    actual.status !== expected.status ||
    actual.trackedWorktreeSha256 !== expected.trackedWorktreeSha256
  ) {
    throw new Error("target dependency setup mutated source or proof identity");
  }
}

function validationCheckoutIdentity(cwd: string, baseRef: string): ValidationCheckoutIdentity {
  return {
    headSha: currentHead(cwd),
    baseSha: run("git", ["rev-parse", baseRef], { cwd }).trim(),
    status: run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd }),
    trackedWorktreeSha256: trackedWorktreeSha256(cwd),
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
    actual.status !== expected.status ||
    actual.trackedWorktreeSha256 !== expected.trackedWorktreeSha256
  ) {
    throw new Error("unsafe validation command mutated checkout or proof identity");
  }
}

function validationProofInputSnapshot(
  cwd: string,
  commands: readonly { parts: readonly string[] }[],
): ValidationProofInputSnapshot {
  const root = fs.realpathSync(cwd);
  const entries = new Map<string, string>();
  const visitedPaths = new Set<string>();

  const visit = (relativePath: string) => {
    if (visitedPaths.has(relativePath)) return;
    visitedPaths.add(relativePath);
    const entryPath = proofInputPath(root, relativePath);
    const stat = fs.lstatSync(entryPath, { bigint: true });
    entries.set(relativePath, validationProofInputSignature(stat));

    if (stat.isSymbolicLink()) {
      entries.set(`${relativePath}\0link`, fs.readlinkSync(entryPath));
      const targetPath = proofInputSymlinkTarget(root, entryPath, relativePath);
      const targetStat = fs.statSync(targetPath, { bigint: true });
      const targetRelativePath = proofInputRelativePath(root, targetPath);
      entries.set(
        `${relativePath}\0target`,
        `${targetRelativePath}\0${validationProofInputSignature(targetStat)}`,
      );
      visit(targetRelativePath);
      return;
    }
    if (!stat.isDirectory()) {
      if (!stat.isFile()) {
        throw new Error(`unsupported proof input entry: ${relativePath}`);
      }
      return;
    }
    const children = fs.readdirSync(entryPath).sort();
    entries.set(`${relativePath}\0children`, children.join("\0"));
    for (const name of children) {
      visit(path.posix.join(relativePath, name));
    }
  };

  for (const relativePath of validationProofInputCandidates(cwd, commands)) {
    if (proofInputLstat(root, relativePath)) visit(relativePath);
    else entries.set(relativePath, ABSENT_PROOF_INPUT);
  }
  return { entries };
}

function validationProofInputSignature(stat: fs.BigIntStats) {
  return [
    stat.mode,
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
  ].join(":");
}

function assertValidationProofInputSnapshot(cwd: string, expected: ValidationProofInputSnapshot) {
  const root = fs.realpathSync(cwd);
  for (const [entryPath, signature] of expected.entries) {
    if (currentProofInputSignature(root, entryPath) === signature) continue;
    throw new Error(
      `unsafe validation command mutated ignored proof input surface: ${entryPath.split("\0", 1)[0] ?? "unknown"}`,
    );
  }
}

function validationProofInputCandidates(
  cwd: string,
  commands: readonly { parts: readonly string[] }[],
): string[] {
  const candidates = new Set(ROOT_PROOF_INPUT_CANDIDATES);
  for (const candidate of trackedManifestProofInputCandidates(cwd)) candidates.add(candidate);
  const ignoredEntries = run(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    { cwd },
  );
  const ignoredPaths = ignoredEntries
    .split("\0")
    .map((entry) => entry.replace(/\/+$/, ""))
    .filter(Boolean);
  for (const ignoredPath of ignoredPaths) {
    const parts = ignoredPath.split("/");
    const protectedIndex = parts.findIndex((part) => PROTECTED_PROOF_INPUT_DIRECTORIES.has(part));
    if (protectedIndex >= 0) {
      candidates.add(parts.slice(0, protectedIndex + 1).join("/"));
    } else if (isProtectedProofInputFile(ignoredPath)) {
      candidates.add(ignoredPath);
    }
  }

  for (const command of commands) {
    for (const argument of stripEnvPrefix(command.parts).slice(1)) {
      if (!looksLikePathArgument(argument) || argument.startsWith("-")) continue;
      const absolute = path.resolve(cwd, argument);
      if (!isPathWithin(path.resolve(cwd), absolute) || !fs.existsSync(absolute)) continue;
      const relative = proofInputRelativePath(path.resolve(cwd), absolute);
      if (
        ignoredPaths.some((ignored) => relative === ignored || relative.startsWith(`${ignored}/`))
      ) {
        candidates.add(relative);
      }
    }
  }

  return [...candidates]
    .map((candidate) => candidate.replaceAll("\\", "/").replace(/^\.\/+/, ""))
    .filter((candidate) => candidate && candidate !== ".git" && !candidate.startsWith(".git/"))
    .sort((left, right) => left.localeCompare(right))
    .filter(
      (candidate, index, values) =>
        !values.some(
          (parent, parentIndex) =>
            parentIndex !== index &&
            candidate.startsWith(`${parent}/`) &&
            parent.split("/").length < candidate.split("/").length,
        ),
    );
}

function trackedManifestProofInputCandidates(cwd: string): string[] {
  const manifests = run(
    "git",
    [
      "ls-files",
      "-z",
      "--",
      ":(glob)**/Cargo.toml",
      ":(glob)**/Gemfile",
      ":(glob)**/Pipfile",
      ":(glob)**/composer.json",
      ":(glob)**/go.mod",
      ":(glob)**/package.json",
      ":(glob)**/poetry.lock",
      ":(glob)**/pyproject.toml",
      ":(glob)**/requirements*.txt",
    ],
    { cwd },
  )
    .split("\0")
    .filter(Boolean);
  const candidates = new Set<string>();
  for (const manifest of manifests) {
    const directory = path.posix.dirname(manifest);
    for (const name of ROOT_PROOF_INPUT_CANDIDATES) {
      candidates.add(directory === "." ? name : path.posix.join(directory, name));
    }
    if (
      path.posix.basename(manifest) === "Cargo.toml" ||
      path.posix.basename(manifest) === "go.mod"
    ) {
      candidates.add(directory === "." ? "vendor" : path.posix.join(directory, "vendor"));
    }
  }
  return [...candidates];
}

function isProtectedProofInputFile(filePath: string) {
  const name = path.posix.basename(filePath);
  return (
    /^\.env(?:\..+)?$/.test(name) ||
    /^(?:\.npmrc|\.pnp\.(?:cjs|loader\.mjs)|\.pnpmfile\.cjs|\.yarnrc(?:\.yml)?)$/.test(name)
  );
}

function currentProofInputSignature(root: string, entryPath: string): string {
  const [relativePath, kind = "stat"] = entryPath.split("\0");
  const absolute = proofInputPath(root, relativePath!);
  const stat = proofInputLstat(root, relativePath!);
  if (!stat) return ABSENT_PROOF_INPUT;
  if (kind === "stat") return validationProofInputSignature(stat);
  if (kind === "children") {
    return stat.isDirectory() ? fs.readdirSync(absolute).sort().join("\0") : "<not-directory>";
  }
  if (kind === "link") {
    return stat.isSymbolicLink() ? fs.readlinkSync(absolute) : "<not-symlink>";
  }
  if (kind === "target") {
    if (!stat.isSymbolicLink()) return "<not-symlink>";
    const targetPath = proofInputSymlinkTarget(root, absolute, relativePath!);
    return `${proofInputRelativePath(root, targetPath)}\0${validationProofInputSignature(
      fs.statSync(targetPath, { bigint: true }),
    )}`;
  }
  return "<unknown-proof-input>";
}

function proofInputLstat(root: string, relativePath: string): fs.BigIntStats | null {
  try {
    return fs.lstatSync(proofInputPath(root, relativePath), { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function proofInputPath(root: string, relativePath: string) {
  const absolute = path.resolve(root, ...relativePath.split("/"));
  if (!isPathWithin(root, absolute)) {
    throw new Error(`proof input path escapes validation checkout: ${relativePath}`);
  }
  return absolute;
}

function proofInputSymlinkTarget(root: string, entryPath: string, relativePath: string) {
  let targetPath: string;
  try {
    targetPath = fs.realpathSync(entryPath);
  } catch {
    throw new Error(`proof input symlink is broken or cyclic: ${relativePath}`);
  }
  if (!isPathWithin(root, targetPath)) {
    throw new Error(`proof input symlink escapes validation checkout: ${relativePath}`);
  }
  return targetPath;
}

function proofInputRelativePath(root: string, absolute: string) {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function isPathWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function remainingCommandBudget(timeoutMs: number, startedAt: number) {
  return Math.max(0, timeoutMs - Math.max(0, Date.now() - startedAt));
}

function remainingProofBudgetMs(budgetMs: number, startedAt: number) {
  return Math.max(0, budgetMs - Math.max(0, Date.now() - startedAt));
}

function trackedWorktreeSha256(cwd: string): string {
  assertNoHiddenTrackedIndexFlags(cwd);
  const root = fs.realpathSync(cwd);
  const digest = crypto.createHash("sha256");
  const entries = run("git", ["ls-files", "--stage", "-z"], { cwd }).split("\0").filter(Boolean);
  for (const entry of entries) {
    const match = entry.match(/^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/);
    if (!match || match[3] !== "0") {
      throw new Error("staged proof requires an unambiguous tracked index");
    }
    const [, mode, indexObject, , relativePath] = match;
    const absolutePath = path.resolve(root, ...relativePath!.split("/"));
    if (!isPathWithin(root, absolutePath)) {
      throw new Error(`tracked proof input escapes validation checkout: ${relativePath}`);
    }
    updateProofDigest(digest, "path", relativePath!);
    updateProofDigest(digest, "mode", mode!);
    updateProofDigest(digest, "index", indexObject!);
    if (mode === "160000") {
      const head = run("git", ["-C", absolutePath, "rev-parse", "HEAD"], { cwd }).trim();
      updateProofDigest(digest, "gitlink", head);
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      updateProofDigest(digest, "working-tree", ABSENT_PROOF_INPUT);
      continue;
    }
    if (stat.isSymbolicLink()) {
      updateProofDigest(digest, "symlink", fs.readlinkSync(absolutePath));
      const targetPath = trackedProofInputSymlinkTarget(root, absolutePath, relativePath!);
      updateProofDigest(digest, "symlink-target", proofInputRelativePath(root, targetPath));
      updateTrackedSymlinkTargetDigest(digest, root, targetPath, relativePath!, new Set());
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`tracked proof input is not a regular file: ${relativePath}`);
    }
    const bytes = fs.readFileSync(absolutePath);
    digest.update(`working-tree:${bytes.length}:`);
    digest.update(bytes);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function trackedProofInputSymlinkTarget(root: string, entryPath: string, relativePath: string) {
  let targetPath: string;
  try {
    targetPath = fs.realpathSync(entryPath);
  } catch {
    throw new Error(`tracked proof input symlink is broken or cyclic: ${relativePath}`);
  }
  if (!isPathWithin(root, targetPath)) {
    throw new Error(`tracked proof input symlink escapes validation checkout: ${relativePath}`);
  }
  return targetPath;
}

function updateTrackedSymlinkTargetDigest(
  digest: crypto.Hash,
  root: string,
  entryPath: string,
  logicalPath: string,
  activeDirectories: Set<string>,
) {
  const stat = fs.lstatSync(entryPath);
  updateProofDigest(digest, "symlink-target-entry", logicalPath);
  updateProofDigest(digest, "symlink-target-mode", stat.mode.toString(8));
  if (stat.isSymbolicLink()) {
    updateProofDigest(digest, "symlink-target-link", fs.readlinkSync(entryPath));
    const targetPath = trackedProofInputSymlinkTarget(root, entryPath, logicalPath);
    updateProofDigest(digest, "symlink-target-resolved", proofInputRelativePath(root, targetPath));
    if (activeDirectories.has(targetPath)) {
      throw new Error(`tracked proof input symlink is broken or cyclic: ${logicalPath}`);
    }
    updateTrackedSymlinkTargetDigest(
      digest,
      root,
      targetPath,
      `${logicalPath}\0target`,
      activeDirectories,
    );
    return;
  }
  if (stat.isFile()) {
    const bytes = fs.readFileSync(entryPath);
    digest.update(`symlink-target-bytes:${bytes.length}:`);
    digest.update(bytes);
    digest.update("\0");
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`tracked proof input symlink target is unsupported: ${logicalPath}`);
  }

  const realDirectory = fs.realpathSync(entryPath);
  if (activeDirectories.has(realDirectory)) {
    throw new Error(`tracked proof input symlink is broken or cyclic: ${logicalPath}`);
  }
  activeDirectories.add(realDirectory);
  try {
    const children = fs.readdirSync(entryPath).sort();
    updateProofDigest(digest, "symlink-target-children", children.join("\0"));
    for (const child of children) {
      updateTrackedSymlinkTargetDigest(
        digest,
        root,
        path.join(entryPath, child),
        `${logicalPath}/${child}`,
        activeDirectories,
      );
    }
  } finally {
    activeDirectories.delete(realDirectory);
  }
}

function assertNoHiddenTrackedIndexFlags(cwd: string) {
  const entries = run("git", ["ls-files", "-v", "-z"], { cwd }).split("\0").filter(Boolean);
  for (const entry of entries) {
    const tag = entry[0] ?? "";
    if (tag === "S" || (/[A-Za-z]/.test(tag) && tag === tag.toLowerCase())) {
      throw new Error(
        `staged proof rejects hidden tracked index flags: ${entry.slice(2) || "unknown"}`,
      );
    }
  }
}

function updateProofDigest(digest: crypto.Hash, label: string, value: string) {
  digest.update(`${label}:${Buffer.byteLength(value)}:${value}\0`);
}

function validationCommandBudgetError(rendered: string, cause?: unknown) {
  return new Error(
    `validation command failed (${rendered}): validation command runtime budget exhausted`,
    cause === undefined ? undefined : { cause },
  );
}

export function preflightTargetValidationPlan(
  { fixArtifact, targetDir, baseBranch = DEFAULT_BASE_BRANCH }: LooseRecord,
  options: TargetValidationOptions,
) {
  const scriptInventory = readPackageScriptInventory(targetDir);
  const availableScripts = [...scriptInventory.rootScripts].sort();
  const resolved: string[] = [];
  const resolvedEntries: StagedProofCommandInput[] = [];
  const validationEnv = targetValidationEnv();
  for (const command of resolvedRequiredValidationCommandEntries(
    fixArtifact.validation_commands ?? [],
    targetDir,
    baseBranch,
    options,
    validationEnv,
  )) {
    resolvedEntries.push(command);
    const rendered = (command.displayParts ?? command.parts).join(" ");
    if (!resolved.includes(rendered)) resolved.push(rendered);
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

  const missing = missingRequiredPackageScript(resolvedEntries, scriptInventory);
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
  if (gate && !options.skipOpenClawChangedGate) {
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
  delete env.GITHUB_ENV;
  delete env.GITHUB_OUTPUT;
  delete env.GITHUB_PATH;
  delete env.GITHUB_STEP_SUMMARY;
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete env.ACTIONS_RUNTIME_TOKEN;
  delete env.ACTIONS_RUNTIME_URL;
  for (const key of Object.keys(env)) {
    if (/^CLAWSWEEPER_.*GH_TOKEN$/.test(key)) delete env[key];
  }
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

type PackageScriptInventory = {
  rootScripts: Set<string>;
  workspaces: Array<{
    name: string;
    relativePath: string;
    scripts: Set<string>;
  }>;
};

function readPackageScriptInventory(cwd: string): PackageScriptInventory {
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) return { rootScripts: new Set(), workspaces: [] };
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const patterns = workspacePackagePatterns(cwd, pkg);
    const workspaces = workspacePackagePaths(cwd, patterns).flatMap((relativePath) => {
      try {
        const workspace = JSON.parse(
          fs.readFileSync(path.join(cwd, relativePath, "package.json"), "utf8"),
        );
        return [
          {
            name: String(workspace.name ?? ""),
            relativePath,
            scripts: new Set<string>(Object.keys(workspace.scripts ?? {})),
          },
        ];
      } catch {
        return [];
      }
    });
    return {
      rootScripts: new Set<string>(Object.keys(pkg.scripts ?? {})),
      workspaces,
    };
  } catch {
    return { rootScripts: new Set(), workspaces: [] };
  }
}

function getToolchain(options: TargetValidationOptions): TargetRepoToolchain {
  return options.toolchain ?? resolveTargetRepoToolchain(options.targetRepo);
}

function missingRequiredPackageScript(
  commands: readonly { parts: readonly string[] }[],
  inventory: PackageScriptInventory,
) {
  for (const command of commands) {
    const script = packageScriptRequirement(command.parts);
    if (!script) continue;
    if (!script.workspaceScoped) {
      if (!inventory.rootScripts.has(script.name)) return script;
      continue;
    }
    const selected = selectWorkspacePackages(script, inventory.workspaces);
    if (selected === null) continue;
    if (
      selected.length === 0 ||
      (script.executable === "pnpm" && script.allWorkspaces
        ? !selected.some((workspace) => workspace.scripts.has(script.name))
        : selected.some((workspace) => !workspace.scripts.has(script.name)))
    ) {
      return script;
    }
  }
  return null;
}

function workspacePackagePatterns(cwd: string, rootPackage: LooseRecord): string[] {
  const packageWorkspaces = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : Array.isArray(rootPackage.workspaces?.packages)
      ? rootPackage.workspaces.packages
      : [];
  const pnpmWorkspacePath = path.join(cwd, "pnpm-workspace.yaml");
  let pnpmPackages: unknown[] = [];
  if (fs.existsSync(pnpmWorkspacePath)) {
    try {
      const parsed = parseYaml(fs.readFileSync(pnpmWorkspacePath, "utf8"));
      pnpmPackages = Array.isArray(parsed?.packages) ? parsed.packages : [];
    } catch {
      pnpmPackages = [];
    }
  }
  return uniqueStrings([...packageWorkspaces, ...pnpmPackages])
    .map((pattern) =>
      pattern
        .replaceAll("\\", "/")
        .replace(/^\.\/+/, "")
        .replace(/\/+$/, ""),
    )
    .filter(Boolean);
}

const MAX_WORKSPACE_PATTERN_LENGTH = 1_024;
const MAX_WORKSPACE_PATH_LENGTH = 4_096;
const MAX_WORKSPACE_PATTERNS = 256;
const MAX_WORKSPACE_PATTERN_OPERATORS = 128;

export type WorkspaceScanLimits = {
  maxDirectories: number;
  maxDepth: number;
  maxEntries: number;
  maxMatchOperations: number;
};

const DEFAULT_WORKSPACE_SCAN_LIMITS: WorkspaceScanLimits = {
  maxDirectories: 10_000,
  maxDepth: 64,
  maxEntries: 100_000,
  maxMatchOperations: 100_000,
};

export function workspacePackagePaths(
  cwd: string,
  patterns: readonly string[],
  overrides: Partial<WorkspaceScanLimits> = {},
): string[] {
  if (patterns.length === 0) return [];
  if (patterns.length > MAX_WORKSPACE_PATTERNS) {
    throw new Error("workspace pattern count exceeds the supported budget");
  }
  const limits = workspaceScanLimits(overrides);
  const includedPatterns = patterns
    .filter((pattern) => !pattern.startsWith("!"))
    .map(validateWorkspacePattern);
  const excludedPatterns = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => validateWorkspacePattern(pattern.slice(1)));
  if (includedPatterns.length === 0) return [];

  const matches: string[] = [];
  const pending = [{ directory: cwd, relativeDirectory: "", depth: 0 }];
  let visitedDirectories = 0;
  let visitedEntries = 0;
  let matchOperations = 0;
  const matchesPattern = (relativePath: string, candidates: readonly string[]) =>
    candidates.some((pattern) => {
      matchOperations += 1;
      if (matchOperations > limits.maxMatchOperations) {
        throw new Error("workspace glob evaluation exceeded the supported work budget");
      }
      return workspacePatternMatches(pattern, relativePath);
    });

  while (pending.length > 0) {
    const { directory, relativeDirectory, depth } = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
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
  }
  return [...new Set(matches)].sort();
}

export function workspacePatternMatches(pattern: string, relativePath: string): boolean {
  const boundedPattern = validateWorkspacePattern(pattern);
  validateWorkspacePath(relativePath);
  try {
    return path.posix.matchesGlob(relativePath, boundedPattern);
  } catch {
    throw new Error("workspace pattern is not a valid supported glob");
  }
}

function validateWorkspacePattern(pattern: string): string {
  if (!pattern || pattern.length > MAX_WORKSPACE_PATTERN_LENGTH) {
    throw new Error("workspace pattern exceeds the maximum supported length");
  }
  if (pattern.includes("\0")) {
    throw new Error("workspace pattern contains a null byte");
  }
  const operators = [...pattern].filter((character) => "*?[]{}(),".includes(character)).length;
  if (operators > MAX_WORKSPACE_PATTERN_OPERATORS) {
    throw new Error("workspace pattern exceeds the supported operator budget");
  }
  return pattern;
}

function validateWorkspacePath(relativePath: string) {
  if (relativePath.length > MAX_WORKSPACE_PATH_LENGTH) {
    throw new Error("workspace path exceeds the maximum supported length");
  }
}

function workspaceScanLimits(overrides: Partial<WorkspaceScanLimits>): WorkspaceScanLimits {
  const limits = { ...DEFAULT_WORKSPACE_SCAN_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`workspace ${name} must be a positive integer`);
    }
  }
  return limits;
}

function selectWorkspacePackages(
  script: NonNullable<ReturnType<typeof packageScriptRequirement>>,
  workspaces: PackageScriptInventory["workspaces"],
): PackageScriptInventory["workspaces"] | null {
  if (
    script.executable === "pnpm" &&
    script.workspaceSelectors.some((selector) => !locallyEvaluablePnpmSelector(selector))
  ) {
    return null;
  }
  if (script.workspaceSelectors.length === 0) {
    return script.allWorkspaces ? workspaces : [];
  }
  return workspaces.filter((workspace) =>
    script.workspaceSelectors.some((selector) => workspaceSelectorMatches(selector, workspace)),
  );
}

function locallyEvaluablePnpmSelector(selector: string) {
  return (
    !["!", "[", "]", "{", "}", "^"].some((operator) => selector.includes(operator)) &&
    !selector.includes("...")
  );
}

function workspaceSelectorMatches(
  selector: string,
  workspace: PackageScriptInventory["workspaces"][number],
) {
  const normalized = selector.replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (normalized === workspace.name || normalized === workspace.relativePath) return true;
  if (!normalized.includes("*")) return false;
  return (
    workspacePatternMatches(normalized, workspace.name) ||
    workspacePatternMatches(normalized, workspace.relativePath)
  );
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
        const displayParts = requireWorkspaceMatchFailure(parts);
        const concreteParts = requireWorkspaceMatchFailure(
          validateAllowedValidationCommandParts(
            resolveValidationCommandEnvironment(parts, validationEnv),
            command.command,
          ),
        );
        const canonical =
          command.canonical ||
          changedGateCommandParts(toolchain.changedGate, concreteParts) !== null;
        return {
          parts: concreteParts,
          displayParts,
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
