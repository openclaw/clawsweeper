import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";

type Workflow = { jobs: Record<string, { steps: { name?: string; run?: string }[] }> };
const workflowPath = ".github/workflows/sweep.yml";
const current = readFileSync(workflowPath, "utf8");
// Set to a Git revision to run the same complete workflow steps before and after
// the extraction, with a queue stub recording the exact bytes sent by curl.
const baseline = process.env.EXACT_REVIEW_CLIENT_BASE;
const versions = baseline
  ? [execFileSync("git", ["show", `${baseline}:${workflowPath}`], { encoding: "utf8" }), current]
  : [current];
const decision = {
  targetRepo: "openclaw/openclaw",
  targetBranch: "main",
  itemNumber: 7,
  itemKind: "pull_request",
  sourceEvent: "pull_request",
  sourceAction: "opened",
};
const itemKey = "openclaw/openclaw#7";
const lease = {
  claimed: true,
  protocol_version: 2,
  item_key: itemKey,
  lease_revision: 3,
  claim_generation: 2,
  repeat_revision: false,
  decision,
};
const publication = {
  ...lease,
  item_key: `${itemKey}@publish:10:1`,
  decision: {
    ...decision,
    sourceAction: "exact_review_artifact_publish",
    publication: {
      producerDecision: decision,
      producerRunId: "10",
      producerRunAttempt: 1,
      itemKey,
      leaseRevision: 3,
      protocolVersion: 2,
      claimGeneration: 2,
      artifactName: "review",
      sourceSha: "a".repeat(40),
    },
  },
};
const finalization = {
  ...lease,
  decision: publication.decision,
  terminal_finalization: { statusState: "Complete", statusDetail: "done" },
  lifecycle_projection: { canonicalTargetKey: itemKey, fenceKey: itemKey, revision: 3 },
};

