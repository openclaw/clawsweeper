import assert from "node:assert/strict";
import test from "node:test";

import {
  REPOSITORY_PROFILES,
  repositoryProfileFor,
  validateTargetRepositoryConfigForTest,
} from "../dist/repository-profiles.js";

function targetRepositoryConfig(liveTest: Record<string, unknown>, schemaVersion = 2) {
  return {
    schema_version: schemaVersion,
    repositories: [
      {
        target_repo: "example/repo",
        display_name: "Example",
        checkout_dir: "repo",
        prompt_note: "Review the example repository.",
        apply_close_rules: { issue: [], pull_request: [] },
        live_test: liveTest,
      },
    ],
    generic_fallbacks: [],
  };
}

function fallbackRepositoryConfig(liveTest: Record<string, unknown>, schemaVersion = 2) {
  return {
    schema_version: schemaVersion,
    repositories: [],
    generic_fallbacks: [
      {
        owner: "example",
        deny_repositories: [],
        allow_repo_name_pattern: "^[A-Za-z0-9_.-]+$",
        prompt_note: "Review {target_repo}.",
        apply_close_rules: { issue: [], pull_request: [] },
        live_test: liveTest,
      },
    ],
  };
}

const TERMINAL_LIVE_TEST = {
  enabled: true,
  surfaceDefault: "terminal",
  setup: ["pnpm install --frozen-lockfile"],
  allowInstallScripts: false,
  readyTimeoutSeconds: 240,
  maxRecordingSeconds: 90,
} as const;

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

test("Awesome Claws keeps contribution admission review-only", () => {
  const profile = repositoryProfileFor("giodl73-repo/awesome-claws");

  assert.equal(profile.slug, "giodl73-repo-awesome-claws");
  assert.equal(profile.checkoutDir, "awesome-claws");
  assert.equal(profile.packageManager, "npm");
  assert.deepEqual(profile.applyCloseRules.issue, []);
  assert.deepEqual(profile.applyCloseRules.pull_request, []);
  assert.deepEqual(profile.liveTest?.setup, ["npm ci"]);
  assert.match(profile.promptNote, /contribution admission guide/);
  assert.match(profile.promptNote, /never auto-close, auto-fix, or auto-merge/);
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
  assert.deepEqual(profile.liveTest, TERMINAL_LIVE_TEST);
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
  assert.deepEqual(profile.liveTest, TERMINAL_LIVE_TEST);
});

test("generic OpenClaw fallback keeps denied repositories unsupported", () => {
  assert.throws(
    () => repositoryProfileFor("openclaw/clawsweeper-state"),
    /Unsupported target repo: openclaw\/clawsweeper-state/,
  );
});

