#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import {
  assertReportPublicationPolicy,
  decisionPublicationPolicy,
  reportPublicationPolicy,
} from "../manual-publication-policy.js";
import {
  assertManualPublicationAuthority,
  manualPublicationOwnerFromEnv,
  ManualPublicationAuthorityTransportError,
  manualPublicationAuthorityTransportErrorFromStderr,
} from "../manual-publication-authority.js";
import { errorFingerprint } from "./error-fingerprint.js";
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
import { isJsonObject } from "./json-types.js";
import { RecordTupleError } from "./record-tuple.js";
import { GitHubRateLimitError, ghRetryKind } from "../github-retry.js";
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
      | "state_contention"
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
  const reasonCode =
    error instanceof ManualPublicationAuthorityTransportError
      ? "state_contention"
      : error instanceof GitHubRateLimitError
        ? "github_rate_limit"
        : ghRetryKind(error) === "transient"
          ? "github_transient"
          : error instanceof PublicationResultError
            ? error.reasonCode
            : error instanceof RecordTupleError
              ? "tuple_protocol_invalid"
              : "unknown_failure";
  const completionKind = ["state_contention", "github_rate_limit", "github_transient"].includes(
    reasonCode,
  )
    ? "retryable_failure"
    : "permanent_failure";
  const fingerprint = errorFingerprint(error);
  if (options.batchMutationOutput) {
    writeBatchMutationResult(options.batchMutationOutput, {
      kind: completionKind,
      reasonCode,
      errorFingerprint: fingerprint,
      ...(error instanceof GitHubRateLimitError
        ? {
            retryAt: error.retryAt,
            rateLimitScope: error.scope,
            rateLimitProvenance: error.provenance,
            rateLimitAuthoritative: error.authoritative,
            attempted: true,
          }
        : {}),
    });
  }
  writePublicationCompletionOutputs(
    completionKind,
    reasonCode,
    fingerprint,
    error instanceof GitHubRateLimitError ? error.retryAt : undefined,
  );
  throw error;
}

