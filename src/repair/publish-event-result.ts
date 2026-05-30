#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  applyEventSnapshot,
  captureEventSnapshot,
  type EventRecordPaths,
  resetEventSnapshot,
} from "./event-record-store.js";
import {
  commitMessageForPublishedPaths,
  configureGitUser,
  hardResetToRemoteMain,
  hasStagedChanges,
  publishRoot,
  pushCommit,
  runGit,
  setTokenOrigin,
  stagePaths,
  syncPublishPaths,
} from "./git-publish.js";
import { isJsonObject } from "./json-types.js";
import { eventReviewMarkerFreshness } from "./comment-router-core.js";
import { ghJsonWithRetry, ghPagedWithRetry } from "./github-cli.js";

const CLAWSWEEPER_COMMENT_LOGINS = new Set([
  "clawsweeper",
  "clawsweeper[bot]",
  "openclaw-clawsweeper[bot]",
]);

type ApplyAction = {
  action: string;
};

type EventOptions = {
  targetRepo: string;
  itemNumber: string;
  closeReasons: string;
  minAgeMinutes: string;
  reportPath: string;
  snapshotDir: string;
};

const options = eventOptionsFromEnv();
await publishEventResult(options);

async function publishEventResult(options: EventOptions): Promise<void> {
  validateTargetRepo(options.targetRepo);
  validateItemNumber(options.itemNumber);
  const repository = process.env.GITHUB_REPOSITORY;
  const repoToken = process.env.REPO_TOKEN;
  if (!publishRoot() && repository && repoToken) setTokenOrigin(repoToken, repository);
  configureGitUser();

  const recordStore = {
    targetRepo: options.targetRepo,
    itemNumber: options.itemNumber,
    snapshotDir: options.snapshotDir,
  };

  resetEventSnapshot(recordStore);
  fs.rmSync(options.reportPath, { force: true });

  runStreaming("pnpm", [
    "run",
    "apply-artifacts",
    "--",
    "--target-repo",
    options.targetRepo,
    "--artifact-dir",
    "artifacts/event",
    "--skip-reconcile",
    "--skip-dashboard",
    "--replay-closed-artifacts",
  ]);
  runStreaming("pnpm", [
    "run",
    "apply-decisions",
    "--",
    "--target-repo",
    options.targetRepo,
    "--item-numbers",
    options.itemNumber,
    "--apply-kind",
    "all",
    "--apply-close-reasons",
    options.closeReasons,
    "--stale-min-age-days",
    "30",
    "--limit",
    "1",
    "--processed-limit",
    "20",
    "--min-age-minutes",
    options.minAgeMinutes,
    "--close-delay-ms",
    "1000",
    "--comment-sync-min-age-days",
    "0",
    "--progress-every",
    "1",
    "--skip-dashboard",
    "--report-path",
    options.reportPath,
  ]);

  const actions = readApplyActions(options.reportPath);
  const syncedCount = actions.filter((entry) => entry.action === "review_comment_synced").length;
  const closedCount = actions.filter((entry) => entry.action === "closed").length;
  const recordPaths = captureEventSnapshot(recordStore);

  const summary = () =>
    writeSummary({
      targetRepo: options.targetRepo,
      itemNumber: options.itemNumber,
      syncedCount,
      closedCount,
      closeReasons: options.closeReasons,
    });

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    if (publishSnapshot({ paths: recordPaths, options, summary })) {
      emitMarkerFreshness(options);
      return;
    }
    const delaySeconds = attempt * 3 + Math.floor(Math.random() * 11);
    console.log(
      `Event publish attempt ${attempt} failed; retrying from origin/main in ${delaySeconds}s`,
    );
    await sleep(delaySeconds * 1000);
  }
  if (publishSnapshot({ paths: recordPaths, options, summary })) {
    emitMarkerFreshness(options);
    return;
  }
  throw new Error(`Failed to publish event result for ${options.targetRepo}#${options.itemNumber}`);
}

function emitMarkerFreshness(options: EventOptions): void {
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (!githubOutput) return;
  try {
    const fresh = verifyMarkerFreshness(options);
    fs.appendFileSync(githubOutput, `marker_fresh=${fresh ? "1" : "0"}\n`, "utf8");
  } catch (error) {
    console.error(
      `Failed to record durable verdict marker freshness: ${error instanceof Error ? error.message : String(error)}`,
    );
    fs.appendFileSync(githubOutput, "marker_fresh=0\n", "utf8");
  }
}

