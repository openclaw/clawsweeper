#!/usr/bin/env node

import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

const DEFAULT_OUTPUT = ".artifacts/exact-review-dlq/inventory.json";
const MAX_SELECTED_IDS = 2;
const MAX_INVENTORY_ROWS = 10_000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:._-]{1,200}$/;

const HELP = `Usage:
  node scripts/exact-review-dead-letter-operator.mjs --action <inventory|recover-fresh|resolve> [options]

Options:
  --action <action>             Required operator action
  --ids <id,id>                 One or two dead-letter ids for mutation actions
  --idempotency-key <key>       Required for recover-fresh
  --note <text>                 Required for resolve
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

  const inventory = await loadInventory({ queueUrl, secret });
  await mkdir(dirname(resolve(args.output)), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");

  if (args.action === "inventory") {
    printResult({ action: args.action, output: args.output, summary: inventory.summary });
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
    else if (value === "--output") args.output = String(argv[++index] || "").trim();
    else throw new Error(`unknown option ${value}; use --help`);
  }
  if (args.help) return args;
  if (!["inventory", "recover-fresh", "resolve"].includes(args.action)) {
    throw new Error("--action must be inventory, recover-fresh, or resolve");
  }
  if (!args.output) throw new Error("--output is required");
  if (args.action !== "inventory") {
    if (args.ids.length < 1 || args.ids.length > MAX_SELECTED_IDS) {
      throw new Error(`mutation actions require between 1 and ${MAX_SELECTED_IDS} --ids`);
    }
    if (new Set(args.ids).size !== args.ids.length) {
      throw new Error("--ids must not contain duplicates");
    }
  }
  return args;
}

async function loadInventory(options) {
  const rows = [];
  let cursor = "";
  for (;;) {
    const page = await signedPost({
      ...options,
      path: "/internal/exact-review/dead-letters/list",
      payload: { status: "open", limit: 20, ...(cursor ? { cursor } : {}) },
    });
    const pageRows = Array.isArray(page.dead_letters) ? page.dead_letters : [];
    rows.push(...pageRows.map(sanitizeRow));
    if (rows.length > MAX_INVENTORY_ROWS) {
      throw new Error(`open dead-letter inventory exceeds ${MAX_INVENTORY_ROWS} rows`);
    }
    cursor = String(page.next_cursor || "");
    if (!cursor) break;
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
  const apiUrl = String(process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const token = String(process.env.GITHUB_TOKEN || "");
  const canonicalTargetIds = [];
  for (const target of targets) {
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
      throw new Error(`live target check failed for ${target} (${response.status})`);
    }
    let item;
    try {
      item = await response.json();
    } catch {
      throw new Error(`live target check returned invalid JSON for ${target}`);
    }
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
