import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const AUTOMERGE_E2E_FIXTURES = ["tiny", "openclaw-shaped"];

export const OPENCLAW_SHAPED_CONTRACT = Object.freeze({
  node: ">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0",
  packageManager:
    "pnpm@11.2.2+sha512.36e6621fad506178936455e70247b8808ef4ec25797a9f437a93281a020484e2607f6a469a22e982987c3dbb8866e3071514ab10a4a1749e06edcd1ec118436f",
  repairTarget: "src/repair-target.txt",
});

export function createTargetFixture(
  root,
  { fixture = "tiny", dependencySetupMutation = false, packageManager = "pnpm@11.10.0" } = {},
) {
  assertFixture(fixture);
  return fixture === "openclaw-shaped"
    ? createOpenClawShapedFixture(root, { dependencySetupMutation })
    : createTinyFixture(root, { dependencySetupMutation, packageManager });
}

export function createCiRegressionFixture(root, { fixture = "tiny" } = {}) {
  assertFixture(fixture);
  return {
    ...createTargetFixture(root, {
      fixture,
      packageManager: fixture === "tiny" ? "pnpm@11.2.2" : undefined,
    }),
    historicalBaseSha: "977e0b64a12152a2e112634c1c32e8505db08234",
    historicalHeadSha: "34a3001388bb99fb4a041a73aad98631c4557634",
  };
}

function createTinyFixture(root, { dependencySetupMutation, packageManager }) {
  const repairTarget = "src/repair-target.txt";
  return initializeRepository(root, {
    fixture: "tiny",
    repairTarget,
    forcedTrackedFiles: dependencySetupMutation ? ["node_modules/.modules.yaml"] : [],
    files: {
      ".gitignore": "node_modules/\n",
      "package.json": `${JSON.stringify(
        {
          name: "automerge-e2e-target",
          private: true,
          packageManager,
          scripts: { "check:changed": "node scripts/check.mjs" },
        },
        null,
        2,
      )}\n`,
      "pnpm-lock.yaml": tinyLockfile(),
      ...(dependencySetupMutation ? { "node_modules/.modules.yaml": "stale: true\n" } : {}),
      "scripts/check.mjs":
        "import fs from 'node:fs';\nif (fs.readFileSync('src/repair-target.txt', 'utf8') !== 'fixed\\n') throw new Error('fixture is not repaired');\n",
      [repairTarget]: "base\n",
    },
  });
}

function createOpenClawShapedFixture(root, { dependencySetupMutation }) {
  const repairTarget = OPENCLAW_SHAPED_CONTRACT.repairTarget;
  const fixture = initializeRepository(root, {
    fixture: "openclaw-shaped",
    repairTarget,
    forcedTrackedFiles: dependencySetupMutation ? ["node_modules/.modules.yaml"] : [],
    trackedExecutableFiles: ["openclaw.mjs"],
    trackedSymlinks: {
      "CLAUDE.md": "AGENTS.md",
      "extensions/fixture-extension/node_modules/@openclaw/fixture-core":
        "../../../../packages/fixture-core",
      "packages/fixture-cli-consumer/node_modules/.bin/openclaw": "../openclaw/openclaw.mjs",
      "packages/fixture-cli-consumer/node_modules/openclaw": "../../..",
    },
    files: {
      ".gitignore": [
        "node_modules/",
        "**/node_modules/",
        "dist/",
        ".turbo/",
        ".openclaw/runtime/",
        "test-results/",
        "",
      ].join("\n"),
      ".npmrc":
        "# pnpm v11 reads project settings from pnpm-workspace.yaml.\n# Keep registry/auth-only settings here.\n",
      "AGENTS.md":
        "# OpenClaw-shaped fixture\n\nUse workspace-aware validation. CHANGELOG.md is release-owned and must not be edited by repair automation.\n",
      "CHANGELOG.md":
        "# Changelog\n\n## Unreleased\n\nRelease maintainers own this file; automerge repair must preserve it.\n",
      "openclaw.mjs": "#!/usr/bin/env node\nconsole.log('openclaw-shaped fixture');\n",
      "package.json": openClawRootPackage(),
      "pnpm-workspace.yaml": openClawWorkspace(),
      "pnpm-lock.yaml": openClawLockfile(),
      ...(dependencySetupMutation ? { "node_modules/.modules.yaml": "stale: true\n" } : {}),
      "scripts/check-changed.mjs": openClawChangedGate(),
      "scripts/fixture-gate.mjs": openClawNamedGate(),
      "ui/package.json": workspacePackage("@openclaw/fixture-ui", {
        "@openclaw/fixture-core": "workspace:*",
      }),
      "ui/src/index.js": "export const uiFixture = true;\n",
      "packages/fixture-cli-consumer/package.json": workspacePackage(
        "@openclaw/fixture-cli-consumer",
        {
          openclaw: "workspace:*",
        },
      ),
      "packages/fixture-core/package.json": workspacePackage("@openclaw/fixture-core", {
        "@openclaw/fixture-leaf": "workspace:*",
      }),
      "packages/fixture-core/src/index.js": "export const coreFixture = true;\n",
      "packages/fixture-leaf/package.json": workspacePackage("@openclaw/fixture-leaf"),
      "packages/fixture-leaf/src/index.js": "export const leafFixture = true;\n",
      [repairTarget]: "base\n",
      "extensions/fixture-extension/package.json": workspacePackage("@openclaw/fixture-extension", {
        "@openclaw/fixture-core": "workspace:*",
      }),
      "extensions/fixture-extension/src/index.js":
        "export { coreFixture as extensionFixture } from '@openclaw/fixture-core';\n",
      "examples/fixture-example/package.json": workspacePackage("openclaw-fixture-example", {
        "@openclaw/fixture-extension": "workspace:*",
      }),
      "examples/fixture-example/index.js":
        "import { extensionFixture } from '@openclaw/fixture-extension';\nif (!extensionFixture) process.exit(1);\n",
    },
  });

  // The production target is often behind a moving OpenClaw main. Advance a
  // disjoint tracked path after the contributor branch so the real executor,
  // not the simulator, must synchronize base ancestry before it can push.
  git(["checkout", "main"], fixture.seed);
  writeFile(fixture.seed, "docs/main-since-contributor.md", "Main advanced after the PR.\n");
  git(["add", "docs/main-since-contributor.md"], fixture.seed);
  git(["commit", "-m", "docs: advance fixture main"], fixture.seed);
  git(["push", "origin", "main"], fixture.seed);
  git(["checkout", fixture.headRef], fixture.seed);
  return { ...fixture, baseSha: currentRef(fixture.remote, "main"), behindMain: true };
}

