#!/usr/bin/env node

import { createHash, createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

const DEFAULT_OUTPUT = ".artifacts/exact-review-dlq/inventory.json";
const MAX_SELECTED_IDS = 2;
const MAX_RECONCILE_TARGETS = 100;
const MAX_RECONCILE_RECOVERIES = 10;
const MAX_PARKED_RECONCILE_RECOVERIES = 5;
const MAX_PARKED_INVENTORY_PAGE_SIZE = 50;
const MAX_TERMINAL_TARGET_RECHECKS = 10;
const MAX_RESOLUTION_IDS = 20;
const MAX_INVENTORY_ROWS = 10_000;
const MAX_RECONCILE_INVENTORY_PAGES = 250;
const MAX_RECONCILE_INVENTORY_REFRESHES = 2;
const GRAPHQL_IDENTITY_BATCH_SIZE = 40;
const ACTIVE_RECOVERY_REASONS = new Set(["fresh_review_already_active", "publication_item_active"]);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:._-]{1,200}$/;
const OPERATOR_REQUEST_TIMEOUT_MS = 20_000;
const OPERATOR_DEADLINE_SETTLE_MS = 25;
const MAX_SKIP_SAMPLES = 3;
const MAX_SKIP_REASON_LENGTH = 240;

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

const HELP = `Usage:
  node scripts/exact-review-dead-letter-operator.mjs --action <inventory|recover-fresh|resolve|reconcile|reconcile-parked> [options]

Options:
  --action <action>             Required operator action
  --ids <id,id>                 One or two dead-letter ids for mutation actions
  --idempotency-key <key>       Required for recover-fresh
  --note <text>                 Required for resolve
  --max-targets <count>         Reconcile at most 1-100 canonical targets (default 100)
  --max-recoveries <count>      Queue at most 0-10 DLQ or 0-5 parked reviews (default 10)
  --execute                     Apply the selected mutation; otherwise preview only
  --output <path>               Inventory artifact path
  -h, --help                    Show this help

The operator always inventories open dead letters first. It never exposes raw replay.
`;

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const queueUrl = String(process.env.EXACT_REVIEW_QUEUE_URL || "").replace(/\/$/, "");
  const secret = String(process.env.CLAWSWEEPER_WEBHOOK_SECRET || "");
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
    await reconcileParkedReviews({ inventory, queueUrl, secret, args, deadlineAt });
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
      terminalTargetRechecks: 0,
    };
    for (let refreshes = 0; refreshes <= MAX_RECONCILE_INVENTORY_REFRESHES; refreshes += 1) {
      try {
        await reconcileDeadLetters({ inventory, queueUrl, secret, args, progress });
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
          printResult({
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
    const canonicalTargetIds = await assertOpenRecoveryTargets(recoveryTargets);
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
  const args = {
    action: "",
    ids: [],
    idempotencyKey: "",
    note: "",
    execute: false,
    maxTargets: MAX_RECONCILE_TARGETS,
    maxRecoveries: MAX_RECONCILE_RECOVERIES,
    maxRecoveriesProvided: false,
    output: DEFAULT_OUTPUT,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "-h" || value === "--help") args.help = true;
    else if (value === "--execute") args.execute = true;
    else if (value === "--action") args.action = String(argv[++index] || "");
    else if (value === "--ids") {
      args.ids = String(argv[++index] || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    } else if (value === "--idempotency-key") {
      args.idempotencyKey = String(argv[++index] || "").trim();
    } else if (value === "--note") args.note = String(argv[++index] || "").trim();
    else if (value === "--max-targets") {
      args.maxTargets = boundedInteger(argv[++index], "--max-targets", 1, MAX_RECONCILE_TARGETS);
    } else if (value === "--max-recoveries") {
      args.maxRecoveriesProvided = true;
      args.maxRecoveries = boundedInteger(
        argv[++index],
        "--max-recoveries",
        0,
        MAX_RECONCILE_RECOVERIES,
      );
    } else if (value === "--output") args.output = String(argv[++index] || "").trim();
    else throw new Error(`unknown option ${value}; use --help`);
  }
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
  if (args.action === "reconcile-parked" && !args.maxRecoveriesProvided) {
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

async function reconcileDeadLetters({ inventory, queueUrl, secret, args, progress }) {
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
  const accountSkippedTarget = (nodeId) => {
    if (progress.countedSkippedTargets.has(nodeId)) return;
    progress.countedSkippedTargets.add(nodeId);
    summary.skipped_targets += 1;
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
    }
    refreshBlockedInventory();
    summary.skipped_targets += groups.size;
    printResult(summary);
    return;
  }

  let identities;
  try {
    identities = await inspectCanonicalTargets([...groups.values()], args.maxTargets);
  } catch (error) {
    recordInspectionSkips(
      summary,
      [...groups.values()].map((group) => group.target),
      error,
    );
    if (invalidRows.length) {
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
    }
    refreshBlockedInventory();
    summary.skipped_targets += groups.size;
    printResult(summary);
    return;
  }
  const canonicalGroups = new Map();
  for (const group of groups.values()) {
    const live = identities.get(normalizeRecoveryTargetKey(group.target));
    if (!live || !["open", "closed"].includes(live.state)) {
      summary.skipped_targets += groups.size;
      printResult(summary);
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
      accountSkippedTarget(live.node_id);
      continue;
    }
    if (
      hasActiveWork ||
      (live.state === "open" && !rows.some((row) => row.fresh_recovery.eligible))
    ) {
      accountSkippedTarget(live.node_id);
      continue;
    }
    if (live.state === "closed") {
      if (!canInspectTarget(live.node_id)) {
        accountSkippedTarget(live.node_id);
        continue;
      }
      if (progress.terminalTargetRechecks >= MAX_TERMINAL_TARGET_RECHECKS) {
        accountSkippedTarget(live.node_id);
        continue;
      }
      progress.terminalTargetRechecks += 1;
      let current;
      try {
        current = await inspectRecoveryTarget(canonicalTarget);
      } catch (error) {
        recordInspectionSkips(summary, [canonicalTarget], error);
        accountSkippedTarget(live.node_id);
        continue;
      }
      if (current.state !== "closed" || current.node_id !== live.node_id) {
        accountSkippedTarget(live.node_id);
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
        printResult(summary);
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
    if (!primary || summary.recovered_targets + recoveries.length >= args.maxRecoveries) {
      accountSkippedTarget(live.node_id);
      continue;
    }
    const pressure = await readQueuePressure(queueUrl);
    summary.queue_pressure = pressure.status;
    if (pressure.status !== "idle" || pressure.availableSlots <= recoveries.length) {
      accountSkippedTarget(live.node_id);
      continue;
    }
    if (!reserveTargetInspection(live.node_id)) {
      accountSkippedTarget(live.node_id);
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
        accountSkippedTarget(live.node_id);
        if (resolution.unparked) {
          printResult(summary);
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
    if (resolution.unparked) {
      printResult(summary);
      return;
    }
  }

  refreshBlockedInventory();
  if (recoveries.length) {
    for (const recovery of recoveries) {
      let current;
      try {
        current = await inspectRecoveryTarget(recovery.canonicalTarget);
      } catch (error) {
        recordInspectionSkips(
          summary,
          recoveries.map((candidate) => candidate.canonicalTarget),
          error,
        );
        summary.skipped_targets += recoveries.length;
        printResult(summary);
        return;
      }
      if (current.state !== "open" || current.node_id !== recovery.live.node_id) {
        summary.skipped_targets += recoveries.length;
        printResult(summary);
        return;
      }
      if (
        recovery.primary.fresh_recovery.source_head_sha &&
        recovery.primary.fresh_recovery.source_head_sha !== current.head_sha
      ) {
        summary.skipped_targets += recoveries.length;
        printResult(summary);
        return;
      }
      if (current.canonical_target) {
        recovery.canonicalTarget = current.canonical_target;
        recovery.aliases = [
          ...new Set([...recovery.aliases, normalizeRecoveryTargetKey(current.canonical_target)]),
        ];
      }
      recovery.currentHeadSha = current.head_sha || null;
    }
    const finalPressure = await readQueuePressure(queueUrl);
    summary.queue_pressure = finalPressure.status;
    if (finalPressure.status !== "idle" || finalPressure.availableSlots < 1) {
      summary.skipped_targets += recoveries.length;
      printResult(summary);
      return;
    }
    const admitted = recoveries.slice(0, finalPressure.availableSlots);
    summary.skipped_targets += recoveries.length - admitted.length;
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
      summary.skipped_targets += recovered.skipped;
    } else {
      summary.recovered_targets += ids.length;
      summary.resolved_rows += ids.length;
    }
  }
  printResult(summary);
}

async function reconcileParkedReviews({ inventory, queueUrl, secret, args, deadlineAt }) {
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
      target = await inspectParkedReviewTarget(`${row.target_repo}#${row.item_number}`, deadlineAt);
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
      if (recoverable.length < args.maxRecoveries) recoverable.push({ row, target });
      else summary.skipped_targets += 1;
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
      current = await inspectParkedReviewTarget(candidate.target.requested_target, deadlineAt);
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
        current = await inspectParkedReviewTarget(candidate.target.requested_target, deadlineAt);
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
      admitted.push(candidate.row);
    }
    if (!args.execute) {
      summary.recovered_targets += admitted.length;
    } else if (admitted.length) {
      if (parkedReconcileDeadlineReached(deadlineAt)) {
        stopForDeadline(admitted.length);
        return;
      }
      const identity = admitted
        .map((row) => `${row.item_key}:${row.revision}:${row.updated_at_ms}`)
        .sort()
        .join("\n");
      let result;
      try {
        result = await signedPost({
          queueUrl,
          secret,
          path: "/internal/exact-review/parked-reviews/recover-fresh",
          payload: {
            items: admitted.map(parkedMutationItem),
            idempotency_key: `parked-reconcile:${createHash("sha256").update(identity).digest("hex")}`,
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
  }
  printResult(summary);
}

async function loadParkedReviewInventory({ queueUrl, secret, maxRows, deadlineAt }) {
  const rows = [];
  let cursor = "";
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
        payload: { limit, ...(cursor ? { cursor } : {}) },
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
    updated_at: String(value.updated_at || ""),
    updated_at_ms: updatedAtMs,
  };
}

function parkedMutationItem(row) {
  return { item_key: row.item_key, revision: row.revision, updated_at_ms: row.updated_at_ms };
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

async function inspectParkedReviewTarget(target, deadlineAt = Number.POSITIVE_INFINITY) {
  const apiUrl = String(process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const token = String(process.env.GITHUB_TOKEN || "");
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
    throw new Error(`parked review target check failed for ${target} with ${response.status}`);
  }
  const item = await response.json();
  if (
    typeof item?.node_id !== "string" ||
    !item.node_id ||
    !["open", "closed"].includes(String(item.state || "").toLowerCase())
  ) {
    throw new Error(`parked review target check returned an invalid identity for ${target}`);
  }
  return {
    state: String(item.state).toLowerCase(),
    requested_target: normalizeRecoveryTargetKey(target),
    canonical_target: canonicalGitHubTarget(item, target),
    node_id: item.node_id,
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
}) {
  if (!execute) {
    for (const row of rows) openIds?.delete(row.dead_letter_id);
    return { resolved: rows.length, unparked: 0 };
  }
  const result = await signedPost({
    queueUrl,
    secret,
    path: "/internal/exact-review/dead-letters/resolve",
    payload: {
      ids: rows.map((row) => row.dead_letter_id),
      note,
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
  for (const row of rows) openIds?.delete(row.dead_letter_id);
  return summary;
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

async function inspectCanonicalTargets(groups, maxTargets) {
  const identities = new Map();
  if (groups.length <= Math.min(maxTargets, MAX_RECONCILE_RECOVERIES)) {
    for (const group of groups) {
      identities.set(
        normalizeRecoveryTargetKey(group.target),
        await inspectRecoveryTarget(group.target),
      );
    }
    return identities;
  }

  const apiUrl = String(process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const token = String(process.env.GITHUB_TOKEN || "");
  if (!token) throw new Error("GITHUB_TOKEN is required for canonical target discovery");
  for (let offset = 0; offset < groups.length; offset += GRAPHQL_IDENTITY_BATCH_SIZE) {
    const selected = groups.slice(offset, offset + GRAPHQL_IDENTITY_BATCH_SIZE);
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
    if (!response.ok) throw new Error(`canonical target discovery failed (${response.status})`);
    const result = await response.json();
    if (!result || !result.data || (Array.isArray(result.errors) && result.errors.length)) {
      throw new Error("canonical target discovery returned incomplete GitHub identities");
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
    }
  }
  return identities;
}

function normalizeRecoveryTargetKey(target) {
  const match = /^([^/]+)\/([^#]+)#([1-9]\d*)$/.exec(target);
  if (!match) return target;
  return `${match[1].toLowerCase()}/${match[2].toLowerCase()}#${match[3]}`;
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

function recordInspectionSkips(summary, targets, error) {
  const reason = sanitizeSkipReason(error);
  const reasonClass = classifySkipReason(reason);
  summary.skip_reasons[reasonClass] = (summary.skip_reasons[reasonClass] || 0) + targets.length;
  for (const target of targets) {
    if (summary.skip_samples.length >= MAX_SKIP_SAMPLES) break;
    summary.skip_samples.push({ target: normalizeRecoveryTargetKey(target), reason });
  }
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

function classifySkipReason(reason) {
  const normalized = reason.toLowerCase();
  if (normalized.includes("missing from an existing repository")) {
    return "missing_from_existing_repository";
  }
  if (
    normalized.includes("invalid identity") ||
    normalized.includes("invalid canonical identity")
  ) {
    return "invalid_identity";
  }
  if (/\b(timeout|timed out|aborterror|timeouterror)\b/.test(normalized)) return "timeout";
  const status = /(?:\bwith|\breturned|\()\s*([1-5]\d{2})\)?\b/.exec(normalized)?.[1];
  if (status === "403") return "http_403";
  if (status === "429") return "http_429";
  if (status?.startsWith("5")) return "http_5xx";
  if (status?.startsWith("4")) return "http_4xx";
  if (status?.startsWith("3")) return "http_3xx";
  return "other";
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

async function assertOpenRecoveryTargets(targets) {
  const canonicalTargetIds = [];
  for (const target of targets) {
    const item = await inspectRecoveryTarget(target);
    if (item?.state !== "open") {
      throw new Error(`fresh recovery target is not open: ${target}`);
    }
    if (typeof item.node_id !== "string" || !item.node_id) {
      throw new Error(`live target check returned an invalid canonical identity for ${target}`);
    }
    canonicalTargetIds.push(item.node_id);
  }
  return canonicalTargetIds;
}

async function inspectRecoveryTarget(target) {
  const apiUrl = String(process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const token = String(process.env.GITHUB_TOKEN || "");
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
  if (!response.ok) throw new Error(`live target check failed for ${target} (${response.status})`);
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
  if (!pullResponse.ok) throw new Error(`live pull-request check failed for ${target}`);
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

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(
    `exact-review-dead-letter-operator: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.stderr.write("[exact-review-dead-letter-operator] FAILED (exit 1)\n");
  process.exitCode = 1;
});
