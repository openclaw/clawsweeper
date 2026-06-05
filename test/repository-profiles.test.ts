import assert from "node:assert/strict";
import test from "node:test";

import {
  REPOSITORY_PROFILES,
  repositoryProfileFor,
  requireTargetRepo,
  resolveRepositoryReviewProvider,
  reviewModelForProvider,
} from "../dist/repository-profiles.js";

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
  assert.deepEqual(profile.applyCloseRules.issue, [
    "implemented_on_main",
    "duplicate_or_superseded",
    "cannot_reproduce",
    "incoherent",
    "not_actionable_in_repo",
    "stale_insufficient_info",
  ]);
  assert.deepEqual(profile.applyCloseRules.pull_request, [
    "implemented_on_main",
    "mostly_implemented_on_main",
    "duplicate_or_superseded",
    "cannot_reproduce",
    "incoherent",
    "not_actionable_in_repo",
  ]);
});

test("valkyriweb/pi-mono profile carries pi service-area routing notes", () => {
  const profile = repositoryProfileFor("valkyriweb/pi-mono");

  assert.equal(profile.targetRepo, "valkyriweb/pi-mono");
  assert.equal(profile.slug, "valkyriweb-pi-mono");
  assert.equal(profile.checkoutDir, "pi-mono-fork");
  assert.match(profile.promptNote, /area:coding-agent/);
  assert.match(profile.promptNote, /area:extensions/);
  assert.match(profile.promptNote, /area:tui/);
  assert.match(profile.promptNote, /area:sdk/);
  assert.match(profile.promptNote, /area:docs/);
  assert.match(profile.promptNote, /area:tests/);
  assert.deepEqual(profile.applyCloseRules.issue, [
    "implemented_on_main",
    "duplicate_or_superseded",
    "cannot_reproduce",
    "incoherent",
    "not_actionable_in_repo",
    "stale_insufficient_info",
  ]);
  assert.deepEqual(profile.applyCloseRules.pull_request, [
    "implemented_on_main",
    "mostly_implemented_on_main",
    "duplicate_or_superseded",
    "cannot_reproduce",
    "incoherent",
    "not_actionable_in_repo",
  ]);
});

test("valkyriweb/horizon profile carries code-craft and hardening review guidance", () => {
  const profile = repositoryProfileFor("Valkyriweb/Horizon");

  assert.equal(profile.targetRepo, "valkyriweb/horizon");
  assert.equal(profile.slug, "valkyriweb-horizon");
  assert.equal(profile.checkoutDir, "horizon");
  assert.equal(profile.includeMaintainerAuthored, true);
  assert.match(profile.promptNote, /area:billing/);
  assert.match(profile.promptNote, /area:whatsapp/);
  assert.match(profile.promptNote, /code-craft/);
  assert.match(profile.promptNote, /agent-native-hardening/);
  assert.deepEqual(profile.applyCloseRules.issue, []);
  assert.deepEqual(profile.applyCloseRules.pull_request, []);
});

test("openclaw-claude profile uses pi for the narrow review canary", () => {
  const profile = repositoryProfileFor("valkyriweb/openclaw-claude");

  assert.equal(profile.targetRepo, "valkyriweb/openclaw-claude");
  assert.equal(profile.reviewProvider, "pi");
  assert.match(profile.promptNote, /ops\/release triage/);
});

test("review routing maps codex to gpt-5.5 and pi to opus 4.8", () => {
  assert.equal(reviewModelForProvider("codex"), "gpt-5.5");
  assert.equal(reviewModelForProvider("pi"), "claude-opus-4-8");
  assert.equal(reviewModelForProvider("claude-bridge"), "claude-opus-4-8");
});

test("review provider resolution keeps per-target config ahead of env override", () => {
  assert.equal(resolveRepositoryReviewProvider({ explicit: "pi", env: "codex" }), "pi");
  assert.equal(resolveRepositoryReviewProvider({ env: "pi" }), "pi");
  assert.equal(resolveRepositoryReviewProvider({}), "codex");
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

test("requireTargetRepo returns explicitly-provided owner/name targets", () => {
  assert.equal(requireTargetRepo("valkyriweb/clawsweeper"), "valkyriweb/clawsweeper");
  assert.equal(requireTargetRepo("openclaw/openclaw"), "openclaw/openclaw");
});

test("requireTargetRepo fails fast when no target is provided", () => {
  for (const value of ["", undefined, "  ", "not-a-repo"]) {
    assert.throws(() => requireTargetRepo(value), /No target repository/);
  }
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
