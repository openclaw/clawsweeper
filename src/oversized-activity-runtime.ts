import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { recordOrEmpty, stringOrEmpty } from "./value-coerce.js";
import {
  captureOversizedActivity,
  oversizedActivityBlock,
  parseOversizedActivityEvidence,
  parseOversizedActivityReference,
  type OversizedActivityContext,
  type OversizedActivityReference,
} from "./oversized-activity-contract.js";
import {
  isOversizedCommentWrite,
  ownedCommentWriteIntent,
  ownedCommentWriteResult,
} from "./oversized-activity-write.js";

const wait = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function oversizedActivityContextFromEnv(): OversizedActivityContext | null {
  try {
    const value = JSON.parse(process.env.CLAWSWEEPER_OVERSIZED_ACTIVITY_CONTEXT || "null");
    const v = recordOrEmpty(value),
      o = recordOrEmpty(v.owner);
    const reference = parseOversizedActivityReference(v.reference);
    const url = new URL(String(v.queueUrl));
    if (
      !reference ||
      !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
      typeof o.itemKey !== "string" ||
      typeof o.leaseId !== "string" ||
      typeof o.runId !== "string" ||
      !/^[1-9]\d{0,29}$/.test(o.runId) ||
      !Number.isSafeInteger(o.runAttempt) ||
      Number(o.runAttempt) < 1 ||
      !Number.isSafeInteger(o.claimGeneration) ||
      Number(o.claimGeneration) < 1 ||
      (v.failurePath !== undefined && (typeof v.failurePath !== "string" || !v.failurePath))
    )
      return null;
    return { ...v, reference } as unknown as OversizedActivityContext;
  } catch {
    return null;
  }
}
class OversizedPublicationOwnershipError extends Error {}
function failurePath(context: OversizedActivityContext): string {
  return (
    context.failurePath ||
    join(
      process.env.RUNNER_TEMP || process.cwd(),
      ".artifacts",
      `oversized-activity-${context.reference.epoch}-${context.owner.runId}-${context.owner.runAttempt}-${context.owner.claimGeneration}.json`,
    )
  );
}
export function oversizedActivityFailed(context = oversizedActivityContextFromEnv()): boolean {
  return Boolean(context && existsSync(failurePath(context)));
}
function recordEvidenceFailure(context: OversizedActivityContext, ownershipLost = false): void {
  const path = failurePath(context);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    try {
      ownershipLost ||= JSON.parse(readFileSync(path, "utf8")).ownershipLost === true;
    } catch {
      /* Presence already disables closing. */
    }
  }
  writeFileSync(path, JSON.stringify({ version: 1, ownershipLost }), "utf8");
  console.warn("[oversized] queue write evidence unavailable; closing disabled for this publisher");
}
function requireRemainingOwnership(context: OversizedActivityContext): void {
  if (!oversizedActivityFailed(context)) return;
  try {
    if (JSON.parse(readFileSync(failurePath(context), "utf8")).ownershipLost === true)
      throw new OversizedPublicationOwnershipError(
        "queue publication ownership is no longer current",
      );
  } catch (error) {
    if (error instanceof OversizedPublicationOwnershipError) throw error;
    // An unreadable marker still disables closing; existing comment guards remain in force.
  }
}