function verifyMarkerFreshness(options: EventOptions): boolean {
  const issue = ghJsonWithRetry<{ pull_request?: unknown }>(
    ["api", `repos/${options.targetRepo}/issues/${options.itemNumber}`],
    { attempts: 4 },
  );
  if (!issue?.pull_request) return true;
  const pull = ghJsonWithRetry<{ head?: { sha?: unknown } }>(
    ["api", `repos/${options.targetRepo}/pulls/${options.itemNumber}`],
    { attempts: 4 },
  );
  const currentHeadSha = typeof pull?.head?.sha === "string" ? pull.head.sha.trim() : "";
  const freshness = eventReviewMarkerFreshness({
    itemKind: "pull_request",
    commentBody: latestVerdictCommentBody(options),
    currentHeadSha,
  });
  if (!freshness.fresh) {
    console.log(
      `Durable verdict marker not refreshed for ${options.targetRepo}#${options.itemNumber}: ${
        freshness.reason ?? "no verdict marker at current head"
      } (marker sha=${freshness.markerSha ?? "none"}, head=${currentHeadSha || "unknown"})`,
    );
  }
  return freshness.fresh;
}

function latestVerdictCommentBody(options: EventOptions): string {
  const comments = ghPagedWithRetry<{
    body?: unknown;
    updated_at?: unknown;
    user?: { login?: unknown };
  }>(`repos/${options.targetRepo}/issues/${options.itemNumber}/comments`, { attempts: 4 });
  const candidate = comments
    .filter((comment) => {
      const login = String(comment?.user?.login ?? "").toLowerCase();
      return (
        CLAWSWEEPER_COMMENT_LOGINS.has(login) &&
        String(comment?.body ?? "").includes("clawsweeper-verdict:")
      );
    })
    .sort((a, b) => String(b?.updated_at ?? "").localeCompare(String(a?.updated_at ?? "")))[0];
  return String(candidate?.body ?? "");
}

function publishSnapshot({
  paths,
  options,
  summary,
}: {
  paths: EventRecordPaths;
  options: EventOptions;
  summary: () => void;
}): boolean {
  try {
    hardResetToRemoteMain();
    const stateRoot = publishRoot();
    if (
      stateRoot &&
      fs.existsSync(paths.snapshotItem) &&
      !fs.existsSync(paths.snapshotClosed) &&
      fs.existsSync(`${stateRoot}/${paths.closedRecord}`)
    ) {
      console.log(
        `Remote already has closed record for ${paths.targetSlug}#${options.itemNumber}; skipping open-record publish`,
      );
      summary();
      return true;
    }
    const snapshotResult = applyEventSnapshot(paths);
    if (snapshotResult === "remote-closed") {
      console.log(
        `Remote already has closed record for ${paths.targetSlug}#${options.itemNumber}; skipping open-record publish`,
      );
      summary();
      return true;
    }
    if (snapshotResult === "missing") {
      console.log(`No event record snapshot for ${paths.targetSlug}#${options.itemNumber}`);
      summary();
      return true;
    }

    const commitPaths = [paths.itemRecord, paths.closedRecord];
    syncPublishPaths(commitPaths);
    stagePaths(commitPaths);
    if (!hasStagedChanges()) {
      console.log("No event result changes");
      summary();
      return true;
    }

    runGit([
      "commit",
      "-m",
      commitMessageForPublishedPaths(
        `chore: apply event sweep result for ${paths.targetSlug}#${options.itemNumber}`,
        commitPaths,
      ),
    ]);
    if (!pushCommit({ pushAttempts: 3 })) return false;
    summary();
    return true;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return false;
  }
}

function eventOptionsFromEnv(): EventOptions {
  return {
    targetRepo: envValue("TARGET_REPO"),
    itemNumber: envValue("ITEM_NUMBER"),
    closeReasons:
      process.env.CLOSE_REASONS ||
      "implemented_on_main,duplicate_or_superseded,low_signal_unmergeable_pr",
    minAgeMinutes: process.env.MIN_AGE_MINUTES || "0",
    reportPath: ".artifacts/event-apply-report.json",
    snapshotDir: ".artifacts/event-record-snapshot",
  };
}

function readApplyActions(reportPath: string): ApplyAction[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${reportPath} must contain an array`);
  return parsed.map((entry) => {
    if (!isJsonObject(entry) || typeof entry.action !== "string") return { action: "" };
    return { action: entry.action };
  });
}

function writeSummary({
  targetRepo,
  itemNumber,
  syncedCount,
  closedCount,
  closeReasons,
}: {
  targetRepo: string;
  itemNumber: string;
  syncedCount: number;
  closedCount: number;
  closeReasons: string;
}): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  fs.appendFileSync(
    summaryPath,
    [
      "### Event review applied",
      `- Item: ${targetRepo}#${itemNumber}`,
      `- Synced durable comments: ${syncedCount}`,
      `- Closed safe proposals: ${closedCount}`,
      `- Close reasons enabled: ${closeReasons}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

function validateTargetRepo(targetRepo: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo)) {
    throw new Error(`Invalid target repo: ${targetRepo}`);
  }
}

function validateItemNumber(itemNumber: string): void {
  if (!/^[0-9]+$/.test(itemNumber)) throw new Error(`Invalid item number: ${itemNumber}`);
}

function envValue(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function runStreaming(command: string, args: readonly string[]): void {
  const child = spawnSync(command, [...args], { stdio: "inherit", env: process.env });
  if (child.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${child.status}`);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
