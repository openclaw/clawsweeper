#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  applyEventSnapshot,
  applyEventSnapshotIfCurrent,
  captureEventBaseSnapshot,
  captureEventSnapshot,
  eventRecordDirectories,
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
  exactEventRoutingDeferred,
  type EventApplyAction,
} from "./event-apply-proof.js";
import {
  captureStatePublishBaseline,
  configureGitUser,
  GitCommandTimeoutError,
  hardResetToRemoteMain,
  publishRoot,
  refreshSourceAfterStatePublish,
  runGit,
  setTokenOrigin,
} from "./git-publish.js";
import { isJsonObject } from "./json-types.js";
import { RecordTupleError } from "./record-tuple.js";
import {
  postDirectPublicationResult,
  prepareDirectPublicationPayload,
} from "./exact-review-direct-publication.js";
import {
  staleEventDisposition,
  staleEventDispositionOutputLines,
  type StaleEventDisposition,
} from "./stale-event-disposition.js";
import {
  prepareStateMutationPlan,
  type PreparedStateMutationPlan,
  type StateMutationIdentity,
  type StateMutationSourceOperation,
} from "./state-publication-mutation.js";

type EventOptions = {
  codeRoot: string;
  workRoot: string;
  targetRepo: string;
  itemNumber: string;
  closeReasons: string;
  minAgeMinutes: string;
  reviewOnly: boolean;
  exactEventPublication: boolean;
  artifactDir: string;
  reportPath: string;
  snapshotDir: string;
  batchMutationOutput: string | null;
};

