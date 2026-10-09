import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { reviewPromptForTest } from "../dist/clawsweeper.js";
import { createReviewRuntime } from "../dist/clawsweeper-review-runtime.js";
import {
  prefetchReviewHistory,
  pullRequestHistoryCoverage,
  reviewHistoryCapability,
  type ReviewHistoryCoverage,
} from "../dist/pr-review-history.js";
import { git as reviewGit, item } from "./helpers.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// What the sandboxed reviewer can read: no lazy fetch and no transport.
function offline(cwd: string, ...args: string[]) {
  return spawnSync("git", ["-c", "protocol.allow=never", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  });
}

function guard(marker: string): string {
  return `${Array.from({ length: 20 }, (_, line) => `export const line${line} = ${line};`).join("\n")}\n${marker}\n`;
}

function historyFixture() {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-review-history-"));
  const source = join(root, "source");
  const clone = join(root, "clone");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.name", "Review Fixture");
  git(source, "config", "user.email", "fixture@example.invalid");
  git(source, "config", "commit.gpgsign", "false");
  git(source, "config", "uploadpack.allowFilter", "true");
  git(source, "config", "uploadpack.allowAnySHA1InWant", "true");
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), text);
  };
  const commit = (message: string) => {
    git(source, "add", "-A");
    git(source, "commit", "-qm", message);
    return git(source, "rev-parse", "HEAD");
  };
  write("src/old/guard.ts", guard("// first"));
  write("other.ts", "unrelated 1\n");
  const first = commit("initial import");
  write("src/old/guard.ts", guard("const MAGIC = guard();"));
  write("other.ts", "unrelated 2\n");
  const introducing = commit("fix: keep the guard");
  git(source, "rm", "-q", "src/old/guard.ts");
  write("src/new/guard.ts", guard("const MAGIC = guard(); // moved"));
  const moved = commit("refactor: move the guard");
  write("other.ts", "unrelated 3\n");
  const base = commit("main moves on");
  git(source, "checkout", "-qb", "pr");
  write("src/new/guard.ts", guard("const MAGIC = null;"));
  const head = commit("remove the guard");
  git(source, "update-ref", "refs/pull/1/head", head);
  git(source, "checkout", "-q", "main");
  git(
    root,
    "clone",
    "-q",
    "--filter=blob:none",
    "--no-checkout",
    "--single-branch",
    `file://${source}`,
    clone,
  );
  git(clone, "fetch", "-q", "--filter=blob:none", "origin", "refs/pull/1/head:refs/pr-head");
  return { root, clone, first, introducing, moved, base, head };
}

