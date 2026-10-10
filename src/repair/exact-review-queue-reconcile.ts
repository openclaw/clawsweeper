#!/usr/bin/env node
import { createHmac } from "node:crypto";

type ClaimedRun = { run_id: string; run_attempt: number | null; claim_generation: number };
type TerminalRun = {
  run_id: string;
  run_attempt: number;
  claimed_run_attempt: number | null;
  claim_generation: number;
  outcome: "success" | "cancelled" | "failure";
};

if (process.argv[2] === "body") {
  const runAttempt = Number(process.env.SOURCE_RUN_ATTEMPT);
  if (!Number.isInteger(runAttempt) || runAttempt < 1) process.exit(1);
  process.stdout.write(
    JSON.stringify({
      runs: [{ run_id: process.env.SOURCE_RUN_ID, run_attempt: runAttempt }],
      include_all_claimed: true,
    }),
  );
} else if (process.argv[2] === "sweep") {
  await sweep();
} else {
  throw new Error("expected body or sweep");
}

async function sweep() {
  const secret = process.env.CLAWSWEEPER_WEBHOOK_SECRET || "";
  const token = process.env.GH_TOKEN || "";
  const repository = process.env.GITHUB_REPOSITORY || "";
  const queueUrl = (process.env.QUEUE_URL || "").replace(/\/$/, "");
  if (!secret || !token || !repository || !queueUrl)
    throw new Error("missing reconciler configuration");

  async function signedPost(
    path: string,
    value: object,
  ): Promise<{ runs?: ClaimedRun[]; reconciled?: number }> {
    const body = JSON.stringify(value);
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const response = await fetch(`${queueUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": signature,
      },
      body,
    });
    if (!response.ok)
      throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
    return response.json() as Promise<{ runs?: ClaimedRun[]; reconciled?: number }>;
  }

  const claimed = await signedPost("/internal/exact-review/claimed-runs", {
    runs: [],
    include_all_claimed: true,
  });
  const runs = Array.isArray(claimed.runs) ? claimed.runs : [];
  const terminalRuns: TerminalRun[] = [];
  const unavailable: string[] = [];
  for (let offset = 0; offset < runs.length; offset += 8) {
    await Promise.all(
      runs.slice(offset, offset + 8).map(async (claim) => {
        const runId = String(claim.run_id || "");
        const claimedAttempt = claim.run_attempt == null ? null : Number(claim.run_attempt);
        const claimGeneration = Number(claim.claim_generation);
        if (
          !/^\d+$/.test(runId) ||
          (claimedAttempt !== null && (!Number.isInteger(claimedAttempt) || claimedAttempt < 1)) ||
          !Number.isInteger(claimGeneration) ||
          claimGeneration < 0
        ) {
          throw new Error("invalid claimed run tuple");
        }
        const suffix = claimedAttempt === null ? "" : `/attempts/${claimedAttempt}`;
        const response = await fetch(
          `${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${repository}/actions/runs/${runId}${suffix}`,
          {
            headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
          },
        );
        if (!response.ok) {
          unavailable.push(`${runId}:${response.status}`);
          return;
        }
        const run = (await response.json()) as {
          id: string;
          run_attempt: number;
          status: string;
          conclusion: string;
        };
        const runAttempt = Number(run.run_attempt);
        if (
          String(run.id || "") !== runId ||
          !Number.isInteger(runAttempt) ||
          runAttempt < 1 ||
          (claimedAttempt !== null && runAttempt !== claimedAttempt)
        ) {
          unavailable.push(`${runId}:mismatch`);
          return;
        }
        if (run.status !== "completed") return;
        if (!run.conclusion) {
          unavailable.push(`${runId}:missing-conclusion`);
          return;
        }
        terminalRuns.push({
          run_id: runId,
          run_attempt: runAttempt,
          claimed_run_attempt: claimedAttempt,
          claim_generation: claimGeneration,
          outcome:
            run.conclusion === "success"
              ? "success"
              : run.conclusion === "cancelled"
                ? "cancelled"
                : "failure",
        });
      }),
    );
  }
  let reconciled = 0;
  if (terminalRuns.length) {
    const result = await signedPost("/internal/exact-review/reconcile", {
      terminal_runs: terminalRuns,
    });
    reconciled = Number(result.reconciled) || 0;
  }
  console.log(
    `checked=${runs.length} terminal=${terminalRuns.length} reconciled=${reconciled} unavailable=${unavailable.length}`,
  );
  if (unavailable.length)
    console.log(`unavailable runs (next sweep retries): ${unavailable.join(",")}`);
  // Partial lookup failures are routine (rate limits, expired run retention); the
  // 15-minute cadence and lease expiry are the backstop. Fail only on total blindness.
  if (runs.length && unavailable.length === runs.length)
    throw new Error("all claimed run lookups failed");
}
