import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { runCommand as run, runContainedCommand } from "./command-runner.js";
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
  isUnsafeValidationEnvironmentName,
  looksLikePathArgument,
  packageManagerCommandIndex,
  packageManagerWorkspaceScoped,
  packageScriptRequirement,
  parseAllowedValidationCommand,
  requireWorkspaceMatchFailure,
  stripEnvPrefix,
  uniqueStrings,
  validationCommandForExecution,
  vitestPathFilterIndexes,
} from "./validation-command-utils.js";

const DEFAULT_BASE_BRANCH = "main";
const DEFAULT_TARGET_SETUP_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_TARGET_INSTALL_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_TARGET_VALIDATION_TIMEOUT_MS = 12 * 60 * 1000;
const MIN_VALIDATION_RETRY_BUDGET_MS = 1_000;
const verifiedRustupToolchainBins = new Map<string, VerifiedRustupToolchain>();
const preparedTargetPnpmRuntimes = new Map<string, PreparedTargetPnpmRuntime>();
let preparedTargetPnpmRuntimeCleanupRegistered = false;

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

export type TargetValidationExecution = {
  commands: string[];
  checkoutBinding: TargetCheckoutBinding;
};

export type TargetCommitIdentity = {
  name: string;
  email: string;
};

export type TargetCheckpointCommit =
  | {
      status: "unchanged";
      commit: string;
      tree: string;
    }
  | {
      status: "committed";
      commit: string;
      previous_head: string;
      tree: string;
    };

export type TargetHistoryCompaction =
  | {
      status: "unchanged";
      commit: string;
      previous_commit_count: number;
      tree: string;
    }
  | {
      status: "compacted";
      commit: string;
      previous_head: string;
      previous_commit_count: number;
      tree: string;
    };

export type TargetRebaseResult = {
  status: "already-current" | "rebased" | "conflicts";
  base_ref: string;
  base_sha: string;
  previous_head: string;
  current_head: string;
  detail?: string;
};

export type TargetCompleteRebaseResult = {
  status: "not-in-progress" | "continued";
  previous_head: string;
  current_head: string;
  detail?: string;
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
  clearPreparedTargetPnpmRuntime(cwd);
  if (!options.installTargetDeps) return;
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) return;

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
  const deadlineAt = Date.now() + Math.max(setupTimeoutMs, installTimeoutMs);
  const sourceIdentity = validationSourceIdentity(cwd, deadlineAt);
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const toolchain = getToolchain(options);
  return withTargetValidationEnvironment((validationEnv) => {
    let setupError: Error | null = null;
    let preparedPnpmPackageManager: string | null = null;
    try {
      run(
        "node",
        [
          "-e",
          "const major = Number(process.versions.node.split('.')[0]); if (major < 22) { console.error(`Node ${process.version} is too old for target validation`); process.exit(1); }",
        ],
        {
          cwd,
          env: validationEnv,
          timeoutMs: targetToolchainCommandTimeout(deadlineAt, setupTimeoutMs, "node setup probe"),
        },
      );

      if (toolchain.packageManager === "bun") {
        prepareBunToolchain({
          cwd,
          validationEnv,
          setupTimeoutMs,
          installTimeoutMs,
          deadlineAt,
        });
      } else if (toolchain.packageManager === "npm") {
        prepareNpmToolchain({ cwd, validationEnv, installTimeoutMs, deadlineAt });
      } else {
        preparedPnpmPackageManager = preparePnpmToolchain({
          cwd,
          packageJson,
          validationEnv,
          setupTimeoutMs,
          installTimeoutMs,
          deadlineAt,
        });
      }
    } catch (error) {
      setupError = error as Error;
    }
    try {
      assertValidationSourceIdentity(cwd, sourceIdentity, deadlineAt);
    } catch (error) {
      if (!setupError || !isValidationIdentityDeadlineError(error)) throw error;
    }
    if (setupError) throw setupError;
    if (preparedPnpmPackageManager) {
      const preparedSourceIdentity = validationSourceIdentity(cwd, deadlineAt);
      storePreparedTargetPnpmRuntime({
        cwd,
        deadlineAt,
        packageManager: preparedPnpmPackageManager,
        sourceCorepackHome: String(validationEnv.COREPACK_HOME),
        sourceIdentity: preparedSourceIdentity,
      });
    }
  });
}

function preparePnpmToolchain({
  cwd,
  packageJson,
  validationEnv,
  setupTimeoutMs,
  installTimeoutMs,
  deadlineAt,
}: {
  cwd: string;
  packageJson: LooseRecord;
  validationEnv: NodeJS.ProcessEnv;
  setupTimeoutMs: number;
  installTimeoutMs: number;
  deadlineAt: number;
}) {
  const packageManager = targetPnpmPackageManager(packageJson);
  const corepackBin = path.join(String(validationEnv.COREPACK_HOME), "bin");
  run("corepack", ["enable", "--install-directory", corepackBin], {
    cwd,
    env: validationEnv,
    timeoutMs: targetToolchainCommandTimeout(deadlineAt, setupTimeoutMs, "corepack enable"),
  });
  run("corepack", ["prepare", packageManager, "--activate"], {
    cwd,
    env: validationEnv,
    timeoutMs: targetToolchainCommandTimeout(deadlineAt, setupTimeoutMs, "corepack prepare"),
  });
  const installArgs = [
    "install",
    "--frozen-lockfile",
    "--prefer-offline",
    "--ignore-scripts",
    "--config.engine-strict=false",
    "--config.enable-pre-post-scripts=false",
  ];
  const lockfileSnapshot = captureTargetFile(cwd, "pnpm-lock.yaml");
  try {
    run("pnpm", installArgs, {
      cwd,
      env: validationEnv,
      timeoutMs: targetToolchainCommandTimeout(deadlineAt, installTimeoutMs, "pnpm install"),
    });
  } catch (error) {
    if (!/ERR_PNPM_OUTDATED_LOCKFILE/i.test(String(error.message))) throw error;
    run(
      "pnpm",
      installArgs.map((arg) => (arg === "--frozen-lockfile" ? "--no-frozen-lockfile" : arg)),
      {
        cwd,
        env: validationEnv,
        timeoutMs: targetToolchainCommandTimeout(
          deadlineAt,
          installTimeoutMs,
          "pnpm install fallback",
        ),
      },
    );
    restoreTargetFile(cwd, lockfileSnapshot);
    run("pnpm", installArgs, {
      cwd,
      env: validationEnv,
      timeoutMs: targetToolchainCommandTimeout(
        deadlineAt,
        installTimeoutMs,
        "pnpm frozen reinstall",
      ),
    });
  }
  return packageManager;
}

function prepareBunToolchain({
  cwd,
  validationEnv,
  setupTimeoutMs,
  installTimeoutMs,
  deadlineAt,
}: {
  cwd: string;
  validationEnv: NodeJS.ProcessEnv;
  setupTimeoutMs: number;
  installTimeoutMs: number;
  deadlineAt: number;
}) {
  // The repair execution workflow provisions pinned Bun before this path runs.
  // Keep a clear fail-fast probe so local/manual runners surface setup gaps early.
  //
  // ClawSweeper itself runs under pnpm (e.g. `pnpm run repair:execute-fix`), so
  // process.env carries pnpm-injected `npm_config_user_agent=pnpm/...`. When we
  // shell out to `bun install` for a target repo whose package.json has a
  // preinstall hook like `bunx only-allow bun` (e.g. openclaw/clawhub), bun
  // forwards the parent env to the preinstall script and `only-allow` reads the
  // pnpm user-agent and refuses to run. Strip caller identity/lifecycle metadata;
  // the shared validation environment already removed credentials and
  // execution-controlling path configuration.
  const bunEnv = sanitizeEnvForBun(validationEnv);
  run("bun", ["--version"], {
    cwd,
    env: bunEnv,
    timeoutMs: targetToolchainCommandTimeout(deadlineAt, setupTimeoutMs, "bun setup probe"),
  });
  const installArgs = ["install", "--frozen-lockfile", "--ignore-scripts"];
  const lockfileSnapshots = ["bun.lock", "bun.lockb"].map((lockfile) =>
    captureTargetFile(cwd, lockfile),
  );
  try {
    run("bun", installArgs, {
      cwd,
      env: bunEnv,
      timeoutMs: targetToolchainCommandTimeout(deadlineAt, installTimeoutMs, "bun install"),
    });
  } catch (error) {
    const message = String(error?.message ?? "");
    if (!/lockfile|frozen|out of date|out-of-date/i.test(message)) throw error;
    run("bun", ["install", "--no-frozen-lockfile", "--ignore-scripts"], {
      cwd,
      env: bunEnv,
      timeoutMs: targetToolchainCommandTimeout(
        deadlineAt,
        installTimeoutMs,
        "bun install fallback",
      ),
    });
    for (const snapshot of lockfileSnapshots) restoreTargetFile(cwd, snapshot);
    run("bun", installArgs, {
      cwd,
      env: bunEnv,
      timeoutMs: targetToolchainCommandTimeout(
        deadlineAt,
        installTimeoutMs,
        "bun frozen reinstall",
      ),
    });
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
  deadlineAt,
}: {
  cwd: string;
  validationEnv: NodeJS.ProcessEnv;
  installTimeoutMs: number;
  deadlineAt: number;
}) {
  const installArgs = fs.existsSync(path.join(cwd, "package-lock.json"))
    ? ["ci", "--ignore-scripts"]
    : ["install", "--no-package-lock", "--ignore-scripts"];
  run("npm", installArgs, {
    cwd,
    env: validationEnv,
    timeoutMs: targetToolchainCommandTimeout(deadlineAt, installTimeoutMs, "npm install"),
  });
}

export function runAllowedValidationCommands(
  commands: LooseRecord[],
  cwd: string,
  options: TargetValidationOptions,
  baseBranch: string = DEFAULT_BASE_BRANCH,
) {
  return runAllowedValidationCommandsWithBinding(commands, cwd, options, baseBranch).commands;
}

