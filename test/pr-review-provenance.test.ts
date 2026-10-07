import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reviewPromptForTest } from "../dist/clawsweeper.js";
import {
  buildProvenanceEvidence,
  commitPullRequest,
  createCommitPullResolver,
  parseBlamePorcelain,
  pullRequestProvenanceEvidence,
  selectProvenanceHunks,
  type ProvenanceEvidence,
  type ProvenanceGitRead,
} from "../dist/pr-review-provenance.js";
import { ReviewGitError } from "../dist/clawsweeper-review-blobs.js";
import { git as reviewGit, item } from "./helpers.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const ROOT = "c".repeat(40);
const ZERO = "0".repeat(40);
const MERGE_BASE = "1".repeat(40);
const HEAD = "2".repeat(40);

function fileDiff(path: string, hunks: string[], from = `a/${path}`): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- ${from}`,
    `+++ b/${path}`,
    ...hunks,
  ].join("\n");
}

function hunk(start: number, removed: number, added: number): string {
  return [
    `@@ -${start},${removed} +${start},${added} @@`,
    ...Array.from({ length: removed }, (_, index) => `-old ${index}`),
    ...Array.from({ length: added }, (_, index) => `+new ${index}`),
  ].join("\n");
}

const samplePatch = [
  fileDiff("src/new.ts", [hunk(0, 0, 3)], "/dev/null"),
  fileDiff("src/added-only.ts", ["@@ -4,0 +5,2 @@", "+a", "+b"]),
  [
    "diff --git a/src/gone.ts b/src/gone.ts",
    "deleted file mode 100644",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -1,3 +0,0 @@",
    // Removed content that looks like a file header must not switch files.
    "--- a/src/evil.ts",
    "-two",
    "-three",
    "\\ No newline at end of file",
  ].join("\n"),
  fileDiff("src/many.ts", [
    hunk(10, 1, 1),
    hunk(20, 5, 0),
    hunk(40, 2, 2),
    hunk(60, 6, 1),
    hunk(80, 1, 0),
    hunk(90, 4, 4),
  ]),
  fileDiff('"src/quoted\\tname.ts"', [hunk(1, 9, 9)], '"a/src/quoted\\tname.ts"'),
].join("\n");

test("hunk selection keeps modified base ranges and insertion context on existing files", () => {
  const { hunks, omitted } = selectProvenanceHunks(samplePatch);
  assert.deepEqual(hunks, [
    { path: "src/many.ts", start: 20, end: 24, change: "modified" },
    { path: "src/many.ts", start: 40, end: 41, change: "modified" },
    { path: "src/many.ts", start: 60, end: 65, change: "modified" },
    { path: "src/many.ts", start: 90, end: 93, change: "modified" },
    { path: "src/gone.ts", start: 1, end: 3, change: "modified" },
    { path: "src/added-only.ts", start: 3, end: 5, change: "insertion_context" },
  ]);
  assert.equal(omitted, 2);
});

test("pure insertions blame up to three unchanged base lines around the insertion point", () => {
  const patch = fileDiff("src/ins.ts", [
    "@@ -0,0 +1,2 @@",
    "+top",
    "+top",
    "@@ -1,0 +4 @@",
    "+after first",
    "@@ -10,0 +14,3 @@",
    "+x",
    "+y",
    "+z",
    "@@ -20 +23 @@",
    "-old",
    "+new",
  ]);
  assert.deepEqual(
    selectProvenanceHunks(patch).hunks.map(({ start, end, change }) => `${start}-${end} ${change}`),
    ["1-1 insertion_context", "1-2 insertion_context", "9-11 insertion_context", "20-20 modified"],
  );
  // Modified lines outrank insertions under the per-file hunk cap.
  const capped = fileDiff("src/cap.ts", [
    "@@ -1,0 +2,9 @@",
    ...Array.from({ length: 9 }, () => "+n"),
    hunk(10, 1, 0),
    hunk(20, 1, 0),
    hunk(30, 1, 0),
    hunk(40, 1, 0),
  ]);
  const { hunks, omitted } = selectProvenanceHunks(capped);
  assert.deepEqual(
    hunks.map(({ start }) => start),
    [10, 20, 30, 40],
  );
  assert.equal(omitted, 1);
});

test("hunk selection caps files by most modified base lines", () => {
  const patch = Array.from({ length: 14 }, (_, index) =>
    fileDiff(`src/f${String(index).padStart(2, "0")}.ts`, [hunk(1, index + 1, 0)]),
  ).join("\n");
  const { hunks, omitted } = selectProvenanceHunks(patch);
  assert.equal(hunks.length, 12);
  assert.equal(omitted, 2);
  assert.equal(hunks[0]!.path, "src/f13.ts");
  assert.ok(!hunks.some((entry) => entry.path === "src/f00.ts" || entry.path === "src/f01.ts"));
});

const samplePorcelain = [
  `${A} 1 1 2`,
  "author Alice",
  "author-time 1700000000",
  "author-tz +0000",
  "summary fix(auth): keep the refresh guard",
  "filename src/auth.ts",
  "\tline one",
  `${A} 2 2`,
  "\tline two",
  `${ROOT} 3 3 1`,
  "author Root",
  "author-time 1600000000",
  "summary initial import",
  "boundary",
  "filename src/auth.ts",
  "\tline three",
  `${B} 4 4 1`,
  "author Bob",
  "author-time 1710000000",
  "summary   refactor:\tsplit   helpers  ",
  "previous " + A + " src/auth.ts",
  "filename src/auth.ts",
  "\tauthor-time 1 not a header",
  `${A} 5 5 1`,
  "\tline five",
  `${ZERO} 6 6 1`,
  "author Not Committed Yet",
  "summary Version of src/auth.ts from src/auth.ts",
  "filename src/auth.ts",
  "\tline six",
].join("\n");

test("blame porcelain parses introducing commits and skips boundary and uncommitted lines", () => {
  assert.deepEqual(parseBlamePorcelain(samplePorcelain), [
    {
      sha: A,
      date: "2023-11-14T22:13:20.000Z",
      summary: "fix(auth): keep the refresh guard",
      lines: 3,
    },
    { sha: B, date: "2024-03-09T16:00:00.000Z", summary: "refactor: split helpers", lines: 1 },
  ]);
});

test("pull request resolution prefers the merged PR, collapses the body, and caches by commit", () => {
  const body = `Why:\n\n  ${"keep the guard ".repeat(200)}`;
  const pulls = [
    {
      number: 7,
      html_url: "https://github.com/o/r/pull/7",
      title: "Draft",
      merged_at: null,
      body: "x",
    },
    {
      number: 8,
      html_url: "https://github.com/o/r/pull/8",
      title: "Guard",
      merged_at: "2024-01-02T00:00:00Z",
      body,
    },
  ];
  const pull = commitPullRequest(pulls)!;
  assert.equal(pull.number, 8);
  assert.equal(pull.mergedAt, "2024-01-02T00:00:00Z");
  assert.equal(pull.bodyExcerpt.length, 1200);
  assert.ok(pull.bodyExcerpt.startsWith("Why: keep the guard keep"));
  assert.equal(commitPullRequest([{ number: 9, html_url: "u", title: "t" }])?.mergedAt, null);
  assert.equal(commitPullRequest({ message: "Not Found" }), null);
  assert.equal(commitPullRequest([]), null);

  const calls: string[] = [];
  const resolve = createCommitPullResolver((repo, sha) => {
    calls.push(`${repo}@${sha}`);
    if (sha === B) throw new Error("HTTP 502");
    return sha === A ? pulls : [];
  });
  assert.equal(resolve("o/r", A)?.number, 8);
  assert.equal(resolve("o/r", A)?.number, 8);
  assert.equal(resolve("o/r", ROOT), null);
  assert.equal(resolve("o/r", ROOT), null);
  assert.equal(resolve("o/other", A)?.number, 8);
  assert.throws(() => resolve("o/r", B), /HTTP 502/);
  assert.throws(() => resolve("o/r", B), /HTTP 502/);
  assert.deepEqual(calls, [`o/r@${A}`, `o/r@${ROOT}`, `o/other@${A}`, `o/r@${B}`, `o/r@${B}`]);
});

function fakeGit(
  blame: Record<string, string | null>,
  diff: string | null = samplePatch,
  history: { log: string | null; check: string | null } = { log: null, check: null },
) {
  const calls: string[][] = [];
  const inputs: string[] = [];
  const read: ProvenanceGitRead = (args, options) => {
    calls.push(args);
    assert.ok(typeof options.deadlineAt === "number");
    if (args[0] === "diff") return diff;
    if (args.includes("log")) {
      assert.equal(options.lazyFetch, false, "history listing must not fetch blobs");
      return history.log;
    }
    if (args[0] === "cat-file") {
      assert.equal(options.lazyFetch, false, "the missing filter must not fetch blobs");
      inputs.push(options.input!.toString("utf8"));
      return history.check;
    }
    const range = args[args.indexOf("-L") + 1]!;
    return blame[`${args.at(-1)}:${range}`] ?? null;
  };
  return { calls, inputs, read };
}

const blameB = [
  `${B} 40 40 2`,
  "author-time 1710000000",
  "summary split",
  "\tx",
  `${B} 41 41`,
  "\ty",
].join("\n");

const blameByArea = {
  "src/many.ts:20,24": samplePorcelain,
  "src/many.ts:40,41": blameB,
  "src/many.ts:60,65": samplePorcelain,
  "src/many.ts:90,93": samplePorcelain,
  "src/gone.ts:1,3": [`${ROOT} 1 1 3`, "boundary", "summary root", "\ta", "\tb", "\tc"].join("\n"),
  "src/added-only.ts:3,5": blameB,
};

const noFetch = () => assert.fail("no blob fetch expected");

test("provenance evidence attaches resolved pull requests to blamed areas", () => {
  const { calls, read } = fakeGit(blameByArea);
  const resolved: string[] = [];
  const evidence = buildProvenanceEvidence({
    repo: "o/r",
    mergeBaseSha: MERGE_BASE,
    headSha: HEAD,
    git: read,
    fetchBlobs: noFetch,
    resolvePull: (repo, sha) => {
      resolved.push(`${repo}@${sha}`);
      return sha === A
        ? {
            number: 8,
            url: "https://github.com/o/r/pull/8",
            title: "Guard",
            mergedAt: null,
            bodyExcerpt: "Keep it.",
          }
        : null;
    },
  });
  assert.equal(evidence.status, "partial");
  assert.match(evidence.reason!, /2 base hunks omitted/);
  assert.deepEqual(resolved, [`o/r@${A}`, `o/r@${B}`]);
  assert.deepEqual(
    evidence.areas.map((area) => `${area.path}:${area.baseLines} ${area.change}`),
    [
      "src/many.ts:20-24 modified",
      "src/many.ts:40-41 modified",
      "src/many.ts:60-65 modified",
      "src/many.ts:90-93 modified",
      "src/gone.ts:1-3 modified",
      "src/added-only.ts:3-5 insertion_context",
    ],
  );
  assert.equal(evidence.areas[0]!.commits[0]!.pr?.number, 8);
  assert.equal(evidence.areas[0]!.commits[1]!.pr, undefined);
  assert.deepEqual(evidence.areas[4]!.commits, []);
  assert.equal(evidence.areas[5]!.commits[0]!.sha, B);
  const blame = calls.find((args) => args[0] === "blame")!;
  assert.deepEqual(blame, [
    "blame",
    "--porcelain",
    "--no-textconv",
    "--ignore-revs-file",
    "",
    "-L",
    "20,24",
    MERGE_BASE,
    "--",
    "src/many.ts",
  ]);
  assert.ok(calls[0]!.includes("--unified=0"));
});

function objectIds(count: number, prefix: string): string[] {
  return Array.from(
    { length: count },
    (_, index) => prefix + (index + 1).toString(16).padStart(39, "0"),
  );
}

test("history blobs are listed, filtered to missing ones, and fetched in 400-object chunks before blame", () => {
  const source = objectIds(450, "d");
  const lock = objectIds(101, "f");
  const gitlink = objectIds(2, "9");
  const log = [
    `:000000 100644 ${ZERO} ${source[0]} A\tsrc/many.ts`,
    ...source
      .slice(1)
      .map((objectId, index) => `:100644 100755 ${source[index]} ${objectId} M\tsrc/many.ts`),
    "",
    `:160000 160000 ${gitlink[0]} ${gitlink[1]} M\tsrc/many.ts`,
    ...lock
      .slice(1)
      .map((objectId, index) => `:100644 100644 ${lock[index]} ${objectId} M\tpnpm-lock.yaml`),
    `:100644 000000 ${source[449]} ${ZERO} D\tsrc/gone.ts`,
  ].join("\n");
  const check = [
    `${source[0]} blob 100`,
    ...source.slice(1).map((objectId) => `${objectId} missing`),
    // One local lockfile version of 1 MiB: 100 missing versions exceed the 64 MiB budget.
    `${lock[0]} blob ${1024 * 1024}`,
    ...lock.slice(1).map((objectId) => `${objectId} missing`),
  ].join("\n");
  const events: string[] = [];
  const fake = fakeGit(blameByArea, samplePatch, { log, check });
  const fetched: string[][] = [];
  const evidence = buildProvenanceEvidence({
    repo: "o/r",
    mergeBaseSha: MERGE_BASE,
    headSha: HEAD,
    git: (args, options) => {
      events.push(args.includes("log") ? "log" : args[0]!);
      return fake.read(args, options);
    },
    fetchBlobs: (ids, deadlineAt) => {
      assert.ok(deadlineAt > 0);
      events.push("fetch");
      fetched.push(ids);
    },
    resolvePull: () => null,
  });
  const history = fake.calls.find((args) => args.includes("log"))!;
  assert.deepEqual(history.slice(0, 9), [
    "--literal-pathspecs",
    "log",
    "--format=",
    "--raw",
    "--no-abbrev",
    "--no-renames",
    "-n",
    "300",
    MERGE_BASE,
  ]);
  assert.deepEqual(history.slice(10), ["src/many.ts", "src/gone.ts", "src/added-only.ts"]);
  const listed = fake.inputs[0]!.trim().split("\n");
  assert.equal(new Set(listed).size, listed.length);
  assert.deepEqual(new Set(listed), new Set([...source, ...lock]));
  assert.deepEqual(
    fetched.map((chunk) => chunk.length),
    [400, 49],
  );
  assert.deepEqual(new Set(fetched.flat()), new Set(source.slice(1)));
  assert.deepEqual(events.slice(0, 5), ["diff", "log", "cat-file", "fetch", "fetch"]);
  assert.equal(events[5], "blame");
  assert.equal(evidence.areas.length, 6);
});

test("prefetch failures fall back to lazy blame; an unsettled Git process still stops", () => {
  const history = {
    log: `:100644 100644 ${A} ${B} M\tsrc/many.ts`,
    check: `${A} blob 10\n${B} missing`,
  };
  const baseline = buildProvenanceEvidence({
    repo: "o/r",
    mergeBaseSha: MERGE_BASE,
    headSha: HEAD,
    git: fakeGit(blameByArea).read,
    fetchBlobs: noFetch,
    resolvePull: () => null,
  });
  let attempts = 0;
  const failed = buildProvenanceEvidence({
    repo: "o/r",
    mergeBaseSha: MERGE_BASE,
    headSha: HEAD,
    git: fakeGit(blameByArea, samplePatch, history).read,
    fetchBlobs: (ids) => {
      attempts += 1;
      assert.deepEqual(ids, [B]);
      throw new Error("fetch failed: remote end hung up");
    },
    resolvePull: () => null,
  });
  assert.equal(attempts, 1);
  assert.deepEqual(failed, baseline);

  const noSizes = buildProvenanceEvidence({
    repo: "o/r",
    mergeBaseSha: MERGE_BASE,
    headSha: HEAD,
    git: fakeGit(blameByArea, samplePatch, { log: history.log, check: null }).read,
    fetchBlobs: noFetch,
    resolvePull: () => null,
  });
  assert.deepEqual(noSizes, baseline);

  const unsettled = new ReviewGitError(
    "review_blobs_unavailable",
    Object.assign(new Error("settlement"), {
      error: Object.assign(new Error("settlement"), { code: "EPROCESSSETTLEMENT" }),
    }),
  );
  assert.throws(
    () =>
      buildProvenanceEvidence({
        repo: "o/r",
        mergeBaseSha: MERGE_BASE,
        headSha: HEAD,
        git: fakeGit(blameByArea, samplePatch, history).read,
        fetchBlobs: () => {
          throw unsettled;
        },
        resolvePull: () => null,
      }),
    (error) => error === unsettled,
  );
});

test("provenance evidence fails soft on resolver, blame, diff, and deadline failures", () => {
  let lookups = 0;
  const throwing = buildProvenanceEvidence({
    repo: "o/r",
    mergeBaseSha: MERGE_BASE,
    headSha: HEAD,
    git: fakeGit({ ...blameByArea, "src/many.ts:90,93": null }).read,
    fetchBlobs: noFetch,
    resolvePull: () => {
      lookups += 1;
      throw new Error("gh: HTTP 403\n  rate limit exceeded");
    },
  });
  assert.equal(throwing.status, "partial");
  assert.equal(lookups, 1, "the first API failure stops further lookups");
  assert.match(
    throwing.reason!,
    /GitHub pull request lookup failed: gh: HTTP 403 rate limit exceeded/,
  );
  assert.match(
    throwing.reason!,
    /git blame failed or exceeded its bounds for 1 areas: src\/many.ts:90-93/,
  );
  assert.equal(throwing.areas.length, 5);
  assert.ok(throwing.areas.flatMap((area) => area.commits).every((commit) => !commit.pr));

  const noDiff = buildProvenanceEvidence({
    repo: "o/r",
    mergeBaseSha: MERGE_BASE,
    headSha: HEAD,
    git: fakeGit({}, null).read,
    fetchBlobs: noFetch,
    resolvePull: () => null,
  });
  assert.equal(noDiff.status, "unavailable");
  assert.deepEqual(noDiff.areas, []);

  const gitThrows = buildProvenanceEvidence({
    repo: "o/r",
    mergeBaseSha: MERGE_BASE,
    headSha: HEAD,
    git: () => {
      throw new Error("spawn git ENOENT");
    },
    fetchBlobs: noFetch,
    resolvePull: () => null,
  });
  assert.deepEqual(gitThrows, {
    status: "unavailable",
    reason: "Host provenance step failed: spawn git ENOENT",
    areas: [],
  });

  let clock = 0;
  const expired = buildProvenanceEvidence({
    repo: "o/r",
    mergeBaseSha: MERGE_BASE,
    headSha: HEAD,
    git: (args, options) => {
      if (args[0] === "diff") clock = 46_000;
      return fakeGit(blameByArea, samplePatch, {
        log: `:100644 100644 ${A} ${B} M\tsrc/many.ts`,
        check: `${B} missing`,
      }).read(args, options);
    },
    fetchBlobs: noFetch,
    resolvePull: () => null,
    now: () => clock,
  });
  assert.equal(expired.status, "partial");
  assert.match(expired.reason!, /Host deadline reached; 6 areas were not blamed/);
  assert.deepEqual(expired.areas, []);

  const complete = buildProvenanceEvidence({
    repo: "o/r",
    mergeBaseSha: MERGE_BASE,
    headSha: HEAD,
    git: fakeGit({}, fileDiff("src/new.ts", [hunk(0, 0, 3)], "/dev/null")).read,
    fetchBlobs: noFetch,
    resolvePull: () => null,
  });
  assert.deepEqual(complete, { status: "complete", areas: [] });
});

function run(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("real Git blame at the merge base attributes changed lines to their introducing commit", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-provenance-evidence-"));
  try {
    run(root, "init", "-q", "-b", "main");
    run(root, "config", "user.name", "Review Fixture");
    run(root, "config", "user.email", "fixture@example.invalid");
    run(root, "config", "commit.gpgsign", "false");
    const commit = (message: string) => {
      run(root, "add", ".");
      run(root, "commit", "-qm", message);
      return run(root, "rev-parse", "HEAD");
    };
    writeFileSync(join(root, "guard.ts"), "one\ntwo\nthree\n");
    commit("initial import");
    writeFileSync(join(root, "guard.ts"), "one\nguard()\nthree\n");
    writeFileSync(join(root, "keep.ts"), "first\nsecond\n");
    const introducing = commit("fix: keep the guard");
    run(root, "checkout", "-qb", "pr");
    writeFileSync(join(root, "guard.ts"), "one\nthree\n");
    writeFileSync(join(root, "keep.ts"), "first\ninserted\nsecond\n");
    writeFileSync(join(root, "added.ts"), "new\n");
    const head = commit("remove the guard");
    const resolved: string[] = [];
    const evidence: ProvenanceEvidence = pullRequestProvenanceEvidence({
      targetDir: root,
      repo: "o/r",
      context: { pullRequest: { base: { sha: introducing }, head: { sha: head } } },
      resolvePull: (_repo, sha) => {
        resolved.push(sha);
        return {
          number: 5,
          url: "https://github.com/o/r/pull/5",
          title: "Guard",
          mergedAt: null,
          bodyExcerpt: "Keeps refresh safe.",
        };
      },
    });
    assert.deepEqual(resolved, [introducing]);
    assert.equal(evidence.status, "complete");
    assert.deepEqual(
      evidence.areas.map((area) => `${area.path}:${area.baseLines} ${area.change}`),
      ["guard.ts:2-2 modified", "keep.ts:1-2 insertion_context"],
    );
    for (const area of evidence.areas) {
      assert.equal(area.commits.length, 1);
      assert.equal(area.commits[0]!.sha, introducing);
      assert.equal(area.commits[0]!.summary, "fix: keep the guard");
      assert.equal(area.commits[0]!.pr?.number, 5);
    }

    const missing = pullRequestProvenanceEvidence({
      targetDir: root,
      repo: "o/r",
      context: { pullRequest: { base: {}, head: { sha: head } } },
      resolvePull: () => null,
    });
    assert.equal(missing.status, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pull request prompts carry provenance evidence after introduction evidence; issues do not", () => {
  const evidence: ProvenanceEvidence = {
    status: "partial",
    reason: "Host deadline reached; 1 areas were not blamed.",
    areas: [
      {
        path: "src/auth.ts",
        baseLines: "10-12",
        commits: [
          {
            sha: A,
            date: "2024-01-01T00:00:00.000Z",
            summary: "fix: keep the guard",
            pr: {
              number: 8,
              url: "https://github.com/o/r/pull/8",
              title: "Guard",
              mergedAt: null,
              bodyExcerpt: "Keep it.",
            },
          },
        ],
      },
    ],
  };
  const prompt = reviewPromptForTest(item({ kind: "pull_request" }), {}, reviewGit, "", {
    provenanceEvidence: evidence,
  });
  const section = prompt.match(/\n```\n\n## Provenance Evidence\n\n```json\n([\s\S]*?)\n```\n/);
  assert.ok(section, "provenance evidence follows the introduction evidence block");
  const header = (name: string) => prompt.indexOf(`\n## ${name}\n`);
  assert.ok(header("PR Introduction Evidence") > 0);
  assert.ok(header("PR Introduction Evidence") < header("Provenance Evidence"));
  assert.ok(header("Provenance Evidence") < header("GitHub Context"));
  assert.deepEqual(JSON.parse(section[1]!), evidence);

  const notRun = reviewPromptForTest(item({ kind: "pull_request" }), {}, reviewGit);
  assert.equal(
    JSON.parse(notRun.match(/## Provenance Evidence\n\n```json\n([\s\S]*?)\n```/)![1]!).status,
    "unavailable",
  );

  const issue = reviewPromptForTest(item({ kind: "issue" }), {}, reviewGit, "", {
    provenanceEvidence: evidence,
  });
  assert.doesNotMatch(issue, /## Provenance Evidence/);
});
