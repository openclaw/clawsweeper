#!/usr/bin/env bash
set -euo pipefail

expected_head=${1:?expected committed head argument is required}

echo "PROOF_PHASE=environment"
echo "provider=local-container"
echo "image=node:24-bookworm"
echo "head=$expected_head"
node --version

echo "PROOF_PHASE=corepack"
corepack enable
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
git clone --depth 1 https://github.com/openclaw/openclaw.git "$target_dir"
node - "$target_dir" <<'NODE'
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const target = process.argv[2];
const { prepareTargetToolchain } = await import(
  new URL("dist/repair/target-validation.js", `file://${process.cwd()}/`)
);

console.log(
  `PROOF_TARGET=openclaw/openclaw@${execFileSync("git", ["-C", target, "rev-parse", "HEAD"]).toString().trim()}`,
);
console.log("PROOF_ENTRY=prepareTargetToolchain");
console.log(
  `PROOF_DEPRECATED_FIELD_PRESENT=${fs
    .readFileSync(`${target}/pnpm-lock.yaml`, "utf8")
    .includes("deprecated: |-")}`,
);

try {
  prepareTargetToolchain(target, {
    targetRepo: "openclaw/openclaw",
    installTargetDeps: true,
    installTimeoutMs: 8000,
    setupTimeoutMs: 8000,
  });
  console.log("PROOF_RESULT=prepareTargetToolchain returned without throwing");
} catch (error) {
  const message = String(error?.message ?? error);
  console.log(`PROOF_ERROR_MESSAGE=${message.split("\n")[0]}`);
  console.log(
    `PROOF_NETWORK_POLICY_DESTINATION_REJECTED=${message.includes(
      "target dependency install destination is not approved",
    )}`,
  );
}
NODE

echo "PROOF_PHASE=content"
sha256sum \
  src/repair/target-validation.ts \
  test/repair/target-validation.test.ts \
  docs/proof/lockfile-deprecated-field-network-policy/behavior-contract.md \
  docs/proof/lockfile-deprecated-field-network-policy/run-proof.sh

echo "PROOF_PHASE=done"
