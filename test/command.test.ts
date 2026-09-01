import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  defaultReviewArtifactDirForTest,
  exactEventReviewLeaseDispositionForTest,
  itemSourceRevisionSha256ForTest,
  isSuppliedReviewStartLeaseForTest,
  localExactReviewHistoryPathForTest,
  prepareManagedLocalReviewCheckoutForTest,
  reviewPolicyHashForTest,
  reviewLeaseStillMatchesContextForTest,
} from "../dist/clawsweeper.js";
import { runText, UserFacingCommandError } from "../dist/command.js";
import { reviewMergeBase } from "../dist/pr-review-evidence.js";
import { reviewStructuralPullStateDigest } from "../dist/review-structural-cache.js";
import { mockGhBinEnv, workPlanCandidateReport } from "./helpers.ts";
import { writeFakeScanner } from "./agent-input-scan-helpers.ts";

const CLI = fileURLToPath(new URL("../dist/clawsweeper.js", import.meta.url));

test("runText explains missing working directories", () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-"));
  const missing = join(root, "missing");
  try {
    assert.throws(
      () => runText(process.execPath, ["--version"], { cwd: missing }),
      (error: unknown) => {
        assert.ok(error instanceof UserFacingCommandError);
        assert.match(
          error.message,
          /Working directory not found while running .*: .*missing.*Check --target-dir/,
        );
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runText explains missing executables", () => {
  assert.throws(
    () => runText("clawsweeper-missing-command-for-test", [], { env: { PATH: "" } }),
    (error: unknown) => {
      assert.ok(error instanceof UserFacingCommandError);
      assert.match(
        error.message,
        /Command not found while running clawsweeper-missing-command-for-test/,
      );
      return true;
    },
  );
});

test("review CLI suppresses stack traces for missing local target checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-"));
  const missing = join(root, "missing-target");
  const artifactDir = join(root, "artifacts");
  try {
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "review",
        "--local-only",
        "--target-repo",
        "openclaw/openclaw",
        "--target-dir",
        missing,
        "--item-number",
        "357",
        "--artifact-dir",
        artifactDir,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Error: Working directory not found while running git:/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local exact reviews default to item-specific artifacts", () => {
  assert.equal(defaultReviewArtifactDirForTest(true, 357, undefined), "artifacts/local-review-357");
  assert.equal(defaultReviewArtifactDirForTest(true, 357, [357]), "artifacts/reviews");
  assert.equal(defaultReviewArtifactDirForTest(false, 357, undefined), "artifacts/reviews");
});

test("local exact review history is keyed by repository and item", () => {
  const artifactDir = join("artifacts", "reviews");
  const first = localExactReviewHistoryPathForTest(artifactDir, "openclaw/openclaw", 357);
  const second = localExactReviewHistoryPathForTest(artifactDir, "openclaw/openclaw", 358);
  const otherRepo = localExactReviewHistoryPathForTest(artifactDir, "openclaw/clawsweeper", 357);

  assert.equal(first, join(artifactDir, "local-review-history-openclaw-openclaw-357.md"));
  assert.equal(second, join(artifactDir, "local-review-history-openclaw-openclaw-358.md"));
  assert.notEqual(first, second);
  assert.notEqual(first, otherRepo);
});

