#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  type ActionEventReasonCode,
  type ActionEventStatus,
} from "../action-ledger.js";
import { recordWorkflowPhaseEvent } from "../action-ledger-runtime.js";
import {
  executionReportEvidence,
  prepareExecutionReportProbe,
  type ExecuteFixMutationEvidence,
} from "./execute-fix-report.js";
import { parseJob, repoRoot, type ParsedJob } from "./lib.js";

type ExecuteResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

type ExecuteFixAttemptDependencies = {
  root?: string;
  env?: NodeJS.ProcessEnv;
  executorPath?: string;
  loadJob?: (filePath: string) => ParsedJob;
  loadExecutionReport?: () => unknown;
  recordPhaseEvent?: typeof recordWorkflowPhaseEvent;
  execute?: (
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      stdio: "inherit";
    },
  ) => ExecuteResult;
};

export type ExecuteFixAttemptResult = {
  exitCode: number;
  signal: NodeJS.Signals | null;
};

export function runExecuteFixAttempt(
  argv: readonly string[],
  dependencies: ExecuteFixAttemptDependencies = {},
): ExecuteFixAttemptResult {
  const jobPath = argv[0];
  if (!jobPath) throw new Error("execute-fix attempt requires a job path");

  const root = dependencies.root ?? repoRoot();
  const env = dependencies.env ?? process.env;
  const job = (dependencies.loadJob ?? parseJob)(jobPath);
  const identity = executeFixIdentity(job);
  const recordPhaseEvent = dependencies.recordPhaseEvent ?? recordWorkflowPhaseEvent;
  const workflowStart = recordPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.workflowAttempt,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { state: "started", jobSha256: identity.jobSha256 },
      operation: "repair",
      operationIdentity: identity.operation,
      phaseSeq: 1,
      component: "repair_execute_attempt",
      subject: identity.subject,
      attributes: {
        state: "started",
        completion_reason: "workflow_started",
        workflow_phase: "execute_fix",
      },
    },
    { env },
  );
  if (!workflowStart) {
    throw new Error("execute-fix attempt requires an enabled action ledger");
  }

  const mutationStart = recordPhaseEvent(
    root,
    {
      phase: ACTION_EVENT_TYPES.repairExecute,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: true,
      mutation: false,
      identity: { state: "mutation_attempted", jobSha256: identity.jobSha256 },
      operation: "repair",
      operationIdentity: identity.operation,
      parentEventId: workflowStart.event_id,
      phaseSeq: 2,
      idempotencyIdentity: identity.mutation,
      component: "repair_execute_attempt",
      subject: identity.subject,
      attributes: {
        state: "mutation_attempted",
        completion_reason: "mutation_attempted",
        workflow_phase: "execute_fix",
      },
    },
    { env },
  );
  if (!mutationStart) {
    throw new Error("execute-fix mutation start was not recorded");
  }

  const reportProbe = dependencies.loadExecutionReport
    ? { read: dependencies.loadExecutionReport }
    : prepareExecutionReportProbe(argv, root);
  const executorPath =
    dependencies.executorPath ?? path.join(repoRoot(), "dist", "repair", "execute-fix-artifact.js");
  const execute =
    dependencies.execute ??
    ((command, args, options) => {
      const result = spawnSync(command, args, options);
      return {
        status: result.status,
        signal: result.signal,
        ...(result.error ? { error: result.error } : {}),
      };
    });
  const result = execute(process.execPath, [executorPath, ...argv], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  const disposition = executeFixDisposition(
    result,
    executionReportEvidence(reportProbe.read(), job),
  );

  try {
    const mutationOutcome = recordPhaseEvent(
      root,
      {
        phase: ACTION_EVENT_TYPES.repairExecute,
        status: disposition.mutationStatus,
        reasonCode: disposition.reasonCode,
        retryable: disposition.retryable,
        mutation: disposition.mutation,
        identity: {
          state: disposition.completionReason,
          exitCode: disposition.exitCode,
          signal: result.signal ?? "none",
        },
        operation: "repair",
        operationIdentity: identity.operation,
        parentEventId: mutationStart.event_id,
        phaseSeq: 3,
        idempotencyIdentity: identity.mutation,
        component: "repair_execute_attempt",
        subject: identity.subject,
        attributes: {
          state: disposition.completionReason,
          completion_reason: disposition.completionReason,
          workflow_phase: "execute_fix",
        },
      },
      { env },
    );
    if (!mutationOutcome) throw new Error("execute-fix mutation outcome was not recorded");

    recordPhaseEvent(
      root,
      {
        phase: ACTION_EVENT_TYPES.workflowAttempt,
        status: disposition.workflowStatus,
        reasonCode: disposition.reasonCode,
        retryable: disposition.retryable,
        mutation: disposition.mutation,
        identity: {
          state: disposition.workflowCompletionReason,
          exitCode: disposition.exitCode,
          signal: result.signal ?? "none",
        },
        operation: "repair",
        operationIdentity: identity.operation,
        parentEventId: mutationOutcome.event_id,
        phaseSeq: 4,
        ...(disposition.mutation
          ? {
              idempotencyIdentity: {
                operation: identity.operation,
                slot: "execute_fix_workflow_terminal",
              },
            }
          : {}),
        component: "repair_execute_attempt",
        subject: identity.subject,
        attributes: {
          state: disposition.workflowCompletionReason,
          completion_reason: disposition.workflowCompletionReason,
          workflow_phase: "execute_fix",
        },
      },
      { env },
    );
  } catch (error) {
    console.error(
      `[action-ledger] failed to record execute-fix terminal receipts: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return {
    exitCode: disposition.exitCode,
    signal: result.signal,
  };
}

function executeFixIdentity(job: ParsedJob) {
  const repository = String(job.frontmatter.repo ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9_][a-z0-9_.-]*\/[a-z0-9_][a-z0-9_.-]*$/.test(repository)) {
    throw new Error("execute-fix job repository is invalid");
  }
  const clusterId = String(job.frontmatter.cluster_id ?? "").trim();
  if (!clusterId) throw new Error("execute-fix job cluster id is required");
  const jobIdentity = job.relativePath.replaceAll(path.sep, "/");
  if (
    jobIdentity.length > 256 ||
    !/^jobs\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./@+-]+$/.test(jobIdentity) ||
    jobIdentity.split("/").includes("..")
  ) {
    throw new Error("execute-fix public job identity is invalid");
  }
  const jobSha256 = createHash("sha256").update(job.raw).digest("hex");
  const operation = {
    repository,
    job: jobIdentity,
    jobSha256,
    clusterId,
  };
  return {
    jobSha256,
    operation,
    mutation: {
      operation,
      slot: "execute_fix_command",
    },
    subject: {
      repository,
      kind: "cluster" as const,
      subjectId: jobIdentity,
      clusterId,
    },
  };
}

function executeFixDisposition(
  result: ExecuteResult,
  evidence: ExecuteFixMutationEvidence,
): {
  exitCode: number;
  mutationStatus: ActionEventStatus;
  workflowStatus: ActionEventStatus;
  reasonCode: ActionEventReasonCode;
  retryable: boolean;
  mutation: boolean;
  completionReason: string;
  workflowCompletionReason: string;
} {
  if (result.error) {
    return {
      exitCode: 1,
      mutationStatus: ACTION_EVENT_STATUSES.skipped,
      workflowStatus: ACTION_EVENT_STATUSES.failed,
      reasonCode: ACTION_EVENT_REASON_CODES.unavailable,
      retryable: true,
      mutation: false,
      completionReason: "mutation_rejected",
      workflowCompletionReason: "workflow_failed",
    };
  }
  const exitCode = result.status ?? signalExitCode(result.signal);
  const cancelled =
    result.signal === "SIGINT" ||
    result.signal === "SIGTERM" ||
    exitCode === 130 ||
    exitCode === 143;
  const timedOut =
    !cancelled && (result.signal === "SIGKILL" || exitCode === 124 || exitCode === 137);
  const commandSucceeded = result.status === 0;
  const workflowStatus = commandSucceeded
    ? ACTION_EVENT_STATUSES.completed
    : cancelled
      ? ACTION_EVENT_STATUSES.cancelled
      : ACTION_EVENT_STATUSES.failed;
  const workflowReasonCode = commandSucceeded
    ? ACTION_EVENT_REASON_CODES.completed
    : cancelled
      ? ACTION_EVENT_REASON_CODES.cancelled
      : timedOut
        ? ACTION_EVENT_REASON_CODES.timeout
        : ACTION_EVENT_REASON_CODES.exception;

  if (evidence.outcome === "observed") {
    return {
      exitCode,
      mutationStatus: ACTION_EVENT_STATUSES.executed,
      workflowStatus,
      reasonCode: commandSucceeded ? evidence.reasonCode : workflowReasonCode,
      retryable: evidence.retryable,
      mutation: true,
      completionReason: "mutation_observed",
      workflowCompletionReason: commandSucceeded ? "workflow_completed" : "mutation_observed",
    };
  }
  if (evidence.outcome === "rejected") {
    return {
      exitCode,
      mutationStatus: ACTION_EVENT_STATUSES.skipped,
      workflowStatus,
      reasonCode: commandSucceeded ? evidence.reasonCode : workflowReasonCode,
      retryable: false,
      mutation: false,
      completionReason: "mutation_rejected",
      workflowCompletionReason: commandSucceeded ? "workflow_completed" : "workflow_failed",
    };
  }
  return {
    exitCode,
    mutationStatus: commandSucceeded
      ? ACTION_EVENT_STATUSES.failed
      : cancelled
        ? ACTION_EVENT_STATUSES.cancelled
        : ACTION_EVENT_STATUSES.failed,
    workflowStatus: commandSucceeded ? ACTION_EVENT_STATUSES.failed : workflowStatus,
    reasonCode: commandSucceeded ? evidence.reasonCode : workflowReasonCode,
    retryable: commandSucceeded || evidence.retryable,
    mutation: true,
    completionReason: "mutation_outcome_unknown",
    workflowCompletionReason: "mutation_outcome_unknown",
  };
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGKILL") return 137;
  if (signal === "SIGTERM") return 143;
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runExecuteFixAttempt(process.argv.slice(2));
    if (result.signal) {
      process.kill(process.pid, result.signal);
    } else {
      process.exitCode = result.exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
