import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const entries = {
  actionLedger: path.resolve("dist/repair/action-ledger-cli.js"),
  publishMain: path.resolve("dist/repair/publish-main.js"),
  collectCodexDebug: path.resolve("dist/repair/collect-codex-debug.js"),
  deadLetter: path.resolve("scripts/exact-review-dead-letter-operator.mjs"),
  hydrateState: path.resolve("scripts/hydrate-state.ts"),
  automerge: path.resolve("scripts/e2e/automerge.mjs"),
  automergeContainer: path.resolve("scripts/e2e/automerge-container.mjs"),
};

for (const edge of [
  {
    name: "action-ledger",
    entry: entries.actionLedger,
    unknown: ["finalize", "--unknown"],
    unknownMessage: "unknown argument: --unknown",
    missing: ["finalize", "--lane"],
    missingMessage: "--lane requires a value",
  },
  {
    name: "publish-main",
    entry: entries.publishMain,
    unknown: ["--unknown"],
    unknownMessage: "Unknown argument: --unknown",
    missing: ["--message"],
    missingMessage: "--message requires a value",
  },
  {
    name: "dead-letter operator",
    entry: entries.deadLetter,
    unknown: ["--unknown"],
    unknownMessage: "unknown option --unknown; use --help",
    missing: ["--action"],
    missingMessage:
      "--action must be inventory, recover-fresh, resolve, reconcile, or reconcile-parked",
  },
  {
    name: "hydrate-state",
    entry: entries.hydrateState,
    unknown: ["--unknown"],
    unknownMessage: "Unknown argument: --unknown",
    missing: ["--state-dir"],
    missingMessage: "--state-dir requires a value",
  },
  {
    name: "automerge E2E",
    entry: entries.automerge,
    unknown: ["--unknown"],
    unknownMessage: "unknown option: --unknown; use --help for usage",
    missing: ["--scenario"],
    missingMessage: "--scenario requires a value",
  },
  {
    name: "automerge container E2E",
    entry: entries.automergeContainer,
    unknown: ["--unknown"],
    unknownMessage: "unknown option: --unknown; use --help for usage",
    missing: ["--scenario"],
    missingMessage: "--scenario requires a value",
  },
]) {
  test(`${edge.name} preserves unknown-option and missing-value errors`, () => {
    const unknown = run(edge.entry, edge.unknown);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, new RegExp(escapeRegex(edge.unknownMessage)));

    const missing = run(edge.entry, edge.missing);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, new RegExp(escapeRegex(edge.missingMessage)));
  });
}

test("collect-codex-debug preserves permissive unknown and missing-value defaults", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-collect-parser-"));
  try {
    const unknown = run(
      entries.collectCodexDebug,
      ["--unknown", "ignored", "--codex-home", path.join(root, "missing"), "--out", "out"],
      root,
    );
    assert.equal(unknown.status, 0, unknown.stderr);
    assert.equal(JSON.parse(unknown.stdout).out_dir, "out");

    const missing = run(
      entries.collectCodexDebug,
      ["--codex-home", path.join(root, "missing"), "--out"],
      root,
    );
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(JSON.parse(missing.stdout).out_dir, ".clawsweeper-repair/codex-debug");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function run(entry: string, args: string[], cwd = process.cwd()) {
  return spawnSync(process.execPath, [entry, ...args], { cwd, encoding: "utf8" });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
