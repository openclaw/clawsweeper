import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Reuse the publication harness's real Worker and stock gh transports.
export async function proveHeadlessCommandLease({
  source,
  root,
  output,
  repo,
  producerRepo,
  sweep,
  command,
  post,
  dispatches,
  comments,
  pulls,
  trace,
  wait,
}) {
  const number = 77;
  const staleHead = "c".repeat(40);
  const liveHead = pulls.get(number).head.sha;
  assert.notEqual(staleHead, liveHead);
  const marker = `<!-- clawsweeper-command-status:${number}:automerge:${staleHead} -->`;
  const payload = join(root, "headless-command-comment.json");
  writeFileSync(payload, JSON.stringify({ body: `${marker}\nAutomerge queued.` }));
  const acknowledgement = JSON.parse(
    (
      await command("gh", [
        "api",
        `repos/${repo}/issues/${number}/comments`,
        "--method",
        "POST",
        "--input",
        payload,
      ])
    ).stdout,
  );
  await post("exact-review/enqueue", {
    delivery_id: "headless-command-proof",
    decision: {
      targetRepo: repo,
      targetBranch: "main",
      itemNumber: number,
      itemKind: "pull_request",
      sourceEvent: "pull_request",
      sourceAction: "legacy_dispatch",
      supersedesInProgress: true,
      commandStatusMarker: marker,
      statusCommentId: acknowledgement.id,
    },
  });
  for (let i = 0; i < 60 && !dispatches.some((d) => d.item_number === number); i++)
    await wait(1000);
  const dispatch = dispatches.findLast((d) => d.item_number === number);
  assert.ok(dispatch, "head-less command must dispatch through the real queue");
  const tuple = {
    item_key: dispatch.queue_claim.item_key,
    lease_id: dispatch.queue_lease_id,
    lease_revision: dispatch.queue_claim.lease_revision,
    run_id: "1077",
    run_attempt: 1,
  };
  const claim = await post("exact-review/claim", tuple);
  assert.equal(claim.claimed, true);
  assert.ok(!claim.decision.sourceHeadSha);
  tuple.claim_generation = claim.claim_generation;
  const work = join(root, "headless-command");
  mkdirSync(work);
  const steps = sweep.jobs["event-review-apply"].steps;
  const step = (id) => steps.find((entry) => entry.id === id);
  const admissionFile = join(output, "headless-command-admission.txt");
  const env = {
    TARGET_REPO: repo,
    ITEM_NUMBER: String(number),
    CLAIM_TARGET_BRANCH: "main",
    CLAIM_DECISION: JSON.stringify(claim.decision),
    CLAWSWEEPER_PUBLIC_GH_TOKEN: "synthetic-only-token",
    GITHUB_RUN_ID: tuple.run_id,
    GITHUB_RUN_ATTEMPT: "1",
    EXACT_REVIEW_ITEM_KEY: tuple.item_key,
    EXACT_REVIEW_LEASE_ID: tuple.lease_id,
    EXACT_REVIEW_LEASE_REVISION: String(tuple.lease_revision),
    EXACT_REVIEW_CLAIM_GENERATION: String(tuple.claim_generation),
    EXACT_REVIEW_SOURCE_HEAD_SHA: "",
    EXACT_REVIEW_SOURCE_REVISION: "",
    COMMAND_STATUS_MARKER: marker,
    STATUS_COMMENT_ID: String(acknowledgement.id),
    RESOLVED_STATUS_COMMENT_ID: String(acknowledgement.id),
    RUN_URL: `https://github.com/${producerRepo}/actions/runs/${tuple.run_id}`,
    CODEX_TIMEOUT_MS: "60000",
    MEDIA_PROOF_TIMEOUT_MS: "0",
  };
  await command("bash", ["-eu", "-c", step("live-item").run], {
    ...env,
    GITHUB_OUTPUT: admissionFile,
  });
  const admission = readFileSync(admissionFile, "utf8");
  assert.match(admission, /^proceed=true$/m);
  assert.match(admission, new RegExp(`^live_head_sha=${liveHead}$`, "m"));
  env.EXACT_REVIEW_LIVE_HEAD_SHA = admission.match(/^live_head_sha=(.+)$/m)[1];
  const patchCount = () =>
    trace.filter(
      (entry) =>
        entry.method === "PATCH" &&
        entry.path === `/repos/${repo}/issues/comments/${acknowledgement.id}`,
    ).length;
  const start = trace.length;
  let baseline = "not run";
  if (process.env.MANUAL_PUBLICATION_BASELINE_DIST) {
    const before = patchCount();
    const result = await command(
      process.execPath,
      [
        join(process.env.MANUAL_PUBLICATION_BASELINE_DIST, "repair/update-command-status.js"),
        "--repo",
        repo,
        "--item-number",
        String(number),
        "--marker",
        marker,
        "--status-comment-id",
        String(acknowledgement.id),
        "--state",
        "Review in progress",
        "--detail",
        "Head-less command proof",
        "--run-url",
        env.RUN_URL,
        "--require-queue-authority-fence",
        "--refuse-terminal-state",
      ],
      env,
      work,
      true,
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /invalid queue-owned command review lease/);
    assert.equal(patchCount(), before);
    baseline = "invalid queue-owned command review lease; no PATCH";
  }
  for (const id of ["mark-re-review-command-in-progress", "reserve-exact-review-lease"]) {
    const resultFile = join(output, `headless-command-${id}.txt`);
    await command("bash", ["-eu", "-c", step(id).run], { ...env, GITHUB_OUTPUT: resultFile });
    if (id === "reserve-exact-review-lease") {
      const result = readFileSync(resultFile, "utf8");
      assert.match(result, /^status=posted$/m);
      assert.match(result, /^queue_only=true$/m);
    }
  }
  const readback = JSON.parse(
    (await command("gh", ["api", `repos/${repo}/issues/${number}/comments`])).stdout,
  );
  assert.equal(readback.length, 1, "both steps must rewrite the same acknowledgement");
  const { createReviewCommentLeases } = await import(
    pathToFileURL(join(source, "dist/clawsweeper-review-comment-leases.js"))
  );
  const leases = createReviewCommentLeases({
    PATCHABLE_REVIEW_COMMENT_AUTHORS: new Set(["clawsweeper[bot]"]),
    commentId: (comment) => comment?.id ?? null,
  });
  const candidates = leases.freshDedicatedReviewStartLeases({
    comments: readback,
    itemNumber: number,
    headSha: liveHead,
    nowMs: Date.now(),
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].commentId, acknowledgement.id);
  assert.equal(candidates[0].owner, `github-run-${tuple.run_id}-1`);
  assert.equal(
    leases.freshDedicatedReviewStartLeases({
      comments: readback,
      itemNumber: number,
      headSha: staleHead,
      nowMs: Date.now(),
    }).length,
    0,
  );
  const written = patchCount();
  assert.equal(written, 2, "mark and reservation each PATCH the acknowledgement");
  await post("exact-review/complete", { ...tuple, outcome: "success" });
  const rejectedFile = join(output, "headless-command-rejected.txt");
  await command("bash", ["-eu", "-c", step("reserve-exact-review-lease").run], {
    ...env,
    GITHUB_OUTPUT: rejectedFile,
  });
  assert.match(readFileSync(rejectedFile, "utf8"), /^status=superseded$/m);
  assert.equal(patchCount(), written, "inactive claim must not PATCH");
  const heartbeats = trace
    .slice(start)
    .filter((entry) => entry.body && entry.path.endsWith("/exact-review/heartbeat"));
  assert.ok(heartbeats.length >= 3);
  for (const heartbeat of heartbeats)
    assert.equal(Object.hasOwn(heartbeat.body, "source_head_sha"), false);
  await command("gh", [
    "api",
    `repos/${repo}/issues/comments/${acknowledgement.id}`,
    "--method",
    "DELETE",
  ]);
  assert.equal(comments.get(number).length, 0);
  return {
    scenario: "head-less command uses admission head without changing queue authority",
    baseline,
    liveHead,
    staleHead,
    acknowledgementId: acknowledgement.id,
    patches: written,
    inactiveClaimPatches: 0,
    heartbeatCount: heartbeats.length,
    consumer: "production freshDedicatedReviewStartLeases used by supplied-lease claiming",
    limits:
      "Synthetic GitHub HTTP peer; actual gh, workflow shell and Worker/SQLite queue. No Actions or model generation.",
  };
}
