import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseProcessRows } from "../../dist/repair/process-tree-containment.js";
import { readText } from "../helpers.ts";

test("process tree parsing preserves parent relationships for host-side tracking", () => {
  assert.deepEqual(parseProcessRows("  10  1\n11 10\ninvalid\n12 11 extra\n"), [
    { pid: 10, parentPid: 1 },
    { pid: 11, parentPid: 10 },
    { pid: 12, parentPid: 11 },
  ]);
});

test("contained validation does not rely on target-controlled markers", () => {
  const worker = readText(path.join(process.cwd(), "src/repair/contained-command-worker.ts"));
  const tracker = readText(path.join(process.cwd(), "src/repair/process-tree-containment.ts"));

  assert.doesNotMatch(worker, /CS_VALIDATION_|markedProcessIds/);
  assert.match(worker, /tracker\?\.trackedPids\(\)/);
  assert.match(worker, /terminateWindowsProcessTree\(trackedPid\)/);
  assert.match(tracker, /Get-CimInstance Win32_Process/);
  assert.match(tracker, /this\.#trackedPids\.has\(row\.parentPid\)/);
  assert.equal(
    fs.existsSync(path.join(process.cwd(), "src/repair/process-tree-containment.ts")),
    true,
  );
});
