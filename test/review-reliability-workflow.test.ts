import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { deflateRawSync } from "node:zlib";
import {
  classifyReviewRun,
  REVIEW_RUN_OBSERVER_TITLE_LANES,
} from "../scripts/review-run-observer.mjs";

test("review reliability telemetry shares the terminal reconciler workflow", () => {
  assert.equal(existsSync(".github/workflows/review-reliability-observer.yml"), false);
  const source = readFileSync(".github/workflows/exact-review-reconcile.yml", "utf8");
  const workflow = parse(source) as Record<string, any>;
  assert.deepEqual(workflow.on.workflow_run, {
    workflows: ["ClawSweeper", "ClawSweeper Review Plan"],
    types: ["completed"],
  });
  assert.deepEqual(workflow.permissions, {});
  const reconcileIf = String(workflow.jobs.observe.if);
  assert.match(reconcileIf, /github\.event_name == 'workflow_run'/);
  const gatedPrefixes = [
    ...reconcileIf.matchAll(/startsWith\(github\.event\.workflow_run\.display_title, '([^']+)'\)/g),
  ].map((match) => match[1]);
  assert.deepEqual(gatedPrefixes, Object.keys(REVIEW_RUN_OBSERVER_TITLE_LANES));
  for (const [prefix, lane] of Object.entries(REVIEW_RUN_OBSERVER_TITLE_LANES)) {
    assert.equal(
      classifyReviewRun({
        display_title: `${prefix}openclaw/openclaw#1`,
        event: "repository_dispatch",
      })?.trigger_lane,
      lane,
      prefix,
    );
  }
  assert.doesNotMatch(reconcileIf, /Review exact item/);
  assert.deepEqual(workflow.jobs.observe.permissions, { actions: "read", contents: "read" });
  const checkout = workflow.jobs.observe.steps.find((candidate: Record<string, unknown>) =>
    String(candidate.uses || "").startsWith("actions/checkout@"),
  );
  assert.equal(checkout.if, "${{ always() }}");
  assert.equal(checkout.with.ref, "${{ github.event.repository.default_branch }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const step = workflow.jobs.observe.steps.find((candidate: Record<string, unknown>) =>
    String(candidate.run || "").includes("review-run-observer.mjs"),
  );
  assert.ok(step);
  assert.equal(step.if, "${{ always() }}");
  assert.match(step.run, /--event-file/);
  assert.ok(step.env.CLAWSWEEPER_WEBHOOK_SECRET);
  assert.ok(step.env.GH_TOKEN);
  assert.ok(step.env.QUEUE_URL);
  assert.match(
    workflow.jobs.observe.concurrency.group,
    /exact-review-observe-.*github\.event\.workflow_run\.id.*github\.event\.workflow_run\.run_attempt/,
  );
  assert.equal(workflow.jobs.observe.concurrency["cancel-in-progress"], false);
});

test("queued workflow remediation shares the guarded dead-letter cadence", () => {
  assert.equal(existsSync(".github/workflows/queued-run-janitor.yml"), false);
  const workflow = parse(
    readFileSync(".github/workflows/exact-review-dead-letter-reconcile.yml", "utf8"),
  ) as Record<string, any>;
  assert.equal(workflow.on.schedule[0].cron, "*/5 * * * *");
  assert.equal(workflow.concurrency.group, "exact-review-dead-letter-operator");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.permissions.actions, "write");
  const remediate = workflow.jobs.reconcile.steps.find(
    (step: Record<string, unknown>) => step.name === "Remediate demonstrably stuck queued runs",
  );
  assert.equal(remediate.id, "remediate");
  assert.equal(remediate["continue-on-error"], true);
  assert.equal(remediate.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.equal(
    remediate.env.EXECUTE,
    "${{ github.event_name == 'schedule' && 'true' || github.event.inputs.execute }}",
  );
  assert.match(String(remediate.run), /stuck-queued-run-remediation\.mjs/);
  assert.match(String(remediate.run), /--execute/);
  const steps = workflow.jobs.reconcile.steps as Array<Record<string, unknown>>;
  const reconcileIndex = steps.findIndex(
    (step) => step.name === "Reconcile closed, duplicate, and recoverable dead letters",
  );
  const parkedIndex = steps.findIndex(
    (step) => step.name === "Reconcile terminal and open parked reviews",
  );
  const remediationFailureIndex = steps.findIndex(
    (step) => step.name === "Fail if queued-run remediation failed",
  );
  assert.ok(reconcileIndex > steps.indexOf(remediate));
  assert.ok(parkedIndex > reconcileIndex);
  assert.ok(remediationFailureIndex > parkedIndex);
  assert.match(
    String(steps[remediationFailureIndex]?.if),
    /steps\.remediate\.outcome == 'failure'/,
  );
  const upload = workflow.jobs.reconcile.steps.find(
    (step: Record<string, unknown>) => step.name === "Upload sanitized inventory",
  );
  assert.match(String(upload.with.path), /stuck-queued-runs\.json/);
  assert.match(String(upload.with.path), /stuck-queued-zombies\.json/);
  assert.equal(upload.with["if-no-files-found"], "ignore");
});

