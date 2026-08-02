#!/usr/bin/env node

import { createHash, createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

const DEFAULT_OUTPUT = ".artifacts/exact-review-dlq/inventory.json";
const MAX_SELECTED_IDS = 2;
const MAX_RECONCILE_TARGETS = 100;
const MAX_RECONCILE_RECOVERIES = 10;
const MAX_RESOLUTION_IDS = 20;
const MAX_INVENTORY_ROWS = 10_000;
const MAX_RECONCILE_INVENTORY_PAGES = 250;
const MAX_RECONCILE_INVENTORY_REFRESHES = 2;
const GRAPHQL_IDENTITY_BATCH_SIZE = 40;
const ACTIVE_RECOVERY_REASONS = new Set(["fresh_review_already_active", "publication_item_active"]);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:._-]{1,200}$/;

class DeadLetterInventoryChangedError extends Error {
  constructor(summary) {
    super("dead-letter cleanup changed during reconciliation; refusing stale recovery");
    this.name = "DeadLetterInventoryChangedError";
    this.summary = summary;
  }
}

const HELP = `Usage:
  node scripts/exact-review-dead-letter-operator.mjs --action <inventory|recover-fresh|resolve|reconcile> [options]

Options:
  --action <action>             Required operator action
  --ids <id,id>                 One or two dead-letter ids for mutation actions
  --idempotency-key <key>       Required for recover-fresh
  --note <text>                 Required for resolve
  --max-targets <count>         Reconcile at most 1-100 canonical targets (default 25)
  --max-recoveries <count>      Queue at most 0-10 fresh reviews (default 5)
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
    const progress = { summary: null };
    for (let refreshes = 0; refreshes <= MAX_RECONCILE_INVENTORY_REFRESHES; refreshes += 1) {
      try {
        await reconcileDeadLetters({ inventory, queueUrl, secret, args, progress });
        return;
      } catch (error) {
        if (!(error instanceof DeadLetterInventoryChangedError)) throw error;
        // Guarded resolution is one Worker transaction: an inventory race skips
        // every requested row. Refuse recovery if that safety contract changes.
        if (error.summary.resolved !== 0 || error.summary.unparked !== 0) {
          throw new Error("guarded dead-letter cleanup was not atomic; refusing stale recovery");
        }
        if (
          refreshes === MAX_RECONCILE_INVENTORY_REFRESHES ||
          progress.summary.inspected_targets >= args.maxTargets
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
    maxTargets: 25,
    maxRecoveries: 5,
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
  if (!["inventory", "recover-fresh", "resolve", "reconcile"].includes(args.action)) {
    throw new Error("--action must be inventory, recover-fresh, resolve, or reconcile");
  }
  if (!args.output) throw new Error("--output is required");
  if (args.action !== "inventory" && args.action !== "reconcile") {
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
  });
  summary.inventory_complete = inventory.complete;
  summary.queue_pressure = initialPressure.status;
  const groups = new Map();
  const invalidRows = [];
  for (const row of inventory.dead_letters) {
    const target = row.fresh_recovery.item_key;
    if (!target || !/^([^/]+)\/([^#]+)#([1-9]\d*)$/.test(target)) {
      invalidRows.push(row);
      continue;
    }
    const key = normalizeRecoveryTargetKey(target);
    const group = groups.get(key) ?? { target, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }

  // A partial page window cannot prove that a transferred alias or an active
  // sibling was observed. Invalid rows are independently terminal and safe to
  // drain; every GitHub-targeted mutation waits for a complete inventory.
  if (!inventory.complete) {
    if (invalidRows.length) {
      const resolution = await reconcileResolve({
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
    summary.skipped_targets += groups.size;
    printResult(summary);
    return;
  }

  let identities;
  try {
    identities = await inspectCanonicalTargets([...groups.values()], args.maxTargets);
  } catch {
    if (invalidRows.length) {
      const resolution = await reconcileResolve({
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
    if (
      hasActiveWork ||
      (live.state === "open" && !rows.some((row) => row.fresh_recovery.eligible))
    ) {
      summary.skipped_targets += 1;
      continue;
    }
    if (live.state === "closed") {
      if (summary.inspected_targets >= args.maxTargets) {
        summary.skipped_targets += 1;
        continue;
      }
      let current;
      try {
        current = await inspectRecoveryTarget(canonicalTarget);
      } catch {
        summary.skipped_targets += 1;
        continue;
      }
      if (current.state !== "closed" || current.node_id !== live.node_id) {
        summary.skipped_targets += 1;
        continue;
      }
      summary.inspected_targets += 1;
      const resolution = await reconcileResolve({
        queueUrl,
        secret,
        rows: rows.slice(0, MAX_RESOLUTION_IDS),
        note: `automatic reconciliation: canonical target ${canonicalTarget} is closed`,
        execute: args.execute,
        openIds,
        canonicalTarget: current.canonical_target,
        aliases: groupAliases,
      });
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
      summary.skipped_targets += 1;
      continue;
    }
    const pressure = await readQueuePressure(queueUrl);
    summary.queue_pressure = pressure.status;
    if (pressure.status !== "idle" || pressure.availableSlots <= recoveries.length) {
      summary.skipped_targets += 1;
      continue;
    }
    if (summary.inspected_targets >= args.maxTargets) {
      summary.skipped_targets += 1;
      continue;
    }
    summary.inspected_targets += 1;
    const duplicates = rows.filter((row) => row.dead_letter_id !== primary.dead_letter_id);
    if (duplicates.length) {
      const selectedDuplicates = duplicates.slice(0, MAX_RESOLUTION_IDS);
      const resolution = await reconcileResolve({
        queueUrl,
        secret,
        rows: selectedDuplicates,
        note: `automatic reconciliation: duplicate publication superseded by canonical target ${canonicalTarget}`,
        execute: args.execute,
        openIds,
        canonicalTarget: live.canonical_target,
        aliases: groupAliases,
      });
      summary.resolved_rows += resolution.resolved;
      summary.duplicate_rows += resolution.resolved;
      if (
        resolution.unparked ||
        resolution.resolved !== selectedDuplicates.length ||
        duplicates.length > MAX_RESOLUTION_IDS
      ) {
        summary.skipped_targets += 1;
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
  }

  if (invalidRows.length) {
    const resolution = await reconcileResolve({
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

  if (recoveries.length) {
    for (const recovery of recoveries) {
      let current;
      try {
        current = await inspectRecoveryTarget(recovery.canonicalTarget);
      } catch {
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

async function readQueuePressure(queueUrl) {
  try {
    const response = await fetch(`${queueUrl}/api/exact-review-queue`, {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
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
    throw new DeadLetterInventoryChangedError(summary);
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
  if (groups.length <= maxTargets) {
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

async function signedPost({ queueUrl, secret, path, payload }) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const response = await fetch(`${queueUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature,
    },
    body,
    signal: AbortSignal.timeout(20_000),
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