type PublishedEventSnapshot = {
  completionKind: "published" | "superseded" | "deferred";
  reasonCode:
    | "publication_applied"
    | "remote_newer_tuple"
    | "remote_closed"
    | "close_coverage_deferred";
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
class PublicationResultError extends Error {
  constructor(
    readonly reasonCode:
      | "missing_record_tuple"
      | "tuple_protocol_invalid"
      | "policy_invariant"
      | "unknown_failure",
    message: string,
  ) {
    super(message);
  }
}

const options = eventOptionsFromEnv();
try {
  await publishEventResult(options);
} catch (error) {
  const retryableFailure = error instanceof GitCommandTimeoutError;
  const completionKind = retryableFailure ? "retryable_failure" : "permanent_failure";
  const reasonCode =
    error instanceof GitCommandTimeoutError
      ? "github_transient"
      : error instanceof PublicationResultError
        ? error.reasonCode
        : error instanceof RecordTupleError
          ? "tuple_protocol_invalid"
          : "unknown_failure";
  const fingerprint = errorFingerprint(error);
  if (options.batchMutationOutput) {
    writeBatchMutationResult(options.batchMutationOutput, {
      kind: completionKind,
      reasonCode,
      errorFingerprint: fingerprint,
    });
  }
  writePublicationCompletionOutputs(completionKind, reasonCode, fingerprint);
  throw error;
}

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
  const stateRoot = publishRoot();

  resetEventSnapshot(recordStore);
  const recordPaths = captureEventBaseSnapshot(
    recordStore,
    stateRoot ? { sourceRoot: stateRoot } : {},
  );
  fs.rmSync(options.reportPath, { force: true });

  runClawsweeper(options, [
    "apply-artifacts",
    "--target-repo",
    options.targetRepo,
    "--artifact-dir",
    options.artifactDir,
    "--skip-reconcile",
    "--skip-dashboard",
    "--replay-closed-artifacts",
    ...eventRecordDirectoryArgs(options, recordPaths),
  ]);

  // Preserve the exact artifact candidate before refreshing the state checkout.
  // A stale event must be rejected before apply-decisions can comment, label,
  // or close anything on GitHub.
  captureEventSnapshot(recordStore);
  hardResetToRemoteMain();
  const stateBaseCommit = captureStatePublishBaseline();
  const preflightResult = applyEventSnapshotIfCurrent(
    recordPaths,
    stateRoot ? { remoteRoot: stateRoot } : {},
    () => runApplyDecisions(options, recordPaths),
  );
  if (
    preflightResult === "remote-closed" ||
    preflightResult === "remote-newer" ||
    preflightResult === "missing"
  ) {
    const disposition = staleEventDisposition(preflightResult);
    console.log(
      `Skipping stale event apply for ${options.targetRepo}#${options.itemNumber}: ${disposition.detail}`,
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
    // A stale artifact can never publish: the state already advanced (or the
    // event carried no tuple). Failing here would requeue the same artifact
    // forever, so exit successfully with the terminal disposition instead —
    // `requeue_latest` hands remote-newer to the source-drift requeue step,
    // which reviews the LATEST revision.
    writeStaleEventDispositionOutputs(disposition);
    if (options.batchMutationOutput)
      writeBatchMutationResult(options.batchMutationOutput, {
        kind: "superseded",
        disposition: { requeueLatestExpected: disposition.requeueLatest },
      });
    if (preflightResult !== "missing") {
      writePublicationCompletionOutputs(
        "superseded",
        preflightResult === "remote-closed" ? "remote_closed" : "remote_newer_tuple",
      );
    }
    return;
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
    activeReviewLeaseRetryAt,
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
  const deferredCloseCoverageExpected = applyDisposition === "close_coverage_deferred";
  if (activeReviewLeaseRetryAt !== null) {
    console.log(
      `Deferring ${options.targetRepo}#${options.itemNumber}: active review lease remains active until ${activeReviewLeaseRetryAt}`,
    );
    writePublicationCompletionOutputs(
      "retryable_failure",
      "review_lease_active",
      undefined,
      activeReviewLeaseRetryAt,
    );
    return;
  }
  const deferredCloseCoverageEnabled = process.env.EXACT_REVIEW_CLOSE_COVERAGE_DEFERRED === "true";
  if (deferredCloseCoverageExpected) {
    console.log(
      `Deferring ${options.targetRepo}#${options.itemNumber}: PR close coverage proof must run in the read-only apply-proof lane`,
    );
    if (!deferredCloseCoverageEnabled) {
      writeLegacyRefreshRequiredOutputs();
      return;
    }
  }
  if (
    syncedCount + closedCount + missingCount === 0 &&
    guardedOpenAction === null &&
    !requeueLatestExpected &&
    !deferredCloseCoverageExpected
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
  if (options.batchMutationOutput) {
    const prepared = prepareBatchMutation({
      paths: recordPaths,
      options,
      stateBaseCommit,
      guardedOpenAction,
      requeueLatestExpected,
      routableSyncExpected,
      deferredCloseCoverageExpected,
      terminalClosedExpected: closedCount > 0,
      terminalMissingExpected: missingCount > 0,
    });
    writeBatchMutationResult(options.batchMutationOutput, prepared);
    summary();
    return;
  }
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const published = await publishSnapshot({
      paths: recordPaths,
      options,
      summary,
      guardedOpenAction,
      requeueLatestExpected,
      routableSyncExpected,
      deferredCloseCoverageExpected,
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
  const published = await publishSnapshot({
    paths: recordPaths,
    options,
    summary,
    guardedOpenAction,
    requeueLatestExpected,
    routableSyncExpected,
    deferredCloseCoverageExpected,
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

function prepareBatchMutation({
  paths,
  options,
  stateBaseCommit,
  guardedOpenAction,
  requeueLatestExpected,
  routableSyncExpected,
  deferredCloseCoverageExpected,
  terminalClosedExpected,
  terminalMissingExpected,
}: {
  paths: EventRecordPaths;
  options: EventOptions;
  stateBaseCommit: string | null;
  guardedOpenAction: string | null;
  requeueLatestExpected: boolean;
  routableSyncExpected: boolean;
  deferredCloseCoverageExpected: boolean;
  terminalClosedExpected: boolean;
  terminalMissingExpected: boolean;
}) {
  const stateRoot = publishRoot();
  if (!stateRoot) throw new Error("Batch mutation preparation requires an isolated state root");
  hardResetToRemoteMain();
  const snapshotResult = applyEventSnapshot(paths, { remoteRoot: stateRoot });
  if (snapshotResult === "remote-closed" || snapshotResult === "remote-newer") {
    return { kind: "superseded" as const };
  }
  if (snapshotResult === "missing") {
    throw new PublicationResultError(
      "missing_record_tuple",
      `No event record snapshot for ${paths.targetSlug}#${options.itemNumber}`,
    );
  }
  const plan = prepareTupleMutationPlan(
    paths,
    options.workRoot,
    {
      itemKey: envValue("EXACT_REVIEW_BATCH_ITEM_KEY"),
      revision: positiveEnvInteger("EXACT_REVIEW_BATCH_REVISION"),
      claimGeneration: positiveEnvInteger("EXACT_REVIEW_BATCH_CLAIM_GENERATION"),
    },
    "Batch",
  );
  // These expectations are emitted with the plan so the batch workflow can run
  // post-commit routing without re-running GitHub mutations.
  return {
    kind: "eligible" as const,
    plan,
    disposition: {
      stateBaseCommit,
      guardedOpenAction,
      requeueLatestExpected,
      routableSyncExpected,
      deferredCloseCoverageExpected,
      terminalClosedExpected,
      terminalMissingExpected,
    },
  };
}

function prepareTupleMutationPlan(
  paths: EventRecordPaths,
  contentRoot: string,
  identity: StateMutationIdentity,
  label: string,
): PreparedStateMutationPlan {
  const commitPaths = [
    paths.itemRecord,
    paths.closedRecord,
    paths.planRecord,
    paths.decisionPacket,
  ];
  const operations: StateMutationSourceOperation[] = [];
  for (const path of commitPaths) {
    const expectedOid = runGit(["rev-parse", "--verify", `HEAD:${path}`], {
      allowFailure: true,
      quiet: true,
    }).trim();
    const contentPath = join(contentRoot, path);
    if (!fs.existsSync(contentPath)) {
      if (expectedOid) operations.push({ path, expectedOid, delete: true });
      continue;
    }
    operations.push({
      path,
      expectedOid: expectedOid || null,
      content: fs.readFileSync(contentPath),
    });
  }
  if (!operations.length) {
    throw new Error(`${label} mutation for ${paths.targetSlug} is empty`);
  }
  return prepareStateMutationPlan({ identity, operations });
}

function runApplyDecisions(options: EventOptions, paths: EventRecordPaths): void {
  const args = [
    "apply-decisions",
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
    ...eventRecordDirectoryArgs(options, paths),
  ];
  runClawsweeper(options, args);
}

function eventRecordDirectoryArgs(options: EventOptions, paths: EventRecordPaths): string[] {
  const directories = eventRecordDirectories(paths, options.workRoot);
  return [
    "--record-root",
    options.workRoot,
    "--items-dir",
    directories.items,
    "--closed-dir",
    directories.closed,
    "--plans-dir",
    directories.plans,
    "--decision-packets-dir",
    directories.decisionPackets,
  ];
}

async function publishSnapshot({
  paths,
  options,
  summary,
  guardedOpenAction,
  requeueLatestExpected,
  routableSyncExpected,
  deferredCloseCoverageExpected,
  terminalClosedExpected,
  terminalMissingExpected,
}: {
  paths: EventRecordPaths;
  options: EventOptions;
  summary: () => void;
  guardedOpenAction: string | null;
  requeueLatestExpected: boolean;
  routableSyncExpected: boolean;
  deferredCloseCoverageExpected: boolean;
  terminalClosedExpected: boolean;
  terminalMissingExpected: boolean;
}): Promise<PublishedEventSnapshot | null> {
  const complete = (
    candidateApplied: boolean,
    supersededReason?: "remote_newer_tuple" | "remote_closed",
  ): PublishedEventSnapshot => {
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
    const completionSupersededReason =
      supersededReason ||
      (deferredCloseCoverageExpected && !candidateMatchesCurrentTuple
        ? ("remote_newer_tuple" as const)
        : undefined);
    const deferredCloseCoverage = !completionSupersededReason && deferredCloseCoverageExpected;
    const published = {
      ...disposition,
      completionKind: completionSupersededReason
        ? ("superseded" as const)
        : deferredCloseCoverage
          ? ("deferred" as const)
          : ("published" as const),
      reasonCode:
        completionSupersededReason ||
        (deferredCloseCoverage
          ? ("close_coverage_deferred" as const)
          : ("publication_applied" as const)),
      policyNoop: disposition.guardedOpenAction === "skipped_same_author_pair",
      requeueLatest:
        requeueLatestExpected && candidateMatchesCurrentTuple && candidateTupleState === "open",
      remoteTupleVerified: candidateMatchesCurrentTuple,
      routingDeferred:
        exactEventRoutingDeferred({
          candidateMatchesCurrentTuple,
          candidateTupleState,
          guardedOpenAction,
          requeueLatestExpected,
        }) && !deferredCloseCoverage,
    };
    if (completionSupersededReason) {
      summary();
      return published;
    }
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
  try {
    hardResetToRemoteMain();
    const stateRoot = publishRoot();
    const snapshotResult = applyEventSnapshot(paths, stateRoot ? { remoteRoot: stateRoot } : {});
    if (snapshotResult === "remote-closed") {
      console.log(
        `Remote already has closed record for ${paths.targetSlug}#${options.itemNumber}; skipping open-record publish`,
      );
      return complete(false, "remote_closed");
    }
    if (snapshotResult === "remote-newer") {
      console.log(
        `Remote has newer record tuple for ${paths.targetSlug}#${options.itemNumber}; skipping stale event publish`,
      );
      return complete(false, "remote_newer_tuple");
    }
    if (snapshotResult === "missing") {
      throw new PublicationResultError(
        "missing_record_tuple",
        `No event record snapshot for ${paths.targetSlug}#${options.itemNumber}`,
      );
    }

    const itemKey = envValue("EXACT_REVIEW_ITEM_KEY");
    const revision = positiveEnvInteger("EXACT_REVIEW_LEASE_REVISION");
    const plan = prepareTupleMutationPlan(
      paths,
      options.workRoot,
      {
        itemKey,
        revision,
        claimGeneration: positiveEnvInteger("EXACT_REVIEW_CLAIM_GENERATION"),
      },
      "Exact event",
    );
    const publication = await postDirectPublicationResult({
      baseUrl: envValue("EXACT_REVIEW_QUEUE_URL"),
      webhookSecret: envValue("CLAWSWEEPER_WEBHOOK_SECRET"),
      path: "/internal/exact-review/publication-batch-results",
      payload: prepareDirectPublicationPayload({
        itemKey,
        revision,
        plan,
        stateRoot: options.workRoot,
      }),
    });
    if (publication.kind === "fallback") {
      throw new Error(`Canonical exact-event publication failed: ${publication.reason}`);
    }
    if (publication.response.superseded === true) {
      return complete(false, "remote_newer_tuple");
    }
    return complete(true);
  } catch (error) {
    if (
      error instanceof GitCommandTimeoutError ||
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
  const workRoot = resolve(process.env.EXACT_REVIEW_WORK_ROOT || ".");
  return {
    codeRoot: resolve(process.env.CLAWSWEEPER_CODE_ROOT || process.env.GITHUB_WORKSPACE || "."),
    workRoot,
    targetRepo: envValue("TARGET_REPO"),
    itemNumber: envValue("ITEM_NUMBER"),
    closeReasons:
      process.env.CLOSE_REASONS ||
      "implemented_on_main,duplicate_or_superseded,low_signal_unmergeable_pr",
    minAgeMinutes: process.env.MIN_AGE_MINUTES || "0",
    reviewOnly: process.env.REVIEW_ONLY === "true",
    exactEventPublication: process.env.EXACT_EVENT_PUBLICATION === "true",
    artifactDir: join(workRoot, "artifacts/event"),
    reportPath: join(workRoot, ".artifacts/event-apply-report.json"),
    snapshotDir: join(workRoot, ".artifacts/event-record-snapshot"),
    batchMutationOutput: process.env.EXACT_REVIEW_BATCH_MUTATION_OUTPUT || null,
  };
}

function writeBatchMutationResult(path: string, result: unknown): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function positiveEnvInteger(name: string): number {
  const value = Number(envValue(name));
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
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

function writeStaleEventDispositionOutputs(disposition: StaleEventDisposition): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  fs.appendFileSync(
    outputPath,
    `${staleEventDispositionOutputLines(disposition).join("\n")}\n`,
    "utf8",
  );
}

function writeEventDispositionOutputs(published: PublishedEventSnapshot): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  fs.appendFileSync(
    outputPath,
    [
      `completion_kind=${published.completionKind}`,
      `reason_code=${published.reasonCode}`,
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

function writeLegacyRefreshRequiredOutputs(): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  fs.appendFileSync(
    outputPath,
    [
      "completion_kind=refresh_required",
      "reason_code=close_coverage_retry",
      "remote_tuple_verified=false",
      "terminal_missing=false",
      "terminal_closed=false",
      "guarded_open=false",
      "policy_noop=false",
      "requeue_latest=false",
      "routing_deferred=false",
      "",
    ].join("\n"),
    "utf8",
  );
}

function writePublicationCompletionOutputs(
  completionKind: "superseded" | "deferred" | "retryable_failure" | "permanent_failure",
  reasonCode:
    | "remote_newer_tuple"
    | "remote_closed"
    | "close_coverage_deferred"
    | "github_transient"
    | "state_contention"
    | "review_lease_active"
    | "missing_record_tuple"
    | "tuple_protocol_invalid"
    | "policy_invariant"
    | "unknown_failure",
  fingerprint?: string,
  retryAt?: string,
): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  fs.appendFileSync(
    outputPath,
    [
      `completion_kind=${completionKind}`,
      `reason_code=${reasonCode}`,
      ...(fingerprint ? [`error_fingerprint=${fingerprint}`] : []),
      ...(retryAt ? [`retry_at=${retryAt}`] : []),
      "",
    ].join("\n"),
    "utf8",
  );
}

function errorFingerprint(error: unknown): string {
  const message = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  return `sha256:${createHash("sha256").update(message).digest("hex")}`;
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

function runClawsweeper(options: EventOptions, args: readonly string[]): void {
  const cli = join(options.codeRoot, "dist/clawsweeper.js");
  const child = spawnSync(process.execPath, [cli, ...args], {
    cwd: options.workRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (child.status !== 0) {
    throw new Error(`${process.execPath} ${cli} ${args.join(" ")} exited ${child.status}`);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
