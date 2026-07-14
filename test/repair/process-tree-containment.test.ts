import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { readText } from "../helpers.ts";

test("Linux validation containment uses a kernel child subreaper", () => {
  const worker = readText(path.join(process.cwd(), "src/repair/contained-command-worker.ts"));
  const containment = readText(path.join(process.cwd(), "src/repair/process-tree-containment.ts"));

  assert.match(containment, /PR_SET_CHILD_SUBREAPER/);
  assert.match(containment, /os\.waitpid\(-1, os\.WNOHANG\)/);
  assert.match(containment, /except ChildProcessError/);
  assert.doesNotMatch(containment, /setInterval|Get-CimInstance|ProcessTreeTracker/);
  assert.match(worker, /LINUX_SUBREAPER_SCRIPT/);
  assert.match(worker, /validation process containment requires Linux/);
  assert.doesNotMatch(worker, /ProcessTreeTracker/);
});
