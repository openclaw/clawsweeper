import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPrAdmissionInput } from "../dist/clawsweeper-pr-admission-input.js";
import { repositoryProfileFor } from "../dist/repository-profiles.js";

function admissionFile(repo: string, pull: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "clawsweeper-pr-admission-"));
  const path = join(dir, "exact-pr-admission.json");
  writeFileSync(path, JSON.stringify({ repo, observedAt: "2026-09-09T15:11:31.000Z", pull }));
  return path;
}

const pull = {
  number: 3246,
  state: "open",
  title: "Example",
  labels: [],
  user: { login: "contributor" },
  author_association: "CONTRIBUTOR",
  additions: 1200,
  deletions: 839,
  changed_files: 12,
  head: { sha: "a881c63d08d36e3926aaa7b97a2eef2e438cd53b" },
};

test("PR admission accepts the workflow's mixed-case repo against a lowercased fallback profile", () => {
  // Fallback profiles carry the normalized slug; the workflow records the repo as GitHub spells it.
  const profileRepo = repositoryProfileFor("steipete/CodexBar").targetRepo;
  assert.equal(profileRepo, "steipete/codexbar");
  const path = admissionFile("steipete/CodexBar", pull);
  try {
    const input = readPrAdmissionInput(path, profileRepo, [3246]);
    assert.equal(input.item.repo, profileRepo);
    assert.equal(input.item.number, 3246);
    assert.equal(input.admission.admitted, true);
  } finally {
    rmSync(join(path, ".."), { recursive: true, force: true });
  }
});

test("PR admission still rejects a different repo, item number, or closed pull request", () => {
  const cases: Array<[string, string, number[], Record<string, unknown>]> = [
    ["steipete/CodexBar", "steipete/camsnap", [3246], pull],
    ["steipete/CodexBar", "steipete/codexbar", [3247], pull],
    ["steipete/CodexBar", "steipete/codexbar", [3246, 3247], pull],
    ["steipete/CodexBar", "steipete/codexbar", [3246], { ...pull, state: "closed" }],
  ];
  for (const [fileRepo, repo, numbers, filePull] of cases) {
    const path = admissionFile(fileRepo, filePull);
    try {
      assert.throws(
        () => readPrAdmissionInput(path, repo, numbers),
        /does not match the selected open pull request/,
      );
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  }
});
