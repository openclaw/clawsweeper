import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflowPath = ".github/workflows/maintainer-activity-report.yml";
const prepareScript = join(process.cwd(), "scripts/prepare-maintainer-report-publication.sh");

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function configureCommitter(cwd: string) {
  git(cwd, "config", "user.name", "ClawSweeper Test");
  git(cwd, "config", "user.email", "clawsweeper@example.invalid");
}

function prepare(generated: string, maintainers: string, baseSha: string) {
  return execFileSync("bash", [prepareScript, generated, maintainers, baseSha], {
    encoding: "utf8",
  }).trim();
}

test("maintainer report jobs isolate generation, publication, and deployment credentials", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const generateStart = workflow.indexOf("\n  generate:");
  const publishStart = workflow.indexOf("\n  publish:", generateStart);
  const deployStart = workflow.indexOf("\n  deploy:", publishStart);

  assert.ok(generateStart >= 0);
  assert.ok(publishStart > generateStart);
  assert.ok(deployStart > publishStart);

  const generate = workflow.slice(generateStart, publishStart);
  const publish = workflow.slice(publishStart, deployStart);
  const deploy = workflow.slice(deployStart);

  assert.match(generate, /permission-contents: read/);
  assert.doesNotMatch(generate, /permission-contents: write/);
  assert.doesNotMatch(generate, /maintainers_write_token|git push|CLOUDFLARE_API_TOKEN/);
  assert.equal(generate.match(/persist-credentials: false/g)?.length, 2);

  assert.match(publish, /permission-contents: write/);
  assert.match(publish, /prepare-maintainer-report-publication\.sh/);
  assert.match(publish, /steps\.prepare\.outputs\.changed == 'true'/);
  assert.doesNotMatch(publish, /setup-codex|OPENAI_API_KEY|CLOUDFLARE_API_TOKEN/);

  assert.match(deploy, /permission-contents: read/);
  assert.doesNotMatch(deploy, /permission-contents: write/);
  assert.match(deploy, /token: \$\{\{ steps\.maintainers_read_token\.outputs\.token \}\}/);
  assert.doesNotMatch(deploy, /setup-codex|OPENAI_API_KEY|maintainers_write_token/);
});

test("maintainer report publication stages new paths and retries idempotently", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-maintainer-report-"));
  const remote = join(root, "maintainers.git");
  const seed = join(root, "seed");
  const first = join(root, "first");
  const retry = join(root, "retry");
  const generated = join(root, "generated");

  try {
    git(root, "init", "--bare", remote);
    mkdirSync(seed);
    git(seed, "init", "-b", "main");
    configureCommitter(seed);
    mkdirSync(join(seed, "reports"));
    writeFileSync(join(seed, "reports", "old.json"), "old\n");
    git(seed, "add", "reports");
    git(seed, "commit", "-m", "seed reports");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", "main");
    git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
    const baseSha = git(seed, "rev-parse", "HEAD");

    mkdirSync(join(generated, "day"), { recursive: true });
    writeFileSync(join(generated, "day", "report.json"), '{"status":"ready"}\n');

    git(root, "clone", remote, first);
    configureCommitter(first);
    assert.equal(prepare(generated, first, baseSha), "changed=true");
    assert.match(git(first, "status", "--porcelain"), /D  reports\/old\.json/);
    assert.match(git(first, "status", "--porcelain"), /A  reports\/day\/report\.json/);
    git(first, "commit", "-m", "publish reports");
    git(first, "push", "origin", "HEAD:main");
    assert.equal(git(remote, "rev-list", "--count", "refs/heads/main"), "2");

    git(root, "clone", remote, retry);
    configureCommitter(retry);
    git(retry, "checkout", "--detach", baseSha);
    assert.equal(prepare(generated, retry, baseSha), "changed=true");
    git(retry, "commit", "-m", "publish reports");
    git(retry, "pull", "--rebase", "origin", "main");
    git(retry, "push", "origin", "HEAD:main");

    assert.equal(git(remote, "rev-list", "--count", "refs/heads/main"), "2");
    assert.equal(
      readFileSync(join(retry, "reports", "day", "report.json"), "utf8"),
      '{"status":"ready"}\n',
    );
    assert.equal(prepare(generated, retry, git(retry, "rev-parse", "HEAD")), "changed=false");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("maintainer report publication rejects empty artifacts and Git control files", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-maintainer-report-empty-"));
  const maintainers = join(root, "maintainers");
  const generated = join(root, "generated");
  try {
    mkdirSync(maintainers);
    mkdirSync(generated);
    git(maintainers, "init", "-b", "main");
    configureCommitter(maintainers);
    writeFileSync(join(maintainers, "README.md"), "maintainers\n");
    git(maintainers, "add", "README.md");
    git(maintainers, "commit", "-m", "seed");
    const baseSha = git(maintainers, "rev-parse", "HEAD");

    assert.throws(
      () => prepare(generated, maintainers, baseSha),
      /Command failed|empty or exceeds/,
    );

    writeFileSync(join(generated, ".gitignore"), "*\n");
    assert.throws(
      () => prepare(generated, maintainers, baseSha),
      /Command failed|Git control files/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
