import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const CONCURRENT_JOB = "jobs/openclaw/inbox/issue-openclaw-openclaw-167865.md";
const CONCURRENT_AUDIT = "results/issue-implementation-intake/openclaw-openclaw/167865.md";
const OWN_AUDIT = "results/issue-implementation-intake/openclaw-openclaw/128411.md";

test("intake ledger publication keeps a job that a parallel intake published", () => {
  const workflow = parse(
    fs.readFileSync(".github/workflows/repair-issue-implementation-intake.yml", "utf8"),
  ) as { jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }> };
  const run = workflow.jobs.intake?.steps?.find(
    (step) => step.name === "Commit intake ledger",
  )?.run;
  assert.ok(run);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-intake-publish-"));
  const remote = path.join(root, "remote.git");
  const writer = path.join(root, "writer");
  const state = path.join(root, "state");
  const source = path.join(root, "source");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
  const write = (dir: string, file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  try {
    git(root, "init", "--bare", "--initial-branch=state", remote);
    git(root, "clone", remote, writer);
    write(writer, "jobs/openclaw/inbox/existing.md", "existing\n");
    write(writer, "results/issue-implementation-intake/openclaw-openclaw/1.md", "audit\n");
    git(writer, "add", "-A");
    git(writer, "commit", "-m", "seed");
    git(writer, "push", "origin", "HEAD:state");

    // This intake run checks out state and copies jobs and results into its workspace.
    git(root, "clone", "--branch", "state", remote, state);
    fs.mkdirSync(source);
    for (const dir of ["jobs", "results"]) {
      fs.cpSync(path.join(state, dir), path.join(source, dir), { recursive: true });
    }

    // A parallel intake run queues issue 167865 and publishes first.
    write(writer, CONCURRENT_JOB, "---\nsource_issue_number: 167865\n---\n");
    write(writer, CONCURRENT_AUDIT, "queued\n");
    git(writer, "add", "-A");
    git(writer, "commit", "-m", "chore: record issue implementation intake");
    git(writer, "push", "origin", "HEAD:state");

    // This intake run finds issue 128411 not eligible and writes only its audit.
    write(source, OWN_AUDIT, "not eligible\n");
    const publishMain = path.join(process.cwd(), "dist/repair/publish-main.js");
    const result = spawnSync(
      "bash",
      ["-c", `pnpm() { shift 2; node "$PUBLISH_MAIN" "$@"; }\n${run}`],
      {
        cwd: source,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: root,
          PUBLISH_MAIN: publishMain,
          CLAWSWEEPER_STATE_DIR: state,
          JOB_PATH: "",
          AUDIT_PATH: OWN_AUDIT,
        },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    git(writer, "fetch", "origin", "state");
    const files = git(writer, "ls-tree", "-r", "--name-only", "FETCH_HEAD").split("\n");
    assert.ok(files.includes(OWN_AUDIT), files.join("\n"));
    assert.ok(files.includes(CONCURRENT_JOB), files.join("\n"));
    assert.ok(files.includes(CONCURRENT_AUDIT), files.join("\n"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
