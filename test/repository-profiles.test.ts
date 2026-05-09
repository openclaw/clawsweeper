import assert from "node:assert/strict";
import test from "node:test";

import { REPOSITORY_PROFILES, repositoryProfileFor } from "../dist/repository-profiles.js";

test("repositoryProfileFor matches mixed-case input against canonical profiles", () => {
  const profile = repositoryProfileFor("OpenClaw/ClawHub");

  assert.equal(profile.targetRepo, "openclaw/clawhub");
  assert.equal(profile.slug, "openclaw-clawhub");
});

test("repositoryProfileFor supports fs-safe event reviews", () => {
  const profile = repositoryProfileFor("OpenClaw/fs-safe");

  assert.equal(profile.targetRepo, "openclaw/fs-safe");
  assert.equal(profile.slug, "openclaw-fs-safe");
  assert.equal(profile.checkoutDir, "fs-safe");
  assert.deepEqual(profile.applyCloseRules.issue, []);
  assert.deepEqual(profile.applyCloseRules.pull_request, [
    "implemented_on_main",
    "mostly_implemented_on_main",
  ]);
});

test("generic OpenClaw fallback supports conservative event-only onboarding", () => {
  const profile = repositoryProfileFor("OpenClaw/example-tool");

  assert.equal(profile.targetRepo, "openclaw/example-tool");
  assert.equal(profile.slug, "openclaw-example-tool");
  assert.equal(profile.displayName, "example-tool");
  assert.equal(profile.checkoutDir, "example-tool");
  assert.match(profile.promptNote, /generic OpenClaw onboarding profile/);
  assert.deepEqual(profile.applyCloseRules.issue, []);
  assert.deepEqual(profile.applyCloseRules.pull_request, [
    "implemented_on_main",
    "mostly_implemented_on_main",
  ]);
});

test("generic OpenClaw fallback keeps denied repositories unsupported", () => {
  assert.throws(
    () => repositoryProfileFor("openclaw/clawsweeper-state"),
    /Unsupported target repo: openclaw\/clawsweeper-state/,
  );
});

test("generic fallback does not support repositories outside OpenClaw", () => {
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
