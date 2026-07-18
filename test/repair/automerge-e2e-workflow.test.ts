import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(".github/workflows/automerge-e2e.yml", "utf8");

test("automerge E2E uses the production containment runner and container entrypoint", () => {
  assert.match(workflow, /runs-on: blacksmith-16vcpu-ubuntu-2404/);
  assert.match(workflow, /node scripts\/e2e\/automerge-container\.mjs/);
  assert.match(workflow, /--scenario all/);
  assert.match(workflow, /--output test-results\/automerge/);
  assert.doesNotMatch(workflow, /\.\/\.github\/actions\/setup-pnpm/);
});

test("automerge E2E is read-only and excludes untrusted fork pull requests", () => {
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(
    workflow,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\.|create-github-app-token|GH_TOKEN:/);
});

test("automerge E2E uploads the container proof even when a scenario fails", () => {
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /path: test-results\/automerge/);
  assert.match(workflow, /if-no-files-found: error/);
});
