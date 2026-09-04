#!/usr/bin/env node

import { createHash, createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { parseArgs as parseNodeArgs } from "node:util";
import {
  GitHubRequestError,
  createGithubAppTokenFor,
  githubAppCredentials,
  githubAppInstallationId,
  signGithubAppJwt,
} from "../dashboard/github-api.ts";
import { exactReviewSourceRevisionMaterial } from "../dashboard/exact-review-source-revision.ts";
import { classifyOperatorSkipReason, isGitHubThrottleFailure } from "./operator-skip-reasons.mjs";

const DEFAULT_OUTPUT = ".artifacts/exact-review-dlq/inventory.json";
const MAX_SELECTED_IDS = 2;
const MAX_RECONCILE_TARGETS = 100;
const MAX_RECONCILE_RECOVERIES = 10;
const MAX_PARKED_RECONCILE_RECOVERIES = 5;
const MAX_PARKED_INVENTORY_PAGE_SIZE = 50;
const MAX_TERMINAL_TARGET_RECHECKS = 10;
const MAX_RESOLUTION_IDS = 20;
const MAX_HEAD_MISMATCH_SUPERSEDE_TARGETS = 10;
const MAX_INVENTORY_ROWS = 10_000;
const MAX_RECONCILE_INVENTORY_PAGES = 250;
const MAX_RECONCILE_INVENTORY_REFRESHES = 2;
const GRAPHQL_IDENTITY_BATCH_SIZE = 40;
const MAX_CONSECUTIVE_GITHUB_THROTTLES = 3;
const ACTIVE_RECOVERY_REASONS = new Set(["fresh_review_already_active", "publication_item_active"]);
const HEAD_MISMATCH_SUPERSEDE_EXCLUDED_REASONS = new Set(["workflow_cancelled"]);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:._-]{1,200}$/;
const OPERATOR_REQUEST_TIMEOUT_MS = 20_000;
const OPERATOR_DEADLINE_SETTLE_MS = 25;
const MAX_SKIP_SAMPLES = 3;
const MAX_SKIP_REASON_LENGTH = 240;
const TARGET_READ_TOKEN_MODE_ENV = "EXACT_REVIEW_TARGET_TOKEN_MODE";

class DeadLetterInventoryChangedError extends Error {
  constructor(summary, rowIds, targetKeys, blockedGroups) {
    super("dead-letter cleanup changed during reconciliation; refusing stale recovery");
    this.name = "DeadLetterInventoryChangedError";
    this.summary = summary;
    this.rowIds = [...new Set(rowIds)];
    this.targetKeys = [...new Set(targetKeys.filter(Boolean).map(normalizeRecoveryTargetKey))];
    this.blockedGroups = blockedGroups ?? [{ rowIds: this.rowIds, targetKeys: this.targetKeys }];
  }
}

class CanonicalTargetInspectionError extends Error {
  constructor(
    error,
    {
      inspectedTargets = [],
      classifiedFailures = [],
      failedTargets = [],
      notInspectedTargets = [],
    },
  ) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = "CanonicalTargetInspectionError";
    this.inspectedTargets = inspectedTargets;
    this.classifiedFailures = classifiedFailures;
    this.failedTargets = failedTargets;
    this.notInspectedTargets = notInspectedTargets;
  }
}

class GitHubInspectionHttpError extends Error {
  constructor(message, response) {
    super(message);
    this.name = "GitHubInspectionHttpError";
    this.status = response.status;
    this.retryAfter = response.headers.get("retry-after");
    this.rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
  }
}

class TargetInstallationMissingError extends Error {
  constructor(targetRepo, options) {
    super(`GitHub App installation is missing or revoked for ${targetRepo}`, options);
    this.name = "TargetInstallationMissingError";
  }
}

class TargetAppSetupThrottleError extends Error {
  constructor(error, { owner, stage }) {
    const status = Number.isInteger(error?.status) ? error.status : "unknown";
    super(
      `github_throttled scope=app_setup stage=${stage} owner=${owner.toLowerCase()} status=${status}`,
      { cause: error },
    );
    this.name = "TargetAppSetupThrottleError";
    this.status = error?.status;
    this.rateLimited = true;
  }
}

class TargetReadTokenCache {
  constructor(env) {
    this.env = env;
    this.mode = String(env[TARGET_READ_TOKEN_MODE_ENV] || "github-app").trim();
    if (this.mode !== "github-app" && this.mode !== "actions") {
      throw new Error(`${TARGET_READ_TOKEN_MODE_ENV} must be github-app or actions`);
    }
    this.fallbackToken = String(env.GH_TOKEN || "").trim() || String(env.GITHUB_TOKEN || "").trim();
    this.tokensByOwner = new Map();
    this.mintsByRepository = new Map();
    if (this.mode === "actions") {
      if (!this.fallbackToken) {
        throw new Error(
          `GH_TOKEN or GITHUB_TOKEN is required when ${TARGET_READ_TOKEN_MODE_ENV}=actions`,
        );
      }
      this.credentials = null;
      this.appJwt = null;
      return;
    }

    const missing = [];
    if (
      !String(env.CLAWSWEEPER_APP_ID || "").trim() &&
      !String(env.CLAWSWEEPER_APP_CLIENT_ID || "").trim()
    ) {
      missing.push("CLAWSWEEPER_APP_CLIENT_ID or CLAWSWEEPER_APP_ID");
    }
    if (!String(env.CLAWSWEEPER_APP_PRIVATE_KEY || "").trim()) {
      missing.push("CLAWSWEEPER_APP_PRIVATE_KEY");
    }
    if (missing.length) {
      throw new Error(
        `${TARGET_READ_TOKEN_MODE_ENV}=github-app requires complete GitHub App credentials; missing ${missing.join(" and ")}`,
      );
    }
    this.credentials = githubAppCredentials(env);
    if (!this.credentials) {
      throw new Error(
        `${TARGET_READ_TOKEN_MODE_ENV}=github-app requires complete GitHub App credentials`,
      );
    }
    this.appJwt = signGithubAppJwt(this.credentials.issuer, this.credentials.privateKey);
  }

  async tokenFor(target) {
    const { owner, repo } = parseTargetRepository(target);
    if (this.mode === "actions") {
      return this.fallbackToken;
    }
    const ownerKey = owner.toLowerCase();
    const repositoryKey = `${owner}/${repo}`.toLowerCase();
    // Successful tokens and setup throttles are installation-scoped, so they remain owner-cached.
    // Selected-repository installations still authorize each repo on its own REST/GraphQL read,
    // whose 403/404 handling fails closed. An installation-missing 404 is repository-specific,
    // so keep the in-flight/rejected mint under the repository key until its outcome is known.
    let token = this.tokensByOwner.get(ownerKey);
    if (token) return token;

    token = this.mintsByRepository.get(repositoryKey);
    if (!token) {
      token = this.mintForOwner(`${owner}/${repo}`);
      this.mintsByRepository.set(repositoryKey, token);
    }
    try {
      const mintedToken = await token;
      this.tokensByOwner.set(ownerKey, Promise.resolve(mintedToken));
      return mintedToken;
    } catch (error) {
      if (error instanceof TargetAppSetupThrottleError) {
        this.tokensByOwner.set(ownerKey, token);
      }
      throw error;
    }
  }

  async mintForOwner(targetRepo) {
    const [owner] = targetRepo.split("/");
    let installationId;
    try {
      const appJwt = await this.appJwt;
      installationId = await githubAppInstallationId(appJwt, targetRepo, this.env);
    } catch (error) {
      if (error instanceof GitHubRequestError && error.status === 404) {
        throw new TargetInstallationMissingError(targetRepo, { cause: error });
      }
      if (error instanceof GitHubRequestError && error.rateLimited) {
        throw new TargetAppSetupThrottleError(error, { owner, stage: "installation_lookup" });
      }
      throw error;
    }
    try {
      const appJwt = await this.appJwt;
      return await createGithubAppTokenFor({
        env: this.env,
        appJwt,
        installationId,
        label: targetRepo,
        permissions: { contents: "read", issues: "read", pull_requests: "read" },
      });
    } catch (error) {
      if (error instanceof GitHubRequestError && error.status === 404) {
        throw new TargetInstallationMissingError(targetRepo, { cause: error });
      }
      if (error instanceof GitHubRequestError && error.rateLimited) {
        throw new TargetAppSetupThrottleError(error, { owner, stage: "token_mint" });
      }
      throw error;
    }
  }
}

