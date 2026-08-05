#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { classifyRecords, mapWorkspaceItem, proposesClose } from "../dist/linear/index.js";

const DEFAULT_STALE_DAYS = 60;

export function parseArgs(argv) {
  const options = {
    reviewOnly: true,
    json: false,
    snapshot: "",
    nowIso: undefined,
    staleDays: DEFAULT_STALE_DAYS,
    requiredLabels: [],
    exclusionLabels: [],
    protectedLabels: [],
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--review-only":
        options.reviewOnly = true;
        break;
      case "--apply":
      case "--mutate":
      case "--no-review-only":
        throw new Error("review-only runner: mutations are not supported");
      case "--json":
        options.json = true;
        break;
      case "--snapshot":
        options.snapshot = requireValue(argv, ++index, arg);
        break;
      case "--now":
        options.nowIso = requireValue(argv, ++index, arg);
        break;
      case "--stale-days":
        options.staleDays = positiveInt(requireValue(argv, ++index, arg), "--stale-days");
        break;
      case "--required-label":
        options.requiredLabels.push(requireValue(argv, ++index, arg));
        break;
      case "--exclusion-label":
        options.exclusionLabels.push(requireValue(argv, ++index, arg));
        break;
      case "--protected-label":
        options.protectedLabels.push(requireValue(argv, ++index, arg));
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

export function loadSnapshot(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`snapshot is not valid JSON: ${error.message}`);
  }

  let items;
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.items)) {
    items = parsed.items;
  } else {
    throw new Error(
      "snapshot must be a WorkspaceItem[] array or an object { items: WorkspaceItem[] }",
    );
  }

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item === null || typeof item !== "object") {
      throw new Error(`snapshot item at index ${i} is not an object`);
    }
    if (!item.team || typeof item.team !== "object") {
      throw new Error(`snapshot item at index ${i} is missing a team object`);
    }
    if (!item.issue || typeof item.issue !== "object") {
      throw new Error(`snapshot item at index ${i} is missing an issue object`);
    }
  }

  return items;
}

export function buildDigest(items, options) {
  const {
    nowIso,
    staleDays = DEFAULT_STALE_DAYS,
    requiredLabels = [],
    exclusionLabels = [],
    protectedLabels = [],
  } = options;

  if (!nowIso) {
    throw new Error("buildDigest requires options.nowIso");
  }

  const records = items.map(mapWorkspaceItem);
  const classifications = classifyRecords(records, {
    nowIso,
    staleDays,
    requiredLabels,
    exclusionLabels,
    protectedLabels,
  });

  const byDisposition = {
    review: [],
    "stale-candidate": [],
    protected: [],
    excluded: [],
    "not-ready": [],
    closed: [],
  };

  const byCategory = {};
  const byPriority = {};
  let anyProposesClose = false;

  for (let i = 0; i < classifications.length; i += 1) {
    const c = classifications[i];
    if (proposesClose(c)) {
      anyProposesClose = true;
    }
    byDisposition[c.disposition].push(c);
    const cat = records[i].itemCategory;
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    const pri = records[i].triagePriority;
    byPriority[pri] = (byPriority[pri] ?? 0) + 1;
  }

  const staleCandidates = byDisposition["stale-candidate"].map((c) => ({
    key: c.key,
    identifier: c.identifier,
    reasons: c.reasons,
  }));

  const totals = {
    items: items.length,
    eligible: classifications.filter((c) => c.eligible).length,
    review: byDisposition.review.length,
    staleCandidates: byDisposition["stale-candidate"].length,
    protected: byDisposition.protected.length,
    excluded: byDisposition.excluded.length,
    notReady: byDisposition["not-ready"].length,
    closed: byDisposition.closed.length,
  };

  return {
    ok: !anyProposesClose,
    reviewOnly: true,
    proposesClose: false,
    generatedAt: nowIso,
    staleDays,
    totals,
    byDisposition: {
      review: byDisposition.review.length,
      "stale-candidate": byDisposition["stale-candidate"].length,
      protected: byDisposition.protected.length,
      excluded: byDisposition.excluded.length,
      "not-ready": byDisposition["not-ready"].length,
      closed: byDisposition.closed.length,
    },
    byCategory,
    byPriority,
    staleCandidates,
    sentinel: "TRIAGE_OK",
  };
}