test("dead-letter reconcile restores zombie state from the newest live artifact by exact name", () => {
  const job = parse(
    readFileSync(".github/workflows/exact-review-dead-letter-reconcile.yml", "utf8"),
  ).jobs.reconcile as Record<string, any>;
  const steps = job.steps as Array<Record<string, any>>;
  const restore = steps.find((step) => step.name === "Restore permanent queued-run zombie state");
  const upload = steps.find((step) => step.name === "Upload sanitized inventory");
  assert.ok(restore && upload);
  const artifactName = String(job.env.EXACT_REVIEW_DLQ_ARTIFACT);
  assert.equal(upload.with.name, "${{ env.EXACT_REVIEW_DLQ_ARTIFACT }}");
  assert.equal(upload.with.overwrite, true);
  const zombies = '{"schema_version":1,"zombies":[{"run_id":"7"}]}\n';
  // Mirrors `gh api --include`: CRLF headers, then the raw body; non-2xx exits 1.
  const fixture = [
    "gh() {",
    '  printf "gh %s\\n" "$*" >> "$CALLS"',
    '  if [ "$2" != "--include" ]; then cat "$MOCK_ZIP"; return; fi',
    '  if [ -z "$MOCK_STATUS" ]; then echo "dial tcp: connection refused" >&2; return 1; fi',
    '  printf "HTTP/2.0 %s Fixture\\r\\nContent-Type: application/json\\r\\n\\r\\n%s" "$MOCK_STATUS" "$MOCK_BODY"',
    '  case "$MOCK_STATUS" in 2??) ;; *) echo "unexpected end of JSON input" >&2; return 1 ;; esac',
    "}",
  ].join("\n");
  const artifact = (id: number, name: string, createdAt: string, expired = false) => ({
    id,
    name,
    expired,
    created_at: createdAt,
  });
  const run = (status: string, body: string, archive = zip([])) => {
    const root = mkdtempSync(join(tmpdir(), "dead-letter-restore-"));
    try {
      writeFileSync(join(root, "prior.zip"), archive);
      const result = spawnSync("bash", ["-c", `${fixture}\n${restore.run}`], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          CALLS: join(root, "calls"),
          EXACT_REVIEW_DLQ_ARTIFACT: artifactName,
          GH_TOKEN: "fixture-token",
          GITHUB_REPOSITORY: "openclaw/clawsweeper",
          MOCK_BODY: body,
          MOCK_STATUS: status,
          MOCK_ZIP: join(root, "prior.zip"),
          RUNNER_TEMP: root,
        },
      });
      const restored = join(root, ".artifacts/exact-review-dlq/prior-stuck-queued-zombies.json");
      return {
        ...result,
        calls: existsSync(join(root, "calls"))
          ? readFileSync(join(root, "calls"), "utf8").trim().split("\n")
          : [],
        restored: existsSync(restored) ? readFileSync(restored, "utf8") : undefined,
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  const listed = run(
    "200",
    JSON.stringify({
      total_count: 4,
      artifacts: [
        artifact(4, `${artifactName}-99-1`, "2026-10-04T00:00:00Z"),
        artifact(3, artifactName, "2026-10-03T00:00:00Z", true),
        artifact(1, artifactName, "2026-10-01T00:00:00Z"),
        artifact(2, artifactName, "2026-10-02T00:00:00Z"),
      ],
    }),
    zip([{ name: "stuck-queued-zombies.json", content: Buffer.from(zombies), compressed: true }]),
  );
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.calls, [
    `gh api --include -X GET repos/openclaw/clawsweeper/actions/artifacts -f name=${artifactName} -F per_page=100`,
    "gh api repos/openclaw/clawsweeper/actions/artifacts/2/zip",
  ]);
  assert.equal(listed.restored, zombies);
  assert.match(listed.stdout, /restored queued-run zombie state from artifact 2/);

  const unrelated = run(
    "200",
    JSON.stringify({
      total_count: 1,
      artifacts: [artifact(2, artifactName, "2026-10-02T00:00:00Z")],
    }),
    zip([{ name: "inventory.json", content: Buffer.from("{}") }]),
  );
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.equal(unrelated.restored, undefined);
  assert.match(unrelated.stdout, /no queued-run zombie state; using checked-in seed/);

  const none = run("200", JSON.stringify({ total_count: 0, artifacts: [] }));
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.calls.length, 1);
  assert.equal(none.restored, undefined);
  assert.match(none.stdout, /no prior reconcile artifact; using checked-in zombie seed/);

  for (const [status, body, message] of [
    ["", "", /got no HTTP response \(gh exit 1: dial tcp: connection refused/],
    ["500", "", /returned HTTP 500 \(empty body\)/],
    ["502", '{"message":"Server Error"}', /returned HTTP 502 \(\{"message":"Server Error"\}\)/],
    ["200", "", /returned HTTP 200 with an empty body/],
    ["200", "<html>", /returned HTTP 200 with an unreadable artifact list/],
    ["200", '{"message":"ok"}', /returned HTTP 200 with an unreadable artifact list/],
  ] as const) {
    const failed = run(status, body);
    assert.equal(failed.status, 1, `${status} ${body}`);
    assert.match(failed.stderr, message);
    assert.doesNotMatch(failed.stderr, /unexpected end of JSON input/);
    assert.equal(failed.calls.length, 1);
    assert.equal(failed.restored, undefined);
  }
});