export function runAllowedValidationCommandsWithBinding(
  commands: LooseRecord[],
  cwd: string,
  options: TargetValidationOptions,
  baseBranch: string = DEFAULT_BASE_BRANCH,
): TargetValidationExecution {
  const baseRef = validationBaseRef(cwd, baseBranch, options);
  const requiredCommands = requiredValidationCommands(commands, cwd, options);
  const needsRustToolchain = targetValidationNeedsRustToolchain(cwd, requiredCommands);
  const preparedPnpmRuntime = preparedPnpmRuntimeForValidation(cwd, options);
  return withTargetValidationEnvironment((validationEnv, resetValidationEnvironment) => {
    const validationTimeoutMs = targetValidationTimeoutMs(
      "CLAWSWEEPER_TARGET_VALIDATION_TIMEOUT_MS",
      options.validationTimeoutMs ?? DEFAULT_TARGET_VALIDATION_TIMEOUT_MS,
      options.validationTimeoutMs,
    );
    const checkoutIdentity = validationCheckoutIdentity(
      cwd,
      baseRef,
      Date.now() + validationTimeoutMs,
    );
    if (
      preparedPnpmRuntime &&
      !sameValidationSourceIdentity(
        sourceIdentityFromCheckout(checkoutIdentity),
        preparedPnpmRuntime.sourceIdentity,
      )
    ) {
      throw new Error(
        "prepared target pnpm toolchain is stale; refresh dependencies before validation",
      );
    }
    const executed: string[] = [];
    const attempts = new Map<string, number>();
    let rustToolchainPrepared = !needsRustToolchain;
    if (requiredCommands.length === 0) {
      throw new Error(
        "validation_command_missing: no configured or artifact validation command is available",
      );
    }
    for (const command of requiredCommands) {
      const resolvedCommands = resolveAllowedValidationCommands(command, cwd, baseBranch, options);
      for (const parts of resolvedCommands) {
        const rendered = parts.join(" ");
        if (executed.includes(rendered)) continue;
        assertNoUnsafeBunLifecycleHooks(cwd, parts);
        const startedAt = Date.now();
        const deadlineAt = startedAt + validationTimeoutMs;
        const identityReserveMs = validationIdentityReserveMs(validationTimeoutMs);
        while (true) {
          let executionError: Error | null = null;
          try {
            resetValidationEnvironment(deadlineAt - identityReserveMs);
            if (!rustToolchainPrepared) {
              rustToolchainPrepared = true;
              const rustupToolchainBin = verifiedRustupToolchainBin(deadlineAt, identityReserveMs);
              if (rustupToolchainBin) prependValidationPath(validationEnv, rustupToolchainBin);
            }
            const executionParts = validationCommandForExecution(parts);
            const executionBudgetMs = remainingCommandBudget(deadlineAt, identityReserveMs);
            if (executionBudgetMs <= 0) throw validationCommandBudgetError(rendered);
            runContainedCommand(executionParts[0]!, executionParts.slice(1), {
              cwd,
              env: validationEnv,
              timeoutMs: executionBudgetMs,
            });
          } catch (error) {
            executionError = error as Error;
          }
          assertValidationCheckoutIdentityWithinCommand(
            cwd,
            baseRef,
            checkoutIdentity,
            deadlineAt,
            rendered,
            executionError,
          );
          if (!executionError) {
            executed.push(rendered);
            break;
          }

          const fallbackCommands = validationFallbackCommands({
            parts,
            error: executionError,
            cwd,
            baseBranch,
            baseRef,
            options,
          });
          if (fallbackCommands.length > 0) {
            for (const fallbackParts of fallbackCommands) {
              const fallbackRendered = fallbackParts.join(" ");
              if (executed.includes(fallbackRendered)) continue;
              let fallbackError: Error | null = null;
              try {
                resetValidationEnvironment(deadlineAt - identityReserveMs);
                const fallbackBudgetMs = remainingCommandBudget(deadlineAt, identityReserveMs);
                if (fallbackBudgetMs <= 0) {
                  throw validationCommandBudgetError(rendered, executionError);
                }
                const executionParts = validationCommandForExecution(fallbackParts);
                runContainedCommand(executionParts[0]!, executionParts.slice(1), {
                  cwd,
                  env: validationEnv,
                  timeoutMs: fallbackBudgetMs,
                });
              } catch (error) {
                fallbackError = error as Error;
              }
              assertValidationCheckoutIdentityWithinCommand(
                cwd,
                baseRef,
                checkoutIdentity,
                deadlineAt,
                rendered,
                fallbackError ?? executionError,
              );
              if (fallbackError) throw fallbackError;
              executed.push(fallbackRendered);
            }
            break;
          }
          const retryBudgetMs = remainingCommandBudget(deadlineAt, identityReserveMs);
          if (
            retryBudgetMs >= MIN_VALIDATION_RETRY_BUDGET_MS &&
            shouldRetryValidationCommand({ parts, error: executionError, attempts, options })
          ) {
            continue;
          }
          if (retryBudgetMs <= 0) throw validationCommandBudgetError(rendered, executionError);
          throw new Error(
            `validation command failed (${rendered}): ${compactText(executionError.message, 12000)}`,
            { cause: executionError },
          );
        }
      }
    }
    return {
      commands: executed,
      checkoutBinding: sourceIdentityFromCheckout(checkoutIdentity),
    };
  }, preparedPnpmRuntime);
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

  const missing = requiredScripts.find(
    (script: JsonValue) => !targetPackageScriptIsAvailable(targetDir, scripts, script),
  );
  const unsafe = requiredScripts
    .map((script) => unsafeBunLifecycleHook(targetDir, script))
    .find((value): value is NonNullable<typeof value> => value !== null);
  if (unsafe) {
    return {
      status: "blocked",
      code: "validation_script_unsafe",
      required: unsafe.command,
      unsafe_hook: unsafe.hook,
      available_scripts: availableScripts,
      resolved_commands: resolved,
      reason: `validation_script_unsafe: Bun would execute ${unsafe.hook} around ${unsafe.command}`,
    };
  }
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

type TargetFileSnapshot =
  | { relativePath: string; kind: "absent" }
  | { relativePath: string; kind: "file"; contents: Buffer; mode: number }
  | { relativePath: string; kind: "symlink"; target: string };

function captureTargetFile(cwd: string, relativePath: string): TargetFileSnapshot {
  const filePath = path.join(cwd, relativePath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { relativePath, kind: "absent" };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return { relativePath, kind: "symlink", target: fs.readlinkSync(filePath) };
  }
  if (!stat.isFile()) {
    throw new Error(`unsupported target lockfile type: ${relativePath}`);
  }
  return {
    relativePath,
    kind: "file",
    contents: fs.readFileSync(filePath),
    mode: stat.mode,
  };
}

function restoreTargetFile(cwd: string, snapshot: TargetFileSnapshot) {
  const filePath = path.join(cwd, snapshot.relativePath);
  fs.rmSync(filePath, { recursive: true, force: true });
  if (snapshot.kind === "absent") return;
  if (snapshot.kind === "symlink") {
    fs.symlinkSync(snapshot.target, filePath);
    return;
  }
  fs.writeFileSync(filePath, snapshot.contents, { mode: snapshot.mode });
  fs.chmodSync(filePath, snapshot.mode);
}

type ValidationSourceIdentity = {
  contentTreeSha: string;
  gitAdminSha256: string;
  headSha: string;
  runtimeInputsSha256: string;
  treeSha: string;
  status: string;
  worktreeSha256: string;
};

export type TargetCheckoutBinding = ValidationSourceIdentity;

type ValidationCheckoutIdentity = ValidationSourceIdentity & {
  baseSha: string;
};

type PreparedTargetPnpmRuntime = {
  corepackHome: string;
  packageManager: string;
  root: string;
  runtimeSha256: string;
  sourceIdentity: ValidationSourceIdentity;
};

function sourceIdentityFromCheckout(identity: ValidationCheckoutIdentity): TargetCheckoutBinding {
  return {
    contentTreeSha: identity.contentTreeSha,
    gitAdminSha256: identity.gitAdminSha256,
    headSha: identity.headSha,
    runtimeInputsSha256: identity.runtimeInputsSha256,
    treeSha: identity.treeSha,
    status: identity.status,
    worktreeSha256: identity.worktreeSha256,
  };
}

export function captureTargetCheckoutBinding(
  cwd: string,
  timeoutMs = DEFAULT_TARGET_VALIDATION_TIMEOUT_MS,
): TargetCheckoutBinding {
  return validationSourceIdentity(cwd, Date.now() + timeoutMs);
}

export function assertTargetCheckoutBinding(
  cwd: string,
  expected: TargetCheckoutBinding,
  timeoutMs = DEFAULT_TARGET_VALIDATION_TIMEOUT_MS,
) {
  const actual = captureTargetCheckoutBinding(cwd, timeoutMs);
  if (!sameValidationSourceIdentity(actual, expected)) {
    throw new Error("target checkout changed after validation");
  }
}

export function assertTargetPublicationGitConfiguration(
  cwd: string,
  timeoutMs = DEFAULT_TARGET_VALIDATION_TIMEOUT_MS,
) {
  const deadlineAt = Date.now() + timeoutMs;
  assertCallbackFreeGitConfig(cwd, deadlineAt);
  assertNoHiddenIndexEntries(cwd, deadlineAt);
}

export function captureFinalTargetCheckoutBinding(
  cwd: string,
  accepted: TargetCheckoutBinding,
  expectedHeadSha: string,
  timeoutMs = DEFAULT_TARGET_VALIDATION_TIMEOUT_MS,
): TargetCheckoutBinding {
  const actual = captureTargetCheckoutBinding(cwd, timeoutMs);
  if (
    actual.headSha !== expectedHeadSha ||
    actual.status !== "" ||
    actual.treeSha !== accepted.contentTreeSha ||
    actual.contentTreeSha !== accepted.contentTreeSha ||
    actual.runtimeInputsSha256 !== accepted.runtimeInputsSha256 ||
    actual.worktreeSha256 !== accepted.worktreeSha256
  ) {
    throw new Error("target checkout content changed after validation");
  }
  return actual;
}

export function commitTargetCheckoutWithPlumbing({
  cwd,
  messages,
  identity,
  timeoutMs = DEFAULT_TARGET_VALIDATION_TIMEOUT_MS,
}: {
  cwd: string;
  messages: readonly string[];
  identity: TargetCommitIdentity;
  timeoutMs?: number;
}): string {
  return createTargetCheckpointWithPlumbing({
    cwd,
    messages,
    identity,
    timeoutMs,
  }).commit;
}

export function switchTargetBranchWithPlumbing({
  cwd,
  branch,
  expectedHeadSha,
  timeoutMs = DEFAULT_TARGET_VALIDATION_TIMEOUT_MS,
}: {
  cwd: string;
  branch: string;
  expectedHeadSha: string;
  timeoutMs?: number;
}) {
  if (!branch || branch.includes("\0") || !/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new Error("invalid target branch name");
  }
  const deadlineAt = Date.now() + timeoutMs;
  assertCallbackFreeGitConfig(cwd, deadlineAt);
  assertNoHiddenIndexEntries(cwd, deadlineAt);
  return withIsolatedTargetGit(cwd, deadlineAt, (git) => {
    const branchRef = `refs/heads/${branch}`;
    git.run(["check-ref-format", "--branch", branch], "replacement branch validation");
    const currentHead = git.run(["rev-parse", "HEAD"], "replacement branch head");
    if (currentHead !== expectedHeadSha) {
      throw new Error("target checkout head changed before branch switch");
    }
    const previousHeadRef = git.run(["symbolic-ref", "HEAD"], "replacement previous HEAD ref");
    const previousBranchSha = git.run(
      ["for-each-ref", "--format=%(objectname)", branchRef],
      "replacement previous branch ref",
    );
    assertTargetBranchNotAttachedElsewhere(git, cwd, branchRef);
    const reserveMs = targetGitRollbackReserveMs(git.deadlineAt);
    try {
      git.run(
        [
          "update-ref",
          "-m",
          "clawsweeper replacement branch",
          branchRef,
          currentHead,
          previousBranchSha || "0".repeat(currentHead.length),
        ],
        "replacement branch ref update",
        { reserveMs },
      );
      git.run(
        ["symbolic-ref", "-m", "clawsweeper replacement branch", "HEAD", branchRef],
        "replacement branch HEAD update",
        { reserveMs },
      );
      if (
        git.run(["rev-parse", "HEAD"], "replacement branch result", { reserveMs }) !==
          currentHead ||
        git.run(["symbolic-ref", "HEAD"], "replacement branch symbolic ref", { reserveMs }) !==
          branchRef
      ) {
        throw new Error("target branch switch did not preserve the validated head");
      }
    } catch (error) {
      rollbackTargetBranchSwitch(
        git,
        { branchRef, currentHead, previousBranchSha, previousHeadRef },
        error,
      );
    }
    return currentHead;
  });
}

export function materializeTargetCommitWithIsolation({
  cwd,
  expectedHeadSha,
  timeoutMs = DEFAULT_TARGET_VALIDATION_TIMEOUT_MS,
}: {
  cwd: string;
  expectedHeadSha: string;
  timeoutMs?: number;
}) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(expectedHeadSha)) {
    throw new Error("invalid target commit object id");
  }
  const deadlineAt = Date.now() + timeoutMs;
  assertCallbackFreeGitConfig(cwd, deadlineAt);
  assertNoHiddenIndexEntries(cwd, deadlineAt);
  return withIsolatedTargetGit(cwd, deadlineAt, (git) => {
    const commit = git.run(
      ["rev-parse", "--verify", `${expectedHeadSha}^{commit}`],
      "materialized target commit",
    );
    if (commit !== expectedHeadSha) {
      throw new Error("target commit resolved to an unexpected object");
    }
    const previousHead = git.run(["rev-parse", "HEAD"], "materialized target previous head");
    const status = git.run(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      "materialized target initial status",
      { trim: false },
    );
    if (status) {
      throw new Error("cannot materialize target commit over a changed checkout");
    }
    git.run(
      ["reset", "--hard", "--no-recurse-submodules", expectedHeadSha],
      "materialize target commit",
    );
    const materializedHead = git.run(["rev-parse", "HEAD"], "materialized target result");
    const materializedStatus = git.run(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      "materialized target result status",
      { trim: false },
    );
    if (materializedHead !== expectedHeadSha || materializedStatus) {
      throw new Error("target commit materialization did not produce the expected clean checkout");
    }
    return {
      previous_head: previousHead,
      current_head: materializedHead,
    };
  });
}

export function rebaseTargetOntoVerifiedBase({
  cwd,
  baseRef,
  timeoutMs = DEFAULT_TARGET_VALIDATION_TIMEOUT_MS,
}: {
  cwd: string;
  baseRef: string;
  timeoutMs?: number;
}): TargetRebaseResult {
  if (!baseRef || baseRef.includes("\0")) throw new Error("invalid target rebase base");
  const deadlineAt = Date.now() + timeoutMs;
  assertCallbackFreeGitConfig(cwd, deadlineAt);
  assertNoHiddenIndexEntries(cwd, deadlineAt);
  return withIsolatedTargetGit(cwd, deadlineAt, (git) => {
    const baseSha = git.run(["rev-parse", "--verify", `${baseRef}^{commit}`], "target rebase base");
    const previousHead = git.run(["rev-parse", "HEAD"], "target rebase previous head");
    const mergeBase = git.run(["merge-base", baseSha, previousHead], "target rebase merge base");
    if (mergeBase === baseSha) {
      return {
        status: "already-current",
        base_ref: baseRef,
        base_sha: baseSha,
        previous_head: previousHead,
        current_head: previousHead,
      };
    }
    try {
      const detail = git.run(
        ["-c", "rebase.autoStash=false", "-c", "rebase.updateRefs=false", "rebase", baseSha],
        "isolated target rebase",
        { env: isolatedTargetRebaseEnv() },
      );
      return {
        status: "rebased",
        base_ref: baseRef,
        base_sha: baseSha,
        previous_head: previousHead,
        current_head: git.run(["rev-parse", "HEAD"], "target rebase result"),
        detail,
      };
    } catch (error) {
      if (
        targetRebaseInProgress(cwd, git) ||
        targetUnmergedPaths(git, "target rebase conflicts").length > 0
      ) {
        return {
          status: "conflicts",
          base_ref: baseRef,
          base_sha: baseSha,
          previous_head: previousHead,
          current_head: git.run(["rev-parse", "HEAD"], "target conflicted rebase head"),
          detail: String((error as Error).message ?? error),
        };
      }
      throw error;
    }
  });
}

