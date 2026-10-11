import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const entries = {
  actionLedger: path.resolve("dist/repair/action-ledger-cli.js"),
  publishMain: path.resolve("dist/repair/publish-main.js"),
  deadLetter: path.resolve("scripts/exact-review-dead-letter-operator.mjs"),
  hydrateState: path.resolve("scripts/hydrate-state.ts"),
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

function run(entry: string, args: string[], cwd = process.cwd()) {
  return spawnSync(process.execPath, [entry, ...args], { cwd, encoding: "utf8" });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