function runStep(
  source: string,
  name: string,
  response: unknown,
  status: string,
  key: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const workflow = YAML.parse(source) as Workflow;
  const step = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((s) => s?.name === name);
  assert.ok(step?.run, name);
  const root = mkdtempSync(join(tmpdir(), "queue-client-"));
  try {
    for (const owner of ["request", "response"]) {
      copyFileSync(
        `src/repair/exact-review-queue-${owner}.ts`,
        join(root, `exact-review-queue-${owner}.mts`),
      );
    }
    writeFileSync(join(root, "response"), JSON.stringify(response));
    writeFileSync(join(root, "output"), "");
    writeFileSync(join(root, "body"), "");
    writeFileSync(
      join(root, "control-plane-curl.sh"),
      `control_plane_curl() {
      local output body
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --output) output="$2"; shift 2 ;;
          --data) body="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      printf '%s' "$body" > "$RUNNER_TEMP/body"
      cp "$RUNNER_TEMP/response" "$output"
      printf '%s' "$STUB_STATUS"
    }
    control_plane_signed_post() {
      printf '%s' "$2" > "$RUNNER_TEMP/body"
      printf '{"ok":true}'
    }
`,
    );
    const result = spawnSync("bash", ["-c", step.run], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        GITHUB_OUTPUT: join(root, "output"),
        QUEUE_URL: "https://queue.invalid",
        ITEM_KEY: key,
        QUEUE_LEASE_ID: "lease-7",
        QUEUE_LEASE_REVISION: "3",
        DISPATCH_PAYLOAD: "{}",
        STUB_STATUS: status,
        GITHUB_RUN_ID: "20",
        GITHUB_RUN_ATTEMPT: "1",
        ...extraEnv,
      },
    });
    return {
      status: result.status,
      body: readFileSync(join(root, "body"), "utf8"),
      output: readFileSync(join(root, "output"), "utf8"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const [name, valid, key] of [
  ["Claim exact-review queue lease", lease, itemKey],
  ["Claim durable exact review publication", publication, publication.item_key],
  ["Claim committed terminal finalization", finalization, itemKey],
] as const) {
  for (const [label, response, status, expected] of [
    ["valid", valid, "200", 0],
    ["not claimed", { ...valid, claimed: false }, "200", 1],
    ["invalid generation", { ...valid, claim_generation: 0 }, "200", 1],
    ["wrong item", { ...valid, item_key: "other#1" }, "200", 1],
    ["unknown conflict", { error: "unknown" }, "409", 1],
    ["server error", {}, "503", 1],
  ] as const) {
    test(`${name}: ${label} preserves queue body and exit status`, () => {
      const results = versions.map((source) => runStep(source, name, response, status, key));
      for (const result of results) assert.equal(result.status, expected);
      if (results.length === 2) assert.deepEqual(results[1], results[0]);
      assert.deepEqual(JSON.parse(results[0]!.body), {
        lease_id: "lease-7",
        item_key: key,
        lease_revision: 3,
        run_id: "20",
        run_attempt: 1,
      });
    });
  }
}

for (const protocolVersion of [1, 2]) {
  for (const repeatRevision of [false, true]) {
    test(`review claim v${protocolVersion} exposes repeat_revision=${repeatRevision} for telemetry`, () => {
      const results = versions.map((source) =>
        runStep(
          source,
          "Claim exact-review queue lease",
          { ...lease, protocol_version: protocolVersion, repeat_revision: repeatRevision },
          "200",
          itemKey,
        ),
      );
      for (const result of results) {
        assert.equal(result.status, 0);
        const outputs = Object.fromEntries(
          result.output
            .trim()
            .split("\n")
            .map((line) => {
              const separator = line.indexOf("=");
              return [line.slice(0, separator), line.slice(separator + 1)];
            }),
        );
        assert.equal(outputs.protocol_version, String(protocolVersion));
        assert.equal(outputs.repeat_revision, String(protocolVersion === 2 && repeatRevision));
      }
      if (results.length === 2) assert.deepEqual(results[1], results[0]);
    });
  }
}

test("review claim v2 rejects a non-boolean repeat revision before exposing telemetry outputs", () => {
  for (const repeatRevision of [undefined, "true"]) {
    for (const source of versions) {
      const result = runStep(
        source,
        "Claim exact-review queue lease",
        { ...lease, repeat_revision: repeatRevision },
        "200",
        itemKey,
      );
      assert.equal(result.status, 1);
      assert.equal(result.output, "claimed=false\ndecision={}\n");
    }
  }
});

for (const [command, variable, valid, invalid] of [
  [
    "reservation",
    "RESERVATION",
    { status: "posted", owner: "worker", commentId: 7 },
    { status: "posted", owner: "bad owner", commentId: 7 },
  ],
  ["lifecycleKind", "DIRECT_LIFECYCLE_PLAN", { kind: "router" }, { kind: "router", extra: true }],
] as const) {
  test(`${command} accepts valid data and rejects malformed data`, () => {
    const root = mkdtempSync(join(tmpdir(), "queue-response-"));
    try {
      for (const [value, expected] of [
        [valid, 0],
        [invalid, 1],
      ] as const) {
        const result = spawnSync(
          process.execPath,
          ["src/repair/exact-review-queue-response.ts", command],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              [variable]: JSON.stringify(value),
              GITHUB_OUTPUT: join(root, "output"),
            },
          },
        );
        assert.equal(result.status, expected, result.stderr);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const kind of ["router_not_required", "requeue", "target_closed", "invalid"]) {
  test(`direct lifecycle ${kind} replays without a checkout`, () => {
    const results = versions.map((source) =>
      runStep(source, "Replay committed direct lifecycle handoff", {}, "200", itemKey, {
        CLAWSWEEPER_WEBHOOK_SECRET: "fixture-only",
        DIRECT_LIFECYCLE_PLAN: JSON.stringify({ kind }),
        DIRECT_LIFECYCLE_RECEIPT_OUTCOME: "accepted",
        TARGET_REPO: "openclaw/openclaw",
        ITEM_NUMBER: "7",
        FENCE_KEY: itemKey,
        REVISION: "3",
      }),
    );
    assert.equal(results[0]!.status, kind === "invalid" ? 1 : 0);
    if (results.length === 2) assert.deepEqual(results[1], results[0]);
  });
}