test("generic fallback does not support repositories outside configured owners", () => {
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

test("schema v2 repository profiles strictly validate optional live_test config", () => {
  const liveTest = {
    enabled: true,
    surface_default: "browser",
    setup: ["pnpm install", "pnpm build"],
    start: "pnpm dev",
    url: "http://localhost:3000",
    ready_timeout_seconds: 120,
    max_recording_seconds: 90,
  };
  const parsed = validateTargetRepositoryConfigForTest(targetRepositoryConfig(liveTest));
  assert.deepEqual(parsed.repositories[0]?.liveTest, {
    enabled: true,
    surfaceDefault: "browser",
    setup: ["pnpm install", "pnpm build"],
    allowInstallScripts: false,
    start: "pnpm dev",
    url: "http://localhost:3000",
    readyTimeoutSeconds: 120,
    maxRecordingSeconds: 90,
  });

  const invalidCases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["unknown key", { ...liveTest, surprise: true }, /live_test has unexpected keys: surprise/],
    ["surface", { ...liveTest, surface_default: "desktop" }, /surface_default/],
    ["setup", { ...liveTest, setup: "pnpm install" }, /setup must be an array/],
    ["browser start", { ...liveTest, start: undefined }, /start is required/],
    ["browser URL", { ...liveTest, url: "http://localhost:3000/path" }, /HTTP URL origin/],
    ["recording limit", { ...liveTest, max_recording_seconds: 91 }, /must be at most 90/],
    ["positive timeout", { ...liveTest, ready_timeout_seconds: 0 }, /positive integer/],
  ];
  for (const [name, value, expected] of invalidCases) {
    assert.throws(
      () => validateTargetRepositoryConfigForTest(targetRepositoryConfig(value)),
      expected,
      name,
    );
  }
  assert.throws(
    () => validateTargetRepositoryConfigForTest(targetRepositoryConfig(liveTest, 1)),
    /live_test requires schema_version 2/,
  );
  assert.throws(
    () =>
      validateTargetRepositoryConfigForTest({
        ...targetRepositoryConfig(liveTest),
        repositories: [
          { ...targetRepositoryConfig(liveTest).repositories[0], package_manager: "yarn" },
        ],
      }),
    /package_manager must be bun, pnpm, or npm/,
  );
});

test("terminal live_test profiles may omit browser start and URL fields", () => {
  const parsed = validateTargetRepositoryConfigForTest(
    targetRepositoryConfig({
      enabled: true,
      surface_default: "terminal",
      setup: ["pnpm install", "pnpm build"],
      ready_timeout_seconds: 120,
      max_recording_seconds: 90,
    }),
  );
  assert.deepEqual(parsed.repositories[0]?.liveTest, {
    enabled: true,
    surfaceDefault: "terminal",
    setup: ["pnpm install", "pnpm build"],
    allowInstallScripts: false,
    readyTimeoutSeconds: 120,
    maxRecordingSeconds: 90,
  });
});

test("live_test install scripts are disabled by default and require an explicit opt-in", () => {
  const base = {
    enabled: true,
    surface_default: "terminal",
    setup: ["pnpm install"],
    ready_timeout_seconds: 120,
    max_recording_seconds: 90,
  };
  const defaulted = validateTargetRepositoryConfigForTest(targetRepositoryConfig(base));
  const optedIn = validateTargetRepositoryConfigForTest(
    targetRepositoryConfig({ ...base, allow_install_scripts: true }),
  );

  assert.equal(defaulted.repositories[0]?.liveTest?.allowInstallScripts, false);
  assert.equal(optedIn.repositories[0]?.liveTest?.allowInstallScripts, true);
});

test("schema v2 generic fallbacks strictly validate and inherit optional live_test config", () => {
  const liveTest = {
    enabled: true,
    surface_default: "terminal",
    setup: ["pnpm install"],
    ready_timeout_seconds: 120,
    max_recording_seconds: 90,
  };
  const parsed = validateTargetRepositoryConfigForTest(fallbackRepositoryConfig(liveTest));
  assert.deepEqual(parsed.genericFallbacks[0]?.liveTest, {
    enabled: true,
    surfaceDefault: "terminal",
    setup: ["pnpm install"],
    allowInstallScripts: false,
    readyTimeoutSeconds: 120,
    maxRecordingSeconds: 90,
  });
  assert.throws(
    () =>
      validateTargetRepositoryConfigForTest(
        fallbackRepositoryConfig({ ...liveTest, surprise: true }),
      ),
    /generic_fallbacks\[0\]\.live_test has unexpected keys: surprise/,
  );
  assert.throws(
    () => validateTargetRepositoryConfigForTest(fallbackRepositoryConfig(liveTest, 1)),
    /generic_fallbacks\[0\]\.live_test requires schema_version 2/,
  );
});

test("configured and fallback-owned repositories expose their enabled live-proof surfaces", () => {
  assert.deepEqual(repositoryProfileFor("openclaw/openclaw").liveTest, {
    enabled: true,
    surfaceDefault: "browser",
    setup: ["pnpm install --frozen-lockfile", "pnpm ui:install"],
    allowInstallScripts: false,
    start: "pnpm dev:ui:mock",
    url: "http://127.0.0.1:5187",
    readyTimeoutSeconds: 300,
    maxRecordingSeconds: 90,
  });
  assert.deepEqual(repositoryProfileFor("openclaw/openclaw-facetime").liveTest, TERMINAL_LIVE_TEST);
  assert.deepEqual(repositoryProfileFor("openclaw/fs-safe").liveTest, TERMINAL_LIVE_TEST);
  assert.deepEqual(repositoryProfileFor("openclaw/clawhub").liveTest, {
    enabled: true,
    surfaceDefault: "browser",
    setup: ["bun install"],
    allowInstallScripts: false,
    start: "bun run dev",
    url: "http://127.0.0.1:3000",
    readyTimeoutSeconds: 240,
    maxRecordingSeconds: 90,
  });
});

test("ClawSweeper enables browser live proof with the local Bay demo", () => {
  assert.deepEqual(repositoryProfileFor("openclaw/clawsweeper").liveTest, {
    enabled: true,
    surfaceDefault: "browser",
    setup: ["pnpm install --frozen-lockfile"],
    allowInstallScripts: false,
    start: "./scripts/live-proof/bay-demo/start.sh",
    url: "http://127.0.0.1:8787",
    readyTimeoutSeconds: 240,
    maxRecordingSeconds: 90,
  });
});
