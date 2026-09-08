#!/usr/bin/env node

/**
 * Definition: build and run the repository-owned automerge E2E image locally.
 * Parameters: --scenario, --fixture, --expect, --candidate-root, --output, --image,
 * --base-image, and --no-build are optional.
 * Outputs: the harness summary on stdout and retained step logs under --output.
 * Decision: local validation builds its base from repository source and uses a
 * fresh application image so host state and external publishers cannot affect
 * the result. Docker still caches unchanged OS and dependency layers.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseCliArgs } from "../cli-args.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`Usage:
  node scripts/e2e/automerge-container.mjs [options]

Description:
  Builds a Node 24 local container and runs the same automerge E2E harness used
  by CI and Crabbox. GitHub and Codex are simulated; production CLIs, Git,
  Corepack, pnpm, artifact transfer, validation, push, and merge routing are real.

Options:
  --scenario <name>       Scenario name or all (default: all)
  --fixture <name>        tiny, openclaw-shaped, or all (default: all)
  --expect <outcome>      success or setup-identity-failure (default: success);
                          failure proof supports the historical regression and
                          openclaw-shaped happy-path
  --candidate-root <dir>  Built candidate checkout mounted read-only
  --output <dir>          Host artifact directory (default: test-results/automerge-container)
  --image <tag>           Local image tag (default: clawsweeper-automerge-e2e:local)
  --base-image <tag>      Explicitly trust and reuse a prebuilt base image
  --no-build              Reuse an existing local image
  -h, --help              Show this help

Outputs:
  <output>/<scenario>/summary.json plus one stdout/stderr log per production step.
  Exit code 0 means every selected terminal-state assertion passed.

Examples:
  pnpm e2e:automerge:container
  pnpm e2e:automerge:container -- --scenario planning-head-drift --fixture openclaw-shaped
  pnpm e2e:automerge:container -- --scenario ci-regression-29623139111 \\
    --candidate-root ../clawsweeper-ci-regression --expect setup-identity-failure
  pnpm e2e:automerge:container -- --scenario happy-path --fixture openclaw-shaped \\
    --candidate-root ../clawsweeper-before-fix --expect setup-identity-failure
`);
  process.exit(0);
}

const repoRoot = process.cwd();
const output = path.resolve(String(args.output ?? "test-results/automerge-container"));
const image = String(args.image ?? "clawsweeper-automerge-e2e:local");
const baseImage = String(args.baseImage ?? "clawsweeper-automerge-e2e-base:local");
const scenario = String(args.scenario ?? "all");
const fixture = String(args.fixture ?? "all");
const expectedOutcome = String(args.expect ?? "success");
const candidateRoot = args.candidateRoot ? path.resolve(String(args.candidateRoot)) : null;
if (candidateRoot && !fs.statSync(candidateRoot, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error(`candidate root is not a directory: ${candidateRoot}`);
}
fs.mkdirSync(output, { recursive: true });

run("docker", ["--version"]);
if (!args.noBuild) {
  if (!args.baseImage) {
    run("docker", [
      "build",
      "--file",
      "test/e2e/automerge/Dockerfile.base",
      "--tag",
      baseImage,
      ".",
    ]);
  }
  run("docker", [
    "build",
    "--file",
    "test/e2e/automerge/Dockerfile",
    "--tag",
    image,
    "--build-arg",
    `AUTOMERGE_E2E_BASE_IMAGE=${baseImage}`,
    ".",
  ]);
}

const hostOwner =
  typeof process.getuid === "function" && typeof process.getgid === "function"
    ? `${process.getuid()}:${process.getgid()}`
    : null;
const e2eRun = runResult("docker", [
  "run",
  "--rm",
  // A broken fixture must fail inside a bounded test process instead of
  // consuming the developer host. The reconstructed target is intentionally
  // small and should remain far below these limits.
  "--memory",
  "8g",
  "--memory-swap",
  "8g",
  "--pids-limit",
  "1024",
  // The production validator creates a nested user/mount namespace and then
  // drops all capabilities. Docker's defaults block that namespace setup;
  // these options enable it without granting SYS_ADMIN or privileged mode.
  "--security-opt",
  "seccomp=unconfined",
  "--security-opt",
  "systempaths=unconfined",
  // The production validator creates its own user/mount namespace and drops
  // every capability before the target starts. Mapping a non-root host UID
  // into this outer container prevents that nested namespace from remounting
  // Docker's root filesystem read-only.
  "--env",
  "HOME=/tmp/clawsweeper-e2e-home",
  "--volume",
  `${output}:/e2e-output`,
  ...(candidateRoot ? ["--volume", `${candidateRoot}:/candidate:ro`] : []),
  image,
  "node",
  "scripts/e2e/automerge.mjs",
  "--scenario",
  scenario,
  "--fixture",
  fixture,
  "--output",
  "/e2e-output",
  "--expect",
  expectedOutcome,
  ...(candidateRoot ? ["--candidate-root", "/candidate"] : []),
]);
if (hostOwner && hostOwner !== "0:0") {
  run("docker", [
    "run",
    "--rm",
    "--volume",
    `${output}:/e2e-output`,
    image,
    "chown",
    "-R",
    hostOwner,
    "/e2e-output",
  ]);
}
assertRunSucceeded("docker", e2eRun);

function run(command, commandArgs) {
  assertRunSucceeded(command, runResult(command, commandArgs));
}

function runResult(command, commandArgs) {
  return spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
}

function assertRunSucceeded(command, child) {
  if (child.error) {
    throw new Error(`${command} could not start: ${child.error.message}`);
  }
  if (child.status !== 0) {
    throw new Error(`${command} exited ${child.status ?? `with signal ${child.signal}`}`);
  }
}

function parseArgs(argv) {
  const values = parseCliArgs(argv, {
    help: { type: "boolean", short: "h" },
    "no-build": { type: "boolean" },
    scenario: { type: "string" },
    fixture: { type: "string" },
    expect: { type: "string" },
    "candidate-root": { type: "string" },
    output: { type: "string" },
    image: { type: "string" },
    "base-image": { type: "string" },
  });
  return {
    help: values.help,
    noBuild: values["no-build"],
    scenario: values.scenario,
    fixture: values.fixture,
    expect: values.expect,
    candidateRoot: values["candidate-root"],
    output: values.output,
    image: values.image,
    baseImage: values["base-image"],
  };
}
