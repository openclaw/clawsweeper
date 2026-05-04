import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILT_IN_REPOSITORY_PROFILES,
  REPOSITORY_PROFILES,
  isAutoCloseAllowed,
  mergeRepositoryProfiles,
  parseExtraRepositoryProfilesJson,
  repositoryProfileFor,
} from "../dist/repository-profiles.js";

test("repositoryProfileFor matches mixed-case input against canonical profiles", () => {
  const profile = repositoryProfileFor("OpenClaw/ClawHub");

  assert.equal(profile.targetRepo, "openclaw/clawhub");
  assert.equal(profile.slug, "openclaw-clawhub");
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

test("extra repository profiles default to review-only external targets", () => {
  const [profile] = parseExtraRepositoryProfilesJson(
    JSON.stringify([
      {
        targetRepo: "ExampleOrg/ops-bot",
        displayName: "Ops Bot",
        docsUrl: "https://example.com/docs",
        promptNote: "Focus on operational safety and reproducible evidence.",
      },
    ]),
  );

  assert.equal(profile.targetRepo, "ExampleOrg/ops-bot");
  assert.equal(profile.slug, "exampleorg-ops-bot");
  assert.equal(profile.checkoutDir, "ops-bot");
  assert.equal(profile.displayName, "Ops Bot");
  assert.equal(profile.docsUrl, "https://example.com/docs");
  assert.deepEqual(profile.applyCloseRules.issue, []);
  assert.deepEqual(profile.applyCloseRules.pull_request, []);
  assert.match(profile.promptNote, /external ClawSweeper target/);
  assert.match(profile.promptNote, /operational safety/);
});

test("extra repository profiles may opt pull requests into implemented-on-main only", () => {
  const [profile] = parseExtraRepositoryProfilesJson(
    JSON.stringify([
      {
        targetRepo: "ExampleOrg/reviewed-prs",
        applyCloseRules: {
          issue: [],
          pull_request: ["implemented_on_main", "implemented_on_main"],
        },
      },
    ]),
  );

  assert.deepEqual(profile.applyCloseRules.issue, []);
  assert.deepEqual(profile.applyCloseRules.pull_request, ["implemented_on_main"]);
  assert.equal(isAutoCloseAllowed(profile, "pull_request", "implemented_on_main"), true);
  assert.equal(isAutoCloseAllowed(profile, "pull_request", "cannot_reproduce"), false);
});

test("extra repository profiles cannot enable issue auto-close", () => {
  assert.throws(
    () =>
      parseExtraRepositoryProfilesJson(
        JSON.stringify([
          {
            targetRepo: "ExampleOrg/unsafe-issues",
            applyCloseRules: {
              issue: ["implemented_on_main"],
            },
          },
        ]),
      ),
    /external profiles cannot enable issue auto-close/,
  );
});

test("extra repository profiles cannot duplicate built-in targets", () => {
  const [profile] = parseExtraRepositoryProfilesJson(
    JSON.stringify([{ targetRepo: "OPENCLAW/OPENCLAW" }]),
  );

  assert.throws(
    () => mergeRepositoryProfiles(BUILT_IN_REPOSITORY_PROFILES, [profile]),
    /Duplicate repository profile for OPENCLAW\/OPENCLAW/,
  );
});