test("CSW-088 scheduled hot planning suppresses #117063, observes an in-flight update, and leaves explicit re-review eligible", () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-csw-088-"));
  const binDir = join(root, "bin");
  const itemsDir = join(root, "items");
  const coverageManifest = join(root, "coverage.json");
  const ghPath = join(binDir, "gh.js");
  const number = 117063;
  const headSha = "0a3959fe0123456789abcdef0123456789abcdef";
  const reviewedAt = new Date().toISOString();
  const pull = {
    number,
    title: "CSW-088 scheduled hot review fixture",
    body: "The reviewed PR body is unchanged.",
    labels: ["needs-review"],
    head: { sha: headSha },
    base: { sha: "b".repeat(40) },
    draft: false,
    mergeable: true,
    mergeable_state: "clean",
    additions: 5,
    deletions: 2,
    changed_files: 2,
    commits: 1,
    updated_at: reviewedAt,
  };
  const updatedPull = { ...pull, body: "The PR body changed during the snapshot read." };
  const commentUpdatedPull = {
    ...pull,
    updated_at: new Date(Date.parse(reviewedAt) + 1).toISOString(),
  };
  const issue = {
    number,
    title: pull.title,
    body: pull.body,
    html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
    created_at: "2026-07-30T00:00:00Z",
    updated_at: reviewedAt,
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: pull.labels,
    pull_request: {},
  };
  const listItem = {
    number,
    title: pull.title,
    html_url: issue.html_url,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    author_association: issue.author_association,
    user: issue.user,
    labels: issue.labels,
    pull_request: {},
  };
  const sourceRevision = itemSourceRevisionSha256ForTest(pull, []);
  const pullStateDigest = reviewStructuralPullStateDigest({
    headSha,
    baseSha: pull.base.sha,
    draft: pull.draft,
    mergeable: pull.mergeable,
    mergeStateStatus: pull.mergeable_state,
    additions: pull.additions,
    deletions: pull.deletions,
    changedFiles: pull.changed_files,
    commitCount: pull.commits,
  });
  assert.ok(pullStateDigest);

  try {
    mkdirSync(binDir, { recursive: true });
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(
      join(itemsDir, `${number}.md`),
      workPlanCandidateReport({
        repository: "openclaw/openclaw",
        type: "pull_request",
        number,
        title: pull.title,
        reviewed_at: reviewedAt,
        review_policy: reviewPolicyHashForTest(),
        item_updated_at: reviewedAt,
        item_source_revision: sourceRevision,
        pull_head_sha: headSha,
        reviewed_pull_state_digest: pullStateDigest,
      }),
    );
    writeFileSync(
      coverageManifest,
      JSON.stringify({
        schemaVersion: 3,
        source: "worker",
        repositories: { "openclaw-openclaw": { coverageTrackedItemIds: [] } },
      }),
    );
    writeFileSync(
      ghPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const path = args[1] || "";
const listItem = ${JSON.stringify(listItem)};
const issue = ${JSON.stringify(issue)};
const pull = ${JSON.stringify(pull)};
const updatedPull = ${JSON.stringify(updatedPull)};
const commentUpdatedPull = ${JSON.stringify(commentUpdatedPull)};
const raceMarker = process.env.CSW_RACE_MARKER;
const race = process.env.CSW_RACE === "1";
const activityRaceMarker = process.env.CSW_ACTIVITY_RACE_MARKER;
const activityRace = process.env.CSW_ACTIVITY_RACE === "1";
const commentRaceMarker = process.env.CSW_COMMENT_RACE_MARKER;
const commentRace = process.env.CSW_COMMENT_RACE === "1";
const updatedReview = { id: 1, user: { login: "reviewer" }, state: "COMMENTED", body: "new review activity", submitted_at: "2026-07-31T00:00:00Z", commit_id: pull.head.sha };
if (args[0] === "api" && /issues\\?state=open/.test(path)) {
  console.log(JSON.stringify(listItem));
  process.exit(0);
}
if (args[0] === "api" && path === "repos/openclaw/openclaw/issues/${number}") {
  console.log(JSON.stringify(issue));
  process.exit(0);
}
if (args[0] === "api" && path === "repos/openclaw/openclaw/pulls/${number}") {
  if (activityRace && activityRaceMarker) require("node:fs").writeFileSync(activityRaceMarker, "seen");
  console.log(JSON.stringify(race && raceMarker && require("node:fs").existsSync(raceMarker) ? updatedPull : commentRace && commentRaceMarker && require("node:fs").existsSync(commentRaceMarker) ? commentUpdatedPull : pull));
  process.exit(0);
}
if (args[0] === "api" && path.startsWith("repos/openclaw/openclaw/issues/${number}/comments")) {
  if (commentRace && commentRaceMarker) require("node:fs").writeFileSync(commentRaceMarker, "seen");
  console.log(JSON.stringify([[]]));
  process.exit(0);
}
if (args[0] === "api" && path.startsWith("repos/openclaw/openclaw/pulls/${number}/comments")) {
  if (race && raceMarker) require("node:fs").writeFileSync(raceMarker, "seen");
  console.log(JSON.stringify([[]]));
  process.exit(0);
}
if (args[0] === "api" && /pulls\\/${number}\\/reviews/.test(path)) {
  console.log(JSON.stringify(activityRace && activityRaceMarker && require("node:fs").existsSync(activityRaceMarker) ? [[updatedReview]] : [[]]));
  process.exit(0);
}
console.error("unexpected gh args " + JSON.stringify(args));
process.exit(1);
`,
    );
    chmodSync(ghPath, 0o755);
    const env = { ...process.env, ...mockGhBinEnv(ghPath) };
    const scheduled = spawnSync(
      process.execPath,
      [
        CLI,
        "plan",
        "--target-repo",
        "openclaw/openclaw",
        "--items-dir",
        itemsDir,
        "--coverage-tracked-items-manifest",
        coverageManifest,
        "--hot-intake",
        "--max-pages",
        "1",
        "--batch-size",
        "1",
        "--shard-count",
        "1",
      ],
      { encoding: "utf8", env },
    );
    assert.equal(scheduled.status, 0, scheduled.stderr);
    assert.deepEqual(JSON.parse(scheduled.stdout).candidates, []);

    const raced = spawnSync(
      process.execPath,
      [
        CLI,
        "plan",
        "--target-repo",
        "openclaw/openclaw",
        "--items-dir",
        itemsDir,
        "--coverage-tracked-items-manifest",
        coverageManifest,
        "--hot-intake",
        "--max-pages",
        "1",
        "--batch-size",
        "1",
        "--shard-count",
        "1",
      ],
      { encoding: "utf8", env: { ...env, CSW_RACE: "1", CSW_RACE_MARKER: join(root, "race") } },
    );
    assert.equal(raced.status, 0, raced.stderr);
    assert.deepEqual(
      JSON.parse(raced.stdout).candidates.map((candidate: { number: number }) => candidate.number),
      [number],
    );

    const commentRaced = spawnSync(
      process.execPath,
      [
        CLI,
        "plan",
        "--target-repo",
        "openclaw/openclaw",
        "--items-dir",
        itemsDir,
        "--coverage-tracked-items-manifest",
        coverageManifest,
        "--hot-intake",
        "--max-pages",
        "1",
        "--batch-size",
        "1",
        "--shard-count",
        "1",
      ],
      {
        encoding: "utf8",
        env: {
          ...env,
          CSW_COMMENT_RACE: "1",
          CSW_COMMENT_RACE_MARKER: join(root, "comment-race"),
        },
      },
    );
    assert.equal(commentRaced.status, 0, commentRaced.stderr);
    assert.deepEqual(
      JSON.parse(commentRaced.stdout).candidates.map(
        (candidate: { number: number }) => candidate.number,
      ),
      [number],
    );

    const activityRaced = spawnSync(
      process.execPath,
      [
        CLI,
        "plan",
        "--target-repo",
        "openclaw/openclaw",
        "--items-dir",
        itemsDir,
        "--coverage-tracked-items-manifest",
        coverageManifest,
        "--hot-intake",
        "--max-pages",
        "1",
        "--batch-size",
        "1",
        "--shard-count",
        "1",
      ],
      {
        encoding: "utf8",
        env: {
          ...env,
          CSW_ACTIVITY_RACE: "1",
          CSW_ACTIVITY_RACE_MARKER: join(root, "activity-race"),
        },
      },
    );
    assert.equal(activityRaced.status, 0, activityRaced.stderr);
    assert.deepEqual(
      JSON.parse(activityRaced.stdout).candidates.map(
        (candidate: { number: number }) => candidate.number,
      ),
      [number],
    );

    const explicit = spawnSync(
      process.execPath,
      [
        CLI,
        "plan",
        "--target-repo",
        "openclaw/openclaw",
        "--items-dir",
        itemsDir,
        "--item-number",
        String(number),
      ],
      { encoding: "utf8", env },
    );
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.deepEqual(
      JSON.parse(explicit.stdout).candidates.map(
        (candidate: { number: number }) => candidate.number,
      ),
      [number],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact event publication requeues legacy tuples and source drift before mutation", () => {
  const revision = "0123456789abcdef0123456789abcdef01234567";
  const base = `---\nitem_source_revision: ${revision}\n---\n`;
  assert.deepEqual(exactEventReviewLeaseDispositionForTest(base, revision), {
    status: "legacy_tupleless",
    reason: "local report has no durable lease identity",
  });
  assert.deepEqual(exactEventReviewLeaseDispositionForTest(base, "f".repeat(40)), {
    status: "source_drift",
    reportRevision: revision,
    liveRevision: "f".repeat(40),
  });
  assert.deepEqual(
    exactEventReviewLeaseDispositionForTest(
      `---\nitem_source_revision: ${revision}\nreview_lease_owner: run-123\nreview_lease_comment_id: 99\n---\n`,
      revision,
    ),
    { status: "current" },
  );
});

test("reserved exact-review leases compare a head only for pull requests", () => {
  const revision = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(reviewLeaseStillMatchesContextForTest("issue", null, revision), true);
  assert.equal(reviewLeaseStillMatchesContextForTest("pull_request", revision, revision), true);
  assert.equal(
    reviewLeaseStillMatchesContextForTest("pull_request", "f".repeat(40), revision),
    false,
  );
});

test("only the exact supplied lease is externally owned", () => {
  const supplied = { owner: "exact-issue-123", commentId: 456 };
  assert.equal(isSuppliedReviewStartLeaseForTest(supplied, supplied), true);
  assert.equal(
    isSuppliedReviewStartLeaseForTest(supplied, { owner: supplied.owner, commentId: 457 }),
    false,
  );
  assert.equal(
    isSuppliedReviewStartLeaseForTest(supplied, { owner: "shard-123", commentId: 456 }),
    false,
  );
});

test("reserve-review-lease hydrates a legacy queue claim without cross-head cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-reserve-lease-"));
  const binDir = join(root, "bin");
  const ghPath = join(binDir, "gh.js");
  const curlPath = join(binDir, "curl");
  const leasePath = join(root, "lease.json");
  const deleteLogPath = join(root, "deletes.log");
  const curlLogPath = join(root, "curl.log");
  const headSha = "0123456789abcdef0123456789abcdef01234567";
  const oldHeadSha = "f".repeat(40);
  try {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      ghPath,
      `
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const leasePath = ${JSON.stringify(leasePath)};
const deleteLogPath = ${JSON.stringify(deleteLogPath)};
const headSha = ${JSON.stringify(headSha)};
const oldHeadSha = ${JSON.stringify(oldHeadSha)};
const leaseExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
const args = process.argv.slice(2);
const path = args[1] || "";
const oldLease = {
  id: 9990,
  html_url: "https://github.com/openclaw/openclaw/pull/357#issuecomment-9990",
  created_at: "2026-07-15T00:00:00Z",
  updated_at: "2026-07-15T00:00:00Z",
  user: { login: "clawsweeper[bot]" },
  body: [
    "ClawSweeper status: review started.",
    \`<!-- clawsweeper-review-status:started item=357 sha=\${oldHeadSha} started_at=2026-07-15T00:00:00.000Z lease_expires_at=\${leaseExpiresAt} owner=github-run-998-1 v=1 -->\`,
    "<!-- clawsweeper-review-lease item=357 -->",
  ].join("\\n"),
};
const comments = () => existsSync(leasePath)
  ? [oldLease, JSON.parse(readFileSync(leasePath, "utf8"))]
  : [oldLease];
if (args[0] === "api" && path === "repos/openclaw/openclaw/issues/357") {
  console.log(JSON.stringify({
    number: 357,
    title: "Reserve durable exact review lease",
    html_url: "https://github.com/openclaw/openclaw/pull/357",
    created_at: "2026-07-15T00:00:00Z",
    updated_at: "2026-07-15T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    pull_request: {}
  }));
} else if (args[0] === "api" && path === "repos/openclaw/openclaw/pulls/357") {
  console.log(JSON.stringify({ head: { sha: headSha } }));
} else if (args[0] === "api" && path.startsWith("repos/openclaw/openclaw/issues/357/comments") && !args.includes("--method")) {
  const value = comments();
  console.log(JSON.stringify(args.includes("--slurp") ? [value] : value));
} else if (args[0] === "api" && path === "repos/openclaw/openclaw/issues/357/comments" && args.includes("--method")) {
  const body = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8")).body;
  const lease = {
    id: 9991,
    html_url: "https://github.com/openclaw/openclaw/pull/357#issuecomment-9991",
    created_at: "2026-07-15T00:00:00Z",
    updated_at: "2026-07-15T00:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body
  };
  writeFileSync(leasePath, JSON.stringify(lease));
  console.log(JSON.stringify(lease));
} else if (args[0] === "api" && /repos\\/openclaw\\/openclaw\\/issues\\/comments\\/\\d+$/.test(path) && args.includes("DELETE")) {
  appendFileSync(deleteLogPath, path + "\\n");
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`,
      "utf8",
    );
    writeFileSync(
      curlPath,
      `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(curlLogPath)}, process.argv.slice(2).join(" ") + "\\n");
process.stdout.write("200");
`,
      "utf8",
    );
    chmodSync(curlPath, 0o755);
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "reserve-review-lease",
        "--target-repo",
        "openclaw/openclaw",
        "--item-number",
        "357",
        "--review-timeout-ms",
        "600000",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...mockGhBinEnv(ghPath, binDir),
          GITHUB_RUN_ID: "999",
          GITHUB_RUN_ATTEMPT: "1",
          EXACT_REVIEW_QUEUE_URL: "https://queue.example.invalid",
          EXACT_REVIEW_ITEM_KEY: "openclaw/openclaw#357",
          EXACT_REVIEW_LEASE_ID: "lease-357",
          EXACT_REVIEW_LEASE_REVISION: "1",
          EXACT_REVIEW_CLAIM_GENERATION: "1",
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const reservation = JSON.parse(result.stdout);
    assert.equal(reservation.status, "posted");
    assert.match(reservation.owner, /^[a-zA-Z0-9._-]{1,200}$/);
    assert.equal(reservation.commentId, 9991);
    assert.equal(reservation.headSha, headSha);
    const lease = JSON.parse(readFileSync(leasePath, "utf8"));
    assert.match(lease.body, /clawsweeper-review-status:started/);
    assert.match(lease.body, /clawsweeper-review-lease item=357/);
    assert.match(lease.body, new RegExp(`sha=${headSha}`));
    assert.match(readFileSync(curlLogPath, "utf8"), new RegExp(`source_head_sha.*${headSha}`));
    assert.equal(existsSync(deleteLogPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reserve-review-lease completes as superseded when the item closed after enqueue", () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-reserve-lease-closed-"));
  const binDir = join(root, "bin");
  const ghPath = join(binDir, "gh.js");
  const leasePath = join(root, "lease.json");
  try {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      ghPath,
      `
const { readFileSync, writeFileSync } = require("node:fs");
const leasePath = ${JSON.stringify(leasePath)};
const args = process.argv.slice(2);
const path = args[1] || "";
if (args[0] === "api" && path === "repos/openclaw/openclaw/issues/357") {
  console.log(JSON.stringify({
    number: 357,
    title: "Closed before review",
    html_url: "https://github.com/openclaw/openclaw/pull/357",
    created_at: "2026-07-15T00:00:00Z",
    updated_at: "2026-07-15T00:00:00Z",
    closed_at: "2026-07-16T00:00:00Z",
    state: "closed",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    pull_request: {}
  }));
} else if (args[0] === "api" && path === "repos/openclaw/openclaw/issues/357/comments" && args.includes("--method")) {
  writeFileSync(leasePath, readFileSync(args[args.indexOf("--input") + 1], "utf8"));
  console.log(JSON.stringify({ id: 9993 }));
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`,
      "utf8",
    );
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "reserve-review-lease",
        "--target-repo",
        "openclaw/openclaw",
        "--item-number",
        "357",
        "--review-timeout-ms",
        "600000",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...mockGhBinEnv(ghPath, binDir),
          GITHUB_RUN_ID: "999",
          GITHUB_RUN_ATTEMPT: "1",
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const reservation = JSON.parse(result.stdout);
    assert.equal(reservation.status, "superseded");
    assert.equal(reservation.reason, "item_not_open");
    assert.equal(reservation.state, "closed");
    assert.equal(existsSync(leasePath), false, "no lease comment may be posted for closed items");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reserve-review-lease completes as superseded when the PR head drifted past the queue authority", () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-reserve-lease-drift-"));
  const binDir = join(root, "bin");
  const ghPath = join(binDir, "gh.js");
  const leasePath = join(root, "lease.json");
  const headSha = "0123456789abcdef0123456789abcdef01234567";
  const queuedHeadSha = "f".repeat(40);
  try {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      ghPath,
      `
const { readFileSync, writeFileSync } = require("node:fs");
const leasePath = ${JSON.stringify(leasePath)};
const headSha = ${JSON.stringify(headSha)};
const args = process.argv.slice(2);
const path = args[1] || "";
if (args[0] === "api" && path === "repos/openclaw/openclaw/issues/357") {
  console.log(JSON.stringify({
    number: 357,
    title: "Reserve durable exact review lease",
    html_url: "https://github.com/openclaw/openclaw/pull/357",
    created_at: "2026-07-15T00:00:00Z",
    updated_at: "2026-07-15T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    pull_request: {}
  }));
} else if (args[0] === "api" && path === "repos/openclaw/openclaw/pulls/357") {
  console.log(JSON.stringify({ head: { sha: headSha } }));
} else if (args[0] === "api" && path === "repos/openclaw/openclaw/issues/357/comments" && args.includes("--method")) {
  writeFileSync(leasePath, readFileSync(args[args.indexOf("--input") + 1], "utf8"));
  console.log(JSON.stringify({ id: 9992 }));
} else if (args[0] === "api" && path.startsWith("repos/openclaw/openclaw/issues/357/comments")) {
  console.log(JSON.stringify(args.includes("--slurp") ? [[]] : []));
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`,
      "utf8",
    );
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "reserve-review-lease",
        "--target-repo",
        "openclaw/openclaw",
        "--item-number",
        "357",
        "--review-timeout-ms",
        "600000",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...mockGhBinEnv(ghPath, binDir),
          GITHUB_RUN_ID: "999",
          GITHUB_RUN_ATTEMPT: "1",
          EXACT_REVIEW_QUEUE_URL: "https://queue.example.invalid",
          EXACT_REVIEW_ITEM_KEY: "openclaw/openclaw#357",
          EXACT_REVIEW_LEASE_ID: "lease-357",
          EXACT_REVIEW_LEASE_REVISION: "1",
          EXACT_REVIEW_CLAIM_GENERATION: "1",
          EXACT_REVIEW_SOURCE_HEAD_SHA: queuedHeadSha,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const reservation = JSON.parse(result.stdout);
    assert.equal(reservation.status, "superseded");
    assert.equal(reservation.reason, "source_head_drift");
    assert.match(result.stderr, /does not match the current pull request head/);
    assert.equal(existsSync(leasePath), false, "no lease comment may be posted on drift");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reserve-review-lease stale A preserves newer-head lease B", () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-reserve-lease-race-"));
  const binDir = join(root, "bin");
  const ghPath = join(binDir, "gh.js");
  const curlPath = join(binDir, "curl");
  const postedPath = join(root, "posted.json");
  const pullCountPath = join(root, "pull-count.txt");
  const deleteLogPath = join(root, "deletes.log");
  const curlLogPath = join(root, "curl.log");
  const staleHead = "a".repeat(40);
  const newerHead = "b".repeat(40);
  try {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      ghPath,
      `
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const postedPath = ${JSON.stringify(postedPath)};
const pullCountPath = ${JSON.stringify(pullCountPath)};
const deleteLogPath = ${JSON.stringify(deleteLogPath)};
const staleHead = ${JSON.stringify(staleHead)};
const newerHead = ${JSON.stringify(newerHead)};
const leaseExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
const args = process.argv.slice(2);
const path = args[1] || "";
const newerLease = {
  id: 9992,
  html_url: "https://github.com/openclaw/openclaw/pull/357#issuecomment-9992",
  created_at: "2026-07-23T13:00:02Z",
  updated_at: "2026-07-23T13:00:02Z",
  user: { login: "clawsweeper[bot]" },
  body: [
    "ClawSweeper status: review started.",
    \`<!-- clawsweeper-review-status:started item=357 sha=\${newerHead} started_at=2026-07-23T13:00:02.000Z lease_expires_at=\${leaseExpiresAt} owner=github-run-222-1 v=1 -->\`,
    "<!-- clawsweeper-review-lease item=357 -->",
  ].join("\\n"),
};
const comments = () => existsSync(postedPath)
  ? [JSON.parse(readFileSync(postedPath, "utf8")), newerLease]
  : [];
if (args[0] === "api" && path === "repos/openclaw/openclaw/issues/357") {
  console.log(JSON.stringify({
    number: 357,
    title: "Fence stale review cleanup",
    html_url: "https://github.com/openclaw/openclaw/pull/357",
    created_at: "2026-07-23T12:00:00Z",
    updated_at: "2026-07-23T13:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    pull_request: {}
  }));
} else if (args[0] === "api" && path === "repos/openclaw/openclaw/pulls/357") {
  const count = existsSync(pullCountPath) ? Number(readFileSync(pullCountPath, "utf8")) : 0;
  writeFileSync(pullCountPath, String(count + 1));
  console.log(JSON.stringify({ head: { sha: count < 2 ? staleHead : newerHead } }));
} else if (args[0] === "api" && path.startsWith("repos/openclaw/openclaw/issues/357/comments") && !args.includes("--method")) {
  const value = comments();
  console.log(JSON.stringify(args.includes("--slurp") ? [value] : value));
} else if (args[0] === "api" && path === "repos/openclaw/openclaw/issues/357/comments" && args.includes("POST")) {
  const body = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8")).body;
  const lease = {
    id: 9991,
    html_url: "https://github.com/openclaw/openclaw/pull/357#issuecomment-9991",
    created_at: "2026-07-23T13:00:01Z",
    updated_at: "2026-07-23T13:00:01Z",
    user: { login: "clawsweeper[bot]" },
    body
  };
  writeFileSync(postedPath, JSON.stringify(lease));
  console.log(JSON.stringify(lease));
} else if (args[0] === "api" && /repos\\/openclaw\\/openclaw\\/issues\\/comments\\/\\d+$/.test(path) && args.includes("DELETE")) {
  appendFileSync(deleteLogPath, path + "\\n");
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`,
      "utf8",
    );
    writeFileSync(
      curlPath,
      `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(curlLogPath)}, process.argv.slice(2).join(" ") + "\\n");
process.stdout.write("200");
`,
      "utf8",
    );
    chmodSync(curlPath, 0o755);

    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "reserve-review-lease",
        "--target-repo",
        "openclaw/openclaw",
        "--item-number",
        "357",
        "--review-timeout-ms",
        "600000",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...mockGhBinEnv(ghPath, binDir),
          GITHUB_RUN_ID: "111",
          GITHUB_RUN_ATTEMPT: "1",
          EXACT_REVIEW_QUEUE_URL: "https://queue.example.invalid",
          EXACT_REVIEW_ITEM_KEY: "openclaw/openclaw#357",
          EXACT_REVIEW_LEASE_ID: "lease-357",
          EXACT_REVIEW_LEASE_REVISION: "1",
          EXACT_REVIEW_CLAIM_GENERATION: "1",
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /review revision changed while reserving #357/);
    assert.deepEqual(readFileSync(deleteLogPath, "utf8").trim().split("\n"), [
      "repos/openclaw/openclaw/issues/comments/9991",
    ]);
    assert.match(readFileSync(curlLogPath, "utf8"), new RegExp(`source_head_sha.*${staleHead}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed local review checkout preserves base ancestry for a merged pull request", () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-"));
  const origin = join(root, "origin.git");
  const source = join(root, "source");
  const targetDir = join(root, "artifacts", "local-review-357", "target");
  try {
    execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
    execFileSync("git", ["init", source], { stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "clawsweeper@example.com"], { cwd: source });
    execFileSync("git", ["config", "user.name", "ClawSweeper Test"], { cwd: source });
    writeFileSync(join(source, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: source });
    execFileSync("git", ["commit", "-m", "base"], { cwd: source, stdio: "ignore" });
    execFileSync("git", ["branch", "-M", "main"], { cwd: source });
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: source });
    execFileSync("git", ["push", "origin", "main"], { cwd: source, stdio: "ignore" });
    execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: origin });

    execFileSync("git", ["checkout", "-b", "feature"], { cwd: source, stdio: "ignore" });
    writeFileSync(join(source, "feature.txt"), "from pr\n");
    execFileSync("git", ["add", "feature.txt"], { cwd: source });
    execFileSync("git", ["commit", "-m", "feature"], { cwd: source, stdio: "ignore" });
    for (let index = 0; index < 60; index += 1) {
      writeFileSync(join(source, "feature.txt"), `feature ${index}\n`);
      execFileSync("git", ["commit", "-am", `feature ${index}`], {
        cwd: source,
        stdio: "ignore",
      });
    }

    execFileSync("git", ["checkout", "main"], { cwd: source, stdio: "ignore" });
    for (let index = 0; index < 60; index += 1) {
      writeFileSync(join(source, "history.txt"), `base ${index}\n`);
      execFileSync("git", ["add", "history.txt"], { cwd: source });
      execFileSync("git", ["commit", "-m", `base ${index}`], { cwd: source, stdio: "ignore" });
    }
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: source,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["push", "origin", "main"], { cwd: source, stdio: "ignore" });

    execFileSync("git", ["checkout", "feature"], { cwd: source, stdio: "ignore" });
    execFileSync("git", ["merge", "--no-ff", "main", "-m", "merge main"], {
      cwd: source,
      stdio: "ignore",
    });
    const pullSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: source,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["push", "origin", "HEAD:refs/pull/357/head"], {
      cwd: source,
      stdio: "ignore",
    });

    mkdirSync(join(root, "artifacts", "local-review-357"), { recursive: true });
    execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout", origin, targetDir], {
      stdio: "ignore",
    });
    execFileSync("git", ["fetch", "origin", "refs/pull/357/head", "--depth=50"], {
      cwd: targetDir,
      stdio: "ignore",
    });
    assert.equal(
      execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
        cwd: targetDir,
        encoding: "utf8",
      }).trim(),
      "true",
    );
    assert.equal(reviewMergeBase(targetDir, baseSha, pullSha).status, "unavailable");

    prepareManagedLocalReviewCheckoutForTest({
      baseBranch: "main",
      cloneUrl: origin,
      itemNumber: 357,
      targetDir,
      targetRepo: "openclaw/openclaw",
    });

    assert.equal(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: targetDir,
        encoding: "utf8",
      }).trim(),
      "clawsweeper/pr-357",
    );
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetDir, encoding: "utf8" }).trim(),
      pullSha,
    );
    assert.equal(
      Number(
        execFileSync("git", ["rev-list", "--count", baseSha], {
          cwd: targetDir,
          encoding: "utf8",
        }).trim(),
      ),
      61,
    );
    assert.equal(reviewMergeBase(targetDir, baseSha, pullSha).status, "verified");
    assert.equal(
      execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
        cwd: targetDir,
        encoding: "utf8",
      }).trim(),
      "false",
    );
    assert.ok(existsSync(join(targetDir, "feature.txt")));
    assert.equal(normalizeLf(readFileSync(join(targetDir, "feature.txt"), "utf8")), "feature 59\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local exact review explains when GitHub item is not open", () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-"));
  const origin = join(root, "origin.git");
  const targetDir = join(root, "target");
  const artifactDir = join(root, "artifacts");
  const binDir = join(root, "bin");
  try {
    execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
    execFileSync("git", ["init", targetDir], { stdio: "ignore" });
    execFileSync("git", ["config", "--local", "fetch.prune", "true"], { cwd: targetDir });
    execFileSync("git", ["config", "user.email", "clawsweeper@example.com"], { cwd: targetDir });
    execFileSync("git", ["config", "user.name", "ClawSweeper Test"], { cwd: targetDir });
    writeFileSync(join(targetDir, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: targetDir });
    execFileSync("git", ["commit", "-m", "base"], { cwd: targetDir, stdio: "ignore" });
    execFileSync("git", ["branch", "-M", "main"], { cwd: targetDir });
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: targetDir });
    execFileSync("git", ["push", "origin", "main"], { cwd: targetDir, stdio: "ignore" });
    mkdirSync(binDir);
    const ghPath = join(binDir, "gh.js");
    writeFileSync(
      ghPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "repos/openclaw/openclaw/issues/357") {
  console.log(JSON.stringify({
    number: 357,
    title: "Closed local review test",
    html_url: "https://github.com/openclaw/openclaw/pull/357",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    closed_at: "2026-01-03T00:00:00Z",
    state: "closed",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "author" },
    labels: [],
    pull_request: {}
  }));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "repos/openclaw/openclaw/pulls/357") {
  process.exit(1);
}
if (args[0] === "release" && args[1] === "view") {
  process.exit(1);
}
console.error("unexpected gh args " + JSON.stringify(args));
process.exit(1);
`,
    );
    chmodSync(ghPath, 0o755);

    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "review",
        "--local-only",
        "--target-dir",
        targetDir,
        "--item-number",
        "357",
        "--artifact-dir",
        artifactDir,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...mockGhBinEnv(ghPath),
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Local ClawSweeper review for openclaw\/openclaw#357/);
    assert.match(result.stderr, /Preparing target checkout/);
    assert.match(result.stderr, /mode: supplied checkout/);
    assert.match(result.stderr, /Loading review item/);
    assert.match(result.stderr, /Error: No review was run for openclaw\/openclaw#357/);
    assert.match(result.stderr, /GitHub reports this PR is closed/);
    assert.doesNotMatch(result.stderr, /selected=0/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
    assert.equal(
      execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], {
        cwd: targetDir,
        encoding: "utf8",
      }),
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetDir, encoding: "utf8" }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local exact review selects PATH Codex instead of the Desktop app binary", () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-"));
  const origin = join(root, "origin.git");
  const targetDir = join(root, "target");
  const artifactDir = join(root, "artifacts");
  const binDir = join(root, "bin");
  const localAppData = join(root, "local-app-data");
  const codexMarker = join(root, "path-codex-ran.txt");
  const missingHeadArtifactDir = join(root, "missing-head-artifacts");
  try {
    execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
    execFileSync("git", ["init", targetDir], { stdio: "ignore" });
    execFileSync("git", ["config", "--local", "fetch.prune", "false"], { cwd: targetDir });
    execFileSync("git", ["config", "user.email", "clawsweeper@example.com"], { cwd: targetDir });
    execFileSync("git", ["config", "user.name", "ClawSweeper Test"], { cwd: targetDir });
    writeFileSync(join(targetDir, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: targetDir });
    execFileSync("git", ["commit", "-m", "base"], { cwd: targetDir, stdio: "ignore" });
    execFileSync("git", ["branch", "-M", "main"], { cwd: targetDir });
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: targetDir });
    execFileSync("git", ["push", "origin", "main"], { cwd: targetDir, stdio: "ignore" });
    execFileSync("git", ["config", "remote.origin.prune", "true"], { cwd: targetDir });
    const reviewHeadSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: targetDir,
      encoding: "utf8",
    }).trim();

    mkdirSync(binDir);
    writeFakeScanner(binDir);
    const ghPath = join(binDir, "gh.js");
    writeFileSync(
      ghPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const issue = {
  number: 96221,
  title: "Open local review test",
  html_url: "https://github.com/openclaw/openclaw/pull/96221",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  closed_at: null,
  state: "open",
  locked: false,
  active_lock_reason: null,
  author_association: "CONTRIBUTOR",
  comments: 0,
  user: { login: "author" },
  labels: [],
  pull_request: {}
};
const pull = {
  number: 96221,
  title: issue.title,
  html_url: issue.html_url,
  state: "open",
  draft: false,
  merged: false,
  merge_commit_sha: ${JSON.stringify(reviewHeadSha)},
  mergeable: true,
  mergeable_state: "clean",
  user: { login: "author" },
  head: { ref: "feature", sha: process.env.REVIEW_HEAD_SHA || ${JSON.stringify(reviewHeadSha)} },
  base: { ref: "main", sha: ${JSON.stringify(reviewHeadSha)} },
  additions: 1,
  deletions: 0,
  changed_files: 0,
  commits: 0,
  review_comments: 0,
  created_at: issue.created_at,
  updated_at: issue.updated_at,
  body: "body"
};
if (args[0] === "api" && args[1] === "repos/openclaw/openclaw/issues/96221") {
  console.log(JSON.stringify(issue));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "repos/openclaw/openclaw/pulls/96221") {
  console.log(JSON.stringify(pull));
  process.exit(0);
}
if (
  args[0] === "api" &&
  (
    args[1].startsWith("repos/openclaw/openclaw/pulls/96221/reviews") ||
    args[1].startsWith("repos/openclaw/openclaw/pulls/96221/comments")
  )
) {
  console.log(JSON.stringify([[]]));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "-i" && args[2].startsWith("repos/openclaw/openclaw/issues/96221/timeline")) {
  process.stdout.write("HTTP/2 200\\nlink: <https://api.github.test?page=1>; rel=\\"last\\"\\n\\n[]");
  process.exit(0);
}
if (args[0] === "release" && args[1] === "view") {
  process.exit(1);
}
console.error("unexpected gh args " + JSON.stringify(args));
process.exit(1);
`,
    );
    chmodSync(ghPath, 0o755);

    const codexPath = join(binDir, "codex");
    const desktopCodexDir = join(localAppData, "OpenAI", "Codex", "bin");
    mkdirSync(desktopCodexDir, { recursive: true });
    writeFileSync(join(desktopCodexDir, "codex.exe"), "");
    writeFileSync(
      codexPath,
      `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(codexMarker)}, "path\\n");
