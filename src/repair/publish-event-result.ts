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
  captureStatePublishBaseline,
  commitMessageForPublishedPaths,
  configureGitUser,
  hardResetToRemoteMain,
  hasStagedChanges,
  publishRoot,
  pushCommit,
  refreshSourceAfterStatePublish,
  runGit,
  setTokenOrigin,
  stagePaths,
  syncPublishPaths,
} from "./git-publish.js";
import { isJsonObject } from "./json-types.js";

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
  const stateBaseCommit = captureStatePublishBaseline();

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    if (publishSnapshot({ paths: recordPaths, options, summary, stateBaseCommit })) return;
    const delaySeconds = attempt * 3 + Math.floor(Math.random() * 11);
    console.log(
      `Event publish attempt ${attempt} failed; retrying from origin/main in ${delaySeconds}s`,
    );
    await sleep(delaySeconds * 1000);
  }
  if (!publishSnapshot({ paths: recordPaths, options, summary, stateBaseCommit })) {
    throw new Error(
      `Failed to publish event result for ${options.targetRepo}#${options.itemNumber}`,
    );
  }
}

function publishSnapshot({
  paths,
  options,
  summary,
  stateBaseCommit,
}: {
  paths: EventRecordPaths;
  options: EventOptions;
  summary: () => void;
  stateBaseCommit: string | null;
}): boolean {
  const commitPaths = [paths.itemRecord, paths.closedRecord];
  try {
    const complete = (): true => {
      refreshSourceAfterStatePublish(commitPaths, stateBaseCommit);
      summary();
      return true;
    };
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
      return complete();
    }
    const snapshotResult = applyEventSnapshot(paths);
    if (snapshotResult === "remote-closed") {
      console.log(
        `Remote already has closed record for ${paths.targetSlug}#${options.itemNumber}; skipping open-record publish`,
      );
      return complete();
    }
    if (snapshotResult === "missing") {
      console.log(`No event record snapshot for ${paths.targetSlug}#${options.itemNumber}`);
      return complete();
    }

    syncPublishPaths(commitPaths);
    stagePaths(commitPaths);
    if (!hasStagedChanges()) {
      console.log("No event result changes");
      return complete();
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
    return complete();
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