function initializeRepository(
  root,
  {
    fixture,
    files,
    repairTarget,
    forcedTrackedFiles = [],
    trackedExecutableFiles = [],
    trackedSymlinks = {},
  },
) {
  const remote = path.join(root, "target.git");
  const seed = path.join(root, "target-seed");
  git(["init", "--bare", remote]);
  git(["init", "-b", "main", seed]);
  git(["config", "user.name", "E2E Contributor"], seed);
  git(["config", "user.email", "contributor@example.invalid"], seed);
  for (const [relative, contents] of Object.entries(files)) writeFile(seed, relative, contents);
  for (const relative of trackedExecutableFiles) fs.chmodSync(path.join(seed, relative), 0o775);
  for (const [relative, target] of Object.entries(trackedSymlinks)) {
    fs.mkdirSync(path.dirname(path.join(seed, relative)), { recursive: true });
    fs.symlinkSync(target, path.join(seed, relative));
  }
  git(["add", "."], seed);
  for (const relative of Object.keys(trackedSymlinks)) git(["add", "--force", relative], seed);
  // The mutation scenario deliberately tracks package-manager metadata even
  // though production repositories ignore node_modules. pnpm must rewrite it,
  // giving the containment assertion a deterministic real filesystem mutation.
  for (const relative of forcedTrackedFiles) git(["add", "--force", relative], seed);
  git(["commit", "-m", "chore: seed target"], seed);
  git(["remote", "add", "origin", remote], seed);
  git(["push", "-u", "origin", "main"], seed);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], remote);
  git(["checkout", "-b", "contributor/change"], seed);
  writeFile(seed, repairTarget, "broken\n");
  git(["add", repairTarget], seed);
  git(["commit", "-m", "feat: contributor change"], seed);
  git(["push", "-u", "origin", "contributor/change"], seed);
  git(["update-ref", "refs/pull/42/head", currentRef(remote, "contributor/change")], remote);
  return {
    fixture,
    remote,
    seed,
    repairTarget,
    files: [repairTarget],
    headRef: "contributor/change",
    headSha: currentRef(remote, "contributor/change"),
    changelog: files["CHANGELOG.md"] ?? null,
  };
}

function openClawRootPackage() {
  return `${JSON.stringify(
    {
      name: "openclaw",
      version: "0.0.0",
      private: true,
      type: "module",
      engines: { node: OPENCLAW_SHAPED_CONTRACT.node },
      packageManager: OPENCLAW_SHAPED_CONTRACT.packageManager,
      bin: { openclaw: "openclaw.mjs" },
      scripts: {
        "check:changed": "node scripts/check-changed.mjs",
        "check:test-types": "node scripts/fixture-gate.mjs test-types",
        lint: "node scripts/fixture-gate.mjs lint",
        test: "node scripts/fixture-gate.mjs test",
      },
      dependencies: {
        "@openclaw/fixture-core": "workspace:*",
        "@openclaw/fixture-extension": "workspace:*",
      },
    },
    null,
    2,
  )}\n`;
}