process.stdin.resume();
process.stdin.on("end", () => process.exit(1));
`,
    );
    chmodSync(codexPath, 0o755);

    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "review",
        "--local-only",
        "--target-dir",
        targetDir,
        "--item-number",
        "96221",
        "--artifact-dir",
        artifactDir,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          LOCALAPPDATA: localAppData,
          ...mockGhBinEnv(ghPath),
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Running Codex review/);
    assert.match(result.stderr, /timeout: /);
    assert.match(result.stderr, /stdout: .*96221\.1\.codex\.stdout\.log/);
    assert.match(result.stderr, /stderr: .*96221\.1\.codex\.stderr\.log/);
    assert.match(result.stderr, /Codex review failed/);
    assert.match(result.stderr, /report: .*96221\.md/);
    assert.match(result.stderr, /Error: Codex failed for 1 item/);
    assert.match(result.stderr, /Reports?: .*96221\.md/);
    assert.doesNotMatch(result.stderr, /Review complete/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
    assert.match(readFileSync(join(artifactDir, "96221.md"), "utf8"), /review_status: failed/);
    assert.equal(readFileSync(codexMarker, "utf8"), "path\n");

    rmSync(codexMarker);
    const missingHeadResult = spawnSync(
      process.execPath,
      [
        CLI,
        "review",
        "--local-only",
        "--target-dir",
        targetDir,
        "--item-number",
        "96221",
        "--artifact-dir",
        missingHeadArtifactDir,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          LOCALAPPDATA: localAppData,
          REVIEW_HEAD_SHA: "f".repeat(40),
          ...mockGhBinEnv(ghPath),
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    assert.equal(missingHeadResult.status, 1);
    assert.equal(existsSync(codexMarker), false);
    assert.match(missingHeadResult.stderr, /Codex review failed/);
    const missingHeadReport = readFileSync(join(missingHeadArtifactDir, "96221.md"), "utf8");
    assert.match(missingHeadReport, /^review_status: failed$/m);
    assert.match(missingHeadReport, /^review_checkout_inspection_failed: true$/m);
    assert.match(missingHeadReport, /^local_checkout_access: unverified$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function normalizeLf(value: string): string {
  return value.replace(/\r\n/g, "\n");
}
