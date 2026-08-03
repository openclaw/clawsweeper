import assert from "node:assert/strict";
import test from "node:test";

import { createRegressionProvenanceVerifier } from "../dist/clawsweeper-regression-provenance.js";

const mergeSha = "a".repeat(40);
const reviewedSha = "b".repeat(40);
const otherSha = "c".repeat(40);

function candidate(overrides = {}) {
  return {
    repo: "openclaw/clawsweeper",
    pullRequestNumber: 936,
    pullRequestUrl: "https://github.com/openclaw/clawsweeper/pull/936",
    mergeCommitSha: mergeSha,
    sourcePath: "src/clawsweeper-review-runtime.ts",
    sourceLine: 42,
    ...overrides,
  };
}

function mergedPull(overrides = {}) {
  return {
    number: 936,
    html_url: "https://github.com/openclaw/clawsweeper/pull/936",
    merged: true,
    merged_at: "2026-07-31T12:00:00Z",
    merge_commit_sha: mergeSha,
    base: { ref: "main" },
    ...overrides,
  };
}

function verify(
  options: {
    candidate?: ReturnType<typeof candidate> | null;
    pull?: unknown;
    git?: (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => string;
  } = {},
) {
  const gitCalls: Array<{ args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv } }> = [];
  let pullCalls = 0;
  const verifier = createRegressionProvenanceVerifier({
    fetchPull: () => {
      pullCalls += 1;
      return options.pull ?? mergedPull();
    },
    runGit: (args, invocation) => {
      gitCalls.push({ args, options: invocation });
      if (options.git) return options.git(args, invocation);
      if (args[0] === "rev-parse") return `${reviewedSha}\n`;
      if (args[0] === "blame") return `${mergeSha} 42 42 1\nauthor test\n`;
      return "src/clawsweeper-review-runtime.ts\n";
    },
  });
  return {
    result: verifier.verify({
      candidate: options.candidate ?? candidate(),
      item: { repo: "openclaw/clawsweeper", number: 946 },
      checkoutDir: "/read-only/checkout",
      targetBranch: "main",
      reviewedCommitShas: [reviewedSha],
    }),
    gitCalls,
    pullCalls,
  };
}

test("regression provenance publishes only an exact blame-to-merge match", () => {
  const { result, pullCalls, gitCalls } = verify();

  assert.deepEqual(result, {
    ...candidate(),
    evidenceType: "blame_to_merge_commit",
    mergedAt: "2026-07-31T12:00:00Z",
    reviewedCommitSha: reviewedSha,
  });
  assert.equal(pullCalls, 1);
  assert.deepEqual(
    gitCalls.map(({ args }) => args),
    [
      ["rev-parse", "--verify", "HEAD"],
      ["ls-files", "--error-unmatch", "--", "src/clawsweeper-review-runtime.ts"],
      [
        "blame",
        "--line-porcelain",
        "-L",
        "42,42",
        reviewedSha,
        "--",
        "src/clawsweeper-review-runtime.ts",
      ],
    ],
  );
  for (const { options } of gitCalls) {
    assert.equal(options.cwd, "/read-only/checkout");
    assert.equal(options.env.GIT_NO_LAZY_FETCH, "1");
    assert.equal(options.env.GIT_OPTIONAL_LOCKS, "0");
  }
});

test("regression provenance rejects malformed or self candidates before metadata or Git", () => {
  for (const invalid of [
    candidate({ sourcePath: "../secrets" }),
    candidate({ sourcePath: "C:/secrets" }),
    candidate({ pullRequestNumber: 946 }),
    candidate({ pullRequestUrl: "https://github.com/openclaw/other/pull/936" }),
    candidate({ mergeCommitSha: "short" }),
  ]) {
    const { result, pullCalls, gitCalls } = verify({ candidate: invalid });
    assert.equal(result, null);
    assert.equal(pullCalls, 0);
    assert.equal(gitCalls.length, 0);
  }
});

