import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  REPOSITORY_PROFILES,
  repositoryProfileFor,
  repoFromArgs,
  setTargetRepo,
  targetProfile,
  targetRepo,
  withTargetProfile,
} from "../dist/repository-profiles.js";
import {
  defaultItemsDir,
  isMarkdownForActiveRepo,
  markdownFiles,
} from "../dist/clawsweeper-repository-paths.js";
import { reportFileUrl, repoUrl } from "../dist/clawsweeper-links.js";

test("command profiles select real record trees and restore nested repository links", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-profile-"));
  const original = targetProfile();
  try {
    for (const repo of ["openclaw/openclaw", "openclaw/clawhub"]) {
      const profile = repositoryProfileFor(repo);
      const dir = join(root, profile.slug, "items");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "42.md"), `---\nrepository: ${repo}\n---\n# Review\n`);
    }
    for (const repo of ["openclaw/clawhub", "openclaw/openclaw", "openclaw/clawhub"]) {
      const profile = repoFromArgs({ target_repo: repo });
      const dir = join(root, profile.slug, "items");
      const [file] = markdownFiles(dir);
      assert.ok(file);
      assert.equal(isMarkdownForActiveRepo(readFileSync(join(dir, file), "utf8"), file), true);
      const otherRepo = repo === "openclaw/clawhub" ? "openclaw/openclaw" : "openclaw/clawhub";
      const otherFile = join(root, repositoryProfileFor(otherRepo).slug, "items", "42.md");
      assert.equal(isMarkdownForActiveRepo(readFileSync(otherFile, "utf8"), otherFile), false);
      assert.equal(defaultItemsDir().endsWith(join("records", profile.slug, "items")), true);
      assert.equal(new URL(repoUrl()).pathname, `/${repo}`);
      assert.equal(
        new URL(reportFileUrl(42)).pathname,
        `/openclaw/clawsweeper/blob/main/records/${profile.slug}/items/42.md`,
      );
      assert.throws(
        () =>
          withTargetProfile(repositoryProfileFor(otherRepo), () => {
            assert.equal(targetRepo(), otherRepo);
            assert.equal(new URL(repoUrl()).pathname, `/${otherRepo}`);
            throw new Error("restore profile");
          }),
        /restore profile/,
      );
      assert.equal(targetRepo(), repo);
      assert.equal(new URL(repoUrl()).pathname, `/${repo}`);
    }
  } finally {
    setTargetRepo(original.targetRepo);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw allows unsponsored feature closes for issues only", () => {
  const profile = repositoryProfileFor("openclaw/openclaw");
  assert.equal(profile.applyCloseRules.issue?.includes("unsponsored_feature_request"), true);
  assert.equal(
    profile.applyCloseRules.pull_request?.includes("unsponsored_feature_request"),
    false,
  );
});

test("OpenClaw allows author budget closes for pull requests only", () => {
  const profile = repositoryProfileFor("openclaw/openclaw");
  assert.equal(profile.applyCloseRules.issue?.includes("author_pr_budget_exceeded"), false);
  assert.equal(profile.applyCloseRules.pull_request?.includes("author_pr_budget_exceeded"), true);
});

test("OpenClaw routes obsolescence reasons to their item kinds", () => {
  const profile = repositoryProfileFor("openclaw/openclaw");
  assert.equal(profile.applyCloseRules.issue?.includes("stale_version_bug"), true);
  assert.equal(profile.applyCloseRules.pull_request?.includes("stale_version_bug"), false);
  assert.equal(profile.applyCloseRules.issue?.includes("obsolete_fix_pr"), false);
  assert.equal(profile.applyCloseRules.pull_request?.includes("obsolete_fix_pr"), true);
});

test("repositoryProfileFor matches mixed-case input against canonical profiles", () => {
  const profile = repositoryProfileFor("OpenClaw/ClawHub");

  assert.equal(profile.targetRepo, "openclaw/clawhub");
  assert.equal(profile.slug, "openclaw-clawhub");
  assert.equal(profile.packageManager, "bun");
  assert.deepEqual(profile.applyCloseRules.issue, ["implemented_on_main"]);
  assert.deepEqual(profile.applyCloseRules.pull_request, [
    "implemented_on_main",
    "mostly_implemented_on_main",
  ]);
});

test("repositoryProfileFor supports fs-safe event reviews", () => {
  const profile = repositoryProfileFor("OpenClaw/fs-safe");

  assert.equal(profile.targetRepo, "openclaw/fs-safe");
  assert.equal(profile.slug, "openclaw-fs-safe");
  assert.equal(profile.checkoutDir, "fs-safe");
  assert.deepEqual(profile.applyCloseRules.issue, ["implemented_on_main"]);
  assert.deepEqual(profile.applyCloseRules.pull_request, [
    "implemented_on_main",
    "mostly_implemented_on_main",
  ]);
});