export function completeTargetRebaseWithIsolation({
  cwd,
  timeoutMs = DEFAULT_TARGET_VALIDATION_TIMEOUT_MS,
}: {
  cwd: string;
  timeoutMs?: number;
}): TargetCompleteRebaseResult {
  const deadlineAt = Date.now() + timeoutMs;
  assertCallbackFreeGitConfig(cwd, deadlineAt);
  assertNoHiddenIndexEntries(cwd, deadlineAt);
  return withIsolatedTargetGit(cwd, deadlineAt, (git) => {
    const previousHead = git.run(["rev-parse", "HEAD"], "target rebase continuation head");
    if (!targetRebaseInProgress(cwd, git)) {
      return {
        status: "not-in-progress",
        previous_head: previousHead,
        current_head: previousHead,
      };
    }
    const unresolved = targetUnmergedPaths(git, "target rebase unresolved paths");
    assertNoTargetConflictMarkers(cwd, unresolved);
    git.run(["add", "--all"], "stage resolved target rebase");
    const remaining = targetUnmergedPaths(git, "target rebase remaining paths");
    if (remaining.length > 0) {
      throw new Error(`rebase conflicts remain unresolved: ${remaining.join(", ")}`);
    }
    let detail = "";
    while (targetRebaseInProgress(cwd, git)) {
      try {
        detail = git.run(
          ["-c", "core.editor=true", "rebase", "--continue"],
          "continue isolated target rebase",
          { env: isolatedTargetRebaseEnv() },
        );
      } catch (error) {
        const newConflicts = targetUnmergedPaths(git, "target rebase continuation conflicts");
        if (newConflicts.length > 0) {
          throw new Error(`rebase produced additional conflicts: ${newConflicts.join(", ")}`, {
            cause: error,
          });
        }
        throw error;
      }
    }
    return {
      status: "continued",
      previous_head: previousHead,
      current_head: git.run(["rev-parse", "HEAD"], "continued target rebase result"),
      detail,
    };
  });
}

function isolatedTargetRebaseEnv(): NodeJS.ProcessEnv {
  return {
    GIT_EDITOR: "true",
    GIT_MERGE_AUTOEDIT: "no",
    GIT_SEQUENCE_EDITOR: "true",
  };
}

function targetRebaseInProgress(cwd: string, git: IsolatedTargetGit) {
  const gitDir = fs.realpathSync(
    path.resolve(cwd, git.run(["rev-parse", "--absolute-git-dir"], "target rebase Git directory")),
  );
  return (
    fs.existsSync(path.join(gitDir, "rebase-merge")) ||
    fs.existsSync(path.join(gitDir, "rebase-apply"))
  );
}

function targetUnmergedPaths(git: IsolatedTargetGit, operation: string) {
  return git
    .run(["diff", "--name-only", "--diff-filter=U", "-z"], operation, { trim: false })
    .split("\0")
    .filter(Boolean);
}

function assertNoTargetConflictMarkers(cwd: string, paths: readonly string[]) {
  const unresolved = paths.filter((relativePath) => {
    const absolutePath = path.join(cwd, relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) return false;
    return /^<{7} |^={7}$|^>{7} /m.test(fs.readFileSync(absolutePath, "utf8"));
  });
  if (unresolved.length > 0) {
    throw new Error(`rebase conflicts remain unresolved: ${unresolved.join(", ")}`);
  }
}

function assertTargetBranchNotAttachedElsewhere(
  git: IsolatedTargetGit,
  cwd: string,
  branchRef: string,
) {
  const currentWorktree = fs.realpathSync(cwd);
  let worktreePath = "";
  const fields = git
    .run(["worktree", "list", "--porcelain", "-z"], "replacement linked worktrees", {
      trim: false,
    })
    .split("\0");
  for (const field of fields) {
    if (field.startsWith("worktree ")) {
      worktreePath = field.slice("worktree ".length);
      continue;
    }
    if (field !== `branch ${branchRef}` || !worktreePath) continue;
    let attachedWorktree = path.resolve(worktreePath);
    try {
      attachedWorktree = fs.realpathSync(attachedWorktree);
    } catch {}
    if (attachedWorktree !== currentWorktree) {
      throw new Error(`target branch is attached to another worktree: ${branchRef}`);
    }
  }
}

