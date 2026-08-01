import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";

import { runContainedCommand } from "./command-runner.js";

const PINNED_OPENCLAW_KNIP_VERSION = "6.8.0";
const PINNED_OPENCLAW_KNIP_PUBLISHED_AT = "2026-04-29T06:27:29.928Z";
const PREPARED_PNPM_HELPER_CACHE = ".__clawsweeper_pnpm_helper_cache__";
const MINIMUM_OPENCLAW_RELEASE_AGE_MINUTES = 48 * 60;
const PINNED_OPENCLAW_KNIP_LOCK = fileURLToPath(
  new URL("../../config/openclaw-knip-6.8.0.pnpm-lock.yaml", import.meta.url),
);

export function preparePinnedOpenClawValidationHelper({
  cwd,
  targetRepo,
  validationEnv,
  installRegistry,
  remainingTimeoutMs,
}: {
  cwd: string;
  targetRepo: string;
  validationEnv: NodeJS.ProcessEnv;
  installRegistry: string;
  remainingTimeoutMs: () => number;
}): void {
  if (targetRepo !== "openclaw/openclaw") return;
  const runnerPath = path.join(cwd, "scripts", "deadcode-knip-runner.mjs");
  if (!fs.existsSync(runnerPath)) return;
  const runner = fs.readFileSync(runnerPath, "utf8");
  if (!/^const KNIP_VERSION = ["']6\.8\.0["'];/m.test(runner)) return;

  // Materialize the complete reviewed dependency graph with frozen resolution;
  // lifecycle scripts and downloaded package code never execute during setup.
  // Seed pnpm's dlx layout from that exact install so the real repository gate
  // can reuse it offline without ever resolving floating transitive versions.
  const profileRoot = path.dirname(String(validationEnv.HOME));
  const helperCache = path.join(String(validationEnv.COREPACK_HOME), PREPARED_PNPM_HELPER_CACHE);
  const minimumReleaseAge = openClawMinimumReleaseAge(cwd);
  const dlxRoot = path.join(helperCache, "pnpm", "dlx");
  const fullCacheKey = pinnedOpenClawDlxCacheKey(installRegistry);
  const cacheRoot = path.join(dlxRoot, fullCacheKey);
  const helperProject = path.join(cacheRoot, "pinned");
  fs.mkdirSync(helperProject, { recursive: true, mode: 0o700 });
  fs.copyFileSync(PINNED_OPENCLAW_KNIP_LOCK, path.join(helperProject, "pnpm-lock.yaml"));
  fs.writeFileSync(
    path.join(helperProject, "package.json"),
    JSON.stringify({
      name: "clawsweeper-pinned-openclaw-knip",
      private: true,
      dependencies: { knip: PINNED_OPENCLAW_KNIP_VERSION },
    }),
  );
  fs.writeFileSync(
    path.join(helperProject, "pnpm-workspace.yaml"),
    `minimumReleaseAge: ${minimumReleaseAge}\n`,
  );
  runContainedCommand(
    "pnpm",
    [
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      `--config.minimum-release-age=${minimumReleaseAge}`,
      "--config.enable-pre-post-scripts=false",
      "--config.enable-global-virtual-store=false",
      `--config.registry=${installRegistry}`,
    ],
    {
      cwd: helperProject,
      env: { ...validationEnv, XDG_CACHE_HOME: helperCache },
      isolateNetwork: false,
      timeoutMs: remainingTimeoutMs(),
      writableRoots: [profileRoot],
    },
  );
  scopePinnedOpenClawJitiCache(helperProject);
  fs.symlinkSync("pinned", path.join(cacheRoot, "pkg"));
  fs.symlinkSync(fullCacheKey, path.join(dlxRoot, fullCacheKey.slice(0, 32)));
  assertPinnedOpenClawValidationHelperLock(helperCache);
  seedOfflinePinnedOpenClawMetadata(helperCache, helperProject, installRegistry);
}

function scopePinnedOpenClawJitiCache(helperProject: string): void {
  const knipBin = path.join(helperProject, "node_modules", ".bin", "knip");
  const originalBin = path.join(path.dirname(knipBin), "knip-real");
  const mode = fs.statSync(knipBin).mode;
  fs.renameSync(knipBin, originalBin);
  fs.writeFileSync(
    knipBin,
    '#!/bin/sh\nJITI_FS_CACHE=0\nexport JITI_FS_CACHE\nexec "${0%/*}/knip-real" "$@"\n',
    { mode },
  );
}

function pinnedOpenClawDlxCacheKey(installRegistry: string): string {
  const resolvedPackages = [`knip@${PINNED_OPENCLAW_KNIP_VERSION}`];
  const registries = [
    ["@jsr", "https://npm.jsr.io/"],
    ["default", installRegistry],
  ];
  return createHash("sha256")
    .update(JSON.stringify([resolvedPackages, registries]))
    .digest("hex");
}

function seedOfflinePinnedOpenClawMetadata(
  helperCache: string,
  helperProject: string,
  installRegistry: string,
): void {
  const cacheRoot = path.join(helperCache, "pnpm");
  const versions = fs.readdirSync(cacheRoot).filter((entry) => /^v\d+$/.test(entry));
  // pnpm's encode-registry package replaces the host/port separator with `+`.
  const registryHost = new URL(installRegistry).host.replace(":", "+");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(helperProject, "node_modules", "knip", "package.json"), "utf8"),
  ) as Record<string, unknown>;
  if (manifest.name !== "knip" || manifest.version !== PINNED_OPENCLAW_KNIP_VERSION) {
    throw new Error("pinned OpenClaw Knip package does not match the trusted dependency graph");
  }
  const lock = parseYaml(fs.readFileSync(PINNED_OPENCLAW_KNIP_LOCK, "utf8")) as {
    packages?: Record<string, { resolution?: { integrity?: string } }>;
  };
  const integrity = lock.packages?.[`knip@${PINNED_OPENCLAW_KNIP_VERSION}`]?.resolution?.integrity;
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    throw new Error("pinned OpenClaw Knip integrity is missing from the trusted dependency graph");
  }
  const version = {
    ...manifest,
    dist: {
      integrity,
      tarball: new URL(`knip/-/knip-${PINNED_OPENCLAW_KNIP_VERSION}.tgz`, installRegistry).href,
    },
  };
  const metadata = {
    name: "knip",
    "dist-tags": { latest: PINNED_OPENCLAW_KNIP_VERSION },
    versions: { [PINNED_OPENCLAW_KNIP_VERSION]: version },
    time: { [PINNED_OPENCLAW_KNIP_VERSION]: PINNED_OPENCLAW_KNIP_PUBLISHED_AT },
    modified: PINNED_OPENCLAW_KNIP_PUBLISHED_AT,
    cachedAt: Date.now(),
  };
  for (const version of versions) {
    for (const layout of ["metadata", "metadata-full", "metadata-full-filtered"]) {
      const destination = path.join(cacheRoot, version, layout, registryHost, "knip.jsonl");
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(
        destination,
        `${JSON.stringify({ modified: PINNED_OPENCLAW_KNIP_PUBLISHED_AT })}\n${JSON.stringify(metadata)}\n`,
      );
    }
  }
  for (const layout of ["metadata-v1.3", "metadata-full-v1.3", "metadata-ff-v1.3"]) {
    const destination = path.join(cacheRoot, layout, registryHost, "knip.json");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(metadata));
  }
}