function workspacePackage(name, dependencies = undefined) {
  return `${JSON.stringify(
    {
      name,
      version: "0.0.0",
      private: true,
      type: "module",
      ...(dependencies ? { dependencies } : {}),
    },
    null,
    2,
  )}\n`;
}

function openClawWorkspace() {
  return `packages:
  - .
  - ui
  - packages/*
  - extensions/*
  - examples/*

minimumReleaseAge: 2880

minimumReleaseAgeExclude:
  - fixture-overridden

nodeLinker: hoisted
blockExoticSubdeps: true

overrides:
  fixture-overridden: 1.0.0

allowBuilds:
  fixture-native: false
`;
}

function openClawLockfile() {
  const lockfile = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

overrides:
  fixture-overridden: 1.0.0

importers:

  .:
    dependencies:
      '@openclaw/fixture-core':
        specifier: workspace:*
        version: link:packages/fixture-core
      '@openclaw/fixture-extension':
        specifier: workspace:*
        version: link:extensions/fixture-extension

  examples/fixture-example:
    dependencies:
      '@openclaw/fixture-extension':
        specifier: workspace:*
        version: link:../../extensions/fixture-extension

  extensions/fixture-extension:
    dependencies:
      '@openclaw/fixture-core':
        specifier: workspace:*
        version: link:../../packages/fixture-core

  packages/fixture-cli-consumer:
    dependencies:
      openclaw:
        specifier: workspace:*
        version: link:../..

  packages/fixture-core:
    dependencies:
      '@openclaw/fixture-leaf':
        specifier: workspace:*
        version: link:../fixture-leaf

  packages/fixture-leaf: {}

  ui:
    dependencies:
      '@openclaw/fixture-core':
        specifier: workspace:*
        version: link:../packages/fixture-core
`;
  return lockfile;
}

function openClawChangedGate() {
  return `/**
 * Definition: model OpenClaw's changed-surface gate for the E2E fixture.
 * Parameters: none. Output: one JSON summary; non-zero means routing, links,
 * the repair result, or release-owned CHANGELOG preservation is wrong.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const changed = execFileSync("/usr/bin/git", ["diff", "--name-only", "origin/main...HEAD"], {
  encoding: "utf8",
})
  .trim()
  .split("\\n")
  .filter(Boolean);
const repairTarget = "src/repair-target.txt";
assert.ok(changed.includes(repairTarget), "check:changed did not select the repaired root source");
assert.ok(!changed.includes("CHANGELOG.md"), "ordinary automerge repair changed CHANGELOG.md");
assert.equal(fs.readFileSync(repairTarget, "utf8"), "fixed\\n");
assert.equal(
  fs.realpathSync("node_modules/@openclaw/fixture-core"),
  fs.realpathSync("packages/fixture-core"),
  "pnpm did not create the expected root workspace link",
);
assert.equal(
  fs.realpathSync("extensions/fixture-extension/node_modules/@openclaw/fixture-core"),
  fs.realpathSync("packages/fixture-core"),
  "pnpm did not create the expected extension workspace link",
);
const scopes = changed.map((file) =>
  file.startsWith("packages/")
    ? "package"
    : file.startsWith("extensions/")
      ? "extension"
      : file.startsWith("ui/")
        ? "ui"
        : "root",
);
process.stdout.write(
  JSON.stringify({ gate: "check:changed", scopes: [...new Set(scopes)].sort(), changed }) + "\\n",
);
`;
}

function openClawNamedGate() {
  return `/**
 * Definition: preserve OpenClaw's stable validation script names in the fixture.
 * Parameter: gate name. Output: one JSON summary; non-zero rejects unknown gates.
 */
const gate = process.argv[2];
if (!new Set(["lint", "test", "test-types"]).has(gate)) {
  throw new Error("unsupported fixture gate: " + (gate ?? "missing"));
}
process.stdout.write(JSON.stringify({ gate, status: "passed" }) + "\\n");
`;
}

function tinyLockfile() {
  return "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n";
}

function writeFile(root, relative, contents) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function currentRef(remote, ref) {
  return execFileSync("/usr/bin/git", ["--git-dir", remote, "rev-parse", `refs/heads/${ref}`], {
    encoding: "utf8",
  }).trim();
}

function git(args, cwd = process.cwd()) {
  execFileSync("/usr/bin/git", args, { cwd, stdio: "ignore" });
}

function assertFixture(fixture) {
  if (!AUTOMERGE_E2E_FIXTURES.includes(fixture)) {
    throw new Error(`unsupported fixture: ${fixture}`);
  }
}