function rollbackTargetBranchSwitch(
  git: IsolatedTargetGit,
  state: {
    branchRef: string;
    currentHead: string;
    previousBranchSha: string;
    previousHeadRef: string;
  },
  cause: unknown,
): never {
  const failures: unknown[] = [];
  try {
    const actualHeadRef = git.run(["symbolic-ref", "HEAD"], "replacement HEAD rollback inspection");
    if (actualHeadRef === state.branchRef && actualHeadRef !== state.previousHeadRef) {
      git.run(
        ["symbolic-ref", "-m", "clawsweeper replacement rollback", "HEAD", state.previousHeadRef],
        "replacement HEAD rollback",
      );
    } else if (actualHeadRef !== state.previousHeadRef) {
      throw new Error(`replacement rollback found unexpected HEAD ref ${actualHeadRef}`);
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    const actualBranchSha = git.run(
      ["for-each-ref", "--format=%(objectname)", state.branchRef],
      "replacement branch rollback inspection",
    );
    if (actualBranchSha === state.currentHead) {
      if (state.previousBranchSha) {
        git.run(
          [
            "update-ref",
            "-m",
            "clawsweeper replacement rollback",
            state.branchRef,
            state.previousBranchSha,
            state.currentHead,
          ],
          "replacement branch rollback",
        );
      } else {
        git.run(
          ["update-ref", "-d", state.branchRef, state.currentHead],
          "replacement branch rollback",
        );
      }
    } else if (actualBranchSha !== state.previousBranchSha) {
      throw new Error(`replacement rollback found unexpected branch ref ${actualBranchSha}`);
    }
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new Error("replacement branch switch failed and rollback was not proven", {
      cause: new AggregateError([cause, ...failures]),
    });
  }
  throw cause;
}

export function createTargetCheckpointWithPlumbing({
  cwd,
  messages,
  identity,
  timeoutMs = DEFAULT_TARGET_VALIDATION_TIMEOUT_MS,
}: {
  cwd: string;
  messages: readonly string[];
  identity: TargetCommitIdentity;
  timeoutMs?: number;
}): TargetCheckpointCommit {
  validateTargetCommitMessages(messages);
  const deadlineAt = Date.now() + timeoutMs;
  assertCallbackFreeGitConfig(cwd, deadlineAt);
  assertNoHiddenIndexEntries(cwd, deadlineAt);
  return withIsolatedTargetGit(cwd, deadlineAt, (git) => {
    const previousHead = git.run(["rev-parse", "HEAD"], "checkpoint parent");
    const previousTree = git.run(["rev-parse", "HEAD^{tree}"], "checkpoint parent tree");
    const indexTree = git.run(["write-tree"], "checkpoint current index");
    const contentTree = buildRawWorktreeTree(cwd, git);
    if (contentTree === previousTree) {
      if (indexTree !== previousTree) {
        throw new Error("target index differs from unchanged worktree content");
      }
      return { status: "unchanged", commit: previousHead, tree: previousTree };
    }
    const commit = createTargetCommitObject(git, contentTree, previousHead, messages, identity);
    const indexSnapshot = captureTargetIndexSnapshot(cwd, git);
    try {
      synchronizeTargetIndex(git, commit, "checkpoint index synchronization");
    } catch (error) {
      restoreTargetIndexAfterFailure(indexSnapshot, error);
    }
    try {
      updateTargetHead(git, commit, previousHead);
    } catch (error) {
      restoreTargetIndexAfterFailure(indexSnapshot, error);
    }
    return {
      status: "committed",
      commit,
      previous_head: previousHead,
      tree: contentTree,
    };
  });
}

export function compactTargetHistoryWithPlumbing({
  cwd,
  baseRef,
  messages,
  identity,
  timeoutMs = DEFAULT_TARGET_VALIDATION_TIMEOUT_MS,
}: {
  cwd: string;
  baseRef: string;
  messages: readonly string[];
  identity: TargetCommitIdentity;
  timeoutMs?: number;
}): TargetHistoryCompaction {
  validateTargetCommitMessages(messages);
  const deadlineAt = Date.now() + timeoutMs;
  assertCallbackFreeGitConfig(cwd, deadlineAt);
  assertNoHiddenIndexEntries(cwd, deadlineAt);
  return withIsolatedTargetGit(cwd, deadlineAt, (git) => {
    const previousHead = git.run(["rev-parse", "HEAD"], "compaction previous head");
    const previousTree = git.run(["rev-parse", "HEAD^{tree}"], "compaction previous tree");
    const indexTree = git.run(["write-tree"], "compaction current index");
    const contentTree = buildRawWorktreeTree(cwd, git);
    if (contentTree !== previousTree || indexTree !== previousTree) {
      throw new Error("cannot compact generated branch history with worktree changes");
    }
    const baseSha = git.run(["rev-parse", baseRef], "compaction base");
    const baseTree = git.run(["rev-parse", `${baseSha}^{tree}`], "compaction base tree");
    const previousCommitCount = Number(
      git.run(["rev-list", "--count", `${baseSha}..${previousHead}`], "compaction commit count"),
    );
    if (
      !Number.isInteger(previousCommitCount) ||
      previousCommitCount <= 1 ||
      previousTree === baseTree
    ) {
      return {
        status: "unchanged",
        commit: previousHead,
        previous_commit_count: previousCommitCount,
        tree: previousTree,
      };
    }
    const commit = createTargetCommitObject(git, previousTree, baseSha, messages, identity);
    const compactedTree = git.run(["rev-parse", `${commit}^{tree}`], "compaction result tree");
    if (compactedTree !== previousTree) {
      throw new Error("generated branch compaction changed the reviewed tree");
    }
    updateTargetHead(git, commit, previousHead);
    return {
      status: "compacted",
      commit,
      previous_head: previousHead,
      previous_commit_count: previousCommitCount,
      tree: previousTree,
    };
  });
}

function validateTargetCommitMessages(messages: readonly string[]) {
  if (messages.length === 0 || messages.some((message) => !message || message.includes("\0"))) {
    throw new Error("repair commit requires non-empty messages without NUL bytes");
  }
}

function createTargetCommitObject(
  git: IsolatedTargetGit,
  tree: string,
  parent: string,
  messages: readonly string[],
  identity: TargetCommitIdentity,
) {
  const messageArgs = messages.flatMap((message) => ["-m", message]);
  return git.run(["commit-tree", tree, "-p", parent, ...messageArgs], "repair commit object", {
    env: {
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_AUTHOR_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
    },
  });
}

function updateTargetHead(git: IsolatedTargetGit, commit: string, previousHead: string) {
  const reserveMs = targetGitRollbackReserveMs(git.deadlineAt);
  try {
    git.run(
      ["update-ref", "-m", "clawsweeper repair commit", "HEAD", commit, previousHead],
      "repair commit ref update",
      { reserveMs },
    );
    if (
      git.run(["rev-parse", "HEAD"], "repair commit ref verification", { reserveMs }) !== commit
    ) {
      throw new Error("repair commit ref update did not reach the expected commit");
    }
  } catch (error) {
    rollbackTargetHead(git, commit, previousHead, error);
  }
}

function rollbackTargetHead(
  git: IsolatedTargetGit,
  commit: string,
  previousHead: string,
  cause: unknown,
): never {
  try {
    const actual = git.run(["rev-parse", "HEAD"], "repair commit rollback inspection");
    if (actual === commit) {
      git.run(
        ["update-ref", "-m", "clawsweeper repair rollback", "HEAD", previousHead, commit],
        "repair commit rollback",
      );
    } else if (actual !== previousHead) {
      throw new Error(`repair commit rollback found unexpected HEAD ${actual}`);
    }
  } catch (rollbackError) {
    throw new Error("repair commit ref update failed and HEAD rollback was not proven", {
      cause: new AggregateError([cause, rollbackError]),
    });
  }
  throw cause;
}

type TargetIndexSnapshot = {
  contents: Buffer | null;
  indexPath: string;
  mode: number;
};

function captureTargetIndexSnapshot(cwd: string, git: IsolatedTargetGit): TargetIndexSnapshot {
  const gitDir = fs.realpathSync(
    path.resolve(cwd, git.run(["rev-parse", "--absolute-git-dir"], "target index Git directory")),
  );
  const indexPath = path.join(gitDir, "index");
  if (!fs.existsSync(indexPath)) return { contents: null, indexPath, mode: 0o600 };
  const stat = fs.lstatSync(indexPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("unsupported target Git index path");
  }
  assertPathWithin(gitDir, fs.realpathSync(indexPath), "index");
  return {
    contents: fs.readFileSync(indexPath),
    indexPath,
    mode: stat.mode & 0o777,
  };
}

function restoreTargetIndexAfterFailure(snapshot: TargetIndexSnapshot, cause: unknown): never {
  try {
    restoreTargetIndexSnapshot(snapshot);
  } catch (rollbackError) {
    throw new Error("target index mutation failed and rollback was not proven", {
      cause: new AggregateError([cause, rollbackError]),
    });
  }
  throw cause;
}

function restoreTargetIndexSnapshot(snapshot: TargetIndexSnapshot) {
  if (snapshot.contents === null) {
    fs.rmSync(snapshot.indexPath, { force: true });
    return;
  }
  const temporaryPath = path.join(
    path.dirname(snapshot.indexPath),
    `.clawsweeper-index-${randomUUID()}`,
  );
  try {
    fs.writeFileSync(temporaryPath, snapshot.contents, {
      flag: "wx",
      mode: snapshot.mode,
    });
    fs.renameSync(temporaryPath, snapshot.indexPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function targetGitRollbackReserveMs(deadlineAt: number) {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 2) {
    throw new Error("validation identity deadline exhausted before rollback-safe Git mutation");
  }
  return Math.max(1, Math.min(5_000, Math.floor(remainingMs / 2)));
}

function synchronizeTargetIndex(git: IsolatedTargetGit, treeish: string, operation: string) {
  const currentEntries = parseTargetTreeEntries(
    git.run(["ls-files", "-s", "-z"], `${operation} current entries`),
    "index",
  );
  const expectedIndex = path.join(git.root, "synchronized.index");
  const expectedEnv = { GIT_INDEX_FILE: expectedIndex };
  git.run(["read-tree", treeish], `${operation} expected tree`, { env: expectedEnv });
  const expectedEntries = parseTargetTreeEntries(
    git.run(["ls-files", "-s", "-z"], `${operation} expected entries`, { env: expectedEnv }),
    "index",
  );
  const paths = [...new Set([...currentEntries.keys(), ...expectedEntries.keys()])].sort();
  const oidLength =
    currentEntries.values().next().value?.oid.length ??
    expectedEntries.values().next().value?.oid.length ??
    40;
  const zeroOid = "0".repeat(oidLength);
  const removals: string[] = [];
  const additions: string[] = [];
  for (const relativePath of paths) {
    const current = currentEntries.get(relativePath);
    const expected = expectedEntries.get(relativePath);
    if (current?.mode === expected?.mode && current?.oid === expected?.oid) continue;
    if (expected) {
      additions.push(`${expected.mode} ${expected.oid}\t${relativePath}\0`);
    } else {
      removals.push(`0 ${zeroOid}\t${relativePath}\0`);
    }
  }
  if (removals.length > 0 || additions.length > 0) {
    git.run(["update-index", "-z", "--index-info"], operation, {
      input: [...removals, ...additions].join(""),
    });
  }
}

export function runTargetDiffCheck(
  cwd: string,
  baseRef: string,
  expected: TargetCheckoutBinding,
  timeoutMs = DEFAULT_TARGET_VALIDATION_TIMEOUT_MS,
) {
  const deadlineAt = Date.now() + timeoutMs;
  assertCallbackFreeGitConfig(cwd, deadlineAt);
  runIdentityGit(cwd, ["merge-base", baseRef, "HEAD"], deadlineAt, "diff merge base");
  runIdentityGit(cwd, ["diff", "--check", `${baseRef}...HEAD`], deadlineAt, "base diff check");
  runIdentityGit(cwd, ["diff", "--check"], deadlineAt, "worktree diff check");
  const actual = validationSourceIdentity(cwd, deadlineAt);
  if (!sameValidationSourceIdentity(actual, expected)) {
    throw new Error("target checkout changed during diff validation");
  }
}

function validationSourceIdentity(cwd: string, deadlineAt: number): ValidationSourceIdentity {
  assertCallbackFreeGitConfig(cwd, deadlineAt);
  assertNoHiddenIndexEntries(cwd, deadlineAt);
  const headSha = runIdentityGit(cwd, ["rev-parse", "HEAD"], deadlineAt, "source head").trim();
  const treeSha = runIdentityGit(
    cwd,
    ["rev-parse", "HEAD^{tree}"],
    deadlineAt,
    "source tree",
  ).trim();
  const worktreeSha256 = worktreeContentSha256(cwd, deadlineAt);
  const contentTreeSha = rawWorktreeTreeSha(cwd, deadlineAt);
  const indexTreeSha = runIdentityGit(cwd, ["write-tree"], deadlineAt, "source index tree").trim();
  const status =
    indexTreeSha === treeSha && contentTreeSha === indexTreeSha
      ? ""
      : `index=${indexTreeSha}\0content=${contentTreeSha}`;
  return {
    contentTreeSha,
    gitAdminSha256: gitAdministrativeSha256(cwd, deadlineAt),
    headSha,
    runtimeInputsSha256: validationRuntimeInputsSha256(cwd, deadlineAt),
    treeSha,
    status,
    worktreeSha256,
  };
}

function assertValidationSourceIdentity(
  cwd: string,
  expected: ValidationSourceIdentity,
  deadlineAt: number,
) {
  const actual = validationSourceIdentity(cwd, deadlineAt);
  if (!sameValidationSourceIdentityExceptRuntime(actual, expected)) {
    throw new Error("target dependency setup mutated checkout identity");
  }
}

function validationCheckoutIdentity(
  cwd: string,
  baseRef: string,
  deadlineAt: number,
): ValidationCheckoutIdentity {
  return {
    ...validationSourceIdentity(cwd, deadlineAt),
    baseSha: runIdentityGit(cwd, ["rev-parse", baseRef], deadlineAt, "checkout base").trim(),
  };
}

function assertValidationCheckoutIdentity(
  cwd: string,
  baseRef: string,
  expected: ValidationCheckoutIdentity,
  deadlineAt: number,
) {
  const actual = validationCheckoutIdentity(cwd, baseRef, deadlineAt);
  if (!sameValidationSourceIdentity(actual, expected) || actual.baseSha !== expected.baseSha) {
    throw new Error("unsafe validation command mutated checkout identity");
  }
}

function sameValidationSourceIdentity(
  actual: ValidationSourceIdentity,
  expected: ValidationSourceIdentity,
) {
  return (
    actual.contentTreeSha === expected.contentTreeSha &&
    actual.gitAdminSha256 === expected.gitAdminSha256 &&
    actual.headSha === expected.headSha &&
    actual.runtimeInputsSha256 === expected.runtimeInputsSha256 &&
    actual.treeSha === expected.treeSha &&
    actual.status === expected.status &&
    actual.worktreeSha256 === expected.worktreeSha256
  );
}

function sameValidationSourceIdentityExceptRuntime(
  actual: ValidationSourceIdentity,
  expected: ValidationSourceIdentity,
) {
  return (
    actual.contentTreeSha === expected.contentTreeSha &&
    actual.gitAdminSha256 === expected.gitAdminSha256 &&
    actual.headSha === expected.headSha &&
    actual.treeSha === expected.treeSha &&
    actual.status === expected.status &&
    actual.worktreeSha256 === expected.worktreeSha256
  );
}

function assertValidationCheckoutIdentityWithinCommand(
  cwd: string,
  baseRef: string,
  expected: ValidationCheckoutIdentity,
  deadlineAt: number,
  rendered: string,
  cause?: unknown,
) {
  try {
    assertValidationCheckoutIdentity(cwd, baseRef, expected, deadlineAt);
  } catch (error) {
    if (
      /unsafe validation command mutated checkout identity/.test(String((error as Error).message))
    ) {
      throw error;
    }
    throw new Error(
      `unsafe validation command checkout identity could not be verified (${rendered})`,
      { cause: cause ?? error },
    );
  }
}

function worktreeContentSha256(cwd: string, deadlineAt: number) {
  const hash = createHash("sha256");
  const root = fs.realpathSync(cwd);
  const tracked = runIdentityGit(cwd, ["ls-files", "-z"], deadlineAt, "tracked worktree listing")
    .split("\0")
    .filter(Boolean);
  const untracked = runIdentityGit(
    cwd,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    deadlineAt,
    "untracked worktree listing",
  )
    .split("\0")
    .filter(Boolean);
  const paths = [...new Set([...tracked, ...untracked])].sort();
  for (const relativePath of paths) {
    assertValidationIdentityDeadline(deadlineAt, relativePath);
    const absolutePath = path.join(root, relativePath);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    updateIdentityHash(hash, "worktree-path", relativePath);
    updateIdentityHash(hash, "worktree-mode", String(stat.mode));
    if (stat.isSymbolicLink()) {
      updateIdentityHash(hash, "worktree-symlink", fs.readlinkSync(absolutePath));
      updateSymlinkTargetDigest(hash, root, absolutePath, `${relativePath}\0target`, deadlineAt);
      continue;
    }
    if (stat.isFile()) {
      updateFileDigest(hash, absolutePath, relativePath, deadlineAt);
      continue;
    }
    updateIdentityHash(
      hash,
      "worktree-special",
      `${stat.isDirectory() ? "directory" : "other"}:${stat.size}`,
    );
  }
  assertValidationIdentityDeadline(deadlineAt, "worktree digest");
  return hash.digest("hex");
}

function validationRuntimeInputsSha256(cwd: string, deadlineAt: number) {
  const hash = createHash("sha256");
  const root = fs.realpathSync(cwd);
  const runtimePaths = validationRuntimeInputPaths(cwd, deadlineAt);
  updateIdentityHash(hash, "runtime-input-paths", runtimePaths.join("\0"));
  for (const relativePath of runtimePaths) {
    assertValidationIdentityDeadline(deadlineAt, relativePath);
    const entryPath = path.join(root, relativePath);
    updateIdentityHash(hash, "runtime-input", relativePath);
    if (!fs.existsSync(entryPath)) {
      updateIdentityHash(hash, "runtime-state", "absent");
      continue;
    }
    updateRuntimeInputDigest(hash, root, entryPath, relativePath, deadlineAt, new Set());
  }
  assertValidationIdentityDeadline(deadlineAt, "runtime input digest");
  return hash.digest("hex");
}

function validationRuntimeInputPaths(cwd: string, deadlineAt: number) {
  const paths = new Set([".venv", "node_modules", "venv"]);
  const ignored = runIdentityGit(
    cwd,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    deadlineAt,
    "ignored runtime input listing",
  )
    .split("\0")
    .filter(Boolean);
  for (const entry of ignored) {
    const relativePath = entry.replace(/\/+$/, "");
    if ([".venv", "node_modules", "venv"].includes(path.posix.basename(relativePath))) {
      paths.add(relativePath);
    }
  }
  const candidates = [...paths].sort(
    (left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0),
  );
  const roots: string[] = [];
  for (const candidate of candidates) {
    if (roots.some((root) => candidate.startsWith(`${root}/`))) {
      continue;
    }
    roots.push(candidate);
  }
  return roots.sort();
}

function updateRuntimeInputDigest(
  hash: ReturnType<typeof createHash>,
  root: string,
  entryPath: string,
  logicalPath: string,
  deadlineAt: number,
  activeDirectories: Set<string>,
) {
  assertValidationIdentityDeadline(deadlineAt, logicalPath);
  const stat = fs.lstatSync(entryPath);
  updateIdentityHash(hash, "runtime-path", logicalPath);
  updateIdentityHash(hash, "runtime-mode", String(stat.mode));
  if (stat.isSymbolicLink()) {
    updateIdentityHash(hash, "runtime-symlink", fs.readlinkSync(entryPath));
    const targetPath = fs.realpathSync(entryPath);
    assertPathWithin(root, targetPath, logicalPath);
    updateIdentityHash(hash, "runtime-symlink-target", path.relative(root, targetPath));
    return;
  }
  if (stat.isFile()) {
    updateFileDigest(hash, entryPath, logicalPath, deadlineAt);
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`unsupported validation runtime input: ${logicalPath}`);
  }
  const realDirectory = fs.realpathSync(entryPath);
  if (activeDirectories.has(realDirectory)) {
    throw new Error(`validation runtime input directory cycle: ${logicalPath}`);
  }
  activeDirectories.add(realDirectory);
  try {
    const children = fs.readdirSync(entryPath).sort();
    updateIdentityHash(hash, "runtime-children", children.join("\0"));
    for (const child of children) {
      updateRuntimeInputDigest(
        hash,
        root,
        path.join(entryPath, child),
        `${logicalPath}/${child}`,
        deadlineAt,
        activeDirectories,
      );
    }
  } finally {
    activeDirectories.delete(realDirectory);
  }
}

type TargetTreeEntry = {
  mode: string;
  oid: string;
};

type IsolatedTargetGit = {
  deadlineAt: number;
  root: string;
  run: (
    args: string[],
    operation: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      input?: string;
      reserveMs?: number;
      trim?: boolean;
    },
  ) => string;
};

function rawWorktreeTreeSha(cwd: string, deadlineAt: number) {
  return withIsolatedTargetGit(cwd, deadlineAt, (git) =>
    buildRawWorktreeTree(cwd, git, { quarantineObjects: true }),
  );
}

function buildRawWorktreeTree(
  cwd: string,
  git: IsolatedTargetGit,
  options: { quarantineObjects?: boolean } = {},
) {
  const objectEnv = options.quarantineObjects ? targetIdentityObjectEnvironment(cwd, git) : {};
  const headSha = git.run(["rev-parse", "HEAD"], "raw worktree head", { env: objectEnv });
  const headEntries = parseTargetTreeEntries(
    git.run(["ls-tree", "-r", "-z", "--full-tree", "HEAD"], "raw worktree head entries", {
      env: objectEnv,
    }),
    "tree",
  );
  const indexEntries = parseTargetTreeEntries(
    git.run(["ls-files", "-s", "-z"], "raw worktree index entries"),
    "index",
  );
  const untracked = git
    .run(["ls-files", "--others", "--exclude-standard", "-z"], "raw worktree untracked entries")
    .split("\0")
    .filter(Boolean);
  const paths = [...new Set([...headEntries.keys(), ...indexEntries.keys(), ...untracked])].sort();
  const attributes = readTargetGitAttributes(git, paths);
  const coreFileMode = targetCoreBoolean(git, "core.fileMode", true);
  const coreSymlinks = targetCoreBoolean(git, "core.symlinks", true);
  const indexFile = path.join(git.root, "content.index");
  const indexEnv = { ...objectEnv, GIT_INDEX_FILE: indexFile };
  git.run(["read-tree", "HEAD"], "raw worktree temporary index", { env: indexEnv });
  const updates: string[] = [];
  const canonicalEntries: Array<{ mode: string; relativePath: string }> = [];
  const rawEntries: Array<{ mode: string; relativePath: string; sourcePath: string }> = [];
  const worktreeLeafPaths = new Set<string>();
  const zeroOid = "0".repeat(headSha.length);
  for (const relativePath of paths) {
    const indexEntry = indexEntries.get(relativePath);
    const sourceEntry = indexEntry ?? headEntries.get(relativePath);
    if (targetPathHasLeafAncestor(relativePath, worktreeLeafPaths)) {
      if (sourceEntry) updates.push(`0 ${zeroOid}\t${relativePath}\0`);
      continue;
    }
    const absolutePath = path.join(cwd, relativePath);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (code === "ENOENT" && indexEntry?.mode === "160000") {
        worktreeLeafPaths.add(relativePath);
        updates.push(`160000 ${indexEntry.oid}\t${relativePath}\0`);
        continue;
      }
      if (code === "ENOENT" || code === "ENOTDIR") {
        updates.push(`0 ${zeroOid}\t${relativePath}\0`);
        continue;
      }
      throw error;
    }
    if (indexEntry?.mode === "160000" && stat.isDirectory()) {
      if (targetSubmoduleWorktreeIsInitialized(absolutePath, relativePath)) {
        assertCleanTargetSubmodule(cwd, relativePath, indexEntry.oid, git);
      }
      worktreeLeafPaths.add(relativePath);
      updates.push(`160000 ${indexEntry.oid}\t${relativePath}\0`);
      continue;
    }
    if (stat.isDirectory()) {
      if (sourceEntry) updates.push(`0 ${zeroOid}\t${relativePath}\0`);
      continue;
    }
    let mode: string;
    let sourcePath: string;
    if (stat.isSymbolicLink()) {
      mode = "120000";
      const symlinkContentPath = path.join(git.root, `symlink-${rawEntries.length}`);
      fs.writeFileSync(symlinkContentPath, fs.readlinkSync(absolutePath));
      sourcePath = symlinkContentPath;
    } else if (stat.isFile()) {
      if (sourceEntry?.mode === "120000" && !coreSymlinks) {
        mode = "120000";
      } else if (
        sourceEntry &&
        (sourceEntry.mode === "100644" || sourceEntry.mode === "100755") &&
        (process.platform === "win32" || !coreFileMode)
      ) {
        mode = sourceEntry.mode;
      } else {
        mode = (stat.mode & 0o111) !== 0 ? "100755" : "100644";
      }
      sourcePath = relativePath;
    } else {
      throw new Error(`unsupported target worktree path type: ${relativePath}`);
    }
    worktreeLeafPaths.add(relativePath);
    if (stat.isFile() && mode !== "120000") {
      const unsafeAttribute = unsafeCanonicalGitAttribute(attributes.get(relativePath));
      if (unsafeAttribute) {
        if (
          sourceEntry &&
          mode === sourceEntry.mode &&
          targetWorktreeMatchesIndexStat(cwd, relativePath, git)
        ) {
          updates.push(`${sourceEntry.mode} ${sourceEntry.oid}\t${relativePath}\0`);
          continue;
        }
        throw new Error(`unsafe changed target Git ${unsafeAttribute} attribute: ${relativePath}`);
      }
      canonicalEntries.push({ mode, relativePath });
      continue;
    }
    rawEntries.push({ mode, relativePath, sourcePath });
  }
  if (canonicalEntries.length > 0) {
    const oids = hashTargetWorktreeFiles(
      git,
      canonicalEntries.map((entry) => entry.relativePath),
      false,
      "hash canonical worktree files",
      objectEnv,
    );
    if (oids.length !== canonicalEntries.length) {
      throw new Error("canonical worktree hash output did not match target paths");
    }
    for (const [index, entry] of canonicalEntries.entries()) {
      updates.push(`${entry.mode} ${oids[index]}\t${entry.relativePath}\0`);
    }
  }
  if (rawEntries.length > 0) {
    const oids = hashTargetWorktreeFiles(
      git,
      rawEntries.map((entry) => entry.sourcePath),
      true,
      "hash raw worktree files",
      objectEnv,
    );
    if (oids.length !== rawEntries.length) {
      throw new Error("raw worktree hash output did not match target paths");
    }
    for (const [index, entry] of rawEntries.entries()) {
      updates.push(`${entry.mode} ${oids[index]}\t${entry.relativePath}\0`);
    }
  }
  if (updates.length > 0) {
    git.run(["update-index", "-z", "--index-info"], "populate raw worktree index", {
      env: indexEnv,
      input: updates.join(""),
    });
  }
  return git.run(["write-tree"], "write raw worktree tree", { env: indexEnv });
}