const HELP = `Usage:
  node scripts/exact-review-dead-letter-operator.mjs --action <inventory|recover-fresh|resolve|reconcile|reconcile-parked> [options]

Options:
  --action <action>             Required operator action
  --ids <id,id>                 One or two dead-letter ids for mutation actions
  --idempotency-key <key>       Required for recover-fresh
  --note <text>                 Required for resolve
  --max-targets <count>         Reconcile at most 1-100 canonical targets (default 100)
  --max-recoveries <count>      Queue at most 0-10 DLQ or 0-5 parked reviews (default 10)
  --force-unchanged             Explicitly reset parked retry budgets without source drift
  --execute                     Apply the selected mutation; otherwise preview only
  --output <path>               Inventory artifact path
  -h, --help                    Show this help

The operator always inventories open dead letters first. It never exposes raw replay.
Target reads use GitHub App credentials by default. Set EXACT_REVIEW_TARGET_TOKEN_MODE=actions
only to opt explicitly into GH_TOKEN or GITHUB_TOKEN for target reads.
`;

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const queueUrl = String(process.env.EXACT_REVIEW_QUEUE_URL || "").replace(/\/$/, "");
  const secret = String(process.env.CLAWSWEEPER_WEBHOOK_SECRET || "");
  const targetReadTokens = new TargetReadTokenCache(process.env);
  if (!queueUrl || !secret) {
    throw new Error("EXACT_REVIEW_QUEUE_URL and CLAWSWEEPER_WEBHOOK_SECRET are required");
  }

  if (args.action === "reconcile-parked") {
    const deadlineAt = parkedReconcileDeadlineAt();
    const inventory = await loadParkedReviewInventory({
      queueUrl,
      secret,
      maxRows: args.maxTargets,
      deadlineAt,
    });
    await mkdir(dirname(resolve(args.output)), { recursive: true });
    await writeFile(args.output, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
    await reconcileParkedReviews({
      inventory,
      queueUrl,
      secret,
      args,
      deadlineAt,
      targetReadTokens,
    });
    return;
  }

  let inventory = await loadInventory({
    queueUrl,
    secret,
    ...(args.action === "reconcile" ? { maxPages: MAX_RECONCILE_INVENTORY_PAGES } : {}),
  });
  await mkdir(dirname(resolve(args.output)), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");

  if (args.action === "inventory") {
    printResult({ action: args.action, output: args.output, summary: inventory.summary });
    return;
  }

  if (args.action === "reconcile") {
    const progress = {
      summary: null,
      blockedRows: new Set(),
      blockedTargets: new Set(),
      countedSkippedTargets: new Set(),
      inspectedTargetIds: new Set(),
      pendingRecoveryTargetIds: new Set(),
      supersessionTargetIds: new Set(),
      terminalTargetRechecks: 0,
    };
    for (let refreshes = 0; refreshes <= MAX_RECONCILE_INVENTORY_REFRESHES; refreshes += 1) {
      try {
        await reconcileDeadLetters({
          inventory,
          queueUrl,
          secret,
          args,
          progress,
          targetReadTokens,
        });
        return;
      } catch (error) {
        if (!(error instanceof DeadLetterInventoryChangedError)) throw error;
        // Guarded resolution is one Worker transaction: an inventory race skips
        // every requested row. Refuse recovery if that safety contract changes.
        if (
          error.summary.resolved !== 0 ||
          error.summary.unparked !== 0 ||
          error.summary.skipped !== error.rowIds.length
        ) {
          // oxlint-disable-next-line preserve-caught-error -- Keep the guarded mutation invariant stable and bounded.
          throw new Error("guarded dead-letter cleanup was not atomic; refusing stale recovery");
        }
        if (
          refreshes === MAX_RECONCILE_INVENTORY_REFRESHES ||
          (progress.summary.inspected_targets >= args.maxTargets &&
            progress.pendingRecoveryTargetIds.size === 0)
        ) {
          // Never recover against stale aliases if producers keep changing the
          // inventory faster than this bounded operator can inspect it. Keep
          // the original target cap and accumulated counters across refreshes.
          printReconcileResult({
            ...progress.summary,
            inventory_changed: true,
            skipped_rows: error.summary.skipped,
          });
          return;
        }
        inventory = await loadInventory({
          queueUrl,
          secret,
          maxPages: MAX_RECONCILE_INVENTORY_PAGES,
        });
        const openRowIds = new Set(inventory.dead_letters.map((row) => row.dead_letter_id));
        for (const blocked of error.blockedGroups) {
          const unchangedRowIds = blocked.rowIds.filter((id) => openRowIds.has(id));
          for (const id of unchangedRowIds) progress.blockedRows.add(id);
          if (unchangedRowIds.length) {
            if (
              blocked.targetKeys.every((target) => !/^([^/]+)\/([^#]+)#([1-9]\d*)$/.test(target))
            ) {
              for (const row of inventory.dead_letters) {
                const target = row.fresh_recovery.item_key;
                if (!target || !/^([^/]+)\/([^#]+)#([1-9]\d*)$/.test(target)) {
                  progress.blockedRows.add(row.dead_letter_id);
                }
              }
            }
            for (const target of blocked.targetKeys) progress.blockedTargets.add(target);
          }
        }
        await writeFile(args.output, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
      }
    }
    return;
  }

  const selected = selectRows(inventory.dead_letters, args.ids);
  if (args.action === "recover-fresh") {
    // Resolve must remain available for closed or unmapped rows; only recovery needs a live target.
    if (!IDEMPOTENCY_KEY.test(args.idempotencyKey)) {
      throw new Error("--idempotency-key must match [A-Za-z0-9:._-]{1,200}");
    }
    const ineligible = selected.filter((row) => !row.fresh_recovery.eligible);
    if (ineligible.length) {
      throw new Error(
        `selected dead letters are not eligible for fresh recovery: ${ineligible
          .map((row) => row.dead_letter_id)
          .join(",")}`,
      );
    }
    const recoveryTargets = selected.map((row) => row.fresh_recovery.item_key);
    if (recoveryTargets.some((target) => !target)) {
      throw new Error("selected dead letters are missing fresh recovery targets");
    }
    if (new Set(recoveryTargets).size !== recoveryTargets.length) {
      throw new Error("selected dead letters must map to distinct fresh recovery targets");
    }
    const canonicalTargetIds = await assertOpenRecoveryTargets(recoveryTargets, targetReadTokens);
    if (new Set(canonicalTargetIds).size !== canonicalTargetIds.length) {
      throw new Error("selected dead letters must resolve to distinct GitHub items");
    }
    if (!args.execute) {
      printResult({ action: args.action, dry_run: true, selected });
      return;
    }
    const result = await signedPost({
      queueUrl,
      secret,
      path: "/internal/exact-review/dead-letters/recover-fresh",
      payload: { ids: args.ids, idempotency_key: args.idempotencyKey },
    });
    printResult({
      action: args.action,
      dry_run: false,
      selected,
      result: mutationSummary(args.action, result),
    });
    return;
  }

  if (!args.note || args.note.length > 500) {
    throw new Error("--note is required for resolve and must be at most 500 characters");
  }
  if (!args.execute) {
    printResult({ action: args.action, dry_run: true, selected });
    return;
  }
  const result = await signedPost({
    queueUrl,
    secret,
    path: "/internal/exact-review/dead-letters/resolve",
    payload: { ids: args.ids, note: args.note },
  });
  printResult({
    action: args.action,
    dry_run: false,
    selected,
    result: mutationSummary(args.action, result),
  });
}

function parseArgs(argv) {
  // Unlike the E2E CLIs, this operator consumes missing or option-looking values verbatim.
  const normalized = [];
  const stringOptions = new Set([
    "--action",
    "--ids",
    "--idempotency-key",
    "--note",
    "--max-targets",
    "--max-recoveries",
    "--output",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (
      value === "-h" ||
      value === "--help" ||
      value === "--execute" ||
      value === "--force-unchanged"
    ) {
      normalized.push(value);
    } else if (stringOptions.has(value)) normalized.push(`${value}=${String(argv[++index] || "")}`);
    else throw new Error(`unknown option ${value}; use --help`);
  }
  const { values } = parseNodeArgs({
    args: normalized,
    options: {
      help: { type: "boolean", short: "h" },
      execute: { type: "boolean" },
      "force-unchanged": { type: "boolean" },
      action: { type: "string" },
      ids: { type: "string" },
      "idempotency-key": { type: "string" },
      note: { type: "string" },
      "max-targets": { type: "string" },
      "max-recoveries": { type: "string" },
      output: { type: "string" },
    },
  });
  const maxRecoveriesProvided = values["max-recoveries"] !== undefined;
  const args = {
    action: values.action ?? "",
    ids: (values.ids ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    idempotencyKey: (values["idempotency-key"] ?? "").trim(),
    note: (values.note ?? "").trim(),
    execute: values.execute ?? false,
    forceUnchanged: values["force-unchanged"] ?? false,
    maxTargets:
      values["max-targets"] === undefined
        ? MAX_RECONCILE_TARGETS
        : boundedInteger(values["max-targets"], "--max-targets", 1, MAX_RECONCILE_TARGETS),
    maxRecoveries: maxRecoveriesProvided
      ? boundedInteger(values["max-recoveries"], "--max-recoveries", 0, MAX_RECONCILE_RECOVERIES)
      : MAX_RECONCILE_RECOVERIES,
    output: (values.output ?? DEFAULT_OUTPUT).trim(),
    help: values.help ?? false,
  };
  if (args.help) return args;
  if (
    !["inventory", "recover-fresh", "resolve", "reconcile", "reconcile-parked"].includes(
      args.action,
    )
  ) {
    throw new Error(
      "--action must be inventory, recover-fresh, resolve, reconcile, or reconcile-parked",
    );
  }
  if (!args.output) throw new Error("--output is required");
  if (args.forceUnchanged && args.action !== "reconcile-parked") {
    throw new Error("--force-unchanged requires --action reconcile-parked");
  }
  if (args.action === "reconcile-parked" && !maxRecoveriesProvided) {
    args.maxRecoveries = MAX_PARKED_RECONCILE_RECOVERIES;
  }
  if (args.action === "reconcile-parked" && args.maxRecoveries > MAX_PARKED_RECONCILE_RECOVERIES) {
    throw new Error(
      `--max-recoveries must be between 0 and ${MAX_PARKED_RECONCILE_RECOVERIES} for reconcile-parked`,
    );
  }
  if (
    args.action !== "inventory" &&
    args.action !== "reconcile" &&
    args.action !== "reconcile-parked"
  ) {
    if (args.ids.length < 1 || args.ids.length > MAX_SELECTED_IDS) {
      throw new Error(`mutation actions require between 1 and ${MAX_SELECTED_IDS} --ids`);
    }
    if (new Set(args.ids).size !== args.ids.length) {
      throw new Error("--ids must not contain duplicates");
    }
  }
  return args;
}

function boundedInteger(value, flag, minimum, maximum) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${flag} must be between ${minimum} and ${maximum}`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${flag} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

async function reconcileDeadLetters({
  inventory,
  queueUrl,
  secret,
  args,
  progress,
  targetReadTokens,
}) {
  const initialPressure = await readQueuePressure(queueUrl);
  const openIds = new Set(inventory.dead_letters.map((row) => row.dead_letter_id));
  const summary = (progress.summary ??= {
    action: "reconcile",
    dry_run: !args.execute,
    inventory_complete: inventory.complete,
    queue_pressure: initialPressure.status,
    inspected_targets: 0,
    recovered_targets: 0,
    resolved_rows: 0,
    supersession_checked_targets: 0,
    superseded_targets: 0,
    superseded_rows: 0,
    invalid_rows: 0,
    closed_rows: 0,
    duplicate_rows: 0,
    active_review_rows: 0,
    skipped_targets: 0,
    skip_reasons: {},
    skip_samples: [],
  });
  summary.inventory_complete = inventory.complete;
  summary.queue_pressure = initialPressure.status;
  progress.pendingRecoveryTargetIds.clear();
  const groups = new Map();
  const invalidRows = [];
  for (const row of inventory.dead_letters) {
    const target = row.fresh_recovery.item_key;
    if (!target || !/^([^/]+)\/([^#]+)#([1-9]\d*)$/.test(target)) {
      if (!progress.blockedRows.has(row.dead_letter_id)) invalidRows.push(row);
      continue;
    }
    const key = normalizeRecoveryTargetKey(target);
    const group = groups.get(key) ?? { target, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  const blockedResolutions = [];
  const resolveForReconciliation = async (options) => {
    try {
      return await reconcileResolve(options);
    } catch (error) {
      if (
        !(error instanceof DeadLetterInventoryChangedError) ||
        error.summary.resolved !== 0 ||
        error.summary.unparked !== 0 ||
        error.summary.skipped !== error.rowIds.length
      ) {
        throw error;
      }
      blockedResolutions.push(error);
      return { ...error.summary, blocked: true };
    }
  };
  const resolveInvalidRows = async () => {
    const resolution = await resolveForReconciliation({
      queueUrl,
      secret,
      rows: invalidRows.slice(0, MAX_RESOLUTION_IDS),
      note: "automatic reconciliation: invalid legacy publication has no recoverable target",
      execute: args.execute,
      openIds,
    });
    summary.resolved_rows += resolution.resolved;
    summary.invalid_rows += resolution.resolved;
    return resolution;
  };
  const refreshBlockedInventory = () => {
    if (!blockedResolutions.length) return;
    throw new DeadLetterInventoryChangedError(
      {
        resolved: 0,
        skipped: blockedResolutions.reduce((total, error) => total + error.summary.skipped, 0),
        unparked: 0,
      },
      blockedResolutions.flatMap((error) => error.rowIds),
      blockedResolutions.flatMap((error) => error.targetKeys),
      blockedResolutions.flatMap((error) => error.blockedGroups),
    );
  };
  const accountSkippedTarget = (nodeId, target, reasonClass, reason) => {
    if (progress.countedSkippedTargets.has(nodeId)) return;
    progress.countedSkippedTargets.add(nodeId);
    summary.skipped_targets += 1;
    if (reasonClass) recordClassifiedSkips(summary, [target], reasonClass, reason);
  };
  const canInspectTarget = (nodeId) =>
    progress.inspectedTargetIds.has(nodeId) || summary.inspected_targets < args.maxTargets;
  const reserveTargetInspection = (nodeId) => {
    if (progress.inspectedTargetIds.has(nodeId)) return true;
    if (summary.inspected_targets >= args.maxTargets) return false;
    progress.inspectedTargetIds.add(nodeId);
    summary.inspected_targets += 1;
    return true;
  };

  // A partial page window cannot prove that a transferred alias or an active
  // sibling was observed. Invalid rows are independently terminal and safe to
  // drain; every GitHub-targeted mutation waits for a complete inventory.
  if (!inventory.complete) {
    if (invalidRows.length) {
      await resolveInvalidRows();
    }
    refreshBlockedInventory();
    accountClassifiedSkips(
      summary,
      [...groups.values()].map((group) => group.target),
      "inventory_incomplete",
      new Error("dead-letter inventory is incomplete"),
    );
    printReconcileResult(summary);
    return;
  }

  const selectedGroups = [...groups.values()];
  let identities;
  try {
    const inspection = await inspectCanonicalTargets(
      selectedGroups,
      args.maxTargets,
      targetReadTokens,
    );
    identities = inspection.identities;
    for (const failure of inspection.failedTargets) {
      recordInspectionSkips(summary, [failure.target], failure.error);
    }
    if (inspection.notInspectedTargets.length) {
      recordInspectionSkips(
        summary,
        inspection.notInspectedTargets,
        new Error(
          "canonical target was not inspected because canonical discovery aborted after another target inspection failed",
        ),
      );
    }
    summary.skipped_targets +=
      inspection.failedTargets.length + inspection.notInspectedTargets.length;
  } catch (error) {
    if (error instanceof CanonicalTargetInspectionError) {
      for (const failure of error.classifiedFailures) {
        recordInspectionSkips(summary, [failure.target], failure.error);
      }
      recordAbortedInspectionSkips(summary, {
        inspectedTargets: error.inspectedTargets,
        failedTargets: error.failedTargets,
        notInspectedTargets: error.notInspectedTargets,
        error: error.cause ?? error,
      });
    } else {
      recordClassifiedSkips(
        summary,
        selectedGroups.map((group) => group.target),
        "discovery_failed",
        error,
      );
    }
    if (invalidRows.length) {
      await resolveInvalidRows();
    }
    refreshBlockedInventory();
    summary.skipped_targets += groups.size;
    printReconcileResult(summary);
    return;
  }
  const canonicalGroups = new Map();
  for (const group of groups.values()) {
    const live = identities.get(normalizeRecoveryTargetKey(group.target));
    if (!live) continue;
    if (!["open", "closed"].includes(live.state)) {
      accountClassifiedSkips(
        summary,
        selectedGroups
          .filter((group) => identities.has(normalizeRecoveryTargetKey(group.target)))
          .map((group) => group.target),
        "identity_not_actionable",
        new Error("canonical target identity is not open or closed"),
      );
      printReconcileResult(summary);
      return;
    }
    const canonical = canonicalGroups.get(live.node_id) ?? {
      canonicalTarget: group.target,
      live,
      rows: [],
      hasActiveWork: false,
    };
    canonical.rows.push(...group.rows);
    canonical.hasActiveWork ||= group.rows.some((row) =>
      ACTIVE_RECOVERY_REASONS.has(row.fresh_recovery.reason),
    );
    canonicalGroups.set(live.node_id, canonical);
  }

  // Terminal cleanup must always get a turn, even when every earlier open
  // target is blocked by pressure. Active fences are never resolved here.
  const ordered = [...canonicalGroups.values()].sort(
    (left, right) => Number(right.live.state === "closed") - Number(left.live.state === "closed"),
  );
  const recoveries = [];
  for (const { canonicalTarget, live, rows, hasActiveWork } of ordered) {
    const groupAliases = [
      ...new Set([
        ...rows.map((row) => normalizeRecoveryTargetKey(row.fresh_recovery.item_key)),
        ...(live.canonical_target ? [normalizeRecoveryTargetKey(live.canonical_target)] : []),
      ]),
    ];
    if (groupAliases.some((alias) => progress.blockedTargets.has(alias))) {
      accountSkippedTarget(
        live.node_id,
        canonicalTarget,
        "blocked_alias",
        new Error("canonical target is blocked by an unchanged alias"),
      );
      continue;
    }
    if (hasActiveWork) {
      accountSkippedTarget(
        live.node_id,
        canonicalTarget,
        "active_work",
        new Error("canonical target has active review or publication work"),
      );
      continue;
    }
    if (live.state === "open" && !rows.some((row) => row.fresh_recovery.eligible)) {
      accountSkippedTarget(
        live.node_id,
        canonicalTarget,
        "no_eligible_rows",
        new Error("canonical target has no eligible dead-letter rows"),
      );
      continue;
    }
    if (live.state === "closed") {
      if (!canInspectTarget(live.node_id)) {
        accountSkippedTarget(
          live.node_id,
          canonicalTarget,
          "inspection_cap",
          new Error("reconciliation target inspection cap reached"),
        );
        continue;
      }
      if (progress.terminalTargetRechecks >= MAX_TERMINAL_TARGET_RECHECKS) {
        accountSkippedTarget(
          live.node_id,
          canonicalTarget,
          "terminal_recheck_cap",
          new Error("terminal target recheck cap reached"),
        );
        continue;
      }
      progress.terminalTargetRechecks += 1;
      let current;
      try {
        current = await inspectRecoveryTarget(canonicalTarget, targetReadTokens);
      } catch (error) {
        accountSkippedTarget(
          live.node_id,
          canonicalTarget,
          classifyOperatorSkipReason(error),
          error,
        );
        continue;
      }
      if (current.state !== "closed" || current.node_id !== live.node_id) {
        accountSkippedTarget(
          live.node_id,
          canonicalTarget,
          "closed_state_changed",
          new Error("live target state or canonical identity changed during terminal recheck"),
        );
        continue;
      }
      reserveTargetInspection(live.node_id);
      const resolution = await resolveForReconciliation({
        queueUrl,
        secret,
        rows: rows.slice(0, MAX_RESOLUTION_IDS),
        note: `automatic reconciliation: canonical target ${canonicalTarget} is closed`,
        execute: args.execute,
        openIds,
        canonicalTarget: current.canonical_target,
        aliases: groupAliases,
      });
      if (resolution.blocked) {
        continue;
      }
      summary.resolved_rows += resolution.resolved;
      summary.closed_rows += resolution.resolved;
      if (resolution.unparked) {
        printReconcileResult(summary);
        return;
      }
      continue;
    }
    const primary = rows.find(
      (row) =>
        row.fresh_recovery.eligible &&
        (!row.fresh_recovery.source_head_sha ||
          row.fresh_recovery.source_head_sha === live.head_sha),
    );
    if (!primary) {
      const eligibleStaleRows = rows.filter(
        (row) =>
          row.fresh_recovery.eligible &&
          row.fresh_recovery.source_head_sha &&
          row.fresh_recovery.source_head_sha !== live.head_sha,
      );
      const supersedeRows = eligibleStaleRows.filter(
        (row) => !HEAD_MISMATCH_SUPERSEDE_EXCLUDED_REASONS.has(row.reason_code),
      );
      const excludedRows = eligibleStaleRows.filter((row) =>
        HEAD_MISMATCH_SUPERSEDE_EXCLUDED_REASONS.has(row.reason_code),
      );
      if (!supersedeRows.length) {
        accountSkippedTarget(
          live.node_id,
          canonicalTarget,
          "head_mismatch_out_of_scope",
          new Error("head-mismatched dead letters have only excluded resolution reasons"),
        );
        continue;
      }
      if (
        !progress.supersessionTargetIds.has(live.node_id) &&
        progress.supersessionTargetIds.size >= MAX_HEAD_MISMATCH_SUPERSEDE_TARGETS
      ) {
        accountSkippedTarget(
          live.node_id,
          canonicalTarget,
          "head_mismatch_resolution_cap",
          new Error("head-mismatch supersession target cap reached"),
        );
        continue;
      }
      if (!progress.supersessionTargetIds.has(live.node_id)) {
        progress.supersessionTargetIds.add(live.node_id);
        summary.supersession_checked_targets += 1;
      }
      const evidence = await inspectCanonicalSupersessionEvidence({
        queueUrl,
        secret,
        target: live.canonical_target || canonicalTarget,
        liveHeadSha: live.head_sha,
      });
      if (!evidence.proven) {
        accountSkippedTarget(
          live.node_id,
          canonicalTarget,
          "head_mismatch_unproven",
          new Error(evidence.reason),
        );
        continue;
      }
      let current;
      try {
        current = await inspectRecoveryTarget(
          live.canonical_target || canonicalTarget,
          targetReadTokens,
        );
      } catch (error) {
        accountSkippedTarget(
          live.node_id,
          canonicalTarget,
          classifyOperatorSkipReason(error),
          error,
        );
        continue;
      }
      if (
        current.state !== "open" ||
        current.node_id !== live.node_id ||
        current.head_sha !== live.head_sha
      ) {
        accountSkippedTarget(
          live.node_id,
          canonicalTarget,
          "head_mismatch_revalidation_changed",
          new Error(
            "live pull-request identity or head changed after canonical supersession evidence",
          ),
        );
        continue;
      }
      const resolutionAliases = [
        ...new Set([
          ...groupAliases,
          ...(current.canonical_target
            ? [normalizeRecoveryTargetKey(current.canonical_target)]
            : []),
        ]),
      ];
      const selectedRows = supersedeRows.slice(0, MAX_RESOLUTION_IDS);
      const resolution = await resolveForReconciliation({
        queueUrl,
        secret,
        rows: selectedRows,
        note: `automatic reconciliation: stale publication superseded by completed canonical record at newer head ${live.head_sha}; evidence=${evidence.source}`,
        outcome: "superseded",
        execute: args.execute,
        openIds,
        canonicalTarget: current.canonical_target || live.canonical_target,
        aliases: resolutionAliases,
      });
      if (resolution.blocked) continue;
      summary.resolved_rows += resolution.resolved;
      summary.superseded_rows += resolution.resolved;
      if (resolution.resolved) summary.superseded_targets += 1;
      if (resolution.unparked) {
        printReconcileResult(summary);
        return;
      }
      if (supersedeRows.length > selectedRows.length) {
        accountSkippedTarget(
          live.node_id,
          canonicalTarget,
          "head_mismatch_resolution_partial",
          new Error("head-mismatch supersession row cap reached"),
        );
      } else if (excludedRows.length) {
        accountSkippedTarget(
          live.node_id,
          canonicalTarget,
          "head_mismatch_out_of_scope",
          new Error("excluded head-mismatched dead letters remain open"),
        );
      }
      continue;
    }
    if (summary.recovered_targets + recoveries.length >= args.maxRecoveries) {
      accountSkippedTarget(live.node_id, canonicalTarget, "recovery_cap");
      continue;
    }
    const pressure = await readQueuePressure(queueUrl);
    summary.queue_pressure = pressure.status;
    if (pressure.status !== "idle" || pressure.availableSlots <= recoveries.length) {
      accountSkippedTarget(
        live.node_id,
        canonicalTarget,
        pressure.status === "idle" ? "recovery_capacity" : "recovery_deferred_pressure",
        pressure.status === "idle" ? new Error("no queue recovery slot is available") : undefined,
      );
      continue;
    }
    if (!reserveTargetInspection(live.node_id)) {
      accountSkippedTarget(
        live.node_id,
        canonicalTarget,
        "inspection_cap",
        new Error("reconciliation target inspection cap reached"),
      );
      continue;
    }
    const duplicates = rows.filter((row) => row.dead_letter_id !== primary.dead_letter_id);
    if (duplicates.length) {
      const selectedDuplicates = duplicates.slice(0, MAX_RESOLUTION_IDS);
      const resolution = await resolveForReconciliation({
        queueUrl,
        secret,
        rows: selectedDuplicates,
        note: `automatic reconciliation: duplicate publication superseded by canonical target ${canonicalTarget}`,
        execute: args.execute,
        openIds,
        canonicalTarget: live.canonical_target,
        aliases: groupAliases,
      });
      if (resolution.blocked) {
        continue;
      }
      summary.resolved_rows += resolution.resolved;
      summary.duplicate_rows += resolution.resolved;
      if (
        resolution.unparked ||
        resolution.resolved !== selectedDuplicates.length ||
        duplicates.length > MAX_RESOLUTION_IDS
      ) {
        accountSkippedTarget(
          live.node_id,
          canonicalTarget,
          "duplicate_resolution_partial",
          new Error("duplicate resolution did not fully drain the canonical target"),
        );
        if (resolution.unparked) {
          printReconcileResult(summary);
          return;
        }
        continue;
      }
    }
    recoveries.push({
      primary,
      canonicalTarget,
      live,
      aliases: groupAliases,
    });
    progress.pendingRecoveryTargetIds.add(live.node_id);
  }

  if (invalidRows.length) {
    const resolution = await resolveInvalidRows();
    if (resolution.unparked) {
      printReconcileResult(summary);
      return;
    }
  }

  refreshBlockedInventory();
  if (recoveries.length) {
    const revalidatedRecoveries = [];
    let consecutiveThrottles = 0;
    let individuallySkipped = 0;
    for (const [index, recovery] of recoveries.entries()) {
      let current;
      try {
        current = await inspectRecoveryTarget(recovery.canonicalTarget, targetReadTokens);
      } catch (error) {
        if (error instanceof TargetInstallationMissingError) {
          accountInspectionSkips(summary, [recovery.canonicalTarget], error);
          individuallySkipped += 1;
          continue;
        }
        if (isThrottleInspectionError(error)) {
          accountInspectionSkips(summary, [recovery.canonicalTarget], error);
          individuallySkipped += 1;
          consecutiveThrottles += 1;
          if (consecutiveThrottles >= MAX_CONSECUTIVE_GITHUB_THROTTLES) {
            const notInspectedTargets = recoveries
              .slice(index + 1)
              .map((candidate) => candidate.canonicalTarget);
            accountInspectionSkips(
              summary,
              notInspectedTargets,
              new Error(
                "canonical target was not inspected because canonical discovery aborted after another target inspection failed",
              ),
            );
            individuallySkipped += notInspectedTargets.length;
            break;
          }
          continue;
        }
        recordAbortedInspectionSkips(summary, {
          inspectedTargets: revalidatedRecoveries.map((candidate) => candidate.canonicalTarget),
          failedTargets: [recovery.canonicalTarget],
          notInspectedTargets: recoveries
            .slice(index + 1)
            .map((candidate) => candidate.canonicalTarget),
          error,
        });
        summary.skipped_targets += recoveries.length - individuallySkipped;
        printReconcileResult(summary);
        return;
      }
      consecutiveThrottles = 0;
      if (current.state !== "open" || current.node_id !== recovery.live.node_id) {
        recordRecoveryRevalidationAbort(
          summary,
          revalidatedRecoveries,
          recovery,
          recoveries.slice(index + 1),
          "closed_state_changed",
          new Error("live target state or canonical identity changed during recovery recheck"),
        );
        summary.skipped_targets += recoveries.length - individuallySkipped;
        printReconcileResult(summary);
        return;
      }
      if (
        recovery.primary.fresh_recovery.source_head_sha &&
        recovery.primary.fresh_recovery.source_head_sha !== current.head_sha
      ) {
        recordRecoveryRevalidationAbort(
          summary,
          revalidatedRecoveries,
          recovery,
          recoveries.slice(index + 1),
          "head_mismatch",
          new Error("eligible dead-letter source head does not match the live pull-request head"),
        );
        summary.skipped_targets += recoveries.length - individuallySkipped;
        printReconcileResult(summary);
        return;
      }
      if (current.canonical_target) {
        recovery.canonicalTarget = current.canonical_target;
        recovery.aliases = [
          ...new Set([...recovery.aliases, normalizeRecoveryTargetKey(current.canonical_target)]),
        ];
      }
      recovery.currentHeadSha = current.head_sha || null;
      revalidatedRecoveries.push(recovery);
    }
    if (!revalidatedRecoveries.length) {
      printReconcileResult(summary);
      return;
    }
    const finalPressure = await readQueuePressure(queueUrl);
    summary.queue_pressure = finalPressure.status;
    if (finalPressure.status !== "idle" || finalPressure.availableSlots < 1) {
      summary.skipped_targets += revalidatedRecoveries.length;
      if (finalPressure.status !== "idle") {
        recordSkipReasonCount(summary, "recovery_deferred_pressure", revalidatedRecoveries.length);
      } else {
        recordClassifiedSkips(
          summary,
          revalidatedRecoveries.map((recovery) => recovery.canonicalTarget),
          "recovery_capacity",
          new Error("no queue recovery slot is available"),
        );
      }
      printReconcileResult(summary);
      return;
    }
    const admitted = revalidatedRecoveries.slice(0, finalPressure.availableSlots);
    accountClassifiedSkips(
      summary,
      revalidatedRecoveries.slice(admitted.length).map((recovery) => recovery.canonicalTarget),
      "recovery_capacity",
      new Error("no queue recovery slot is available"),
    );
    const ids = admitted.map(({ primary }) => primary.dead_letter_id);
    if (args.execute) {
      const identity = admitted
        .map(({ live }) => live.node_id)
        .sort()
        .join("\n");
      const recoveryKey = `autoreconcile:${createHash("sha256").update(identity).digest("hex")}`;
      const result = await signedPost({
        queueUrl,
        secret,
        path: "/internal/exact-review/dead-letters/recover-fresh",
        payload: {
          ids,
          idempotency_key: recoveryKey,
          inventory_fingerprint: deadLetterInventoryFingerprint(openIds),
          recovery_aliases: admitted.map(({ primary, aliases }) => ({
            id: primary.dead_letter_id,
            aliases,
          })),
          recovery_targets: admitted.map(({ primary, canonicalTarget, currentHeadSha }) => ({
            id: primary.dead_letter_id,
            target: normalizeRecoveryTargetKey(canonicalTarget),
            ...(currentHeadSha ? { source_head_sha: currentHeadSha } : {}),
          })),
        },
      });
      const recovered = mutationSummary("recover-fresh", result);
      summary.recovered_targets += recovered.recovered + recovered.deduped;
      summary.resolved_rows += recovered.recovered + recovered.deduped;
      accountClassifiedSkips(
        summary,
        admitted.slice(0, recovered.skipped).map((recovery) => recovery.canonicalTarget),
        "recovery_mutation_skipped",
        new Error("recovery mutation skipped an admitted target"),
        recovered.skipped,
      );
    } else {
      summary.recovered_targets += ids.length;
      summary.resolved_rows += ids.length;
    }
  }
  printReconcileResult(summary);
}

async function reconcileParkedReviews({
  inventory,
  queueUrl,
  secret,
  args,
  deadlineAt,
  targetReadTokens,
}) {
  const pressure = parkedReconcileDeadlineReached(deadlineAt)
    ? { status: "unknown", availableSlots: 0 }
    : await readQueuePressure(queueUrl, deadlineAt);
  const summary = {
    action: "reconcile-parked",
    dry_run: !args.execute,
    inventory_complete: inventory.complete,
    queue_pressure: pressure.status,
    inspected_targets: 0,
    terminal_targets: 0,
    repository_gone_targets: 0,
    resolved_targets: 0,
    open_targets: 0,
    recovered_targets: 0,
    skipped_targets: 0,
    skip_reasons: {},
    skip_samples: [],
  };
  const stopForDeadline = (skippedTargets) => {
    summary.deadline_reached = true;
    summary.skipped_targets += skippedTargets;
    printResult(summary);
  };
  const terminal = [];
  const recoverable = [];
  const selectedRows = inventory.parked_reviews.slice(0, args.maxTargets);
  if (inventory.deadline_reached || parkedReconcileDeadlineReached(deadlineAt)) {
    stopForDeadline(selectedRows.length);
    return;
  }
  for (const [index, row] of selectedRows.entries()) {
    if (row.excluded_reason) {
      summary.skipped_targets += 1;
      continue;
    }
    if (parkedReconcileDeadlineReached(deadlineAt)) {
      stopForDeadline(selectedRows.length - index + terminal.length + recoverable.length);
      return;
    }
    summary.inspected_targets += 1;
    let target;
    try {
      target = await inspectParkedReviewTarget(
        `${row.target_repo}#${row.item_number}`,
        targetReadTokens,
        deadlineAt,
      );
    } catch (error) {
      if (parkedReconcileDeadlineReached(deadlineAt)) {
        stopForDeadline(selectedRows.length - index + terminal.length + recoverable.length);
        return;
      }
      recordInspectionSkips(summary, [`${row.target_repo}#${row.item_number}`], error);
      summary.skipped_targets += 1;
      continue;
    }
    if (target.state === "closed" || target.state === "repository_gone") {
      terminal.push({ row, target });
      summary.terminal_targets += 1;
      if (target.state === "repository_gone") summary.repository_gone_targets += 1;
    } else if (target.state === "open") {
      summary.open_targets += 1;
      if (!args.forceUnchanged && !parkedReviewRetryIdentityChanged(row, target)) {
        summary.skipped_targets += 1;
        recordSkipReasonCount(summary, "unchanged_review_identity", 1);
      } else if (recoverable.length < args.maxRecoveries) recoverable.push({ row, target });
      else {
        summary.skipped_targets += 1;
        recordSkipReasonCount(summary, "recovery_cap", 1);
      }
    } else {
      summary.skipped_targets += 1;
    }
  }

  for (const [index, candidate] of terminal.entries()) {
    if (parkedReconcileDeadlineReached(deadlineAt)) {
      stopForDeadline(terminal.length - index + recoverable.length);
      return;
    }
    if (!args.execute) {
      summary.resolved_targets += 1;
      continue;
    }
    let current;
    try {
      current = await inspectParkedReviewTarget(
        candidate.target.requested_target,
        targetReadTokens,
        deadlineAt,
      );
    } catch (error) {
      if (parkedReconcileDeadlineReached(deadlineAt)) {
        stopForDeadline(terminal.length - index + recoverable.length);
        return;
      }
      recordInspectionSkips(summary, [candidate.target.requested_target], error);
      summary.skipped_targets += 1;
      continue;
    }
    if (current.state !== candidate.target.state) {
      summary.skipped_targets += 1;
      continue;
    }
    let result;
    try {
      result = await signedPost({
        queueUrl,
        secret,
        path: "/internal/exact-review/parked-reviews/resolve",
        payload: {
          items: [parkedMutationItem(candidate.row)],
          note:
            current.state === "repository_gone"
              ? `automatic reconciliation: repository for ${current.requested_target} no longer exists`
              : `automatic reconciliation: GitHub target ${current.canonical_target} is terminal`,
        },
        deadlineAt,
      });
    } catch (error) {
      if (parkedReconcileDeadlineReached(deadlineAt)) {
        stopForDeadline(terminal.length - index + recoverable.length);
        return;
      }
      throw error;
    }
    summary.resolved_targets += requiredCount(result, "resolved");
    summary.skipped_targets += requiredCount(result, "skipped");
  }

  if (recoverable.length && pressure.status === "idle") {
    const available = Math.min(args.maxRecoveries, pressure.availableSlots);
    const admitted = [];
    const selectedRecoveries = recoverable.slice(0, available);
    summary.skipped_targets += recoverable.length - selectedRecoveries.length;
    for (const [index, candidate] of selectedRecoveries.entries()) {
      if (parkedReconcileDeadlineReached(deadlineAt)) {
        stopForDeadline(admitted.length + selectedRecoveries.length - index);
        return;
      }
      let current;
      try {
        current = await inspectParkedReviewTarget(
          candidate.target.requested_target,
          targetReadTokens,
          deadlineAt,
        );
      } catch (error) {
        if (parkedReconcileDeadlineReached(deadlineAt)) {
          stopForDeadline(admitted.length + selectedRecoveries.length - index);
          return;
        }
        recordInspectionSkips(summary, [candidate.target.requested_target], error);
        summary.skipped_targets += 1;
        continue;
      }
      if (current.state !== "open" || current.node_id !== candidate.target.node_id) {
        summary.skipped_targets += 1;
        continue;
      }
      if (!args.forceUnchanged && !parkedReviewRetryIdentityChanged(candidate.row, current)) {
        summary.skipped_targets += 1;
        recordSkipReasonCount(summary, "unchanged_review_identity", 1);
        continue;
      }
      admitted.push({ row: candidate.row, target: current });
    }
    if (!args.execute) {
      summary.recovered_targets += admitted.length;
    } else if (admitted.length) {
      if (parkedReconcileDeadlineReached(deadlineAt)) {
        stopForDeadline(admitted.length);
        return;
      }
      const identity = admitted
        .map(
          ({ row, target }) =>
            `${row.item_key}:${row.revision}:${row.updated_at_ms}:${parkedReviewLiveSourceIdentity(target)}`,
        )
        .sort()
        .join("\n");
      let result;
      try {
        result = await signedPost({
          queueUrl,
          secret,
          path: "/internal/exact-review/parked-reviews/recover-fresh",
          payload: {
            items: admitted.map(({ row, target }) => parkedMutationItem(row, target)),
            idempotency_key: `parked-reconcile:${createHash("sha256").update(identity).digest("hex")}`,
            ...(args.forceUnchanged ? { override_retry_budget: true } : {}),
          },
          deadlineAt,
        });
      } catch (error) {
        if (parkedReconcileDeadlineReached(deadlineAt)) {
          stopForDeadline(admitted.length);
          return;
        }
        throw error;
      }
      summary.recovered_targets +=
        requiredCount(result, "recovered") + requiredCount(result, "deduped");
      summary.skipped_targets += requiredCount(result, "skipped");
    }
  } else {
    summary.skipped_targets += recoverable.length;
    if (pressure.status !== "idle") {
      recordSkipReasonCount(summary, "recovery_deferred_pressure", recoverable.length);
    }
  }
  printResult(summary);
}

function parkedReviewRetryIdentityChanged(row, target) {
  if (row.retry_policy_changed) return true;
  if (row.item_kind !== target.item_kind) return false;
  const contentChanged =
    row.source_content_revision !== null
      ? row.source_content_revision === target.source_content_revision
        ? false
        : row.source_content_revision === target.source_legacy_content_revision
          ? row.source_updated_at !== null && target.source_updated_at !== null
            ? new Date(Date.parse(row.source_updated_at)).toISOString() !== target.source_updated_at
            : false
          : true
      : row.source_updated_at !== null
        ? new Date(Date.parse(row.source_updated_at)).toISOString() !== target.source_updated_at
        : target.source_content_revision !== null || target.source_updated_at !== null;
  return (
    (row.source_head_sha !== null && row.source_head_sha !== target.source_head_sha) ||
    (row.source_base_sha !== null && row.source_base_sha !== target.source_base_sha) ||
    (row.source_is_draft !== null && row.source_is_draft !== target.source_is_draft) ||
    contentChanged
  );
}

function parkedReviewLiveSourceIdentity(target) {
  return [
    target.item_kind,
    target.source_head_sha || "-",
    target.source_base_sha || "-",
    target.source_is_draft === null ? "-" : String(target.source_is_draft),
    target.source_content_revision || "-",
    target.source_updated_at || "-",
  ].join(":");
}

async function loadParkedReviewInventory({ queueUrl, secret, maxRows, deadlineAt }) {
  const rows = [];
  let cursor = "";
  const scanSeed = `parked-${Date.now()}-${process.pid}`;
  let complete = false;
  let deadlineReached = false;
  while (rows.length < maxRows) {
    if (parkedReconcileDeadlineReached(deadlineAt)) {
      deadlineReached = true;
      break;
    }
    const limit = Math.min(MAX_PARKED_INVENTORY_PAGE_SIZE, maxRows - rows.length);
    let page;
    try {
      page = await signedPost({
        queueUrl,
        secret,
        path: "/internal/exact-review/parked-reviews/list",
        payload: { limit, scan_seed: scanSeed, ...(cursor ? { cursor } : {}) },
        deadlineAt,
      });
    } catch (error) {
      if (!parkedReconcileDeadlineReached(deadlineAt)) throw error;
      deadlineReached = true;
      break;
    }
    const pageRows = Array.isArray(page.parked_reviews) ? page.parked_reviews : [];
    rows.push(...pageRows.map(sanitizeParkedReviewRow));
    cursor = String(page.next_cursor || "");
    if (!cursor) {
      complete = true;
      break;
    }
    if (!pageRows.length) throw new Error("parked review inventory cursor did not advance");
  }
  return {
    generated_at: new Date().toISOString(),
    complete,
    ...(deadlineReached ? { deadline_reached: true } : {}),
    next_cursor: complete ? null : cursor,
    summary: {
      rows: rows.length,
      by_reason: countBy(rows, (row) => row.parked_reason || "unknown"),
    },
    parked_reviews: rows,
  };
}

function sanitizeParkedReviewRow(row) {
  const value = row && typeof row === "object" ? row : {};
  const itemKey = String(value.item_key || "");
  const revision = Number(value.revision);
  const targetRepo = String(value.target_repo || "");
  const itemNumber = Number(value.item_number);
  const updatedAtMs = Number(value.updated_at_ms);
  const sourceHeadSha = value.source_head_sha === null ? null : String(value.source_head_sha || "");
  const sourceBaseSha = value.source_base_sha === null ? null : String(value.source_base_sha || "");
  const sourceIsDraft =
    value.source_is_draft === null || value.source_is_draft === undefined
      ? null
      : value.source_is_draft;
  const sourceContentRevision =
    value.source_content_revision === null ? null : String(value.source_content_revision || "");
  const sourceUpdatedAt =
    value.source_updated_at === null ? null : String(value.source_updated_at || "");
  const retryPolicyEpoch = String(value.retry_policy_epoch || "");
  const excludedReason =
    value.excluded_reason === undefined ? null : String(value.excluded_reason || "");
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(itemKey) ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo) ||
    !Number.isSafeInteger(itemNumber) ||
    itemNumber < 1 ||
    !Number.isSafeInteger(updatedAtMs) ||
    updatedAtMs < 1 ||
    (sourceHeadSha !== null && !/^[0-9a-f]{40}$/.test(sourceHeadSha)) ||
    (sourceBaseSha !== null && !/^[0-9a-f]{40}$/.test(sourceBaseSha)) ||
    (sourceIsDraft !== null && typeof sourceIsDraft !== "boolean") ||
    (sourceContentRevision !== null && !/^[0-9a-f]{64}$/.test(sourceContentRevision)) ||
    (sourceUpdatedAt !== null && !Number.isFinite(Date.parse(sourceUpdatedAt))) ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(retryPolicyEpoch) ||
    typeof value.retry_policy_changed !== "boolean" ||
    (excludedReason !== null && excludedReason !== "command_context")
  ) {
    throw new Error("parked review inventory returned an invalid row");
  }
  return {
    item_key: itemKey,
    revision,
    target_repo: targetRepo,
    item_number: itemNumber,
    item_kind: String(value.item_kind || ""),
    excluded_reason: excludedReason,
    parked_reason: String(value.parked_reason || "") || null,
    parked_recovery_attempts: Number(value.parked_recovery_attempts || 0),
    first_failed_at: value.first_failed_at ? String(value.first_failed_at) : null,
    last_failure_reason: String(value.last_failure_reason || "") || null,
    source_head_sha: sourceHeadSha,
    source_base_sha: sourceBaseSha,
    source_is_draft: sourceIsDraft,
    source_content_revision: sourceContentRevision,
    source_updated_at: sourceUpdatedAt,
    retry_policy_epoch: retryPolicyEpoch,
    retry_policy_changed: value.retry_policy_changed,
    updated_at: String(value.updated_at || ""),
    updated_at_ms: updatedAtMs,
  };
}

function parkedMutationItem(row, target) {
  return {
    item_key: row.item_key,
    revision: row.revision,
    updated_at_ms: row.updated_at_ms,
    ...(target?.source_head_sha ? { source_head_sha: target.source_head_sha } : {}),
    ...(target?.source_base_sha ? { source_base_sha: target.source_base_sha } : {}),
    ...(target && target.source_is_draft !== null
      ? { source_is_draft: target.source_is_draft }
      : {}),
    ...(target?.source_content_revision
      ? { source_content_revision: target.source_content_revision }
      : {}),
    ...(target?.source_updated_at ? { source_updated_at: target.source_updated_at } : {}),
  };
}

function parkedReconcileDeadlineAt() {
  const raw = String(process.env.EXACT_REVIEW_RECONCILE_DEADLINE_MS || "").trim();
  if (!raw) return Number.POSITIVE_INFINITY;
  const deadlineAt = Number(raw);
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt < 1) {
    throw new Error("EXACT_REVIEW_RECONCILE_DEADLINE_MS must be a positive epoch millisecond");
  }
  return deadlineAt;
}

function parkedReconcileDeadlineReached(deadlineAt) {
  return Number.isFinite(deadlineAt) && Date.now() + OPERATOR_DEADLINE_SETTLE_MS >= deadlineAt;
}

function operatorRequestSignal(deadlineAt = Number.POSITIVE_INFINITY) {
  if (parkedReconcileDeadlineReached(deadlineAt)) {
    throw new Error("exact-review reconciliation deadline reached");
  }
  const remaining = Number.isFinite(deadlineAt)
    ? Math.max(1, deadlineAt - Date.now())
    : OPERATOR_REQUEST_TIMEOUT_MS;
  return AbortSignal.timeout(Math.min(OPERATOR_REQUEST_TIMEOUT_MS, remaining));
}

async function inspectParkedReviewTarget(
  target,
  targetReadTokens,
  deadlineAt = Number.POSITIVE_INFINITY,
) {
  const apiUrl = String(process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const token = await targetReadTokens.tokenFor(target);
  const match = /^([^/]+)\/([^#]+)#([1-9]\d*)$/.exec(target);
  if (!match) throw new Error(`invalid parked review target: ${target}`);
  const [, owner, repo, number] = match;
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "clawsweeper-parked-review-operator",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const response = await fetch(
    `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
    { headers, signal: operatorRequestSignal(deadlineAt) },
  );
  if (response.status === 404) {
    const repository = await fetch(
      `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { headers, signal: operatorRequestSignal(deadlineAt) },
    );
    if (repository.status === 404) {
      return {
        state: "repository_gone",
        requested_target: normalizeRecoveryTargetKey(target),
        canonical_target: normalizeRecoveryTargetKey(target),
        node_id: null,
      };
    }
    throw new Error(`parked review target is missing from an existing repository: ${target}`);
  }
  if (!response.ok) {
    throw await githubInspectionHttpError(
      response,
      `parked review target check failed for ${target} with ${response.status}`,
    );
  }
  const item = await response.json();
  if (
    typeof item?.node_id !== "string" ||
    !item.node_id ||
    !["open", "closed"].includes(String(item.state || "").toLowerCase()) ||
    !Number.isFinite(Date.parse(String(item.updated_at || "")))
  ) {
    throw new Error(`parked review target check returned an invalid identity for ${target}`);
  }
  let sourceHeadSha = null;
  let sourceBaseSha = null;
  let sourceIsDraft = null;
  let sourceUpdatedAt = new Date(Date.parse(item.updated_at)).toISOString();
  let sourceTitle = typeof item.title === "string" ? item.title : null;
  let sourceBody = item.body === null || typeof item.body === "string" ? item.body || "" : null;
  const itemKind = item.pull_request ? "pull_request" : "issue";
  if (itemKind === "pull_request") {
    const pull = await fetch(
      `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
      { headers, signal: operatorRequestSignal(deadlineAt) },
    );
    if (!pull.ok) {
      throw await githubInspectionHttpError(
        pull,
        `parked review pull request check failed for ${target} with ${pull.status}`,
      );
    }
    const detail = await pull.json();
    sourceHeadSha = String(detail?.head?.sha || "").toLowerCase();
    sourceBaseSha = String(detail?.base?.sha || "").toLowerCase();
    sourceIsDraft = detail?.draft;
    sourceTitle = typeof detail?.title === "string" ? detail.title : null;
    sourceBody =
      detail?.body === null || typeof detail?.body === "string" ? detail.body || "" : null;
    if (
      !/^[0-9a-f]{40}$/.test(sourceHeadSha) ||
      !/^[0-9a-f]{40}$/.test(sourceBaseSha) ||
      typeof sourceIsDraft !== "boolean" ||
      sourceTitle === null ||
      sourceBody === null ||
      !Number.isFinite(Date.parse(String(detail?.updated_at || "")))
    ) {
      throw new Error(
        `parked review pull request check returned invalid source data for ${target}`,
      );
    }
    sourceUpdatedAt = new Date(Date.parse(detail.updated_at)).toISOString();
  }
  const sourceContentMaterial = exactReviewSourceRevisionMaterial({
    title: sourceTitle,
    body: sourceBody,
    locked: item.locked,
    labels: item.labels,
  });
  if (!sourceContentMaterial) {
    throw new Error(`parked review target check returned invalid lifecycle data for ${target}`);
  }
  const sourceContentRevision = createHash("sha256")
    .update(JSON.stringify(sourceContentMaterial))
    .digest("hex");
  const sourceLegacyContentRevision = createHash("sha256")
    .update(JSON.stringify({ version: 1, title: sourceTitle, body: sourceBody }))
    .digest("hex");
  return {
    state: String(item.state).toLowerCase(),
    requested_target: normalizeRecoveryTargetKey(target),
    canonical_target: canonicalGitHubTarget(item, target),
    node_id: item.node_id,
    item_kind: itemKind,
    source_head_sha: sourceHeadSha,
    source_base_sha: sourceBaseSha,
    source_is_draft: sourceIsDraft,
    source_content_revision: sourceContentRevision,
    source_legacy_content_revision: sourceLegacyContentRevision,
    source_updated_at: sourceUpdatedAt,
  };
}

async function readQueuePressure(queueUrl, deadlineAt = Number.POSITIVE_INFINITY) {
  try {
    const response = await fetch(`${queueUrl}/api/exact-review-queue`, {
      cache: "no-store",
      signal: operatorRequestSignal(deadlineAt),
    });
    if (!response.ok || response.headers.get("x-clawsweeper-cache") === "stale") {
      return { status: "unknown", availableSlots: 0 };
    }
    const pressure = (await response.json())?.pressure;
    const status = String(pressure?.status ?? "");
    const active = Number(pressure?.active);
    const capacity = Number(pressure?.capacity);
    if (
      !["idle", "congested", "saturated"].includes(status) ||
      !Number.isSafeInteger(active) ||
      active < 0 ||
      !Number.isSafeInteger(capacity) ||
      capacity < 1
    ) {
      return { status: "unknown", availableSlots: 0 };
    }
    return { status, availableSlots: Math.max(0, capacity - active) };
  } catch {
    return { status: "unknown", availableSlots: 0 };
  }
}

async function reconcileResolve({
  queueUrl,
  secret,
  rows,
  note,
  execute,
  openIds,
  canonicalTarget,
  aliases = [],
  outcome,
}) {
  if (!execute) {
    for (const row of rows) openIds.delete(row.dead_letter_id);
    return { resolved: rows.length, unparked: 0 };
  }
  const result = await signedPost({
    queueUrl,
    secret,
    path: "/internal/exact-review/dead-letters/resolve",
    payload: {
      ids: rows.map((row) => row.dead_letter_id),
      note,
      ...(outcome ? { resolution_outcome: outcome } : {}),
      resolution_aliases: rows.map((row) => ({
        id: row.dead_letter_id,
        aliases: [
          ...new Set([
            ...(row.fresh_recovery.item_key
              ? [normalizeRecoveryTargetKey(row.fresh_recovery.item_key)]
              : []),
            ...(canonicalTarget ? [normalizeRecoveryTargetKey(canonicalTarget)] : []),
            ...aliases,
          ]),
        ],
      })),
    },
  });
  const summary = mutationSummary("resolve", result);
  if (summary.resolved !== rows.length || summary.skipped !== 0) {
    throw new DeadLetterInventoryChangedError(
      summary,
      rows.map((row) => row.dead_letter_id),
      [
        ...rows.map((row) => row.fresh_recovery.item_key),
        ...(canonicalTarget ? [canonicalTarget] : []),
        ...aliases,
      ],
    );
  }
  for (const row of rows) openIds.delete(row.dead_letter_id);
  return summary;
}

async function inspectCanonicalSupersessionEvidence({ queueUrl, secret, target, liveHeadSha }) {
  const match = /^([^/]+)\/([^#]+)#([1-9]\d*)$/.exec(target);
  if (!match || !/^[0-9a-f]{40}$/.test(String(liveHeadSha || ""))) {
    return {
      proven: false,
      reason: "canonical target or live pull-request head is invalid",
    };
  }
  const [, owner, repo, number] = match;
  const repoSlug = `${owner}-${repo}`.toLowerCase();
  const source = `/internal/state/records/${repoSlug}/items/${number}`;
  let response;
  try {
    response = await signedGet({ queueUrl, secret, path: source });
  } catch {
    return {
      proven: false,
      reason: "canonical completed review record lookup was unavailable",
    };
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return {
      proven: false,
      reason: "canonical completed review record was not found for the live pull-request head",
    };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return {
      proven: false,
      reason: `canonical completed review record lookup returned ${response.status}`,
    };
  }
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    return { proven: false, reason: "canonical completed review record returned invalid JSON" };
  }
  const content = typeof envelope?.content === "string" ? envelope.content : "";
  const digest = String(envelope?.digest || "").toLowerCase();
  const revision = Number(envelope?.revision);
  if (
    !content ||
    !/^[0-9a-f]{64}$/.test(digest) ||
    createHash("sha256").update(content).digest("hex") !== digest ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    return { proven: false, reason: "canonical completed review record envelope is invalid" };
  }
  const frontMatter = canonicalRecordFrontMatter(content);
  const expectedRepository = `${owner}/${repo}`.toLowerCase();
  if (
    !frontMatter ||
    String(frontMatter.get("repository") || "").toLowerCase() !== expectedRepository ||
    frontMatter.get("number") !== number ||
    frontMatter.get("type") !== "pull_request" ||
    frontMatter.get("review_status") !== "complete" ||
    String(frontMatter.get("pull_head_sha") || "").toLowerCase() !== liveHeadSha
  ) {
    return {
      proven: false,
      reason: "canonical completed review record does not prove the live pull-request head",
    };
  }
  return { proven: true, source };
}

function canonicalRecordFrontMatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) return null;
  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([a-z][a-z0-9_]*):[ \t]*(.*)$/.exec(line);
    if (!field) continue;
    if (fields.has(field[1])) return null;
    fields.set(field[1], field[2].trim());
  }
  return fields;
}

function deadLetterInventoryFingerprint(ids) {
  let fingerprint = 2_166_136_261;
  for (const id of [...ids].sort()) {
    for (const character of `${id}\n`) {
      fingerprint = Math.imul(fingerprint ^ character.charCodeAt(0), 16_777_619) >>> 0;
    }
  }
  return `${ids.size}:${fingerprint.toString(16).padStart(8, "0")}`;
}

async function loadInventory(options) {
  const rows = [];
  let cursor = "";
  let pages = 0;
  let complete = false;
  for (;;) {
    if (pages >= (options.maxPages ?? Number.POSITIVE_INFINITY)) break;
    const page = await signedPost({
      ...options,
      path: "/internal/exact-review/dead-letters/list",
      payload: { status: "open", limit: 20, ...(cursor ? { cursor } : {}) },
    });
    pages += 1;
    const pageRows = Array.isArray(page.dead_letters) ? page.dead_letters : [];
    rows.push(...pageRows.map(sanitizeRow));
    if (rows.length > MAX_INVENTORY_ROWS) {
      throw new Error(`open dead-letter inventory exceeds ${MAX_INVENTORY_ROWS} rows`);
    }
    cursor = String(page.next_cursor || "");
    if (!cursor) {
      complete = true;
      break;
    }
  }

  const uniquePublicationKeys = new Set(rows.map((row) => row.item_key));
  const targetKeys = rows
    .map((row) => row.fresh_recovery.item_key)
    .filter(Boolean)
    .map(normalizeRecoveryTargetKey);
  const eligibleRows = rows.filter((row) => row.fresh_recovery.eligible);
  const eligibleTargetKeys = eligibleRows
    .map((row) => row.fresh_recovery.item_key)
    .filter(Boolean)
    .map(normalizeRecoveryTargetKey);
  const uniqueTargetKeys = new Set(targetKeys);
  const uniqueEligibleTargetKeys = new Set(eligibleTargetKeys);
  const byReason = countBy(rows, (row) => row.reason_code);
  const recoveryReasons = countBy(rows, (row) => row.fresh_recovery.reason);
  return {
    generated_at: new Date().toISOString(),
    complete,
    summary: {
      rows: rows.length,
      unique_publication_keys: uniquePublicationKeys.size,
      duplicate_publication_rows: rows.length - uniquePublicationKeys.size,
      unique_target_keys: uniqueTargetKeys.size,
      duplicate_target_key_rows: targetKeys.length - uniqueTargetKeys.size,
      unmapped_target_rows: rows.length - targetKeys.length,
      eligible_fresh_recovery_rows: eligibleRows.length,
      eligible_fresh_recovery_target_keys: uniqueEligibleTargetKeys.size,
      by_reason: byReason,
      recovery_reasons: recoveryReasons,
    },
    dead_letters: rows,
  };
}

async function inspectCanonicalTargets(groups, maxTargets, targetReadTokens) {
  const identities = new Map();
  const failedTargets = [];
  let consecutiveThrottles = 0;
  const countedSetupThrottles = new WeakSet();
  const throttleFuseReached = (error) => {
    if (error instanceof TargetAppSetupThrottleError) {
      if (countedSetupThrottles.has(error)) return false;
      countedSetupThrottles.add(error);
    }
    consecutiveThrottles += 1;
    return consecutiveThrottles >= MAX_CONSECUTIVE_GITHUB_THROTTLES;
  };
  if (groups.length <= Math.min(maxTargets, MAX_RECONCILE_RECOVERIES)) {
    const inspectedTargets = [];
    for (const [index, group] of groups.entries()) {
      try {
        identities.set(
          normalizeRecoveryTargetKey(group.target),
          await inspectRecoveryTarget(group.target, targetReadTokens),
        );
        inspectedTargets.push(group.target);
        consecutiveThrottles = 0;
      } catch (error) {
        if (error instanceof TargetInstallationMissingError) {
          failedTargets.push({ target: group.target, error });
          continue;
        }
        if (isThrottleInspectionError(error)) {
          failedTargets.push({ target: group.target, error });
          if (throttleFuseReached(error)) {
            return {
              identities,
              failedTargets,
              notInspectedTargets: groups.slice(index + 1).map((candidate) => candidate.target),
            };
          }
          continue;
        }
        throw new CanonicalTargetInspectionError(error, {
          inspectedTargets,
          classifiedFailures: failedTargets,
          failedTargets: [group.target],
          notInspectedTargets: groups.slice(index + 1).map((candidate) => candidate.target),
        });
      }
    }
    return { identities, failedTargets, notInspectedTargets: [] };
  }

  const apiUrl = String(process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const inspectedTargets = [];
  const groupsByOwner = new Map();
  for (const group of groups) {
    const { owner } = parseTargetRepository(group.target);
    const ownerGroups = groupsByOwner.get(owner.toLowerCase()) ?? [];
    ownerGroups.push(group);
    groupsByOwner.set(owner.toLowerCase(), ownerGroups);
  }
  const batches = [...groupsByOwner.values()].flatMap((ownerGroups) => {
    const ownerBatches = [];
    for (let offset = 0; offset < ownerGroups.length; offset += GRAPHQL_IDENTITY_BATCH_SIZE) {
      ownerBatches.push(ownerGroups.slice(offset, offset + GRAPHQL_IDENTITY_BATCH_SIZE));
    }
    return ownerBatches;
  });
  for (const [batchIndex, selected] of batches.entries()) {
    const remainingTargets = batches
      .slice(batchIndex + 1)
      .flat()
      .map((candidate) => candidate.target);
    let token;
    try {
      token = await targetReadTokens.tokenFor(selected[0].target);
    } catch (error) {
      if (error instanceof TargetInstallationMissingError) {
        for (const group of selected) failedTargets.push({ target: group.target, error });
        continue;
      }
      if (isThrottleInspectionError(error)) {
        for (const group of selected) failedTargets.push({ target: group.target, error });
        if (throttleFuseReached(error)) {
          return {
            identities,
            failedTargets,
            notInspectedTargets: remainingTargets,
          };
        }
        continue;
      }
      throw new CanonicalTargetInspectionError(error, {
        inspectedTargets,
        classifiedFailures: failedTargets,
        failedTargets: selected.map((group) => group.target),
        notInspectedTargets: remainingTargets,
      });
    }
    const fields = selected.map(({ target }, index) => {
      const match = /^([^/]+)\/([^#]+)#([1-9]\d*)$/.exec(target);
      if (!match) throw new Error(`invalid fresh recovery target: ${target}`);
      const [, owner, repo, number] = match;
      return `target${index}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}){item:issueOrPullRequest(number:${number}){... on Issue{id state number repository{nameWithOwner}} ... on PullRequest{id state number headRefOid repository{nameWithOwner}}}}`;
    });
    const response = await fetch(`${apiUrl}/graphql`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "clawsweeper-dead-letter-operator",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: `query{${fields.join(" ")}}` }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const error = await githubInspectionHttpError(
        response,
        `canonical target discovery failed (${response.status})`,
      );
      if (isThrottleInspectionError(error)) {
        for (const group of selected) failedTargets.push({ target: group.target, error });
        if (throttleFuseReached(error)) {
          return {
            identities,
            failedTargets,
            notInspectedTargets: remainingTargets,
          };
        }
        continue;
      }
      throw new CanonicalTargetInspectionError(error, {
        inspectedTargets,
        classifiedFailures: failedTargets,
        failedTargets: selected.map((group) => group.target),
        notInspectedTargets: remainingTargets,
      });
    }
    consecutiveThrottles = 0;
    const result = await response.json();
    if (!result || !result.data || (Array.isArray(result.errors) && result.errors.length)) {
      throw new CanonicalTargetInspectionError(
        new Error("canonical target discovery returned incomplete GitHub identities"),
        {
          inspectedTargets,
          classifiedFailures: failedTargets,
          failedTargets: selected.map((group) => group.target),
          notInspectedTargets: remainingTargets,
        },
      );
    }
    for (const [index, group] of selected.entries()) {
      const item = result.data[`target${index}`]?.item;
      if (
        typeof item?.id !== "string" ||
        !item.id ||
        !["OPEN", "CLOSED", "MERGED"].includes(item.state)
      ) {
        throw new Error(`canonical target discovery could not inspect ${group.target}`);
      }
      identities.set(normalizeRecoveryTargetKey(group.target), {
        node_id: item.id,
        state: item.state === "OPEN" ? "open" : "closed",
        canonical_target: canonicalGitHubTarget(item, group.target),
        ...(typeof item.headRefOid === "string" && /^[0-9a-f]{40}$/i.test(item.headRefOid)
          ? { head_sha: item.headRefOid.toLowerCase() }
          : {}),
      });
      inspectedTargets.push(group.target);
    }
  }
  return { identities, failedTargets, notInspectedTargets: [] };
}

function normalizeRecoveryTargetKey(target) {
  const match = /^([^/]+)\/([^#]+)#([1-9]\d*)$/.exec(target);
  if (!match) return target;
  return `${match[1].toLowerCase()}/${match[2].toLowerCase()}#${match[3]}`;
}

function parseTargetRepository(target) {
  const match = /^([^/]+)\/([^#]+)(?:#[1-9]\d*)?$/.exec(String(target));
  if (!match) throw new Error(`invalid GitHub target repository: ${target}`);
  return { owner: match[1], repo: match[2] };
}

function sanitizeRow(row) {
  const value = row && typeof row === "object" ? row : {};
  const recovery =
    value.fresh_recovery && typeof value.fresh_recovery === "object" ? value.fresh_recovery : {};
  const diagnostic =
    value.diagnostic && typeof value.diagnostic === "object" ? value.diagnostic : {};
  return {
    dead_letter_id: String(value.dead_letter_id || ""),
    item_key: String(value.item_key || ""),
    revision: Number(value.revision || 0),
    reason_code: String(value.reason_code || diagnostic.reason_code || "unknown_failure"),
    attempts: Number(value.attempts || diagnostic.attempts || 0),
    first_failed_at: diagnostic.first_failed_at || null,
    last_failed_at: diagnostic.last_failed_at || null,
    error_fingerprint:
      String(value.error_fingerprint || diagnostic.error_fingerprint || "") || null,
    status: String(value.status || "open"),
    fresh_recovery: {
      eligible: recovery.eligible === true,
      reason: String(recovery.reason || "unknown"),
      item_key: recovery.item_key ? String(recovery.item_key) : null,
      source_head_sha: /^[0-9a-f]{40}$/i.test(
        String(value.item?.decision?.publication?.producerDecision?.sourceHeadSha || ""),
      )
        ? String(value.item.decision.publication.producerDecision.sourceHeadSha).toLowerCase()
        : null,
    },
  };
}

function selectRows(rows, ids) {
  const byId = new Map(rows.map((row) => [row.dead_letter_id, row]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length)
    throw new Error(`dead letters are not open or were not found: ${missing.join(",")}`);
  return ids.map((id) => byId.get(id));
}

function countBy(rows, keyFor) {
  return Object.fromEntries(
    [
      ...rows.reduce((counts, row) => {
        const key = keyFor(row);
        counts.set(key, (counts.get(key) || 0) + 1);
        return counts;
      }, new Map()),
    ].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function accountClassifiedSkips(summary, targets, reasonClass, reason, count = targets.length) {
  if (count < 1) return;
  summary.skipped_targets += count;
  recordClassifiedSkips(summary, targets, reasonClass, reason, count);
}

function accountInspectionSkips(summary, targets, error) {
  if (targets.length === 0) return;
  summary.skipped_targets += targets.length;
  recordInspectionSkips(summary, targets, error);
}

function recordInspectionSkips(summary, targets, error) {
  if (targets.length === 0) return;
  const reasonClass = classifyOperatorSkipReason(error);
  recordClassifiedSkips(summary, targets, reasonClass, error);
}

function recordClassifiedSkips(summary, targets, reasonClass, error, count = targets.length) {
  recordSkipReasonCount(summary, reasonClass, count);
  if (error === undefined) return;
  const reason = sanitizeSkipReason(error);
  for (const target of targets) {
    if (summary.skip_samples.length >= MAX_SKIP_SAMPLES) break;
    summary.skip_samples.push({ target: normalizeRecoveryTargetKey(target), reason });
  }
}

function recordSkipReasonCount(summary, reasonClass, count) {
  if (count < 1) return;
  summary.skip_reasons[reasonClass] = (summary.skip_reasons[reasonClass] || 0) + count;
}

function isThrottleInspectionError(error) {
  if (isGitHubThrottleFailure(error)) return true;
  return (
    error instanceof GitHubInspectionHttpError &&
    error.status === 403 &&
    (Boolean(error.retryAfter) || error.rateLimitRemaining === "0")
  );
}

async function githubInspectionHttpError(response, context) {
  let detail = "";
  try {
    const body = await response.json();
    detail = String(body?.message || body?.error || "").trim();
  } catch {
    // The HTTP status and headers still preserve the fail-closed classification.
  }
  return new GitHubInspectionHttpError(`${context}${detail ? `: ${detail}` : ""}`, response);
}

function recordAbortedInspectionSkips(
  summary,
  { inspectedTargets, failedTargets, notInspectedTargets, error },
) {
  recordInspectionSkips(summary, failedTargets, error);
  recordInspectionSkips(
    summary,
    inspectedTargets,
    new Error(
      "canonical target was inspected but reconciliation aborted after another target inspection failed",
    ),
  );
  recordInspectionSkips(
    summary,
    notInspectedTargets,
    new Error(
      "canonical target was not inspected because canonical discovery aborted after another target inspection failed",
    ),
  );
}

function recordRecoveryRevalidationAbort(
  summary,
  inspectedRecoveries,
  failedRecovery,
  notInspectedRecoveries,
  reasonClass,
  error,
) {
  recordInspectionSkips(
    summary,
    inspectedRecoveries.map((recovery) => recovery.canonicalTarget),
    new Error(
      "canonical target was inspected but reconciliation aborted after another target inspection failed",
    ),
  );
  recordClassifiedSkips(summary, [failedRecovery.canonicalTarget], reasonClass, error);
  recordInspectionSkips(
    summary,
    notInspectedRecoveries.map((recovery) => recovery.canonicalTarget),
    new Error(
      "canonical target was not inspected because canonical discovery aborted after another target inspection failed",
    ),
  );
}

function sanitizeSkipReason(error) {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw
    .replace(/\b(github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+)\b/g, "[redacted]")
    .replace(/\b(authorization|password|secret|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/([?&](?:access_token|auth|key|secret|token)=)[^&\s]+/gi, "$1[redacted]");
  const sanitized = [...redacted]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return (sanitized || "unknown inspection failure").slice(0, MAX_SKIP_REASON_LENGTH);
}

async function signedPost({
  queueUrl,
  secret,
  path,
  payload,
  deadlineAt = Number.POSITIVE_INFINITY,
}) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const response = await fetch(`${queueUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature,
    },
    body,
    signal: operatorRequestSignal(deadlineAt),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned invalid JSON`);
  }
  if (!result?.ok) throw new Error(`${path} returned an invalid response`);
  return result;
}

function signedGet({ queueUrl, secret, path }) {
  const signature = `sha256=${createHmac("sha256", secret).update("").digest("hex")}`;
  return fetch(`${queueUrl}${path}`, {
    method: "GET",
    headers: { "x-clawsweeper-exact-review-signature": signature },
    signal: operatorRequestSignal(),
  });
}

async function assertOpenRecoveryTargets(targets, targetReadTokens) {
  const canonicalTargetIds = [];
  for (const target of targets) {
    const item = await inspectRecoveryTarget(target, targetReadTokens);
    if (item.state !== "open") {
      throw new Error(`fresh recovery target is not open: ${target}`);
    }
    canonicalTargetIds.push(item.node_id);
  }
  return canonicalTargetIds;
}

async function inspectRecoveryTarget(target, targetReadTokens) {
  const apiUrl = String(process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const token = await targetReadTokens.tokenFor(target);
  const match = /^([^/]+)\/([^#]+)#([1-9]\d*)$/.exec(target);
  if (!match) throw new Error(`invalid fresh recovery target: ${target}`);
  const [, owner, repo, number] = match;
  const response = await fetch(
    `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "clawsweeper-dead-letter-operator",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) {
    throw await githubInspectionHttpError(
      response,
      `live target check failed for ${target} (${response.status})`,
    );
  }
  let item;
  try {
    item = await response.json();
  } catch {
    throw new Error(`live target check returned invalid JSON for ${target}`);
  }
  if (typeof item?.node_id !== "string" || !item.node_id) {
    throw new Error(`live target check returned an invalid canonical identity for ${target}`);
  }
  const canonicalTarget = canonicalGitHubTarget(item, target);
  if (!item.pull_request) return { ...item, canonical_target: canonicalTarget };
  const canonicalMatch = /^([^/]+)\/([^#]+)#([1-9]\d*)$/.exec(canonicalTarget);
  if (!canonicalMatch)
    throw new Error(`pull-request target has invalid canonical identity: ${target}`);
  const [, currentOwner, currentRepo, currentNumber] = canonicalMatch;
  const pullResponse = await fetch(
    `${apiUrl}/repos/${encodeURIComponent(currentOwner)}/${encodeURIComponent(currentRepo)}/pulls/${currentNumber}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "clawsweeper-dead-letter-operator",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!pullResponse.ok) {
    throw await githubInspectionHttpError(
      pullResponse,
      `live pull-request check failed for ${target} (${pullResponse.status})`,
    );
  }
  const pull = await pullResponse.json();
  const headSha = String(pull?.head?.sha || "").toLowerCase();
  if (pull?.node_id !== item.node_id || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error(`live pull-request check returned an invalid current head for ${target}`);
  }
  return {
    ...item,
    state: String(pull.state || item.state),
    canonical_target: canonicalTarget,
    head_sha: headSha,
  };
}

function canonicalGitHubTarget(item, fallback) {
  const number = Number(item?.number);
  let repository = String(item?.repository?.nameWithOwner || "").trim();
  if (!repository && typeof item?.repository_url === "string") {
    const match = /\/repos\/([^/]+)\/([^/]+)\/?$/.exec(item.repository_url);
    if (match) repository = `${match[1]}/${match[2]}`;
  }
  if (!repository || !Number.isSafeInteger(number) || number < 1) {
    return normalizeRecoveryTargetKey(fallback);
  }
  return normalizeRecoveryTargetKey(`${repository}#${number}`);
}

function mutationSummary(action, result) {
  const keys =
    action === "recover-fresh"
      ? ["recovered", "deduped", "skipped", "unparked"]
      : ["resolved", "skipped", "unparked"];
  return Object.fromEntries(keys.map((key) => [key, requiredCount(result, key)]));
}

function requiredCount(result, key) {
  const count = result[key];
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    throw new Error(`mutation response has invalid ${key} count`);
  }
  return count;
}

function printResult(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function printReconcileResult(summary) {
  const accountedSkips = Object.values(summary.skip_reasons).reduce(
    (total, count) => total + count,
    0,
  );
  if (accountedSkips !== summary.skipped_targets) {
    process.stderr.write(
      `${JSON.stringify({
        event: "reconcile_skip_accounting_inconsistent",
        skipped_targets: summary.skipped_targets,
        accounted_skips: accountedSkips,
      })}\n`,
    );
  }
  printResult(summary);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(
    `exact-review-dead-letter-operator: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.stderr.write("[exact-review-dead-letter-operator] FAILED (exit 1)\n");
  process.exitCode = 1;
});