function openClawMinimumReleaseAge(cwd: string): number {
  const workspacePath = path.join(cwd, "pnpm-workspace.yaml");
  if (!fs.existsSync(workspacePath)) return MINIMUM_OPENCLAW_RELEASE_AGE_MINUTES;
  const workspace = parseYaml(fs.readFileSync(workspacePath, "utf8")) as {
    minimumReleaseAge?: unknown;
  } | null;
  const configured = Number(workspace?.minimumReleaseAge);
  return Number.isSafeInteger(configured)
    ? Math.max(MINIMUM_OPENCLAW_RELEASE_AGE_MINUTES, configured)
    : MINIMUM_OPENCLAW_RELEASE_AGE_MINUTES;
}

function assertPinnedOpenClawValidationHelperLock(helperCache: string): void {
  const dlxRoot = path.join(helperCache, "pnpm", "dlx");
  const generatedLocks = fs
    .readdirSync(dlxRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dlxRoot, entry.name, "pkg", "pnpm-lock.yaml"))
    .filter((lockPath) => fs.existsSync(lockPath));
  if (generatedLocks.length !== 1) {
    throw new Error("pinned OpenClaw Knip dependency lockfile is missing or ambiguous");
  }
  const expected = parseYaml(fs.readFileSync(PINNED_OPENCLAW_KNIP_LOCK, "utf8")) as {
    importers?: unknown;
    packages?: unknown;
    snapshots?: unknown;
  };
  const actual = parseYaml(fs.readFileSync(generatedLocks[0]!, "utf8")) as typeof expected;
  if (
    !isDeepStrictEqual(actual.importers, expected.importers) ||
    !isDeepStrictEqual(actual.packages, expected.packages) ||
    !isDeepStrictEqual(actual.snapshots, expected.snapshots)
  ) {
    throw new Error("pinned OpenClaw Knip dependency lockfile does not match the trusted graph");
  }
}

export function restorePinnedOpenClawValidationHelperCache(
  corepackHome: string,
  cache: string,
): void {
  const helperCache = path.join(corepackHome, PREPARED_PNPM_HELPER_CACHE);
  if (!fs.existsSync(helperCache)) return;
  fs.cpSync(helperCache, cache, {
    recursive: true,
    verbatimSymlinks: true,
  });
}
