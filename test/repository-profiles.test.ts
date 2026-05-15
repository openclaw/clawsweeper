import assert from "node:assert/strict";
import test from "node:test";

import { REPOSITORY_PROFILES, repositoryProfileFor } from "../dist/repository-profiles.js";

test("repositoryProfileFor matches mixed-case input against private target profiles", () => {
  const profile = repositoryProfileFor("CLIP-SA/Core-Wholesale");

  assert.equal(profile.targetRepo, "clip-sa/core-wholesale");
  assert.equal(profile.slug, "clip-sa-core-wholesale");
  assert.equal(profile.checkoutDir, "core-wholesale");
});

test("repositoryProfileFor carries service-area routing notes", () => {
  const profile = repositoryProfileFor("bermont-digital/multica");

  assert.equal(profile.targetRepo, "bermont-digital/multica");
  assert.match(profile.promptNote, /area:backend-go/);
  assert.match(profile.promptNote, /area:frontend-next/);
  assert.match(profile.promptNote, /area:daemon/);
  assert.deepEqual(profile.applyCloseRules.issue, []);
  assert.deepEqual(profile.applyCloseRules.pull_request, []);
});

test("private-repo triage disables generic OpenClaw fallback", () => {
  assert.throws(
    () => repositoryProfileFor("OpenClaw/example-tool"),
    /Unsupported target repo: OpenClaw\/example-tool/,
  );
});

test("old Core AI frontend repo is not a target profile", () => {
  assert.throws(
    () => repositoryProfileFor("CLIP-SA/core-ai-frontend"),
    /Unsupported target repo: CLIP-SA\/core-ai-frontend/,
  );
});

test("generic fallback does not support unknown repositories", () => {
  assert.throws(
    () => repositoryProfileFor("other-org/example-tool"),
    /Unsupported target repo: other-org\/example-tool/,
  );
});

test("profile lookup normalizes candidate target repos as well as input", () => {
  const mixedCaseProfile = {
    ...REPOSITORY_PROFILES[0],
    targetRepo: "Example-Org/Mixed-Case-Repo",
    slug: "example-org-mixed-case-repo",
  };
  REPOSITORY_PROFILES.push(mixedCaseProfile);

  try {
    assert.equal(repositoryProfileFor("example-org/mixed-case-repo"), mixedCaseProfile);
    assert.equal(repositoryProfileFor("EXAMPLE-ORG/MIXED-CASE-REPO"), mixedCaseProfile);
  } finally {
    REPOSITORY_PROFILES.pop();
  }
});
