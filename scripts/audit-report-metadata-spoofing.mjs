#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { requiredCliValue } from "../src/clawsweeper-args.ts";
import { discoverWorkerRecordRepoSlugs, exportWorkerRecords } from "./worker-records.ts";

const CANONICAL_PROMOTION_KEYS = Object.freeze([
  "real_behavior_proof_status",
  "real_behavior_proof_evidence_kind",
  "real_behavior_proof_needs_contributor_action",
  "pr_rating_overall",
  "pr_rating_proof",
  "pr_rating_patch",
]);

const DEFAULT_MAX_RECORDS = 10_000;
const DEFAULT_RECORDS_URL = "https://clawsweeper.openclaw.ai";
const REPO_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

export function reportMetadataSpoofingFinding(markdown) {
  const frontMatterMatch = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontMatterMatch) return null;
  const remainderStart = frontMatterMatch[0].length;
  const remainder = markdown.slice(remainderStart);
  const matches = [];
  for (const key of CANONICAL_PROMOTION_KEYS) {
    const match = new RegExp(`^${key}:`, "m").exec(remainder);
    if (!match) continue;
    const absoluteIndex = remainderStart + match.index;
    matches.push({ key, line: lineNumberAt(markdown, absoluteIndex) });
  }
  if (!matches.length) return null;
  matches.sort((left, right) => left.line - right.line || left.key.localeCompare(right.key));
  return {
    matched_keys: matches.map((match) => match.key),
    first_match_line: matches[0].line,
  };
}

export async function auditCanonicalItemRecords(options) {
  const maxRecords = positiveInteger(options.maxRecords ?? DEFAULT_MAX_RECORDS, "maxRecords");
  const repoSlugs = await resolveRepoSlugs(options);
  const findings = [];
  let scannedRecords = 0;
  for (const repoSlug of repoSlugs) {
    const snapshot = await (options.exportRecords ?? exportWorkerRecords)({
      baseUrl: options.baseUrl,
      webhookSecret: options.webhookSecret,
      repoSlug,
      sections: ["items"],
      maxRecords: maxRecords - scannedRecords,
      fetch: options.fetch,
    });
    scannedRecords += snapshot.records.length;
    if (scannedRecords > maxRecords) {
      throw new Error(`Canonical item audit exceeded the ${maxRecords}-record bound`);
    }
    for (const record of snapshot.records) {
      if (record.section !== "items" || record.deleted || typeof record.content !== "string") {
        continue;
      }
      const finding = reportMetadataSpoofingFinding(record.content);
      if (!finding) continue;
      findings.push({
        repo_slug: repoSlug,
        item_number: Number(record.id),
        ...finding,
      });
    }
  }
  findings.sort(
    (left, right) =>
      left.repo_slug.localeCompare(right.repo_slug) || left.item_number - right.item_number,
  );
  return {
    schema_version: 1,
    generated_at: (options.now ?? new Date()).toISOString(),
    repo_slugs: repoSlugs,
    scanned_records: scannedRecords,
    finding_count: findings.length,
    findings,
  };
}

async function runAuditCli(argv, env = process.env) {
  const args = parseArgs(argv);
  const webhookSecret = env.CLAWSWEEPER_RECORDS_SECRET ?? env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
  if (!webhookSecret) throw new Error("CLAWSWEEPER_WEBHOOK_SECRET is required");
  const inventory = await auditCanonicalItemRecords({
    baseUrl:
      args.recordsUrl ??
      env.CLAWSWEEPER_RECORDS_URL ??
      env.CLAWSWEEPER_STATE_COORDINATOR_URL ??
      DEFAULT_RECORDS_URL,
    webhookSecret,
    repoSlugs: args.repoSlugs ?? parseRepoSlugs(env.CLAWSWEEPER_RECORDS_REPO_SLUGS) ?? undefined,
    maxRecords: args.maxRecords ?? DEFAULT_MAX_RECORDS,
  });
  const json = `${JSON.stringify(inventory, null, 2)}\n`;
  if (args.output) {
    const output = path.resolve(args.output);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, json, "utf8");
    console.error(
      `Audited ${inventory.scanned_records} canonical item records; wrote ${inventory.finding_count} finding(s) to ${args.output}`,
    );
  } else {
    process.stdout.write(json);
  }
  return inventory;
}

async function resolveRepoSlugs(options) {
  const configured = options.repoSlugs?.length
    ? options.repoSlugs
    : (
        await (options.discoverRepoSlugs ?? discoverWorkerRecordRepoSlugs)({
          baseUrl: options.baseUrl,
          webhookSecret: options.webhookSecret,
          fetch: options.fetch,
        })
      ).map((entry) => entry.repoSlug);
  const repoSlugs = [...new Set(configured)].sort();
  if (!repoSlugs.length) throw new Error("Canonical record store returned no repository slugs");
  for (const repoSlug of repoSlugs) {
    if (!REPO_SLUG_PATTERN.test(repoSlug)) {
      throw new Error(`Invalid record repository slug: ${repoSlug}`);
    }
  }
  return repoSlugs;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--output") parsed.output = requiredCliValue(argv, ++index, arg);
    else if (arg === "--records-url") parsed.recordsUrl = requiredCliValue(argv, ++index, arg);
    else if (arg === "--repo-slugs") {
      parsed.repoSlugs = parseRepoSlugs(requiredCliValue(argv, ++index, arg));
    } else if (arg === "--max-records") {
      parsed.maxRecords = positiveInteger(requiredCliValue(argv, ++index, arg), arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function parseRepoSlugs(value) {
  if (value === undefined || value.trim() === "") return undefined;
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))].sort();
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${name} requires a positive safe integer`);
  }
  return number;
}

function lineNumberAt(markdown, index) {
  let line = 1;
  for (let offset = 0; offset < index; offset += 1) {
    if (markdown.charCodeAt(offset) === 10) line += 1;
  }
  return line;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await runAuditCli(process.argv.slice(2));
}