function targetPathHasLeafAncestor(relativePath: string, leafPaths: ReadonlySet<string>) {
  let separator = relativePath.indexOf("/");
  while (separator >= 0) {
    if (leafPaths.has(relativePath.slice(0, separator))) return true;
    separator = relativePath.indexOf("/", separator + 1);
  }
  return false;
}

function targetIdentityObjectEnvironment(cwd: string, git: IsolatedTargetGit) {
  const commonDir = fs.realpathSync(
    path.resolve(cwd, git.run(["rev-parse", "--git-common-dir"], "target Git common directory")),
  );
  const repositoryObjects = fs.realpathSync(path.join(commonDir, "objects"));
  const identityObjects = path.join(git.root, "identity-objects");
  fs.mkdirSync(identityObjects, { mode: 0o700 });
  return {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjects,
    GIT_OBJECT_DIRECTORY: identityObjects,
  };
}

function targetCoreBoolean(git: IsolatedTargetGit, key: string, fallback: boolean) {
  return (
    git.run(
      ["config", "--type=bool", `--default=${fallback ? "true" : "false"}`, "--get", key],
      `target ${key}`,
    ) === "true"
  );
}

function assertCleanTargetSubmodule(
  cwd: string,
  relativePath: string,
  expectedOid: string,
  git: IsolatedTargetGit,
  ancestors: Set<string> = new Set(),
) {
  const submodulePath = path.join(cwd, relativePath);
  const realSubmodulePath = fs.realpathSync(submodulePath);
  if (ancestors.has(realSubmodulePath)) {
    throw new Error(`cyclic target submodule worktree: ${relativePath}`);
  }
  ancestors.add(realSubmodulePath);
  try {
    assertCallbackFreeGitConfig(submodulePath, git.deadlineAt, {
      allowedCoreWorktree: realSubmodulePath,
    });
    assertNoHiddenIndexEntries(submodulePath, git.deadlineAt);
    const head = git.run(
      ["-C", submodulePath, "rev-parse", "HEAD"],
      `target submodule head: ${relativePath}`,
    );
    if (head !== expectedOid) {
      throw new Error(`target submodule HEAD does not match indexed gitlink: ${relativePath}`);
    }
    const nestedEntries = parseTargetTreeEntries(
      git.run(
        ["-C", submodulePath, "ls-tree", "-r", "-z", "--full-tree", "HEAD"],
        `target nested submodules: ${relativePath}`,
        { trim: false },
      ),
      "tree",
    );
    for (const [nestedPath, entry] of nestedEntries) {
      if (entry.mode !== "160000") continue;
      const nestedRelativePath = path.posix.join(relativePath, nestedPath);
      const nestedSubmodulePath = path.join(cwd, nestedRelativePath);
      if (!targetSubmoduleWorktreeIsInitialized(nestedSubmodulePath, nestedRelativePath)) continue;
      assertCleanTargetSubmodule(cwd, nestedRelativePath, entry.oid, git, ancestors);
    }
    const changed = git.run(
      [
        "-C",
        submodulePath,
        "-c",
        "diff.ignoreSubmodules=none",
        "diff-index",
        "--ignore-submodules=none",
        "--name-only",
        "-z",
        "HEAD",
        "--",
      ],
      `target submodule changes: ${relativePath}`,
      { trim: false },
    );
    const untracked = git.run(
      ["-C", submodulePath, "ls-files", "--others", "--exclude-standard", "-z"],
      `target submodule untracked files: ${relativePath}`,
      { trim: false },
    );
    if (changed || untracked) {
      throw new Error(`target submodule worktree is dirty: ${relativePath}`);
    }
  } finally {
    ancestors.delete(realSubmodulePath);
  }
}

