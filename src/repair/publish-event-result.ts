#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  applyEventSnapshot,
  applyEventSnapshotIfCurrent,
  captureEventBaseSnapshot,
  captureEventSnapshot,
  eventSnapshotMatchesCurrent,
  type EventRecordPaths,
  resetEventSnapshot,
} from "./event-record-store.js";
import {
  eventRecordActionTaken,
  eventApplyAction,
  exactEventApplyProof,
  eventApplyRequeueLatestExpected,
  exactEventPublishDisposition,
  type EventApplyAction,
} from "./event-apply-proof.js";
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
import { RecordTupleError } from "./record-tuple.js";

type EventOptions = {
  targetRepo: string;
  itemNumber: string;
  closeReasons: string;
  minAgeMinutes: string;
  reviewOnly: boolean;
  exactEventPublication: boolean;
  reportPath: string;
  snapshotDir: string;
};

type PublishedEventSnapshot = {
  guardedOpenAction: string | null;
  policyNoop: boolean;
  requeueLatest: boolean;
  remoteTupleVerified: boolean;
  routableSyncVerified: boolean;
  routingDeferred: boolean;
  terminalClosed: boolean;
  terminalMissing: boolean;
};

class GuardedOpenPublishRaceError extends Error {}
class RoutableSyncPublishRaceError extends Error {}
class SourceDriftPublishRaceError extends Error {}
class TerminalClosedPublishRaceError extends Error {}
class TerminalMissingPublishRaceError extends Error {}

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
  captureEventBaseSnapshot(recordStore);
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

  // Preserve the exact artifact candidate before refreshing the state checkout.
  // A stale event must be rejected before apply-decisions can comment, label,
  // or close anything on GitHub.
  const recordPaths = captureEventSnapshot(recordStore);
  hardResetToRemoteMain();
  const stateBaseCommit = captureStatePublishBaseline();
  const stateRoot = publishRoot();
  const preflightResult = applyEventSnapshotIfCurrent(
    recordPaths,
    stateRoot ? { remoteRoot: stateRoot } : {},
    () => runApplyDecisions(options),
  );
  if (
    preflightResult === "remote-closed" ||
    preflightResult === "remote-newer" ||
    preflightResult === "missing"
  ) {
    const detail =
      preflightResult === "remote-closed"
        ? "current state is already closed"
        : preflightResult === "remote-newer"
          ? "current state has a newer tuple"
          : "the event produced no record tuple";
    console.log(
      `Skipping stale event apply for ${options.targetRepo}#${options.itemNumber}: ${detail}`,
    );
    refreshSourceAfterStatePublish(
      [
        recordPaths.itemRecord,
        recordPaths.closedRecord,
        recordPaths.planRecord,
        recordPaths.decisionPacket,
      ],
      stateBaseCommit,
    );
    writeSummary({
      targetRepo: options.targetRepo,
      itemNumber: options.itemNumber,
      syncedCount: 0,
      closedCount: 0,
      missingCount: 0,
      closeReasons: options.closeReasons,
    });
    throw new Error(
      `Event state for ${options.targetRepo}#${options.itemNumber} was not applied because ${detail}; requeue against the latest item revision`,
    );
  }

  const actions = readApplyActions(options.reportPath);
  captureEventSnapshot(recordStore);
  const snapshotActionTaken = eventRecordActionTaken(
    fs.existsSync(recordPaths.snapshotItem)
      ? fs.readFileSync(recordPaths.snapshotItem, "utf8")
      : null,
  );
  const {
    exactActions,
    syncedCount,
    terminalMissingCount: missingCount,
    terminalCount: closedCount,
    guardedOpenAction,
    legacyTuplelessReviewLease,
    disposition: applyDisposition,
  } = exactEventApplyProof(actions, Number(options.itemNumber), snapshotActionTaken);
  const requeueLatestExpected = eventApplyRequeueLatestExpected({
    disposition: applyDisposition,
    exactEventPublication: options.exactEventPublication,
    legacyTuplelessReviewLease,
  });
  if (options.exactEventPublication && legacyTuplelessReviewLease) {
    console.log(
      `Requeueing ${options.targetRepo}#${options.itemNumber}: legacy exact artifact lacks its durable review lease tuple`,
    );
  }
  if (
    syncedCount + closedCount + missingCount === 0 &&
    guardedOpenAction === null &&
    !requeueLatestExpected
  ) {
    const observed =
      exactActions
        .map((entry) => entry.action)
        .filter(Boolean)
        .join(", ") || "none";
    throw new Error(
      `Event review for ${options.targetRepo}#${options.itemNumber} was not applied; actions: ${observed}`,
    );
  }
  const summary = () =>
    writeSummary({
      targetRepo: options.targetRepo,
      itemNumber: options.itemNumber,
      syncedCount,
      closedCount,
      missingCount,
      closeReasons: options.closeReasons,
    });
  const routableSyncExpected =
    syncedCount > 0 &&
    closedCount === 0 &&
    missingCount === 0 &&
    guardedOpenAction === null &&
    !requeueLatestExpected;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const published = publishSnapshot({
      paths: recordPaths,
      options,
      summary,
      stateBaseCommit,
      guardedOpenAction,
      requeueLatestExpected,
      routableSyncExpected,
      terminalClosedExpected: closedCount > 0,
      terminalMissingExpected: missingCount > 0,
    });
    if (published) {
      writeEventDispositionOutputs(published);
      return;
    }
    const delaySeconds = attempt * 3 + Math.floor(Math.random() * 11);
    console.log(
      `Event publish attempt ${attempt} failed; retrying from origin/main in ${delaySeconds}s`,
    );
    await sleep(delaySeconds * 1000);
  }
  const published = publishSnapshot({
    paths: recordPaths,
    options,
    summary,
    stateBaseCommit,
    guardedOpenAction,
    requeueLatestExpected,
    routableSyncExpected,
    terminalClosedExpected: closedCount > 0,
    terminalMissingExpected: missingCount > 0,
  });
  if (!published) {
    throw new Error(
      `Failed to publish event result for ${options.targetRepo}#${options.itemNumber}`,
    );
  }
  writeEventDispositionOutputs(published);
}