function activityRequest(
  context: OversizedActivityContext,
  operation: string,
  receipt?: unknown,
): Record<string, unknown> {
  const response = spawnSync(
    "curl",
    [
      "--silent",
      "--show-error",
      "--connect-timeout",
      "5",
      "--max-time",
      "20",
      "--request",
      "POST",
      "--header",
      "content-type: application/json",
      "--data-binary",
      "@-",
      "--write-out",
      "\n%{http_code}",
      `${context.queueUrl.replace(/\/$/, "")}/internal/exact-review/oversized-activity`,
    ],
    {
      input: JSON.stringify({
        reference: context.reference,
        owner: context.owner,
        operation,
        ...(receipt ? { receipt } : {}),
      }),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (response.status !== 0) throw new Error("queue activity evidence transport unavailable");
  const split = response.stdout.lastIndexOf("\n");
  const status = Number(response.stdout.slice(split + 1));
  if (status === 404 && operation === "read") return { evidence: null };
  if (status !== 200) throw new Error(`queue activity evidence request refused (${status})`);
  return recordOrEmpty(JSON.parse(response.stdout.slice(0, split)));
}

/** Opt-in transport journal. Every successful request has a durable pre-write intent. */
export function observeOversizedCommentWrite(
  args: string[],
  invoke: (args: string[]) => string,
  input?: string,
  requestEvidence: typeof activityRequest = activityRequest,
): string {
  const context = oversizedActivityContextFromEnv();
  const offset = args[0] === "--repo" ? 2 : 0;
  if (!context || args[offset] !== "api") return invoke(args);
  const methodIndex = args.findIndex((v) => v === "--method" || v === "-X");
  const bodyIndex = args.findIndex((v) => v === "--input");
  const fields = args.flatMap((v, i) =>
    ["-f", "--raw-field", "-F", "--field"].includes(v) ? [args[i + 1] ?? ""] : [],
  );
  const method =
    methodIndex >= 0
      ? String(args[methodIndex + 1]).toUpperCase()
      : bodyIndex >= 0 || fields.length
        ? "POST"
        : "GET";
  const path = String(args[offset + 1] || "");
  let body: unknown;
  if (bodyIndex >= 0)
    body = JSON.parse(
      args[bodyIndex + 1] === "-" ? input || "null" : readFileSync(args[bodyIndex + 1]!, "utf8"),
    );
  else
    body = Object.fromEntries(
      fields.map((f) => [f.slice(0, f.indexOf("=")), f.slice(f.indexOf("=") + 1)]),
    );
  const request = { path, method, body };
  if (!isOversizedCommentWrite(request, context.reference)) return invoke(args);
  const read = (path: string) => JSON.parse(invoke(["api", path.replace(/^\//, "")]) || "null");
  requireRemainingOwnership(context);
  if (oversizedActivityFailed(context)) return invoke(args);
  let intent: ReturnType<typeof ownedCommentWriteIntent>;
  let beforePull: Record<string, unknown>;
  const pullPath = `repos/${context.reference.repo}/pulls/${context.reference.number}`;
  try {
    const before = method === "POST" ? null : read(path);
    intent = ownedCommentWriteIntent(request, before);
    beforePull = recordOrEmpty(read(pullPath));
    const begun = requestEvidence(context, "begin", intent);
    if (begun.authority_current === false)
      throw new OversizedPublicationOwnershipError(
        "queue publication ownership is no longer current",
      );
    if (begun.recorded !== true) throw new Error("queue write intent was not persisted");
  } catch (error) {
    recordEvidenceFailure(context, error instanceof OversizedPublicationOwnershipError);
    if (error instanceof OversizedPublicationOwnershipError) throw error;
    return invoke(args);
  }
  let result: string;
  try {
    result = invoke(args);
  } catch (error) {
    recordEvidenceFailure(context);
    throw error;
  }
  try {
    const parsed = method === "DELETE" ? null : JSON.parse(result || "null");
    const expectedTime = Date.parse(stringOrEmpty(recordOrEmpty(parsed).updated_at));
    const expectedCount =
      Number(beforePull.comments) + (method === "POST" ? 1 : method === "DELETE" ? -1 : 0);
    if (method === "DELETE") wait(1100);
    let pull: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 9; attempt++) {
      pull = recordOrEmpty(read(pullPath));
      if (
        Number(pull.comments) === expectedCount &&
        (!Number.isFinite(expectedTime) || Date.parse(String(pull.updated_at)) >= expectedTime)
      )
        break;
      wait(250);
    }
    const completed = requestEvidence(
      context,
      "complete",
      ownedCommentWriteResult(intent, parsed, pull),
    );
    if (completed.authority_current === false)
      throw new OversizedPublicationOwnershipError(
        "queue publication ownership is no longer current",
      );
    if (completed.recorded !== true) throw new Error("owned write receipt was not persisted");
  } catch (error) {
    recordEvidenceFailure(context, error instanceof OversizedPublicationOwnershipError);
    if (error instanceof OversizedPublicationOwnershipError) throw error;
  }
  return result;
}

export function createQueueOwnedOversizedFreshnessGuard(options: {
  repo: string;
  number: number;
  reference: unknown;
  ghJson: <T>(args: string[]) => T;
}) {
  let closed = false;
  const ref = parseOversizedActivityReference(options.reference, options.repo, options.number);
  const context = oversizedActivityContextFromEnv();
  const matches = Boolean(
    ref &&
    context &&
    ref.epoch === context.reference.epoch &&
    ref.repo.toLowerCase() === context.reference.repo.toLowerCase() &&
    ref.number === context.reference.number,
  );
  const check = (_generation?: number, _force?: boolean): string | null => {
    if (closed) return null;
    if (oversizedActivityFailed(context))
      return "queue-owned write evidence was unavailable in this publisher";
    if (!matches || !context) return "missing, malformed, or stale queue-owned activity evidence";
    try {
      const evidence = parseOversizedActivityEvidence(activityRequest(context, "read").evidence);
      if (
        !evidence ||
        evidence.reference.epoch !== ref!.epoch ||
        !evidence.baseline ||
        evidence.invalid
      )
        return evidence?.invalid || "missing or invalid queue-owned activity evidence";
      const latest = Math.max(
        Date.parse(evidence.baseline.source.updatedAt),
        ...evidence.receipts.map((r) =>
          Date.parse(
            r.after?.updatedAt || r.pullAfter?.updatedAt || evidence.baseline!.source.updatedAt,
          ),
        ),
      );
      for (let attempt = 0; attempt < 9; attempt++) {
        const pull = recordOrEmpty(
          options.ghJson(["api", `repos/${options.repo}/pulls/${options.number}`]),
        );
        if (Date.parse(String(pull.updated_at)) >= latest) break;
        if (attempt === 8) return "owned writes did not settle before finalization deadline";
        wait(250);
      }
      const capture = captureOversizedActivity(
        options.repo,
        options.number,
        new Date().toISOString(),
      );
      let next = capture.next();
      while (next.done !== true) next = capture.next(options.ghJson(["api", next.value]));
      const block = oversizedActivityBlock(evidence, next.value);
      if (block) return block;
      // The fence must still belong to this publisher after the metadata reads.
      const finalEvidence = parseOversizedActivityEvidence(
        activityRequest(context, "read").evidence,
      );
      return finalEvidence && JSON.stringify(finalEvidence) === JSON.stringify(evidence)
        ? null
        : "queue evidence or publication ownership changed during finalization";
    } catch (error) {
      return `oversized PR queue revalidation failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  return {
    check,
    markClosed() {
      closed = true;
    },
    recordOwnComment(_comment: Record<string, unknown>) {},
    receipt(): OversizedActivityReference | null {
      return ref;
    },
  };
}