test("exact review generation enters finalization before state hydration", () => {
  const workflow = parse(readFileSync(".github/workflows/sweep.yml", "utf8")) as Record<
    string,
    any
  >;
  const steps = workflow.jobs["event-review-apply"].steps as Array<Record<string, unknown>>;
  const review = steps.find((step) => step.name === "Review exact event item");
  const setupStateIndex = steps.findIndex((step) => step.id === "direct-setup-state");
  const reviewIndex = steps.indexOf(review!);

  assert.ok(review);
  assert.equal(steps[setupStateIndex]?.uses, "./.github/actions/setup-state");
  assert.ok(reviewIndex >= 0 && reviewIndex < setupStateIndex);
  assert.match(String(review.run), /exact-review-queue-request\.js heartbeat --phase finalizing\)/);
  assert.match(String(review.run), /mark_finalizing \|\| review_exit_code=1/);
});

test("exact review generation reads the item's prior canonical record", () => {
  const workflow = parse(readFileSync(".github/workflows/sweep.yml", "utf8")) as Record<
    string,
    any
  >;
  const steps = workflow.jobs["event-review-apply"].steps as Array<Record<string, any>>;
  const review = steps.find((step) => step.name === "Review exact event item");
  const reviewIndex = steps.indexOf(review!);
  // The review command reads records/<slug>/items/<number>.md; without that
  // prior record every scheduled pass misses both review caches.
  const priorRecordIndex = steps.findIndex(
    (step, index) =>
      index < reviewIndex &&
      step.uses === "./.github/actions/setup-state" &&
      step.with?.["records-item-number"] === "${{ steps.target.outputs.item_number }}",
  );
  const priorRecord = steps[priorRecordIndex];

  assert.ok(review);
  assert.ok(priorRecord, "the exact review must hydrate its prior record before generation");
  assert.equal(priorRecord.with["records-repo-slugs"], "${{ steps.target.outputs.target_slug }}");
  assert.equal(priorRecord.with["hydrate-records"] ?? "true", "true");
  assert.equal(priorRecord.with["hydrate-git-state"], "false");
  assert.equal(priorRecord.with["hydrate-state-blobs"], "false");
  // A missing record only costs the cache; it must not block the review.
  assert.equal(priorRecord["continue-on-error"], true);
  // A stalled Worker must not hold the review lease before generation starts.
  assert.ok(
    Number(priorRecord["timeout-minutes"]) > 0 && Number(priorRecord["timeout-minutes"]) <= 5,
  );
  assert.equal(priorRecord.if, review.if);
  // The Worker secret stays scoped to the hydration step.
  assert.doesNotMatch(JSON.stringify(review.env), /CLAWSWEEPER_WEBHOOK_SECRET/);
});

function zip(
  entries: Array<{ name: string; content: Buffer; mode?: number; compressed?: boolean }>,
): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      data = entry.compressed ? deflateRawSync(entry.content) : entry.content;
    const method = entry.compressed ? 8 : 0,
      crc = crc32(entry.content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(entry.content.length, 22);
    header.writeUInt16LE(name.length, 26);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50);
    index.writeUInt16LE(0x314, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt16LE(0x800, 8);
    index.writeUInt16LE(method, 10);
    index.writeUInt32LE(crc, 16);
    index.writeUInt32LE(data.length, 20);
    index.writeUInt32LE(entry.content.length, 24);
    index.writeUInt16LE(name.length, 28);
    index.writeUInt32LE(((entry.mode ?? 0x81a4) << 16) >>> 0, 38);
    index.writeUInt32LE(offset, 42);
    local.push(header, name, data);
    central.push(index, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function crc32(value: Buffer) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