test("regression provenance omits stale, shallow, incorrect, and unavailable history hypotheses", () => {
  const stale = verify({
    git: (args) => {
      if (args[0] === "rev-parse") return reviewedSha;
      if (args[0] === "blame") return `${otherSha} 42 42 1\n`;
      return "src/clawsweeper-review-runtime.ts\n";
    },
  });
  assert.equal(stale.result, null);
  assert.equal(stale.pullCalls, 1);
  assert.equal(stale.gitCalls.length, 3);

  const shallow = verify({
    git: (args) => {
      if (args[0] === "rev-parse") return reviewedSha;
      if (args[0] === "blame") return `${mergeSha} 42 42 1\nboundary\n`;
      return "src/clawsweeper-review-runtime.ts\n";
    },
  });
  assert.equal(shallow.result, null);
  assert.equal(shallow.pullCalls, 1);
  assert.equal(shallow.gitCalls.length, 3);

  const unmerged = verify({ pull: mergedPull({ merged: false, merged_at: null }) });
  assert.equal(unmerged.result, null);
  assert.equal(unmerged.pullCalls, 1);
  assert.equal(unmerged.gitCalls.length, 0);

  const unavailable = verify({
    git: (args) => {
      if (args[0] === "rev-parse") throw new Error("missing partial-clone blob");
      return "";
    },
  });
  assert.equal(unavailable.result, null);
  assert.equal(unavailable.pullCalls, 1);
  assert.equal(unavailable.gitCalls.length, 1);
  assert.equal(unavailable.gitCalls[0]?.options.env.GIT_NO_LAZY_FETCH, "1");
});

test("regression provenance treats missing local blame history as unknown without fetching", () => {
  const missingHistory = verify({
    git: (args) => {
      if (args[0] === "rev-parse") return reviewedSha;
      if (args[0] === "blame") throw new Error("missing partial-clone parent blob");
      return "src/clawsweeper-review-runtime.ts\n";
    },
  });

  assert.equal(missingHistory.result, null);
  assert.deepEqual(
    missingHistory.gitCalls.map(({ args }) => args),
    [
      ["rev-parse", "--verify", "HEAD"],
      ["ls-files", "--error-unmatch", "--", "src/clawsweeper-review-runtime.ts"],
      [
        "blame",
        "--line-porcelain",
        "-L",
        "42,42",
        reviewedSha,
        "--",
        "src/clawsweeper-review-runtime.ts",
      ],
    ],
  );
  for (const { options } of missingHistory.gitCalls) {
    assert.equal(options.env.GIT_NO_LAZY_FETCH, "1");
  }
});

test("regression provenance refuses a checkout that differs from the reported revision", () => {
  const mismatch = verify({
    git: (args) => {
      if (args[0] === "rev-parse") return otherSha;
      return "";
    },
  });

  assert.equal(mismatch.result, null);
  assert.equal(mismatch.pullCalls, 1);
  assert.deepEqual(
    mismatch.gitCalls.map(({ args }) => args),
    [["rev-parse", "--verify", "HEAD"]],
  );
});

test("regression provenance permits an exact recorded PR-head checkout", () => {
  const prHead = "d".repeat(40);
  const gitCalls: string[][] = [];
  const verifier = createRegressionProvenanceVerifier({
    fetchPull: () => mergedPull(),
    runGit: (args) => {
      gitCalls.push(args);
      if (args[0] === "rev-parse") return prHead;
      if (args[0] === "blame") return `${mergeSha} 42 42 1\n`;
      return "src/clawsweeper-review-runtime.ts\n";
    },
  });

  const result = verifier.verify({
    candidate: candidate(),
    item: { repo: "openclaw/clawsweeper", number: 946 },
    checkoutDir: "/managed-pr-head",
    targetBranch: "main",
    reviewedCommitShas: [reviewedSha, prHead],
  });

  assert.equal(result?.reviewedCommitSha, prHead);
  assert.equal(gitCalls[2]?.[4], prHead);
});
