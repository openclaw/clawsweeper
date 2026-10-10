/**
 * Definition: a Node test-runner entry, started by
 * `run-node-tests.mjs --coverage-from`, that copies raw V8 coverage profiles
 * recorded by `--coverage-out` shards into the coverage directory of the
 * current `node --test --experimental-test-coverage` run. Node's own report
 * then merges them and enforces the configured thresholds exactly as it does
 * for an unsharded run.
 *
 * Parameters: CLAWSWEEPER_COVERAGE_REPLAY_DIR names the shard profile root
 * (searched recursively); NODE_V8_COVERAGE is the coverage directory Node's
 * runner assigns to its test processes.
 *
 * Outputs: one test that fails when no profile is found, a profile is empty or
 * malformed, or no profile covers a script in this checkout (for example,
 * profiles recorded from a different checkout path).
 */

import assert from "node:assert/strict";
import { constants, copyFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { COVERAGE_PROFILE_PATTERN, readCoverageProfile } from "./run-node-tests.mjs";

test("sharded V8 coverage profiles replay into this coverage run", (t) => {
  const source = process.env.CLAWSWEEPER_COVERAGE_REPLAY_DIR;
  const destination = process.env.NODE_V8_COVERAGE;
  assert.ok(source, "CLAWSWEEPER_COVERAGE_REPLAY_DIR must name the shard profile directory");
  assert.ok(destination, "replay must run under node --test --experimental-test-coverage");

  const checkout = `${pathToFileURL(realpathSync(process.cwd())).href}/`;
  const profiles = readdirSync(source, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && COVERAGE_PROFILE_PATTERN.test(entry.name))
    .map((entry) => ({ name: entry.name, path: join(entry.parentPath, entry.name) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  let checkoutScripts = 0;
  for (const [ordinal, { name, path }] of profiles.entries()) {
    checkoutScripts += readCoverageProfile(path).result.filter(({ url }) =>
      url.startsWith(checkout),
    ).length;
    // Shards on different runners can reuse a pid, so the ordinal replaces it.
    // Keeping the recorded (past) timestamp means no name can meet this
    // process's own exit-time profile; COPYFILE_EXCL fails loudly regardless.
    const [, timestamp, sequence] = COVERAGE_PROFILE_PATTERN.exec(name);
    copyFileSync(
      path,
      join(destination, `coverage-${ordinal}-${timestamp}-${sequence}.json`),
      constants.COPYFILE_EXCL,
    );
  }

  assert.ok(profiles.length > 0, `no V8 coverage profiles found under ${source}`);
  assert.ok(
    checkoutScripts > 0,
    `profiles under ${source} cover no script in ${checkout}; record them from the same checkout path`,
  );
  t.diagnostic(`replayed ${profiles.length} profiles covering ${checkoutScripts} checkout scripts`);
});