function targetSubmoduleWorktreeIsInitialized(
  submodulePath: string,
  relativePath: string,
): boolean {
  try {
    const gitPath = fs.lstatSync(path.join(submodulePath, ".git"));
    if (!gitPath.isFile() && !gitPath.isDirectory()) {
      throw new Error(`unsupported target submodule Git path: ${relativePath}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    if (fs.readdirSync(submodulePath).length === 0) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  throw new Error(`target submodule worktree is dirty: ${relativePath}`);
}

function hashTargetWorktreeFiles(
  git: IsolatedTargetGit,
  sourcePaths: readonly string[],
  noFilters: boolean,
  operation: string,
  env: NodeJS.ProcessEnv = {},
) {
  const oids: string[] = [];
  let chunk: string[] = [];
  let chunkSize = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    oids.push(
      ...git
        .run(
          ["hash-object", "-w", ...(noFilters ? ["--no-filters"] : []), "--", ...chunk],
          operation,
          { env },
        )
        .split(/\r?\n/)
        .filter(Boolean),
    );
    chunk = [];
    chunkSize = 0;
  };
  for (const sourcePath of sourcePaths) {
    const size = Buffer.byteLength(sourcePath) + 1;
    if (chunk.length >= 128 || (chunk.length > 0 && chunkSize + size > 64 * 1024)) flush();
    chunk.push(sourcePath);
    chunkSize += size;
  }
  flush();
  return oids;
}

function readTargetGitAttributes(git: IsolatedTargetGit, relativePaths: readonly string[]) {
  const attributes = new Map<string, Map<string, string>>();
  if (relativePaths.length === 0) return attributes;
  const raw = git.run(["check-attr", "-z", "--all", "--stdin"], "target Git attributes", {
    input: `${relativePaths.join("\0")}\0`,
    trim: false,
  });
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 3 !== 0) {
    throw new Error("invalid target Git attribute output");
  }
  for (let index = 0; index < fields.length; index += 3) {
    const relativePath = fields[index]!;
    const name = fields[index + 1]!.toLowerCase();
    const value = fields[index + 2]!;
    const pathAttributes = attributes.get(relativePath) ?? new Map<string, string>();
    pathAttributes.set(name, value);
    attributes.set(relativePath, pathAttributes);
  }
  return attributes;
}

function unsafeCanonicalGitAttribute(attributes: ReadonlyMap<string, string> | undefined) {
  if (!attributes) return null;
  const filter = attributes.get("filter");
  if (filter && filter !== "unset" && filter !== "unspecified") return "filter";
  const encoding = attributes.get("working-tree-encoding");
  if (encoding && encoding !== "unset" && encoding !== "unspecified") {
    return "working-tree-encoding";
  }
  return null;
}

function targetWorktreeMatchesIndexStat(cwd: string, relativePath: string, git: IsolatedTargetGit) {
  const raw = git.run(
    ["--literal-pathspecs", "ls-files", "--debug", "-z", "--", relativePath],
    "target index stat",
    { trim: false },
  );
  const separator = raw.indexOf("\0");
  if (separator < 0 || raw.slice(0, separator) !== relativePath) return false;
  const debug = raw.slice(separator + 1);
  const ctime = debug.match(/ctime: (\d+):(\d+)/);
  const mtime = debug.match(/mtime: (\d+):(\d+)/);
  const deviceAndInode = debug.match(/dev: (\d+)\tino: (\d+)/);
  const owner = debug.match(/uid: (\d+)\tgid: (\d+)/);
  const size = debug.match(/size: (\d+)\tflags: (\d+)/);
  if (!ctime || !mtime || !deviceAndInode || !owner || !size || size[2] !== "0") return false;
  const stat = fs.lstatSync(path.join(cwd, relativePath), { bigint: true });
  const nanoseconds = (match: RegExpMatchArray) =>
    BigInt(match[1]!) * 1_000_000_000n + BigInt(match[2]!);
  const uint32 = (value: bigint) => BigInt.asUintN(32, value);
  const indexSize = BigInt(size[1]!);
  return (
    stat.ctimeNs === nanoseconds(ctime) &&
    stat.mtimeNs === nanoseconds(mtime) &&
    uint32(stat.dev) === BigInt(deviceAndInode[1]!) &&
    uint32(stat.ino) === BigInt(deviceAndInode[2]!) &&
    uint32(stat.uid) === BigInt(owner[1]!) &&
    uint32(stat.gid) === BigInt(owner[2]!) &&
    (indexSize === 0n || uint32(stat.size) === indexSize)
  );
}

function parseTargetTreeEntries(raw: string, source: "tree" | "index") {
  const entries = new Map<string, TargetTreeEntry>();
  for (const entry of raw.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\t");
    if (separator < 0) throw new Error(`invalid target Git ${source} entry`);
    const metadata = entry.slice(0, separator).split(" ");
    const relativePath = entry.slice(separator + 1);
    const mode = metadata[0];
    const oid = source === "tree" ? metadata[2] : metadata[1];
    const stage = source === "index" ? metadata[2] : "0";
    if (!mode || !oid || stage !== "0" || entries.has(relativePath)) {
      throw new Error(`unsupported target Git ${source} entry: ${relativePath}`);
    }
    entries.set(relativePath, { mode, oid });
  }
  return entries;
}

function withIsolatedTargetGit<T>(
  cwd: string,
  deadlineAt: number,
  callback: (git: IsolatedTargetGit) => T,
): T {
  const isolationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-target-git-"));
  const hooksDir = path.join(isolationRoot, "hooks");
  const globalConfig = path.join(isolationRoot, "global.gitconfig");
  fs.mkdirSync(hooksDir, { mode: 0o700 });
  fs.writeFileSync(globalConfig, "", { mode: 0o600 });
  try {
    const baseEnv = targetValidationEnv();
    Object.assign(baseEnv, {
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: globalConfig,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      HOME: isolationRoot,
      XDG_CONFIG_HOME: isolationRoot,
    });
    return callback({
      deadlineAt,
      root: isolationRoot,
      run: (args, operation, options = {}) => {
        const output = run(
          "git",
          [
            "-c",
            `core.hooksPath=${hooksDir}`,
            "-c",
            "commit.gpgSign=false",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "diff.external=",
            ...args,
          ],
          {
            cwd,
            env: { ...baseEnv, ...options.env },
            ...(options.input === undefined ? {} : { input: options.input }),
            timeoutMs: validationIdentityTimeoutMs(
              deadlineAt - (options.reserveMs ?? 0),
              operation,
            ),
          },
        );
        return options.trim === false ? output : output.trim();
      },
    });
  } finally {
    fs.rmSync(isolationRoot, { recursive: true, force: true });
  }
}

function assertCallbackFreeGitConfig(
  cwd: string,
  deadlineAt: number,
  options: { allowedCoreWorktree?: string } = {},
) {
  const gitDir = resolveGitDirectory(cwd, "--absolute-git-dir", deadlineAt);
  const commonDir = resolveGitDirectory(cwd, "--git-common-dir", deadlineAt);
  const configPaths = [
    { root: commonDir, file: path.join(commonDir, "config") },
    { root: gitDir, file: path.join(gitDir, "config.worktree") },
  ];
  for (const { root, file } of configPaths) {
    if (!fs.existsSync(file)) continue;
    assertPathWithin(root, fs.realpathSync(file), path.basename(file));
    const entries = runIdentityGit(
      cwd,
      ["config", "--file", file, "--no-includes", "--null", "--list"],
      deadlineAt,
      `Git config ${path.basename(file)}`,
    )
      .split("\0")
      .filter(Boolean);
    for (const entry of entries) {
      const separator = entry.indexOf("\n");
      const key = (separator >= 0 ? entry.slice(0, separator) : entry).toLowerCase();
      const value = separator >= 0 ? entry.slice(separator + 1) : "";
      if (
        key === "core.worktree" &&
        options.allowedCoreWorktree &&
        targetCoreWorktreeMatches(root, value, options.allowedCoreWorktree)
      ) {
        continue;
      }
      if (isCallbackBearingGitConfigKey(key)) {
        throw new Error(`unsafe target Git callback configuration: ${key}`);
      }
    }
  }
}

function targetCoreWorktreeMatches(configRoot: string, value: string, expected: string) {
  if (!value) return false;
  const configured = path.resolve(configRoot, value);
  try {
    return fs.realpathSync(configured) === expected;
  } catch {
    return false;
  }
}

function isCallbackBearingGitConfigKey(key: string) {
  return (
    key === "core.askpass" ||
    key === "core.alternaterefscommand" ||
    key === "core.attributesfile" ||
    key === "core.excludesfile" ||
    key === "core.fsmonitor" ||
    key === "core.gitproxy" ||
    key === "core.hookspath" ||
    key === "core.sshcommand" ||
    key === "core.worktree" ||
    key === "diff.external" ||
    key === "push.pushoption" ||
    /^credential(?:\..+)?\.helper$/.test(key) ||
    /^http(?:\..+)?\.(?:extraheader|proxy|proxyauthmethod|sslcapath|sslcainfo|sslcert|sslkey|sslverify)$/.test(
      key,
    ) ||
    /^include(?:if\..+)?\.path$/.test(key) ||
    /^diff\..+\.(?:command|textconv)$/.test(key) ||
    /^filter\..+\.(?:clean|smudge|process|required)$/.test(key) ||
    /^merge\..+\.driver$/.test(key) ||
    /^remote\..+\.(?:pushurl|receivepack|uploadpack|vcs)$/.test(key) ||
    /^url\..+\.(?:insteadof|pushinsteadof)$/.test(key)
  );
}

function assertNoHiddenIndexEntries(cwd: string, deadlineAt: number) {
  const entries = runIdentityGit(cwd, ["ls-files", "-v", "-z"], deadlineAt, "hidden index flags")
    .split("\0")
    .filter(Boolean);
  for (const entry of entries) {
    const tag = entry[0] ?? "";
    if (tag === "S" || /^[a-z]$/.test(tag)) {
      throw new Error(`unsafe hidden target index entry: ${entry.slice(2)}`);
    }
  }
}

function runIdentityGit(cwd: string, args: string[], deadlineAt: number, operation: string) {
  const env = targetValidationEnv();
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = os.devNull;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  return run("git", ["-c", "core.fsmonitor=false", "-c", "diff.external=", ...args], {
    cwd,
    env,
    timeoutMs: validationIdentityTimeoutMs(deadlineAt, operation),
  });
}

function updateSymlinkTargetDigest(
  hash: ReturnType<typeof createHash>,
  root: string,
  symlinkPath: string,
  logicalPath: string,
  deadlineAt: number,
) {
  let targetPath: string;
  try {
    targetPath = fs.realpathSync(symlinkPath);
  } catch {
    throw new Error(`validation symlink is broken or cyclic: ${logicalPath}`);
  }
  assertPathWithin(root, targetPath, logicalPath);
  updateIdentityHash(hash, "symlink-target-path", path.relative(root, targetPath));
  updateResolvedPathDigest(hash, root, targetPath, logicalPath, deadlineAt, new Set());
}

function updateResolvedPathDigest(
  hash: ReturnType<typeof createHash>,
  root: string,
  entryPath: string,
  logicalPath: string,
  deadlineAt: number,
  activeDirectories: Set<string>,
) {
  assertValidationIdentityDeadline(deadlineAt, logicalPath);
  const stat = fs.lstatSync(entryPath);
  updateIdentityHash(hash, "resolved-path", logicalPath);
  updateIdentityHash(hash, "resolved-mode", String(stat.mode));
  if (stat.isSymbolicLink()) {
    updateIdentityHash(hash, "resolved-symlink", fs.readlinkSync(entryPath));
    const targetPath = fs.realpathSync(entryPath);
    assertPathWithin(root, targetPath, logicalPath);
    updateResolvedPathDigest(
      hash,
      root,
      targetPath,
      `${logicalPath}\0link`,
      deadlineAt,
      activeDirectories,
    );
    return;
  }
  if (stat.isFile()) {
    updateFileDigest(hash, entryPath, logicalPath, deadlineAt);
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`unsupported validation identity path: ${logicalPath}`);
  }
  const realDirectory = fs.realpathSync(entryPath);
  if (activeDirectories.has(realDirectory)) {
    throw new Error(`validation identity directory cycle: ${logicalPath}`);
  }
  activeDirectories.add(realDirectory);
  try {
    const children = fs.readdirSync(entryPath).sort();
    updateIdentityHash(hash, "resolved-children", children.join("\0"));
    for (const child of children) {
      updateResolvedPathDigest(
        hash,
        root,
        path.join(entryPath, child),
        `${logicalPath}/${child}`,
        deadlineAt,
        activeDirectories,
      );
    }
  } finally {
    activeDirectories.delete(realDirectory);
  }
}

function updateFileDigest(
  hash: ReturnType<typeof createHash>,
  filePath: string,
  logicalPath: string,
  deadlineAt: number,
) {
  updateIdentityHash(hash, "file-size", String(fs.statSync(filePath).size));
  const file = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(file, buffer, 0, buffer.length, null)) > 0) {
      assertValidationIdentityDeadline(deadlineAt, logicalPath);
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(file);
  }
}

function assertPathWithin(root: string, targetPath: string, logicalPath: string) {
  const relative = path.relative(root, targetPath);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`validation symlink escapes target checkout: ${logicalPath}`);
}

function gitAdministrativeSha256(cwd: string, deadlineAt: number) {
  const hash = createHash("sha256");
  const gitDir = resolveGitDirectory(cwd, "--absolute-git-dir", deadlineAt);
  const commonDir = resolveGitDirectory(cwd, "--git-common-dir", deadlineAt);
  const roots = [
    {
      root: gitDir,
      paths: [
        "HEAD",
        "index",
        "ORIG_HEAD",
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "config.worktree",
        "rebase-apply",
        "rebase-merge",
        "sequencer",
      ],
    },
    {
      root: commonDir,
      paths: ["config", "hooks", "info", "objects/info", "refs/replace", "shallow"],
    },
  ];
  for (const { root, paths } of roots) {
    for (const relativePath of paths) {
      const absolutePath = path.join(root, relativePath);
      if (!fs.existsSync(absolutePath)) continue;
      updateResolvedPathDigest(
        hash,
        root,
        absolutePath,
        `${path.basename(root)}/${relativePath}`,
        deadlineAt,
        new Set(),
      );
    }
  }
  return hash.digest("hex");
}

function resolveGitDirectory(cwd: string, option: string, deadlineAt: number) {
  const resolved = runIdentityGit(cwd, ["rev-parse", option], deadlineAt, option).trim();
  return fs.realpathSync(path.resolve(cwd, resolved));
}

function updateIdentityHash(
  hash: ReturnType<typeof createHash>,
  label: string,
  value: string | Buffer,
) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  hash.update(`${label}:${data.length}\0`);
  hash.update(data);
}

function validationIdentityTimeoutMs(deadlineAt: number, operation: string) {
  assertValidationIdentityDeadline(deadlineAt, operation);
  return Math.max(1, deadlineAt - Date.now());
}

function assertValidationIdentityDeadline(deadlineAt: number, operation: string) {
  if (Date.now() >= deadlineAt) {
    throw new Error(`validation identity deadline exhausted during ${operation}`);
  }
}

function isValidationIdentityDeadlineError(error: unknown) {
  return /validation identity deadline exhausted/.test(String((error as Error)?.message ?? error));
}

function targetToolchainCommandTimeout(
  deadlineAt: number,
  configuredTimeoutMs: number,
  operation: string,
) {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new Error(`target dependency setup deadline exhausted during ${operation}`);
  }
  return Math.max(1, Math.min(configuredTimeoutMs, remainingMs));
}

function validationIdentityReserveMs(timeoutMs: number) {
  return Math.max(1, Math.min(30_000, Math.floor(timeoutMs / 2)));
}

function remainingCommandBudget(deadlineAt: number, identityReserveMs: number) {
  return Math.max(0, deadlineAt - Date.now() - identityReserveMs);
}

function validationCommandBudgetError(rendered: string, cause?: unknown) {
  return new Error(
    `validation command failed (${rendered}): validation command runtime budget exhausted`,
    cause === undefined ? undefined : { cause },
  );
}

function validationFallbackCommands({
  parts,
  error,
  cwd,
  baseBranch,
  baseRef,
  options,
}: LooseRecord) {
  if (options.strictTargetValidation) return [];
  if (!isChangedGateCommand(parts, options)) return [];
  if (/no merge base/i.test(String(error?.message ?? ""))) {
    validationBaseRef(cwd, baseBranch, options);
    return [parts];
  }
  if (!isChangedGateStall(error)) return [];
  const changedTests = changedTestFiles(cwd, baseBranch, options);
  return [
    ["git", "diff", "--check", `${baseRef}...HEAD`],
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
  if (/background process|process tree/i.test(String(error?.message ?? error))) return false;

  const configuredRetries = Number.parseInt(process.env.CLAWSWEEPER_VALIDATION_RETRIES ?? "1", 10);
  const maxRetries = Number.isFinite(configuredRetries) ? Math.max(0, configuredRetries) : 1;
  const rendered = parts.join(" ");
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
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (
      /^(?:OPENAI|CODEX|GITHUB|RUNNER|ACTIONS|GH)_/i.test(key) ||
      /(?:^|_)(?:API_KEY|AUTH|CREDENTIALS?|LEDGER|PASSWORD|PRIVATE_KEY|PROXY|SECRET|TOKEN)(?:_|$)/i.test(
        key,
      ) ||
      /^CLAWSWEEPER_INTERNAL_MODEL$/i.test(key) ||
      /^(?:GIT|SSH)_ASKPASS$/i.test(key) ||
      /^SSH_AUTH_SOCK$/i.test(key) ||
      /^NPM_CONFIG_(?:CACHE|PREFIX|USERCONFIG)$/i.test(key) ||
      /^PNPM_(?:HOME|STORE_PATH)$/i.test(key) ||
      /^RUSTUP_/i.test(key) ||
      (isUnsafeValidationEnvironmentName(key) &&
        !["PATH", "PATHEXT", "NPM_CONFIG_REGISTRY"].includes(normalized))
    ) {
      delete env[key];
    }
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

function withTargetValidationEnvironment<T>(
  callback: (env: NodeJS.ProcessEnv, reset: (deadlineAt: number) => void) => T,
  preparedPnpmRuntime?: PreparedTargetPnpmRuntime | null,
): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-target-user-"));
  const rootIdentity = fs.lstatSync(root);
  const home = path.join(root, "home");
  const config = path.join(root, "config");
  const cache = path.join(root, "cache");
  const data = path.join(root, "data");
  const state = path.join(root, "state");
  const runtime = path.join(root, "runtime");
  const cargoHome = path.join(root, "cargo");
  const corepackHome = path.join(root, "corepack");
  const corepackBin = path.join(corepackHome, "bin");
  const globalConfig = path.join(config, "gitconfig");
  const npmConfig = path.join(config, "npmrc");
  const env = targetValidationEnv();
  prependValidationPath(env, corepackBin);
  Object.assign(env, {
    APPDATA: config,
    CARGO_HOME: cargoHome,
    COREPACK_HOME: corepackHome,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: globalConfig,
    GIT_TERMINAL_PROMPT: "0",
    HOME: home,
    LOCALAPPDATA: data,
    NPM_CONFIG_USERCONFIG: npmConfig,
    USERPROFILE: home,
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_RUNTIME_DIR: runtime,
    XDG_STATE_HOME: state,
  });
  const resetProfile = (deadlineAt: number, copyPreparedRuntime: boolean) => {
    const currentRoot = fs.lstatSync(root);
    if (
      !currentRoot.isDirectory() ||
      currentRoot.dev !== rootIdentity.dev ||
      currentRoot.ino !== rootIdentity.ino
    ) {
      throw new Error("disposable target validation profile root changed");
    }
    for (const directory of [home, config, cache, data, state, runtime, cargoHome, corepackHome]) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    for (const directory of [home, config, cache, data, state, runtime, cargoHome]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    if (copyPreparedRuntime && preparedPnpmRuntime) {
      assertPreparedTargetPnpmRuntime(preparedPnpmRuntime, deadlineAt);
      fs.cpSync(preparedPnpmRuntime.corepackHome, corepackHome, {
        recursive: true,
        verbatimSymlinks: true,
      });
      if (
        preparedPnpmRuntimeSha256(corepackHome, deadlineAt) !== preparedPnpmRuntime.runtimeSha256
      ) {
        throw new Error("prepared target pnpm toolchain copy changed before validation");
      }
      assertPreparedTargetPnpmRuntime(preparedPnpmRuntime, deadlineAt);
    }
    fs.mkdirSync(corepackBin, { recursive: true, mode: 0o700 });
    fs.writeFileSync(globalConfig, "", { mode: 0o600 });
    fs.writeFileSync(npmConfig, "", { mode: 0o600 });
  };
  try {
    resetProfile(Number.POSITIVE_INFINITY, false);
    return callback(env, (deadlineAt) => resetProfile(deadlineAt, true));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function preparedPnpmRuntimeForValidation(
  cwd: string,
  options: TargetValidationOptions,
): PreparedTargetPnpmRuntime | null {
  if (getToolchain(options).packageManager !== "pnpm") return null;
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) return null;
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const packageManager = targetPnpmPackageManager(packageJson);
  const prepared = preparedTargetPnpmRuntimes.get(targetPnpmRuntimeKey(cwd));
  if (!prepared) {
    if (options.installTargetDeps) {
      throw new Error("target pnpm toolchain was not prepared before validation");
    }
    return null;
  }
  if (prepared.packageManager !== packageManager) {
    clearPreparedTargetPnpmRuntime(cwd);
    throw new Error("prepared target pnpm toolchain does not match package.json");
  }
  return prepared;
}

function storePreparedTargetPnpmRuntime({
  cwd,
  deadlineAt,
  packageManager,
  sourceCorepackHome,
  sourceIdentity,
}: {
  cwd: string;
  deadlineAt: number;
  packageManager: string;
  sourceCorepackHome: string;
  sourceIdentity: ValidationSourceIdentity;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-target-pnpm-"));
  const corepackHome = path.join(root, "corepack");
  let runtimeSha256: string;
  try {
    const sourceSha256 = preparedPnpmRuntimeSha256(sourceCorepackHome, deadlineAt, {
      allowExternalCorepackShims: true,
    });
    freezePreparedTargetPnpmRuntime(sourceCorepackHome, corepackHome, deadlineAt);
    if (
      preparedPnpmRuntimeSha256(sourceCorepackHome, deadlineAt, {
        allowExternalCorepackShims: true,
      }) !== sourceSha256
    ) {
      throw new Error("prepared target pnpm toolchain changed while it was frozen");
    }
    runtimeSha256 = preparedPnpmRuntimeSha256(corepackHome, deadlineAt);
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const key = targetPnpmRuntimeKey(cwd);
  const previous = preparedTargetPnpmRuntimes.get(key);
  preparedTargetPnpmRuntimes.set(key, {
    corepackHome,
    packageManager,
    root,
    runtimeSha256,
    sourceIdentity,
  });
  if (previous) fs.rmSync(previous.root, { recursive: true, force: true });
  registerPreparedTargetPnpmRuntimeCleanup();
}

function freezePreparedTargetPnpmRuntime(
  sourceRoot: string,
  destinationRoot: string,
  deadlineAt: number,
) {
  fs.cpSync(sourceRoot, destinationRoot, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const runtimeContainer = path.join(destinationRoot, ".__clawsweeper_corepack_runtime__");
  if (fs.existsSync(runtimeContainer)) {
    throw new Error("prepared target pnpm runtime contains a reserved path");
  }
  let copiedDist: { source: string; destination: string } | null = null;
  const visit = (sourceDirectory: string, destinationDirectory: string) => {
    for (const entry of fs.readdirSync(sourceDirectory).sort()) {
      assertValidationIdentityDeadline(deadlineAt, entry);
      const sourcePath = path.join(sourceDirectory, entry);
      const destinationPath = path.join(destinationDirectory, entry);
      const stat = fs.lstatSync(sourcePath);
      if (stat.isDirectory()) {
        visit(sourcePath, destinationPath);
        continue;
      }
      if (!stat.isSymbolicLink()) continue;
      const shim = externalCorepackShim(sourceRoot, sourcePath);
      if (!shim) continue;
      if (copiedDist && copiedDist.source !== shim.distRoot) {
        throw new Error("prepared target pnpm runtime uses multiple external Corepack roots");
      }
      if (!copiedDist) {
        const destination = path.join(runtimeContainer, "dist");
        fs.mkdirSync(runtimeContainer, { recursive: true, mode: 0o700 });
        fs.cpSync(shim.distRoot, destination, {
          recursive: true,
          verbatimSymlinks: true,
        });
        copiedDist = { source: shim.distRoot, destination };
      }
      const copiedTarget = path.join(copiedDist.destination, shim.targetRelative);
      if (!fs.statSync(copiedTarget).isFile()) {
        throw new Error(`prepared target pnpm Corepack shim is not a file: ${entry}`);
      }
      fs.rmSync(destinationPath, { force: true });
      fs.symlinkSync(path.relative(path.dirname(destinationPath), copiedTarget), destinationPath);
    }
  };
  visit(sourceRoot, destinationRoot);
}

function assertPreparedTargetPnpmRuntime(prepared: PreparedTargetPnpmRuntime, deadlineAt: number) {
  if (preparedPnpmRuntimeSha256(prepared.corepackHome, deadlineAt) !== prepared.runtimeSha256) {
    throw new Error("prepared target pnpm toolchain changed before validation");
  }
}

function preparedPnpmRuntimeSha256(
  root: string,
  deadlineAt: number,
  options: { allowExternalCorepackShims?: boolean } = {},
) {
  const hash = createHash("sha256");
  const canonicalRoot = fs.realpathSync(root);
  const hashedExternalRoots = new Set<string>();
  const visit = (directory: string, relativeDirectory: string) => {
    assertValidationIdentityDeadline(
      deadlineAt,
      relativeDirectory || "prepared target pnpm toolchain",
    );
    const entries = fs.readdirSync(directory).sort();
    updateIdentityHash(hash, "runtime-directory", relativeDirectory);
    updateIdentityHash(hash, "runtime-children", entries.join("\0"));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry);
      const relativePath = relativeDirectory ? path.posix.join(relativeDirectory, entry) : entry;
      assertValidationIdentityDeadline(deadlineAt, relativePath);
      const stat = fs.lstatSync(entryPath);
      updateIdentityHash(hash, "runtime-path", relativePath);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(entryPath);
        const resolvedTarget = fs.realpathSync(entryPath);
        const targetRelative = path.relative(canonicalRoot, resolvedTarget);
        if (
          path.isAbsolute(target) ||
          targetRelative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(targetRelative)
        ) {
          const shim = options.allowExternalCorepackShims
            ? externalCorepackShim(canonicalRoot, entryPath)
            : null;
          if (!shim) {
            throw new Error(`prepared target pnpm symlink escapes runtime: ${relativePath}`);
          }
          if (!hashedExternalRoots.has(shim.distRoot)) {
            hashedExternalRoots.add(shim.distRoot);
            updateResolvedPathDigest(
              hash,
              shim.distRoot,
              shim.distRoot,
              "external-corepack-dist",
              deadlineAt,
              new Set(),
            );
          }
        }
        updateIdentityHash(hash, "runtime-type", "symlink");
        updateIdentityHash(hash, "runtime-symlink", target);
      } else if (stat.isFile()) {
        updateIdentityHash(hash, "runtime-type", "file");
        updateIdentityHash(hash, "runtime-mode", String(stat.mode & 0o777));
        updateFileDigest(hash, entryPath, relativePath, deadlineAt);
      } else if (stat.isDirectory()) {
        updateIdentityHash(hash, "runtime-type", "directory");
        visit(entryPath, relativePath);
      } else {
        throw new Error(`unsupported prepared target pnpm path: ${relativePath}`);
      }
    }
  };
  visit(root, "");
  assertValidationIdentityDeadline(deadlineAt, "prepared target pnpm toolchain");
  return hash.digest("hex");
}

function externalCorepackShim(runtimeRoot: string, symlinkPath: string) {
  let resolvedTarget: string;
  try {
    resolvedTarget = fs.realpathSync(symlinkPath);
  } catch {
    throw new Error(`prepared target pnpm symlink escapes runtime: ${path.basename(symlinkPath)}`);
  }
  const relative = path.relative(fs.realpathSync(runtimeRoot), resolvedTarget);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    return null;
  }
  const distRoot = path.dirname(resolvedTarget);
  const targetName = path.basename(resolvedTarget);
  let corepackRuntimeIsFile = false;
  try {
    corepackRuntimeIsFile = fs.statSync(path.join(distRoot, "lib", "corepack.cjs")).isFile();
  } catch {
    // Rejected below as an unrecognized external executable.
  }
  if (
    path.basename(distRoot) !== "dist" ||
    (targetName !== "pnpm.js" && targetName !== "pnpx.js") ||
    !fs.statSync(resolvedTarget).isFile() ||
    !corepackRuntimeIsFile
  ) {
    throw new Error(`prepared target pnpm symlink escapes runtime: ${path.basename(symlinkPath)}`);
  }
  return {
    distRoot,
    targetRelative: path.relative(distRoot, resolvedTarget),
  };
}

function clearPreparedTargetPnpmRuntime(cwd: string) {
  const key = targetPnpmRuntimeKey(cwd);
  const prepared = preparedTargetPnpmRuntimes.get(key);
  if (!prepared) return;
  preparedTargetPnpmRuntimes.delete(key);
  fs.rmSync(prepared.root, { recursive: true, force: true });
}

function targetPnpmRuntimeKey(cwd: string) {
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

function targetPnpmPackageManager(packageJson: LooseRecord) {
  const packageManager = String(packageJson.packageManager ?? "pnpm@10.33.0");
  if (!packageManager.startsWith("pnpm@")) {
    throw new Error(`unsupported target package manager: ${packageManager}`);
  }
  return packageManager;
}

function registerPreparedTargetPnpmRuntimeCleanup() {
  if (preparedTargetPnpmRuntimeCleanupRegistered) return;
  preparedTargetPnpmRuntimeCleanupRegistered = true;
  process.once("exit", () => {
    for (const prepared of preparedTargetPnpmRuntimes.values()) {
      fs.rmSync(prepared.root, { recursive: true, force: true });
    }
    preparedTargetPnpmRuntimes.clear();
  });
}

function prependValidationPath(env: NodeJS.ProcessEnv, directory: string) {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = [directory, env[pathKey]].filter(Boolean).join(path.delimiter);
}

function targetValidationNeedsRustToolchain(cwd: string, commands: readonly string[]) {
  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) return true;
  return commands.some((command) => {
    try {
      const parts = parseAllowedValidationCommand(command);
      if (validationCommandInvokesRust(parts)) return true;
      const requirement = packageScriptRequirement(parts);
      return requirement ? targetPackageScriptMayInvokeRust(cwd, requirement) : false;
    } catch {
      return false;
    }
  });
}

function validationCommandInvokesRust(parts: readonly string[]) {
  const commandParts = stripEnvPrefix(parts);
  const executable = commandParts[0] ?? "";
  if (executable === "cargo" || executable === "rustc") return true;
  const commandIndex = packageManagerCommandIndex(commandParts);
  if (
    executable === "pnpm" &&
    commandIndex !== null &&
    ["exec", "x"].includes(commandParts[commandIndex] ?? "")
  ) {
    return ["cargo", "rustc"].includes(commandParts[commandIndex + 1] ?? "");
  }
  if (
    (executable === "uv" && commandParts[1] === "run") ||
    (["bundle", "composer"].includes(executable) && commandParts[1] === "exec")
  ) {
    return ["cargo", "rustc"].includes(commandParts[2] ?? "");
  }
  return false;
}

function targetPackageScriptMayInvokeRust(cwd: string, requirement: LooseRecord) {
  const manifests = readWorkspacePackageManifests(cwd, requirement.packageManager);
  if (manifests === null) return true;
  const selected = requirement.workspaceScoped
    ? selectWorkspacePackageManifests(
        manifests,
        requirement.workspaceSelectors,
        requirement.workspaceAll,
      )
    : manifests.filter((manifest) => manifest.relativeDir === ".");
  if (selected === null) return true;
  return selected.some((manifest) =>
    shellCommandMayInvokeRust(manifest.scriptCommands.get(String(requirement.name)) ?? ""),
  );
}

function shellCommandMayInvokeRust(command: string) {
  return /(?:^|[\s;&|()])(?:cargo|rustc)(?=$|[\s;&|()])/.test(command);
}

type VerifiedRustupToolchain = {
  bin: string;
  cargo: string;
  rustc: string;
  rustupHome: string;
};

function verifiedRustupToolchainBin(deadlineAt: number, identityReserveMs: number) {
  const env = trustedRustupProbeEnv();
  const cacheKey = [env.PATH, env.PATHEXT, env.HOME, env.RUSTUP_HOME].join("\0");
  const cached = verifiedRustupToolchainBins.get(cacheKey);
  if (cached) {
    if (cachedRustupToolchainIsValid(cached)) return cached.bin;
    verifiedRustupToolchainBins.delete(cacheKey);
  }
  try {
    const rustupHome = fs.realpathSync(
      run("rustup", ["show", "home"], {
        env,
        timeoutMs: rustupProbeTimeoutMs(deadlineAt, identityReserveMs),
      }).trim(),
    );
    const rustc = fs.realpathSync(
      run("rustup", ["which", "rustc"], {
        env,
        timeoutMs: rustupProbeTimeoutMs(deadlineAt, identityReserveMs),
      }).trim(),
    );
    const cargo = fs.realpathSync(
      run("rustup", ["which", "cargo"], {
        env,
        timeoutMs: rustupProbeTimeoutMs(deadlineAt, identityReserveMs),
      }).trim(),
    );
    const toolchainBin = path.dirname(rustc);
    const relative = path.relative(rustupHome, toolchainBin);
    if (
      path.dirname(cargo) === toolchainBin &&
      relative !== "" &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    ) {
      fs.accessSync(rustc, fs.constants.X_OK);
      fs.accessSync(cargo, fs.constants.X_OK);
      const verified = { bin: toolchainBin, cargo, rustc, rustupHome };
      verifiedRustupToolchainBins.set(cacheKey, verified);
      return verified.bin;
    }
  } catch {}
  return null;
}

function cachedRustupToolchainIsValid(cached: VerifiedRustupToolchain) {
  try {
    if (
      fs.realpathSync(cached.rustupHome) !== cached.rustupHome ||
      fs.realpathSync(cached.bin) !== cached.bin ||
      fs.realpathSync(cached.rustc) !== cached.rustc ||
      fs.realpathSync(cached.cargo) !== cached.cargo ||
      path.dirname(cached.rustc) !== cached.bin ||
      path.dirname(cached.cargo) !== cached.bin
    ) {
      return false;
    }
    const relative = path.relative(cached.rustupHome, cached.bin);
    if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return false;
    }
    fs.accessSync(cached.rustc, fs.constants.X_OK);
    fs.accessSync(cached.cargo, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function rustupProbeTimeoutMs(deadlineAt: number, identityReserveMs: number) {
  return Math.max(1, Math.min(5_000, remainingCommandBudget(deadlineAt, identityReserveMs)));
}

function trustedRustupProbeEnv() {
  const env = targetValidationEnv();
  const home = os.userInfo().homedir;
  Object.assign(env, {
    HOME: home,
    RUSTUP_AUTO_INSTALL: "0",
    RUSTUP_HOME: path.join(home, ".rustup"),
    RUSTUP_NO_UPDATE_CHECK: "1",
    USERPROFILE: home,
  });
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
  return resolveAllowedValidationCommandsWithoutWorkspaceBinding(
    command,
    cwd,
    baseBranch,
    options,
  ).map(requireWorkspaceMatchFailure);
}

function resolveAllowedValidationCommandsWithoutWorkspaceBinding(
  command: LooseRecord,
  cwd: string,
  baseBranch: string,
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
    const commandStart = packageManagerCommandIndex(commandParts);
    if (commandStart === null) return [parts];
    const pnpmScript = commandParts[commandStart];
    const pnpmPrefix = commandParts.slice(0, commandStart);
    const packageRequirement = packageScriptRequirement(commandParts);
    const workspaceScoped = packageManagerWorkspaceScoped(commandParts);
    if (
      !packageRequirement?.workspaceScoped &&
      isExpensivePnpmValidation(commandParts, commandStart, options.allowExpensiveValidation)
    ) {
      return [["pnpm", "check:changed"]];
    }
    const vitestArgsStart =
      pnpmScript === "vitest" && commandParts[commandStart + 1] === "run"
        ? commandStart + 2
        : pnpmScript === "exec" &&
            commandParts[commandStart + 1] === "vitest" &&
            commandParts[commandStart + 2] === "run"
          ? commandStart + 3
          : -1;
    if (vitestArgsStart >= 0) {
      if (workspaceScoped) return [parts];
      const vitestArgs = commandParts.slice(vitestArgsStart);
      const pathIndexes = vitestPathFilterIndexes(vitestArgs);
      return withEnvPrefix(
        envPrefix,
        normalizePathValidationCommand(
          [...pnpmPrefix, "exec", "vitest", "run", ...vitestArgs],
          cwd,
          baseBranch,
          pnpmPrefix.length + 3,
          new Set(pathIndexes),
          options,
        ),
      );
    }
    if (pnpmScript === "test" || pnpmScript === "test:serial") {
      if (workspaceScoped) return [parts];
      return withEnvPrefix(
        envPrefix,
        normalizePathValidationCommand(
          [...pnpmPrefix, pnpmScript, ...commandParts.slice(commandStart + 1)],
          cwd,
          baseBranch,
          pnpmPrefix.length + 1,
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
const MAX_WORKSPACE_PATH_LENGTH = 4_096;
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

function targetPackageScriptIsAvailable(
  cwd: string,
  rootScripts: ReadonlySet<string>,
  requirement: LooseRecord,
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
        (manifest) =>
          manifest.relativeDir !== "." && manifest.scripts.has(String(requirement.name)),
      )
    );
  }
  if (selected.length === 0) {
    return requirement.packageManager === "pnpm" && !requirement.workspaceAll;
  }
  if (requirement.packageManager === "npm") {
    return selected.every((manifest) => manifest.scripts.has(requirement.name));
  }
  return selected.some((manifest) => manifest.scripts.has(requirement.name));
}

function assertNoUnsafeBunLifecycleHooks(cwd: string, parts: readonly string[]) {
  const requirement = packageScriptRequirement(parts);
  const unsafe = requirement ? unsafeBunLifecycleHook(cwd, requirement) : null;
  if (unsafe) {
    throw new Error(
      `unsafe validation command: Bun would execute ${unsafe.hook} around ${unsafe.command}`,
    );
  }
}

function unsafeBunLifecycleHook(cwd: string, requirement: LooseRecord) {
  if (requirement.packageManager !== "bun") return null;
  const manifests = readWorkspacePackageManifests(cwd, requirement.packageManager);
  if (manifests === null) return null;
  const selected = requirement.workspaceScoped
    ? selectWorkspacePackageManifests(
        manifests,
        requirement.workspaceSelectors,
        requirement.workspaceAll,
      )
    : manifests.filter((manifest) => manifest.relativeDir === ".");
  if (selected === null) return null;
  for (const manifest of selected) {
    for (const hook of [`pre${requirement.name}`, `post${requirement.name}`]) {
      if (manifest.scripts.has(hook)) {
        return { command: requirement.command, hook };
      }
    }
  }
  return null;
}

function readWorkspacePackageManifests(
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

function readWorkspacePatterns(
  cwd: string,
  packageManager: JsonValue,
  deadlineAt: number,
): string[] | null {
  if (packageManager === "pnpm") {
    const workspacePath = path.join(cwd, "pnpm-workspace.yaml");
    if (fs.existsSync(workspacePath)) {
      try {
        const workspace = parseYaml(
          readWorkspaceMetadataText(workspacePath, deadlineAt),
        ) as LooseRecord;
        if (Array.isArray(workspace?.packages)) {
          return workspace.packages.filter(
            (value: JsonValue): value is string => typeof value === "string",
          );
        }
      } catch {
        return null;
      }
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
    return [];
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

function assertWorkspaceDeadline(deadlineAt: number, operation: string) {
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