function runApplyDecisions(options: EventOptions): void {
  const args = [
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
    ...(options.reviewOnly ? ["--sync-comments-only", "--suppress-automation-markers"] : []),
    "--stale-min-age-days",
    "30",
    "--limit",
    options.reviewOnly ? "0" : "1",
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
    "--event-apply-proof",
    "--exact-event-publication",
    "--skip-dashboard",
    "--report-path",
    options.reportPath,
  ];
  runStreaming("pnpm", args);
}

function publishSnapshot({
  paths,
  options,
  summary,
  stateBaseCommit,
  guardedOpenAction,
  requeueLatestExpected,
  routableSyncExpected,
  terminalClosedExpected,
  terminalMissingExpected,
}: {
  paths: EventRecordPaths;
  options: EventOptions;
  summary: () => void;
  stateBaseCommit: string | null;
  guardedOpenAction: string | null;
  requeueLatestExpected: boolean;
  routableSyncExpected: boolean;
  terminalClosedExpected: boolean;
  terminalMissingExpected: boolean;
}): PublishedEventSnapshot | null {
  const commitPaths = [
    paths.itemRecord,
    paths.closedRecord,
    paths.planRecord,
    paths.decisionPacket,
  ];
  try {
    const complete = (candidateApplied: boolean): PublishedEventSnapshot => {
      // The reconciliation push can succeed just before another publisher
      // advances the same tuple. Refresh from the authoritative remote before
      // emitting any completion output; the workflow never routes an ordinary
      // synced verdict inline, so no read-then-route atomicity is implied here.
      hardResetToRemoteMain();
      refreshSourceAfterStatePublish(commitPaths, stateBaseCommit);
      const candidateMatchesCurrentTuple = candidateApplied && eventSnapshotMatchesCurrent(paths);
      const candidateTupleState = candidateEventTupleState(paths);
      const disposition = exactEventPublishDisposition({
        candidateMatchesCurrentTuple,
        candidateTupleState,
        terminalClosedExpected,
        terminalMissingExpected,
        guardedOpenAction,
        routableSyncExpected,
      });
      const published = {
        ...disposition,
        policyNoop: disposition.guardedOpenAction === "skipped_same_author_pair",
        requeueLatest:
          requeueLatestExpected && candidateMatchesCurrentTuple && candidateTupleState === "open",
        remoteTupleVerified: candidateMatchesCurrentTuple,
        routingDeferred: disposition.routableSyncVerified,
      };
      if (routableSyncExpected && !published.routableSyncVerified) {
        throw new RoutableSyncPublishRaceError(
          `Durable review sync for ${paths.targetSlug}#${options.itemNumber} lost the publish race; requeue against the latest item revision`,
        );
      }
      if (terminalMissingExpected && !published.terminalMissing) {
        throw new TerminalMissingPublishRaceError(
          `Verified missing item ${paths.targetSlug}#${options.itemNumber} lost the publish race; requeue against the latest item revision`,
        );
      }
      if (terminalClosedExpected && !published.terminalClosed) {
        throw new TerminalClosedPublishRaceError(
          `Verified terminal close for ${paths.targetSlug}#${options.itemNumber} lost the publish race; requeue against the latest item revision`,
        );
      }
      if (requeueLatestExpected && !published.requeueLatest) {
        throw new SourceDriftPublishRaceError(
          `Verified source drift for ${paths.targetSlug}#${options.itemNumber} lost the publish race; requeue against the latest item revision`,
        );
      }
      if (
        guardedOpenAction !== null &&
        !published.terminalClosed &&
        !published.terminalMissing &&
        published.guardedOpenAction === null
      ) {
        throw new GuardedOpenPublishRaceError(
          `Deterministic remain-open guard for ${paths.targetSlug}#${options.itemNumber} lost the publish race; requeue against the latest item revision`,
        );
      }
      summary();
      return published;
    };
    hardResetToRemoteMain();
    const stateRoot = publishRoot();
    const snapshotResult = applyEventSnapshot(paths, stateRoot ? { remoteRoot: stateRoot } : {});
    if (snapshotResult === "remote-closed") {
      console.log(
        `Remote already has closed record for ${paths.targetSlug}#${options.itemNumber}; skipping open-record publish`,
      );
      return complete(false);
    }
    if (snapshotResult === "remote-newer") {
      console.log(
        `Remote has newer record tuple for ${paths.targetSlug}#${options.itemNumber}; skipping stale event publish`,
      );
      return complete(false);
    }
    if (snapshotResult === "missing") {
      console.log(`No event record snapshot for ${paths.targetSlug}#${options.itemNumber}`);
      return complete(false);
    }

    syncPublishPaths(commitPaths);
    stagePaths(commitPaths);
    if (!hasStagedChanges()) {
      console.log("No event result changes");
      return complete(true);
    }

    runGit([
      "commit",
      "-m",
      commitMessageForPublishedPaths(
        `chore: apply event sweep result for ${paths.targetSlug}#${options.itemNumber}`,
        commitPaths,
      ),
    ]);
    if (!pushCommit({ pushAttempts: 3, rebaseStrategy: "reconcile-records" })) return null;
    return complete(true);
  } catch (error) {
    if (
      error instanceof RecordTupleError ||
      error instanceof GuardedOpenPublishRaceError ||
      error instanceof RoutableSyncPublishRaceError ||
      error instanceof SourceDriftPublishRaceError ||
      error instanceof TerminalClosedPublishRaceError ||
      error instanceof TerminalMissingPublishRaceError
    )
      throw error;
    console.error(error instanceof Error ? error.message : String(error));
    return null;
  }
}