export function formatDigest(digest) {
  const lines = [];
  lines.push(`Linear Triage Digest — ${digest.generatedAt}`);
  lines.push(
    `reviewOnly: ${digest.reviewOnly}  proposesClose: ${digest.proposesClose}  staleDays: ${digest.staleDays}`,
  );
  lines.push("");
  lines.push("Totals:");
  lines.push(`  items:          ${digest.totals.items}`);
  lines.push(`  eligible:       ${digest.totals.eligible}`);
  lines.push(`  review:         ${digest.totals.review}`);
  lines.push(`  stale-candidate:${digest.totals.staleCandidates}`);
  lines.push(`  protected:      ${digest.totals.protected}`);
  lines.push(`  excluded:       ${digest.totals.excluded}`);
  lines.push(`  not-ready:      ${digest.totals.notReady}`);
  lines.push(`  closed:         ${digest.totals.closed}`);
  lines.push("");
  lines.push("By disposition:");
  for (const [disp, count] of Object.entries(digest.byDisposition)) {
    lines.push(`  ${disp.padEnd(16)} ${count}`);
  }
  if (Object.keys(digest.byCategory).length > 0) {
    lines.push("");
    lines.push("By category:");
    for (const [cat, count] of Object.entries(digest.byCategory)) {
      lines.push(`  ${cat.padEnd(16)} ${count}`);
    }
  }
  if (Object.keys(digest.byPriority).length > 0) {
    lines.push("");
    lines.push("By priority:");
    for (const [pri, count] of Object.entries(digest.byPriority)) {
      lines.push(`  ${pri.padEnd(16)} ${count}`);
    }
  }
  if (digest.staleCandidates.length > 0) {
    lines.push("");
    lines.push("Stale candidates:");
    for (const sc of digest.staleCandidates) {
      lines.push(`  ${sc.identifier}  ${sc.reasons.join("; ")}`);
    }
  }
  lines.push(digest.sentinel);
  return lines.join("\n");
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("\n" + usage());
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  const nowIso = options.nowIso || new Date().toISOString();

  let text;
  try {
    text = options.snapshot ? readFileSync(options.snapshot, "utf8") : readFileSync(0, "utf8");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  let items;
  let digest;
  try {
    items = loadSnapshot(text);
    digest = buildDigest(items, { ...options, nowIso });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(digest, null, 2));
  } else {
    console.log(formatDigest(digest));
  }
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function positiveInt(value, flag) {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return Number(value);
}

function usage() {
  return `Usage: node scripts/linear-triage.mjs [options]

Review-only triage runner for Linear workspace snapshots. Maps workspace items,
classifies each record, and emits a status digest. Never mutates anything.

Options:
  --review-only              Accepted (default and only mode; mutations are not supported)
  --json                     Output JSON digest instead of human-readable format
  --snapshot <path>          Path to snapshot JSON file (default: read stdin)
  --now <iso>                ISO 8601 timestamp to use as "now" (default: current time)
  --stale-days <n>           Days before an issue is considered stale (default: ${DEFAULT_STALE_DAYS})
  --required-label <label>   Require at least one of these labels (repeatable)
  --exclusion-label <label>  Skip items with this label (repeatable)
  --protected-label <label>  Mark items with this label as protected (repeatable)
  --help, -h                 Show this help message

Examples:
  node scripts/linear-triage.mjs --review-only --json --snapshot snapshot.json
  node scripts/linear-triage.mjs --review-only --json --now 2024-09-01T00:00:00Z --snapshot snapshot.json
  cat snapshot.json | node scripts/linear-triage.mjs --stale-days 30`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
