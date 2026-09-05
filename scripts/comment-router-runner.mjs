#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { classifyOperatorSkipReason } from "./operator-skip-reasons.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const targetRepo =
  flagValue(argv, "repo") || process.env.CLAWSWEEPER_TARGET_REPO || "openclaw/openclaw";
const broadScan = !hasAnyFlag(argv, ["item-number", "item-numbers", "comment-id", "comment-ids"]);
const explicitSince = hasAnyFlag(argv, ["since"]);
const cursorEligible = broadScan && !explicitSince;
const cursorPath = path.join(
  root,
  "results",
  "comment-router-cursors",
  `${repoSlug(targetRepo)}.json`,
);
const reportPath = path.join(root, "results", "comment-router-latest.json");
const ledgerPath = path.join(root, "results", "comment-router.json");
const cursorBefore = cursorEligible ? readCursor(cursorPath, targetRepo) : null;
const ledgerBefore = fileDigest(ledgerPath);
const childArgs = [...argv];
if (cursorBefore) {
  childArgs.push("--since", cursorBefore.updated_at);
  if (cursorBefore.comment_ids.length > 0) {
    childArgs.push("--since-comment-ids", cursorBefore.comment_ids.join(","));
  }
}

// Hydrated reports describe an earlier invocation, not this child's progress.
fs.rmSync(reportPath, { force: true });
const child = spawn(
  process.execPath,
  [path.join(root, "dist/repair/comment-router.js"), ...childArgs],
  {
    cwd: root,
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
  },
);
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout = boundedTail(stdout, chunk);
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  stderr = boundedTail(stderr, chunk);
  process.stderr.write(chunk);
});

const { code, signal } = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => resolve({ code, signal }));
});

if (code === 0) {
  if (cursorEligible) advanceCursorAfterSuccess();
  process.exit(0);
}

const failureText = `${stderr}\n${stdout}`.trim();
const failure = Object.assign(new Error(failureText), { status: httpStatus(failureText) });
const reason = classifyOperatorSkipReason(failure);
if (reason !== "github_throttled") {
  if (signal) process.stderr.write(`[comment-router] child terminated by ${signal}\n`);
  process.exit(code || 1);
}

const existingReport = readJsonObject(reportPath) ?? {};
const ledgerChanged = ledgerBefore !== fileDigest(ledgerPath);
const operatorSkip = {
  reason,
  stage: "comment_routing",
  repo: targetRepo,
  cursor_advanced: false,
  cursor_updated_at: cursorBefore?.updated_at ?? null,
};
const deferredReport = {
  ...existingReport,
  status: "deferred",
  generated_at: new Date().toISOString(),
  repo: targetRepo,
  commands_seen: Number.isInteger(existingReport.commands_seen) ? existingReport.commands_seen : 0,
  commands: Array.isArray(existingReport.commands) ? existingReport.commands : [],
  ledger_changed: ledgerChanged ? 1 : Number(existingReport.ledger_changed ?? 0),
  short_circuited: false,
  operator_skip: operatorSkip,
  routing_cursor: {
    advanced: false,
    path: path.relative(root, cursorPath),
    previous: cursorBefore,
  },
  routing_cursor_changed: false,
};
writeJsonAtomic(reportPath, deferredReport);
process.stdout.write(`comment_router_skip ${JSON.stringify(operatorSkip)}\n`);
process.exit(0);

function advanceCursorAfterSuccess() {
  const report = readJsonObject(reportPath);
  const candidate = validatedCursorCandidate(report?.routing_cursor_candidate, targetRepo);
  if (!candidate) {
    if (report) {
      report.routing_cursor = {
        advanced: false,
        path: path.relative(root, cursorPath),
        previous: cursorBefore,
      };
      report.routing_cursor_changed = false;
      writeJsonAtomic(reportPath, report);
    }
    return;
  }
  const next = mergeCursor(cursorBefore, candidate);
  const changed = JSON.stringify(next) !== JSON.stringify(cursorBefore);
  if (changed) writeJsonAtomic(cursorPath, next);
  if (report) {
    report.routing_cursor = {
      advanced: changed,
      path: path.relative(root, cursorPath),
      previous: cursorBefore,
      current: next,
    };
    report.routing_cursor_changed = changed;
    writeJsonAtomic(reportPath, report);
  }
  process.stdout.write(
    `comment_router_cursor ${JSON.stringify({ repo: targetRepo, advanced: changed, updated_at: next.updated_at })}\n`,
  );
}

function readCursor(file, repo) {
  if (!fs.existsSync(file)) return null;
  const value = readJsonObject(file);
  if (!value || value.schema_version !== 1 || value.repo !== repo) {
    throw new Error(`invalid comment router cursor: ${file}`);
  }
  return validatedCursorCandidate(value, repo, true);
}

function validatedCursorCandidate(value, repo, required = false) {
  if (value === null || value === undefined) {
    if (required) throw new Error("comment router cursor is missing");
    return null;
  }
  const updatedAt = String(value.updated_at ?? "");
  const ids = value.comment_ids;
  if (
    !value ||
    typeof value !== "object" ||
    String(value.repo ?? repo) !== repo ||
    !Number.isFinite(Date.parse(updatedAt)) ||
    !Array.isArray(ids) ||
    ids.some((id) => !Number.isSafeInteger(id) || id < 1)
  ) {
    throw new Error("invalid comment router cursor candidate");
  }
  return {
    schema_version: 1,
    repo,
    updated_at: new Date(updatedAt).toISOString(),
    comment_ids: [...new Set(ids)].sort((left, right) => left - right),
  };
}

function mergeCursor(previous, candidate) {
  if (!previous) return candidate;
  const previousTime = Date.parse(previous.updated_at);
  const candidateTime = Date.parse(candidate.updated_at);
  if (candidateTime < previousTime) return previous;
  if (candidateTime > previousTime) return candidate;
  return {
    ...candidate,
    comment_ids: [...new Set([...previous.comment_ids, ...candidate.comment_ids])].sort(
      (left, right) => left - right,
    ),
  };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readJsonObject(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function fileDigest(file) {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function flagValue(args, name) {
  const index = args.lastIndexOf(`--${name}`);
  return index >= 0 ? String(args[index + 1] ?? "") : "";
}

function hasAnyFlag(args, names) {
  const flags = new Set(names.map((name) => `--${name}`));
  return args.some((arg) => flags.has(arg));
}

function repoSlug(repo) {
  return repo.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
}

function boundedTail(current, chunk) {
  return `${current}${chunk}`.slice(-1024 * 1024);
}

function httpStatus(text) {
  const value = Number(/\bHTTP\s+([1-5]\d{2})\b/i.exec(text)?.[1]);
  return Number.isInteger(value) ? value : undefined;
}
