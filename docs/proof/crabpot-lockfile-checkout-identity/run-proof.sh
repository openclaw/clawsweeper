#!/usr/bin/env bash
set -euo pipefail

expected_head=${1:?expected committed head argument is required}

echo "PROOF_PHASE=environment"
echo "provider=local-container"
echo "image=node:24-bookworm"
echo "head=$expected_head"
node --version

echo "PROOF_PHASE=corepack"
corepack enable 2>/dev/null || sudo corepack enable
corepack use pnpm@11.10.0
pnpm --version

echo "PROOF_PHASE=install"
pnpm install --frozen-lockfile

echo "PROOF_PHASE=build"
pnpm run build:all

echo "PROOF_PHASE=static"
pnpm run format:check
pnpm run lint

echo "PROOF_PHASE=focused-tests"
node --test test/repair/target-validation.test.ts

echo "PROOF_PHASE=production-real-behavior"
target_dir="$(mktemp -d)"
git clone --quiet https://github.com/openclaw/crabpot.git "$target_dir"
git -C "$target_dir" fetch --quiet origin 0cb363fdae97a06cc91f96525529cb3907ae20ad
git -C "$target_dir" checkout --quiet --detach 0cb363fdae97a06cc91f96525529cb3907ae20ad
node - "$target_dir" <<'NODE'
import { execFileSync } from "node:child_process";

const target = process.argv[2];
const { prepareTargetToolchain } = await import(
  new URL("dist/repair/target-validation.js", `file://${process.cwd()}/`)
);

console.log(
  `PROOF_TARGET=openclaw/crabpot@${execFileSync("git", ["-C", target, "rev-parse", "HEAD"]).toString().trim()}`,
);
console.log("PROOF_ENTRY=prepareTargetToolchain");
console.log(
  `PROOF_STATUS_BEFORE=${execFileSync("git", ["-C", target, "status", "--porcelain"]).toString().trim() || "(clean)"}`,
);

try {
  prepareTargetToolchain(target, {
    targetRepo: "openclaw/crabpot",
    installTargetDeps: true,
    installTimeoutMs: 120000,
    setupTimeoutMs: 60000,
    toolchain: {
      packageManager: "pnpm",
      baseValidationCommands: ["pnpm check"],
      changedGate: null,
    },
  });
  console.log("PROOF_RESULT=prepareTargetToolchain returned without throwing");
} catch (error) {
  const message = String(error?.message ?? error);
  console.log(`PROOF_ERROR_MESSAGE=${message.split("\n")[0]}`);
}

console.log(
  `PROOF_STATUS_AFTER=${execFileSync("git", ["-C", target, "status", "--porcelain"]).toString().trim() || "(clean)"}`,
);
console.log(`PROOF_LOCKFILE_PRESENT_AFTER=${(await import("node:fs")).existsSync(`${target}/pnpm-lock.yaml`)}`);
NODE

echo "PROOF_PHASE=content"
sha256sum \
  src/repair/target-validation.ts \
  test/repair/target-validation.test.ts \
  docs/proof/crabpot-lockfile-checkout-identity/behavior-contract.md \
  docs/proof/crabpot-lockfile-checkout-identity/run-proof.sh

echo "PROOF_PHASE=done"