test("OpenClaw Enterprise uses an explicit review-only profile and target-native gates", () => {
  const profile = repositoryProfileFor("OpenClaw/OpenClaw-Enterprise");

  assert.equal(profile.targetRepo, "openclaw/openclaw-enterprise");
  assert.equal(profile.slug, "openclaw-openclaw-enterprise");
  assert.equal(profile.displayName, "OpenClaw Enterprise");
  assert.equal(profile.checkoutDir, "openclaw-enterprise");
  assert.equal(profile.packageManager, "pnpm");
  assert.match(profile.promptNote, /authoritative platform design/);
  assert.match(profile.promptNote, /Require target-native integration evidence/);
  assert.match(profile.promptNote, /Review only/);
  assert.deepEqual(profile.applyCloseRules, { issue: [], pull_request: [] });
});

test("generic OpenClaw fallback supports conservative event-only onboarding", () => {
  const profile = repositoryProfileFor("OpenClaw/example-tool");

  assert.equal(profile.targetRepo, "openclaw/example-tool");
  assert.equal(profile.slug, "openclaw-example-tool");
  assert.equal(profile.displayName, "example-tool");
  assert.equal(profile.checkoutDir, "example-tool");
  assert.match(profile.promptNote, /generic OpenClaw onboarding profile/);
  assert.match(profile.promptNote, /current default branch/);
  assert.deepEqual(profile.applyCloseRules.issue, ["implemented_on_main"]);
  assert.deepEqual(profile.applyCloseRules.pull_request, [
    "implemented_on_main",
    "mostly_implemented_on_main",
  ]);
  assert.equal(profile.packageManager, "pnpm");
});

test("generic steipete fallback starts review-only", () => {
  const profile = repositoryProfileFor("Steipete/example-tool");

  assert.equal(profile.targetRepo, "steipete/example-tool");
  assert.equal(profile.slug, "steipete-example-tool");
  assert.equal(profile.displayName, "example-tool");
  assert.equal(profile.checkoutDir, "example-tool");
  assert.match(profile.promptNote, /generic personal-repository onboarding profile/);
  assert.deepEqual(profile.applyCloseRules.issue, []);
  assert.deepEqual(profile.applyCloseRules.pull_request, []);
});

test("Go-root targets use explicit npm profiles without broadening close policy", () => {
  for (const [repo, fallback] of [
    ["Steipete/CamSnap", "steipete/example-tool"],
    ["OpenClaw/Crabbox", "openclaw/example-tool"],
  ] as const) {
    const profile = repositoryProfileFor(repo);
    assert.equal(profile.targetRepo, repo.toLowerCase());
    assert.equal(profile.packageManager, "npm", repo);
    assert.ok(REPOSITORY_PROFILES.includes(profile), "must not use an owner fallback");
    assert.deepEqual(profile.applyCloseRules, repositoryProfileFor(fallback).applyCloseRules);
  }
});

test("dashboard targets stay an explicit public-output scope, not hosted admission policy", () => {
  const wrangler = readFileSync("dashboard/wrangler.toml", "utf8");
  const dashboardTargets = wrangler.match(/^TARGET_REPOS = "([^"]+)"$/m)?.[1]?.split(",");
  assert.deepEqual(dashboardTargets, [
    "openclaw/openclaw",
    "openclaw/clawhub",
    "openclaw/clawsweeper",
    "openclaw/fs-safe",
  ]);
  const bayTargets = wrangler.match(/^PUBLIC_BAY_REPOS = "([^"]+)"$/m)?.[1]?.split(",");
  assert.deepEqual(bayTargets, dashboardTargets);

  const profileConfig = JSON.parse(readFileSync("config/target-repositories.json", "utf8")) as {
    repositories: Array<{ target_repo: string; hosted?: boolean }>;
  };
  assert.equal(
    profileConfig.repositories.some((profile) => "hosted" in profile),
    false,
  );
  assert.ok(
    profileConfig.repositories.some((profile) => profile.target_repo === "steipete/camsnap"),
  );
  assert.ok(!dashboardTargets?.includes("steipete/camsnap"));
});

test("generic OpenClaw fallback keeps denied repositories unsupported", () => {
  assert.throws(
    () => repositoryProfileFor("openclaw/clawsweeper-state"),
    /Unsupported target repo: openclaw\/clawsweeper-state/,
  );
});

test("repository profiles reject targets outside configured profiles and owner fallbacks", () => {
  for (const targetRepo of ["other-org/example-tool", "other-org", "other org/repo"]) {
    assert.throws(() => repositoryProfileFor(targetRepo), /Unsupported target repo/);
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

test("public profile loading rejects unsupported package managers", async () => {
  const originalRead = fs.readFileSync;
  fs.readFileSync = ((file, options) => {
    if (String(file).endsWith("config/target-repositories.json")) {
      return JSON.stringify({
        schema_version: 2,
        repositories: [
          {
            target_repo: "example/repo",
            display_name: "Example",
            checkout_dir: "repo",
            prompt_note: "Review the example repository.",
            package_manager: "yarn",
            apply_close_rules: { issue: [], pull_request: [] },
          },
        ],
      });
    }
    return originalRead(file, options);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    const moduleUrl = new URL("../dist/repository-profiles.js", import.meta.url);
    moduleUrl.search = "invalid-package-manager";
    await assert.rejects(import(moduleUrl.href), /package_manager must be bun, pnpm, or npm/);
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
  }
});