test("host prefetch makes the changed file's history and earlier name local; other old blobs fail fast", () => {
  const f = historyFixture();
  try {
    assert.notEqual(offline(f.clone, "show", `${f.first}:src/old/guard.ts`).status, 0);
    const coverage = pullRequestHistoryCoverage({
      targetDir: f.clone,
      context: { pullRequest: { base: { sha: f.base }, head: { sha: f.head } } },
      mainSha: f.base,
    });
    assert.equal(coverage.status, "complete", coverage.reason);
    assert.equal(coverage.changedPaths, 1);
    assert.deepEqual(coverage.renames, [
      { from: "src/old/guard.ts", to: "src/new/guard.ts", commit: f.moved },
    ]);
    assert.ok(coverage.fetched > 0);
    assert.deepEqual(coverage.truncated, []);

    // The reads the review prompt asks for now succeed without a fetch.
    const show = offline(f.clone, "show", `${f.first}:src/old/guard.ts`);
    assert.equal(show.status, 0, show.stderr);
    const pickaxe = offline(
      f.clone,
      "log",
      "-S",
      "MAGIC",
      "--format=%H",
      f.head,
      "--",
      "src/new/guard.ts",
      "src/old/guard.ts",
    );
    assert.equal(pickaxe.status, 0, pickaxe.stderr);
    assert.deepEqual(pickaxe.stdout.trim().split("\n"), [f.introducing]);
    const blame = offline(
      f.clone,
      "blame",
      "--porcelain",
      "-L",
      "21,21",
      f.base,
      "--",
      "src/new/guard.ts",
    );
    assert.equal(blame.status, 0, blame.stderr);
    assert.ok(blame.stdout.startsWith(f.moved));

    // Unrelated history stays remote and fails at once instead of fetching.
    const unrelated = offline(f.clone, "show", `${f.first}:other.ts`);
    assert.notEqual(unrelated.status, 0);
    assert.doesNotMatch(unrelated.stderr, /HTTP|unable to access/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("history prefetch reports an unusable checkout instead of throwing", () => {
  const f = historyFixture();
  try {
    const missingHead = pullRequestHistoryCoverage({
      targetDir: f.clone,
      context: { pullRequest: { base: { sha: f.base }, head: {} } },
      mainSha: f.base,
    });
    assert.equal(missingHead.status, "unavailable");
    assert.match(
      reviewHistoryCapability(missingHead, "allowlisted-proxy"),
      /^Old file contents were not prefetched: /,
    );
    git(f.clone, "remote", "set-url", "origin", `file://${join(f.root, "gone")}`);
    const failedFetch = pullRequestHistoryCoverage({
      targetDir: f.clone,
      context: { pullRequest: { base: { sha: f.base }, head: { sha: f.head } } },
      mainSha: f.base,
    });
    assert.equal(failedFetch.status, "unavailable");
    assert.match(failedFetch.reason!, /^History prefetch failed: /);
    assert.match(
      reviewHistoryCapability(failedFetch, "allowlisted-proxy"),
      /report such a gap once as a local limit\.$/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

const oid = (prefix: string, index: number) => prefix + index.toString(16).padStart(39, "0");

for (const allLocal of [false, true]) {
  test(`a large hot file keeps only its newest missing versions within the per-path budget, local=${allLocal}`, () => {
    const lock = Array.from({ length: 200 }, (_, index) => oid("a", index));
    const small = Array.from({ length: 3 }, (_, index) => oid("b", index));
    const commits = Array.from({ length: 200 }, (_, index) => oid("c", index));
    const date = (index: number) => `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}Z`;
    // Newest first: commit i changes the lockfile from version i+1 to version i.
    const history = commits
      .map((commit, index) => {
        const entries = [
          `:100644 100644 ${lock[index + 1] ?? lock[index]} ${lock[index]} M\0pnpm-lock.yaml\0`,
        ];
        if (index < 2)
          entries.push(`:100644 100644 ${small[index + 1]} ${small[index]} M\0src/a.ts\0`);
        return `\x01${commit} ${oid("d", index)}\0${date(index)}\0\n${entries.join("")}`;
      })
      .join("");
    const present = new Set(allLocal ? [...lock, ...small] : [lock[0]!, small[0]!]);
    const fetched: string[][] = [];
    const coverage = prefetchReviewHistory({
      git: (args, input) => {
        if (args[0] === "diff")
          return `:100644 100644 ${lock[1]} ${lock[0]} M\0pnpm-lock.yaml\0:100644 100644 ${small[1]} ${small[0]} M\0src/a.ts\0`;
        if (args.includes("--diff-filter=D")) return "";
        if (args[1] === "log") return history;
        const ids = input!.trim().split("\n");
        if (args[0] === "rev-list")
          return ids.map((id) => (present.has(id) ? id : `?${id}`)).join("\n");
        if (args[0] === "cat-file")
          return ids.map((id) => `${id} blob ${id.startsWith("a") ? 1024 * 1024 : 100}`).join("\n");
        return null;
      },
      fetchBlobs: (ids) => {
        fetched.push(ids);
        for (const id of ids) present.add(id);
      },
      mergeBaseSha: oid("e", 0),
      headSha: oid("e", 1),
      tips: [],
      deadlineAt: Date.now() + 60_000,
    });
    if (allLocal) {
      // Local versions cost nothing, so a populated checkout is never cut.
      assert.deepEqual(fetched, []);
      assert.equal(coverage.status, "complete");
      return;
    }
    assert.equal(coverage.status, "partial");
    assert.equal(fetched.length, 1, "one batched fetch");
    const lockVersions = fetched[0]!.filter((id) => id.startsWith("a")).length;
    assert.equal(lockVersions, 128);
    assert.ok(small.every((id) => id === small[0] || fetched[0]!.includes(id)));
    assert.deepEqual(
      coverage.truncated.map(({ path }) => path),
      ["pnpm-lock.yaml"],
    );
    assert.match(
      reviewHistoryCapability(coverage, "allowlisted-proxy"),
      /Not prefetched: `pnpm-lock\.yaml` from 2026-01-01 back\./,
    );
  });
}

for (const [deletions, parents] of [
  [250, 1],
  [1, 1],
  [1, 2],
]) {
  test(`unchecked rename candidates report earlier history as not local: ${deletions} deletions, ${parents} parents`, () => {
    const created = oid("a", 1);
    const deleted = Array.from({ length: deletions }, (_, index) => oid("b", index));
    const commit = `${oid("c", 1)} ${Array.from({ length: parents }, (_, index) => oid("d", index)).join(" ")}`;
    const present = new Set([created]);
    const fetched: string[][] = [];
    const coverage = prefetchReviewHistory({
      git: (args, input) => {
        if (args[0] === "diff")
          return `:000000 100644 ${"0".repeat(40)} ${created} A\0src/new.ts\0`;
        if (args.includes("--diff-filter=D"))
          return `\x01${commit}\0${"2026-02-03T00:00:00Z"}\0\n${deleted
            .map((id, index) => `:100644 000000 ${id} ${"0".repeat(40)} D\0src/old${index}.ts\0`)
            .join("")}`;
        if (args[1] === "log")
          return `\x01${commit}\0${"2026-02-03T00:00:00Z"}\0\n:000000 100644 ${"0".repeat(40)} ${created} A\0src/new.ts\0`;
        // Rename detection fails, as on a timeout.
        if (args[1] === "diff-tree") return null;
        // The merge's other parent lacks the path: the merge created it.
        if (args[1] === "ls-tree") return "";
        const ids = input!.trim().split("\n");
        if (args[0] === "rev-list")
          return ids.map((id) => (present.has(id) ? id : `?${id}`)).join("\n");
        if (args[0] === "cat-file") return ids.map((id) => `${id} blob 100`).join("\n");
        return null;
      },
      fetchBlobs: (ids) => {
        fetched.push(ids);
        for (const id of ids) present.add(id);
      },
      mergeBaseSha: oid("e", 0),
      headSha: oid("e", 1),
      tips: [],
      deadlineAt: Date.now() + 60_000,
    });
    // Past the candidate cap, deletions with other names are not fetched; a
    // merge-created path is not searched for an earlier name at all.
    assert.deepEqual(fetched, deletions > 200 || parents > 1 ? [] : [deleted]);
    assert.equal(coverage.status, "partial");
    assert.deepEqual(coverage.truncated, [{ path: "src/new.ts", before: "2026-02-03T00:00:00Z" }]);
  });
}

test("installed rename candidates do not spend the fetch budget", () => {
  const zero = "0".repeat(40);
  const date = "2026-03-04T00:00:00Z";
  // 26 files, each created in its own commit that deleted 200 installed files:
  // 5,200 local candidates, more than the 5,000-blob budget.
  const files = Array.from({ length: 26 }, (_, index) => ({
    path: `src/f${index}.ts`,
    commit: oid("c", index),
    created: oid("a", index),
    deleted: Array.from({ length: 200 }, (_, n) => oid("b", index * 1000 + n)),
  }));
  // The last file was renamed from a predecessor that is not installed.
  const renamed = { path: "src/z.ts", commit: oid("c", 99), created: oid("a", 99) };
  const predecessor = oid("f", 1);
  const present = new Set([
    ...files.flatMap(({ created, deleted }) => [created, ...deleted]),
    renamed.created,
  ]);
  const fetched: string[][] = [];
  const header = (commit: string) => `\x01${commit} ${oid("d", 0)}\0${date}\0\n`;
  const coverage = prefetchReviewHistory({
    git: (args, input) => {
      if (args[0] === "diff")
        return [...files, renamed]
          .map(({ path, created }) => `:000000 100644 ${zero} ${created} A\0${path}\0`)
          .join("");
      if (args.includes("--diff-filter=D"))
        return [
          ...files.map(
            ({ commit, deleted }, index) =>
              header(commit) +
              deleted
                .map((id, n) => `:100644 000000 ${id} ${zero} D\0old/${index}-${n}.ts\0`)
                .join(""),
          ),
          `${header(renamed.commit)}:100644 000000 ${predecessor} ${zero} D\0src/zold.ts\0`,
        ].join("");
      if (args[1] === "log") {
        if (args.includes("src/zold.ts")) return "";
        return [...files, renamed]
          .map(
            ({ path, commit, created }) =>
              `${header(commit)}:000000 100644 ${zero} ${created} A\0${path}\0`,
          )
          .join("");
      }
      if (args[1] === "diff-tree")
        return args.includes(renamed.commit)
          ? `:100644 100644 ${predecessor} ${renamed.created} R090\0src/zold.ts\0src/z.ts\0`
          : "";
      const ids = input!.trim().split("\n");
      if (args[0] === "rev-list")
        return ids.map((id) => (present.has(id) ? id : `?${id}`)).join("\n");
      if (args[0] === "cat-file") return ids.map((id) => `${id} blob 100`).join("\n");
      return null;
    },
    fetchBlobs: (ids) => {
      fetched.push(ids);
      for (const id of ids) present.add(id);
    },
    mergeBaseSha: oid("e", 0),
    headSha: oid("e", 1),
    tips: [],
    deadlineAt: Date.now() + 60_000,
  });
  assert.deepEqual(fetched, [[predecessor]]);
  assert.deepEqual(coverage.renames, [
    { from: "src/zold.ts", to: "src/z.ts", commit: renamed.commit },
  ]);
  assert.deepEqual(coverage.truncated, []);
  assert.equal(coverage.status, "complete", coverage.reason);
});

test("lazy fetch is disabled only behind the allowlisted proxy, and the prompt says so per runner", () => {
  const coverage: ReviewHistoryCoverage = {
    status: "complete",
    changedPaths: 3,
    renames: [{ from: "src/old.ts", to: "src/new.ts", commit: "f".repeat(40) }],
    blobs: 40,
    fetched: 38,
    truncated: [],
    elapsedMs: 1,
  };
  const capabilities = (networkCapability: "allowlisted-proxy" | "unrestricted" | "none") => {
    const prompt = reviewPromptForTest(item({ kind: "pull_request" }), {}, reviewGit, "", {
      historyCoverage: coverage,
      networkCapability,
    });
    return prompt.slice(prompt.indexOf("## Runtime Capabilities"));
  };
  const local =
    /- Git history of the 3 changed files and their earlier names is local on main and the PR; scope `git log -S\/-G` to those paths\. .*`src\/old\.ts` became `src\/new\.ts` in ffffffffff\./;
  assert.match(capabilities("allowlisted-proxy"), local);
  assert.match(capabilities("allowlisted-proxy"), /lazy fetching disabled/);
  assert.match(capabilities("unrestricted"), local);
  assert.match(capabilities("unrestricted"), /Git downloads any other old blob on demand/);
  assert.doesNotMatch(capabilities("unrestricted"), /lazy fetching disabled|--follow` ends/);
  assert.match(capabilities("none"), /without network access/);
  const issue = reviewPromptForTest(item({ kind: "issue" }), {}, reviewGit, "", {
    historyCoverage: coverage,
  });
  assert.doesNotMatch(issue, /changed files and their earlier names/);

  const unavailable = (): never => {
    throw new Error("unexpected dependency");
  };
  for (const [runner, sandboxMode, disabled] of [
    ["codex", "clawsweeper-review", true],
    ["codex", "read-only", false],
    ["openclaw", "clawsweeper-review", false],
  ] as const) {
    const runtime = createReviewRuntime({
      reviewItemPromptPaths: { core: "", issue: "", pull_request: "", closeReasons: "" },
      decisionSchemaPath: "",
      prCloseCoverageProofPromptPath: "",
      targetRepo: () => "fixture/repository",
      run: unavailable,
      ghJson: unavailable,
      evidenceEntry: unavailable,
      untrustedCodexEnv: () => ({ PATH: "/bin", CLAWSWEEPER_RUNNER: runner }),
      asRecord: unavailable,
      defaultRootCauseCluster: unavailable,
      parseDecision: unavailable,
      ensureDir: unavailable,
      stringOrUndefined: unavailable,
    });
    assert.deepEqual(
      runtime.reviewEnvironment(sandboxMode, true),
      disabled
        ? { PATH: "/bin", CLAWSWEEPER_RUNNER: runner, GIT_NO_LAZY_FETCH: "1" }
        : { PATH: "/bin", CLAWSWEEPER_RUNNER: runner },
      `${runner}/${sandboxMode}`,
    );
  }
});
