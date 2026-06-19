import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const scriptPath = path.resolve("dist/repair/pr-repair-intake.js");

test("pr repair intake ignores cancelled-only checks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-pr-intake-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  writeFakeGh(bin, [
    {
      number: 290,
      title: "cancelled only",
      url: "https://github.com/openclaw/clawsweeper/pull/290",
      mergeStateStatus: "CLEAN",
      reviewDecision: "",
      statusCheckRollup: [{ name: "notify", conclusion: "CANCELLED", status: "COMPLETED" }],
      comments: [],
      reviews: [],
      updatedAt: "2026-06-15T00:00:00Z",
    },
  ]);

  const output = runIntake(root, ["--dry-run"]);
  const parsed = JSON.parse(output);
  assert.equal(parsed.scanned, 1);
  assert.equal(parsed.candidates, 0);
  assert.deepEqual(parsed.jobs, []);
});

test("pr repair intake writes PR repair jobs for failed checks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-pr-intake-"));
  const bin = path.join(root, "bin");
  const outDir = path.join(root, "jobs", "openclaw", "inbox");
  fs.mkdirSync(bin);
  writeFakeGh(bin, [
    {
      number: 291,
      title: "failed check",
      url: "https://github.com/openclaw/clawsweeper/pull/291",
      mergeStateStatus: "CLEAN",
      reviewDecision: "",
      statusCheckRollup: [{ name: "pnpm check", conclusion: "FAILURE", status: "COMPLETED" }],
      comments: [],
      reviews: [],
      updatedAt: "2026-06-15T00:00:00Z",
    },
  ]);

  const output = runIntake(root, ["--out-dir", outDir]);
  const parsed = JSON.parse(output);
  assert.equal(parsed.candidates, 1);
  assert.equal(parsed.jobs[0].status, "written");
  assert.doesNotMatch(output, /private-tool|readonly\/example|openclaw\/unavailable/);
  assert.equal(
    parsed.jobs[0].job,
    path.relative(process.cwd(), path.join(outDir, "repair-pr-openclaw-clawsweeper-291.md")),
  );

  const job = fs.readFileSync(path.join(outDir, "repair-pr-openclaw-clawsweeper-291.md"), "utf8");
  assert.match(job, /^job_intent: pr_repair$/m);
  assert.match(job, /pnpm check: conclusion=FAILURE/);
});

test("pr repair intake supports author-wide open PR discovery", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-pr-intake-"));
  const bin = path.join(root, "bin");
  const outDir = path.join(root, "jobs", "runs", "author-wide");
  fs.mkdirSync(bin);
  writeFakeGhAuthorWide(bin);

  const output = execFileSync(
    process.execPath,
    [
      scriptPath,
      "--author",
      "Jhacarreiro",
      "--all-open",
      "--limit",
      "10",
      "--no-comments",
      "--out-dir",
      outDir,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    },
  );

  const parsed = JSON.parse(output);
  assert.equal(parsed.mode, "author-wide");
  assert.equal(parsed.searched, 4);
  assert.equal(parsed.repos_discovered, 4);
  assert.equal(parsed.repos_scanned, 1);
  assert.deepEqual(parsed.skipped_repositories, {
    private: 1,
    metadata_unavailable: 1,
    unsupported_profile: 1,
  });
  assert.equal(parsed.candidates, 1);
  assert.equal(parsed.jobs[0].status, "written");

  const jobPath = path.join(
    outDir,
    "openclaw-clawsweeper",
    "inbox",
    "repair-pr-openclaw-clawsweeper-291.md",
  );
  assert.equal(fs.existsSync(jobPath), true);
  assert.equal(fs.existsSync(path.join(outDir, "steipete-private-tool")), false);
  assert.equal(fs.existsSync(path.join(outDir, "readonly-example")), false);
  assert.equal(fs.existsSync(path.join(outDir, "openclaw-unavailable")), false);
});

function runIntake(root: string, extraArgs: string[]): string {
  return execFileSync(
    process.execPath,
    [
      scriptPath,
      "--repo",
      "openclaw/clawsweeper",
      "--author",
      "Jhacarreiro",
      "--limit",
      "10",
      "--no-comments",
      ...extraArgs,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    },
  );
}

function writeFakeGh(bin: string, prs: unknown[]) {
  const gh = path.join(bin, "gh");
  fs.writeFileSync(
    gh,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(${JSON.stringify(JSON.stringify(prs))});
  process.exit(0);
}
if (args[0] === "api" && args[1] === "graphql") {
  process.stdout.write(JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { nodes: [] }
        }
      }
    }
  }));
  process.exit(0);
}
console.error("unexpected gh args", args.join(" "));
process.exit(1);
`,
    { mode: 0o755 },
  );
}

function writeFakeGhAuthorWide(bin: string) {
  const gh = path.join(bin, "gh");
  fs.writeFileSync(
    gh,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const byRepo = {
  "openclaw/clawsweeper": [
    {
      number: 291,
      title: "failed check",
      url: "https://github.com/openclaw/clawsweeper/pull/291",
      mergeStateStatus: "CLEAN",
      reviewDecision: "",
      statusCheckRollup: [{ name: "pnpm check", conclusion: "FAILURE", status: "COMPLETED" }],
      comments: [],
      reviews: [],
      updatedAt: "2026-06-15T00:00:00Z",
    },
  ],
};
if (args[0] === "search" && args[1] === "prs") {
  process.stdout.write(JSON.stringify([
    { repository: { nameWithOwner: "openclaw/clawsweeper" } },
    { repository: { nameWithOwner: "readonly/example" } },
    { repository: { nameWithOwner: "steipete/private-tool" } },
    { repository: { nameWithOwner: "openclaw/unavailable" } },
  ]));
  process.exit(0);
}
if (args[0] === "repo" && args[1] === "view") {
  const repo = args[2];
  if (repo === "openclaw/unavailable") process.exit(1);
  process.stdout.write(JSON.stringify({ isPrivate: repo === "steipete/private-tool" }));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "list") {
  const repo = args[args.indexOf("--repo") + 1];
  process.stdout.write(JSON.stringify(byRepo[repo] || []));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "graphql") {
  process.stdout.write(JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { nodes: [] }
        }
      }
    }
  }));
  process.exit(0);
}
console.error("unexpected gh args", args.join(" "));
process.exit(1);
`,
    { mode: 0o755 },
  );
}
