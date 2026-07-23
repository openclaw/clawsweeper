import type { LooseRecord } from "./json-types.js";

export const AUTOMERGE_POLICY_VERSION = "immediate-v1";
const DEFAULT_AUTOMERGE_METRIC_TIMEOUT_MS = 5_000;

export function automergeSessionId(activation: LooseRecord) {
  const repository = String(activation.repo ?? "").trim();
  const itemNumber = Number(activation.issue_number);
  const commentId = String(activation.comment_id ?? "").trim();
  const updatedAt = String(
    activation.comment_updated_at ?? activation.comment_created_at ?? "",
  ).trim();
  if (!repository || !Number.isInteger(itemNumber) || !commentId || !updatedAt) return null;
  return `${repository}#${itemNumber}:${commentId}:${updatedAt}`;
}

export function latestAutomergeActivationForCommand(
  command: LooseRecord,
  candidates: LooseRecord[],
) {
  const commandAt =
    Date.parse(String(command.comment_updated_at ?? command.comment_created_at ?? "")) ||
    Number.POSITIVE_INFINITY;
  const latestPriorStopAt = candidates.reduce((latest, entry) => {
    if (
      entry?.repo !== command.repo ||
      Number(entry?.issue_number) !== Number(command.issue_number)
    )
      return latest;
    if (entry?.intent !== "stop" || !["ready", "executed"].includes(String(entry?.status ?? "")))
      return latest;
    const stoppedAt =
      Date.parse(String(entry.comment_updated_at ?? entry.comment_created_at ?? "")) || 0;
    return stoppedAt < commandAt ? Math.max(latest, stoppedAt) : latest;
  }, 0);
  return candidates
    .filter((entry) => {
      const activationAt =
        Date.parse(String(entry?.comment_updated_at ?? entry?.comment_created_at ?? "")) || 0;
      return (
        entry?.repo === command.repo &&
        Number(entry?.issue_number) === Number(command.issue_number) &&
        entry?.intent === "automerge" &&
        !entry?.trusted_bot &&
        activationAt > latestPriorStopAt &&
        activationAt <= commandAt &&
        ["ready", "executed", "waiting"].includes(String(entry?.status ?? ""))
      );
    })
    .sort(
      (left, right) =>
        (Date.parse(String(right.comment_updated_at ?? right.comment_created_at ?? "")) || 0) -
        (Date.parse(String(left.comment_updated_at ?? left.comment_created_at ?? "")) || 0),
    )[0];
}

export function automergeMetricEvent({
  activation,
  command,
  phase,
  state,
  outcome,
  reason,
  runUrl,
}: {
  activation: LooseRecord;
  command: LooseRecord;
  phase: "activated" | "repair_dispatched" | "state_changed" | "terminal";
  state?: string | null;
  outcome?: string | null;
  reason?: string | null;
  runUrl?: string | null;
}) {
  const sessionId = automergeSessionId(activation);
  if (!sessionId) return null;
  const occurredAt = String(
    phase === "activated"
      ? (activation.comment_updated_at ?? activation.comment_created_at)
      : new Date().toISOString(),
  );
  return {
    event_type: "clawsweeper.automerge_metric",
    event_id: `${sessionId}:${phase}:${command.comment_id ?? occurredAt}:${outcome ?? state ?? reason ?? "event"}`,
    session_id: sessionId,
    phase,
    occurred_at: occurredAt,
    repository: String(command.repo),
    item_number: Number(command.issue_number),
    policy_version: AUTOMERGE_POLICY_VERSION,
    state: state ?? null,
    outcome: outcome ?? null,
    reason: reason ?? null,
    pr_url: `https://github.com/${String(command.repo)}/pull/${Number(command.issue_number)}`,
    run_url: runUrl ?? null,
  };
}

// Product telemetry must never become part of the automerge control plane. The
// caller can await this for bounded delivery, but every transport failure is a skip.
export async function postAutomergeMetricBestEffort(
  event: ReturnType<typeof automergeMetricEvent>,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
) {
  if (!event) return false;
  const token = String(env.CLAWSWEEPER_STATUS_INGEST_TOKEN ?? "").trim();
  if (!token) return false;
  const baseUrl = String(
    env.CLAWSWEEPER_STATUS_INGEST_URL ??
      `${String(env.CLAWSWEEPER_STATUS_URL ?? "https://clawsweeper.openclaw.ai").replace(/\/$/, "")}/api/events`,
  );
  const timeoutMs = positiveTimeout(
    env.CLAWSWEEPER_AUTOMERGE_METRIC_TIMEOUT_MS,
    DEFAULT_AUTOMERGE_METRIC_TIMEOUT_MS,
  );
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  try {
    const response = await Promise.race([
      fetcher(baseUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(event),
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("automerge metric ingest timed out"));
        }, timeoutMs);
      }),
    ]);
    return response.ok;
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function positiveTimeout(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 30_000) : fallback;
}
