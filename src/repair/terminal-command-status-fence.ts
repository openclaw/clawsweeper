import type { JsonValue } from "./json-types.js";

/** Revalidate the exact acknowledgement owner after comment lookup, before PATCH. */
export async function terminalCommandStatusFence(
  address: { marker: string; statusCommentId: number | null },
  release = false,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const origin = new URL(env.QUEUE_URL || "");
  if (
    origin.username ||
    origin.password ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      ))
  ) {
    throw new Error("invalid terminal status fence origin");
  }
  const itemKey = env.TERMINAL_FINALIZATION_ITEM_KEY || "";
  const leaseId = env.TERMINAL_FINALIZATION_LEASE_ID || "";
  const leaseRevision = Number(env.TERMINAL_FINALIZATION_LEASE_REVISION);
  const claimGeneration = Number(env.TERMINAL_FINALIZATION_CLAIM_GENERATION);
  const runId = env.GITHUB_RUN_ID || "";
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT || env.RUN_ATTEMPT);
  const attemptId = env.ATTEMPT_ID || "";
  if (
    !itemKey ||
    !leaseId ||
    !/^[0-9]+$/.test(runId) ||
    !/^ack:[1-9][0-9]*$/.test(attemptId) ||
    ![leaseRevision, claimGeneration, runAttempt].every((n) => Number.isSafeInteger(n) && n > 0)
  ) {
    throw new Error("missing terminal status fence tuple");
  }
  const response = await fetch(
    new URL("/internal/exact-review/terminal-finalization/attempt", origin),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        item_key: itemKey,
        lease_id: leaseId,
        lease_revision: leaseRevision,
        claim_generation: claimGeneration,
        run_id: runId,
        run_attempt: runAttempt,
        attempt_id: attemptId,
        ...(release ? { release_status_write: true } : { verify_only: true }),
        ...(address.marker ? { status_marker: address.marker } : {}),
        ...(address.statusCommentId === null ? {} : { status_comment_id: address.statusCommentId }),
      }),
    },
  );
  const result = (await response.json()) as Record<string, JsonValue>;
  if (
    response.status === 409 &&
    [
      "lease_not_active",
      "parked_command_superseded",
      "parked_command_target_changed",
      "acknowledgement_not_active",
    ].includes(String(result.error))
  )
    return false;
  if (
    !response.ok ||
    result.ok !== true ||
    (release ? result.released !== true : result.allowed !== true || result.write_fenced !== true)
  ) {
    throw new Error(`terminal status fence failed (HTTP ${response.status})`);
  }
  return true;
}
