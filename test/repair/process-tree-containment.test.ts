import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { readText } from "../helpers.ts";

test("Linux validation containment uses an externally owned PID namespace and subreaper", () => {
  const worker = readText(path.join(process.cwd(), "src/repair/contained-command-worker.ts"));
  const containment = readText(path.join(process.cwd(), "src/repair/process-tree-containment.ts"));

  assert.match(containment, /PR_SET_CHILD_SUBREAPER/);
  assert.match(containment, /os\.waitpid\(-1, os\.WNOHANG\)/);
  assert.match(containment, /if pid != primary_pid:\s+background_pids\.add\(pid\)/);
  assert.match(containment, /if pid != os\.getpid\(\)/);
  assert.match(containment, /background_pids\.update\(pid for pid in remaining_pids/);
  assert.match(containment, /reap_adopted_children\(child\.pid, background_pids\)/);
  assert.match(containment, /return_code = child\.poll\(\)/);
  assert.match(containment, /except ChildProcessError/);
  assert.match(containment, /struct\.pack\("=Qi", allowed_access, path_fd\)/);
  assert.match(containment, /struct\.pack\(\s+"=QQQQ"/);
  assert.match(containment, /set_mount_readonly\("\/", True\)/);
  assert.match(containment, /set_mount_readonly\(root, False\)/);
  assert.doesNotMatch(containment, /_pack_|_layout_/);
  assert.doesNotMatch(containment, /setInterval|Get-CimInstance|ProcessTreeTracker/);
  assert.match(worker, /LINUX_SUBREAPER_SCRIPT/);
  assert.match(worker, /command: "\/usr\/bin\/unshare"/);
  assert.match(worker, /"--map-root-user"/);
  assert.match(worker, /"--mount"/);
  assert.match(worker, /input\.isolateNetwork \? \["--net"\] : \[\]/);
  assert.match(worker, /"--pid"/);
  assert.match(worker, /"--mount-proc"/);
  assert.match(worker, /"--kill-child=SIGKILL"/);
  assert.match(worker, /await reapProcessGroup\(child\.pid\)/);
  assert.match(worker, /validation process containment requires Linux/);
  assert.doesNotMatch(worker, /ProcessTreeTracker/);
});