async function publishEventResult(options: EventOptions): Promise<void> {
  validateTargetRepo(options.targetRepo);
  validateItemNumber(options.itemNumber);
  const artifact = join(options.artifactDir, `${options.itemNumber}.md`);
  const claimedPolicy = process.env.EXACT_REVIEW_DECISION
    ? decisionPublicationPolicy(JSON.parse(process.env.EXACT_REVIEW_DECISION))
    : undefined;
  if (!fs.existsSync(artifact)) {
    // Hydrated canonical state is a base, never a newly produced review.
    if (claimedPolicy)
      throw new PublicationResultError(
        "missing_record_tuple",
        "Manual publication report is absent",
      );
    fs.rmSync(options.reportPath, { force: true });
    writeSummary({
      targetRepo: options.targetRepo,
      itemNumber: options.itemNumber,
      syncedCount: 0,
      closedCount: 0,
      missingCount: 0,
      closeReasons: options.closeReasons,
    });
    writeStaleEventDispositionOutputs(staleEventDisposition("missing"));
    if (options.batchMutationOutput)
      writeBatchMutationResult(options.batchMutationOutput, {
        kind: "superseded",
        disposition: { requeueLatestExpected: false },
      });
    return;
  }
  const markdown = fs.readFileSync(artifact, "utf8");
  const policy = reportPublicationPolicy(markdown);
  if (process.env.EXACT_REVIEW_DECISION) assertReportPublicationPolicy(markdown, claimedPolicy);
  if (policy) {
    const allowedArtifacts = new Set([`${options.itemNumber}.md`, "review-cache-metrics.json"]);
    if (
      fs
        .readdirSync(options.artifactDir, { withFileTypes: true })
        .some((entry) => !entry.isFile() || !allowedArtifacts.has(entry.name))
    )
      throw new Error(
        "manual publication artifact directory must contain only the selected report and review cache metadata",
      );
    assertManualPublicationAuthority(markdown, options.targetRepo, Number(options.itemNumber));
    options.reviewOnly = true;
  }
  // Snapshot helpers use relative record paths, not the caller's code directory.
  process.chdir(options.workRoot);
  const recordStore = {
    targetRepo: options.targetRepo,
    itemNumber: options.itemNumber,
    snapshotDir: options.snapshotDir,
  };
  resetEventSnapshot(recordStore);
  const recordPaths = captureEventBaseSnapshot(recordStore, { sourceRoot: options.workRoot });
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
  const preflightResult = applyEventSnapshotIfCurrent(
    recordPaths,
    { remoteRoot: options.workRoot },
    () => runApplyDecisions(options, recordPaths),
  );
  if (
    preflightResult === "remote-closed" ||
    preflightResult === "remote-newer" ||
    preflightResult === "missing"
  ) {
    const disposition = {
      ...staleEventDisposition(preflightResult),
      ...(policy ? { requeueLatest: false } : {}),
    };
    console.log(
      `Skipping stale event apply for ${options.targetRepo}#${options.itemNumber}: ${disposition.detail}`,
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
  if (policy && requeueLatestExpected) {
    if (options.batchMutationOutput)
      writeBatchMutationResult(options.batchMutationOutput, {
        kind: "superseded",
        disposition: { requeueLatestExpected: false },
      });
    writePublicationCompletionOutputs("superseded", "remote_newer_tuple");
    return;
  }
  const rateLimitYield = exactActions.find(
    (action) =>
      action.action === "skipped_runtime_budget" &&
      /GitHub(?: API)? rate limited until/i.test(action.reason),
  );
  if (rateLimitYield) {
    throw new GitHubRateLimitError(new Error(rateLimitYield.reason));
  }
  if (options.exactEventPublication && legacyTuplelessReviewLease) {
    console.log(
      `Requeueing ${options.targetRepo}#${options.itemNumber}: legacy exact artifact lacks its durable review lease tuple`,
    );
  }
  const deferredCloseCoverageExpected = applyDisposition === "close_coverage_deferred";
  if (applyDisposition === "superseded") {
    console.log(
      `Skipping ${options.targetRepo}#${options.itemNumber}: a verified newer durable review tuple is already live`,
    );
    writeSummary({
      targetRepo: options.targetRepo,
      itemNumber: options.itemNumber,
      syncedCount: 0,
      closedCount: 0,
      missingCount: 0,
      closeReasons: options.closeReasons,
    });
    if (options.batchMutationOutput) {
      writeBatchMutationResult(options.batchMutationOutput, {
        kind: "superseded",
        disposition: { requeueLatestExpected: false },
      });
    }
    writePublicationCompletionOutputs("superseded", "remote_newer_tuple");
    return;
  }
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
    (applyDisposition === "unproven" && guardedOpenAction === null && !requeueLatestExpected) ||
    (syncedCount + closedCount + missingCount === 0 &&
      guardedOpenAction === null &&
      !requeueLatestExpected &&
      !deferredCloseCoverageExpected)
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
      stateBaseCommit: null,
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
  const snapshotResult = applyEventSnapshot(paths, { remoteRoot: options.workRoot });
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
    {
      canonicalTargetKey: `${options.targetRepo}#${options.itemNumber}`,
      fenceKey: envValue("EXACT_REVIEW_BATCH_ITEM_KEY"),
    },
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
  publication: PreparedStateMutationPlan["publication"] | undefined,
): PreparedStateMutationPlan {
  const commitPaths = [
    paths.itemRecord,
    paths.closedRecord,
    paths.planRecord,
    paths.decisionPacket,
  ];
  const operations: StateMutationSourceOperation[] = [];
  for (const path of commitPaths) {
    const contentPath = join(contentRoot, path);
    if (!fs.existsSync(contentPath)) {
      operations.push({ path, delete: true });
      continue;
    }
    operations.push({
      path,
      content: fs.readFileSync(contentPath),
    });
  }
  const plan = prepareStateMutationPlan({
    identity,
    ...(publication ? { publication } : {}),
    operations,
  });
  if (
    operations.some(
      (operation) =>
        "content" in operation &&
        operation.path === paths.itemRecord &&
        reportPublicationPolicy(String(operation.content)),
    )
  )
    plan.owner = manualPublicationOwnerFromEnv();
  return plan;
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
    "60",
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
}): Promise<PublishedEventSnapshot> {
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
    const snapshotResult = applyEventSnapshot(paths, { remoteRoot: options.workRoot });
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
      {
        canonicalTargetKey: `${options.targetRepo}#${options.itemNumber}`,
        fenceKey: itemKey,
      },
    );
    const publication = await postDirectPublicationResult({
      baseUrl: envValue("EXACT_REVIEW_QUEUE_URL"),
      webhookSecret: envValue("CLAWSWEEPER_WEBHOOK_SECRET"),
      path: "/internal/exact-review/publication-batch-results",
      payload: prepareDirectPublicationPayload({
        revision,
        plan,
      }),
    });
    if (publication.kind === "fallback") {
      throw new PublicationResultError(
        publication.status === undefined || publication.status === 429 || publication.status >= 500
          ? "state_contention"
          : "policy_invariant",
        `Canonical exact-event publication failed: ${publication.reason}`,
      );
    }
    if (publication.response.superseded === true) {
      return complete(false, "remote_newer_tuple");
    }
    return complete(true);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    throw error;
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
    closeReasons: process.env.CLOSE_REASONS || process.env.CLAWSWEEPER_AUTO_CLOSE_REASONS || "all",
    minAgeMinutes: process.env.MIN_AGE_MINUTES || "0",
    reviewOnly: process.env.REVIEW_ONLY === "true",
    exactEventPublication: process.env.EXACT_EVENT_PUBLICATION === "true",
    artifactDir: resolve(
      workRoot,
      process.env.EXACT_REVIEW_PUBLICATION_ARTIFACT_DIR || "artifacts/event",
    ),
    reportPath: join(workRoot, ".artifacts/event-apply-report.json"),
    snapshotDir: join(workRoot, ".artifacts/event-record-snapshot"),
    batchMutationOutput: process.env.EXACT_REVIEW_BATCH_MUTATION_OUTPUT
      ? resolve(workRoot, process.env.EXACT_REVIEW_BATCH_MUTATION_OUTPUT)
      : null,
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
    | "github_rate_limit"
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
      ...(reasonCode === "github_rate_limit" || reasonCode === "github_transient"
        ? [`failure_kind=${reasonCode}`]
        : []),
      ...(fingerprint ? [`error_fingerprint=${fingerprint}`] : []),
      ...(retryAt ? [`retry_at=${retryAt}`] : []),
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

function runClawsweeper(options: EventOptions, args: readonly string[]): void {
  const cli = join(options.codeRoot, "dist/clawsweeper.js");
  const child = spawnSync(process.execPath, [cli, ...args], {
    cwd: options.workRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["inherit", "inherit", "pipe"],
    env: process.env,
  });
  const stderr = child.stderr ?? "";
  if (stderr) process.stderr.write(stderr);
  if (child.error) throw Object.assign(child.error, { stderr });
  if (child.status !== 0) {
    const authorityError = manualPublicationAuthorityTransportErrorFromStderr(stderr);
    if (authorityError) throw authorityError;
    const error = Object.assign(
      new Error(`${process.execPath} ${cli} ${args.join(" ")} exited ${child.status}`),
      { stderr },
    );
    throw ghRetryKind(error) === "throttle" ? new GitHubRateLimitError(error) : error;
  }
}
