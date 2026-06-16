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
  assert.equal(
    parsed.jobs[0].job,
    path.relative(process.cwd(), path.join(outDir, "repair-pr-openclaw-clawsweeper-291.md")),
  );

  const job = fs.readFileSync(path.join(outDir, "repair-pr-openclaw-clawsweeper-291.md"), "utf8");
  assert.match(job, /^job_intent: pr_repair$/m);
  assert.match(job, /pnpm check: conclusion=FAILURE/);
});

test("pr repair intake routes metadata-only ClawSweeper labels to human review", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-pr-intake-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  writeFakeGh(bin, [
    {
      number: 292,
      title: "metadata only",
      url: "https://github.com/openclaw/clawsweeper/pull/292",
      mergeStateStatus: "CLEAN",
      reviewDecision: "",
      labels: [{ name: "status: 📣 needs proof" }, { name: "rating: 🧂 unranked krab" }],
      statusCheckRollup: [],
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
  assert.equal(parsed.requires_human[0].number, 292);
  assert.match(parsed.requires_human[0].reason, /No repairable blocker/);
  assert.deepEqual(
    parsed.requires_human[0].metadata_signals.map((signal: { kind: string }) => signal.kind),
    ["clawsweeper_status", "clawsweeper_rating"],
  );
});

test("pr repair intake still writes jobs when objective repair blockers exist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-pr-intake-"));
  const bin = path.join(root, "bin");
  const outDir = path.join(root, "jobs", "openclaw", "inbox");
  fs.mkdirSync(bin);
  writeFakeGh(bin, [
    {
      number: 293,
      title: "metadata plus failed check",
      url: "https://github.com/openclaw/clawsweeper/pull/293",
      mergeStateStatus: "CLEAN",
      reviewDecision: "",
      labels: [{ name: "status: 📣 needs proof" }],
      statusCheckRollup: [{ name: "pnpm check", conclusion: "FAILURE", status: "COMPLETED" }],
      comments: [],
      reviews: [],
      updatedAt: "2026-06-15T00:00:00Z",
    },
  ]);

  const output = runIntake(root, ["--out-dir", outDir]);
  const parsed = JSON.parse(output);
  assert.equal(parsed.candidates, 1);
  assert.deepEqual(parsed.requires_human, []);
  assert.equal(parsed.jobs[0].status, "written");
  assert.equal(parsed.jobs[0].number, 293);
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
