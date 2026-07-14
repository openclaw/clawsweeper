import fs from "node:fs";
import path from "node:path";

import { ACTION_EVENT_REASON_CODES, type ActionEventReasonCode } from "../action-ledger.js";
import { parseArgs, type ParsedJob } from "./lib.js";

export type ExecuteFixMutationEvidence =
  | { outcome: "observed"; reasonCode: ActionEventReasonCode; retryable: boolean }
  | { outcome: "rejected"; reasonCode: ActionEventReasonCode; retryable: false }
  | { outcome: "unknown"; reasonCode: ActionEventReasonCode; retryable: boolean };

export function executionReportEvidence(
  value: unknown,
  job: ParsedJob,
): ExecuteFixMutationEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      outcome: "unknown",
      reasonCode: ACTION_EVENT_REASON_CODES.unavailable,
      retryable: false,
    };
  }
  const report = value as Record<string, unknown>;
  if (
    report.repo !== job.frontmatter.repo ||
    report.cluster_id !== job.frontmatter.cluster_id ||
    !Array.isArray(report.actions)
  ) {
    return {
      outcome: "unknown",
      reasonCode: ACTION_EVENT_REASON_CODES.unavailable,
      retryable: false,
    };
  }
  if (report.dry_run === true) {
    return {
      outcome: "rejected",
      reasonCode: ACTION_EVENT_REASON_CODES.dryRun,
      retryable: false,
    };
  }
  const retryable =
    report.requeue_required === true ||
    report.actions.some(
      (value) =>
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).requeue_required === true,
    );
  const observed = report.actions.some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const action = value as Record<string, unknown>;
    return (
      (action.action === "repair_contributor_branch" && action.status === "pushed") ||
      (action.action === "open_fix_pr" && action.status === "opened")
    );
  });
  if (observed) {
    return {
      outcome: "observed",
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      retryable,
    };
  }
  return {
    outcome: "unknown",
    reasonCode: ACTION_EVENT_REASON_CODES.unavailable,
    retryable,
  };
}

export function prepareExecutionReportProbe(
  argv: readonly string[],
  root: string,
): {
  read: () => unknown;
} {
  try {
    const args = parseArgs([...argv]);
    const resultPath = resolveExecutionResultPath(args, root);
    const reportPath =
      typeof args.report === "string"
        ? path.resolve(root, args.report)
        : path.join(path.dirname(resultPath), "fix-execution-report.json");
    const before = fileVersion(reportPath);
    return {
      read() {
        const after = fileVersion(reportPath);
        if (!after || sameFileVersion(before, after)) return null;
        try {
          return JSON.parse(fs.readFileSync(reportPath, "utf8"));
        } catch {
          return null;
        }
      },
    };
  } catch {
    return { read: () => null };
  }
}

function resolveExecutionResultPath(args: ReturnType<typeof parseArgs>, root: string): string {
  const explicit = args._[1];
  if (explicit) return path.resolve(root, explicit);
  if (!args.latest) throw new Error("result path is required unless --latest is set");

  const runsRoot = path.join(root, ".clawsweeper-repair", "runs");
  const candidates = fs
    .readdirSync(runsRoot)
    .map((runName) => path.join(runsRoot, runName, "result.json"))
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => ({ path: candidate, mtimeMs: fs.statSync(candidate).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (!candidates[0]) throw new Error("no result.json files found");
  return candidates[0].path;
}

type FileVersion = {
  ctimeNs: bigint;
  mtimeNs: bigint;
  size: bigint;
};

function fileVersion(filePath: string): FileVersion | null {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return {
      ctimeNs: stat.ctimeNs,
      mtimeNs: stat.mtimeNs,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

function sameFileVersion(left: FileVersion | null, right: FileVersion): boolean {
  return (
    left !== null &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.size === right.size
  );
}