function candidateEventTupleState(paths: EventRecordPaths): "closed" | "open" | "invalid" {
  const hasOpenRecord = fs.existsSync(paths.snapshotItem);
  const hasClosedRecord = fs.existsSync(paths.snapshotClosed);
  if (hasClosedRecord && !hasOpenRecord) return "closed";
  if (hasOpenRecord && !hasClosedRecord) return "open";
  return "invalid";
}

function eventOptionsFromEnv(): EventOptions {
  return {
    targetRepo: envValue("TARGET_REPO"),
    itemNumber: envValue("ITEM_NUMBER"),
    closeReasons:
      process.env.CLOSE_REASONS ||
      "implemented_on_main,duplicate_or_superseded,low_signal_unmergeable_pr",
    minAgeMinutes: process.env.MIN_AGE_MINUTES || "0",
    reviewOnly: process.env.REVIEW_ONLY === "true",
    exactEventPublication: process.env.EXACT_EVENT_PUBLICATION === "true",
    reportPath: ".artifacts/event-apply-report.json",
    snapshotDir: ".artifacts/event-record-snapshot",
  };
}

function readApplyActions(reportPath: string): EventApplyAction[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${reportPath} must contain an array`);
  return parsed.map((entry) => {
    return eventApplyAction(isJsonObject(entry) ? entry : {});
  });
}

function writeSummary({
  targetRepo,
  itemNumber,
  syncedCount,
  closedCount,
  missingCount,
  closeReasons,
}: {
  targetRepo: string;
  itemNumber: string;
  syncedCount: number;
  closedCount: number;
  missingCount: number;
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
      `- Confirmed missing items: ${missingCount}`,
      `- Close reasons enabled: ${closeReasons}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

function writeEventDispositionOutputs(published: PublishedEventSnapshot): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  fs.appendFileSync(
    outputPath,
    [
      `remote_tuple_verified=${published.remoteTupleVerified ? "true" : "false"}`,
      `terminal_missing=${published.terminalMissing ? "true" : "false"}`,
      `terminal_closed=${published.terminalClosed ? "true" : "false"}`,
      `guarded_open=${published.guardedOpenAction === null ? "false" : "true"}`,
      `guarded_open_action=${published.guardedOpenAction ?? ""}`,
      `policy_noop=${published.policyNoop ? "true" : "false"}`,
      `requeue_latest=${published.requeueLatest ? "true" : "false"}`,
      `routing_deferred=${published.routingDeferred ? "true" : "false"}`,
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
