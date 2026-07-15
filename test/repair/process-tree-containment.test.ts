import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { readText } from "../helpers.ts";

test("Linux validation containment uses an externally owned PID namespace and subreaper", () => {
  const worker = readText(path.join(process.cwd(), "src/repair/contained-command-worker.ts"));
  const sandbox = readText(path.join(process.cwd(), "src/repair/contained-command-sandbox.ts"));
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
  assert.match(containment, /checked_mount\(\s+"tmpfs",\s+sandbox_root/);
  assert.match(containment, /checked_mount\(\s+"tmpfs",\s+root_path\(sandbox_root, "\/run"\)/);
  assert.match(containment, /set_mount_readonly\(sandbox_root, True\)/);
  assert.match(containment, /set_mount_readonly\(target, False, recursive\)/);
  assert.match(containment, /if error\.errno != errno\.ENOSYS:/);
  assert.match(containment, /legacy_set_mount_readonly\(path, readonly, recursive\)/);
  assert.match(
    containment,
    /MS_BIND \| MS_REMOUNT \| preserved_flags \| \(MS_RDONLY if readonly else 0\)/,
  );
  assert.match(containment, /\("nosuid", MS_NOSUID\)/);
  assert.match(containment, /\("nodev", MS_NODEV\)/);
  assert.match(containment, /\("noexec", MS_NOEXEC\)/);
  assert.match(containment, /open\("\/proc\/self\/mountinfo"/);
  assert.match(containment, /os\.chroot\(sandbox_root\)/);
  assert.match(containment, /validation working directory is outside writable roots/);
  assert.match(containment, /validation writable root is unsafe/);
  assert.doesNotMatch(containment, /checked_mount\("\/", "\/", MS_BIND/);
  assert.match(containment, /bring_up_loopback\(\)/);
  assert.match(containment, /PR_CAPBSET_DROP/);
  assert.match(containment, /PR_CAP_AMBIENT_CLEAR_ALL/);
  assert.match(containment, /libc\.capset/);
  assert.match(containment, /validation capabilities were not fully dropped/);
  assert.match(containment, /empty_deadline = time\.monotonic\(\) \+ 0\.1/);
  assert.match(containment, /if time\.monotonic\(\) >= empty_deadline/);
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
  assert.match(worker, /createTrustedSandboxRoot\(input\.writableRoots\)/);
  assert.match(worker, /\.\/contained-command-sandbox\.js/);
  assert.match(sandbox, /candidates = \["\/var\/tmp", "\/tmp", os\.tmpdir\(\)\]/);
  assert.match(sandbox, /validation sandbox requires a trusted root outside writable roots/);
  assert.match(worker, /sandboxRoot!/);
  assert.match(worker, /fs\.rmSync\(sandboxRoot/);
  assert.match(worker, /await reapProcessGroup\(child\.pid\)/);
  assert.match(worker, /validation process containment requires Linux/);
  assert.doesNotMatch(worker, /ProcessTreeTracker/);
});

test("Linux validation containment applies every fail-closed stage before target spawn", () => {
  const containment = readText(path.join(process.cwd(), "src/repair/process-tree-containment.ts"));
  const main = containment.slice(containment.indexOf("def main():"));

  const loopback = main.indexOf("bring_up_loopback()");
  const filesystem = main.indexOf("isolate_filesystem(");
  const landlock = main.indexOf("restrict_filesystem_writes(canonical_roots)");
  const capabilities = main.indexOf("drop_capabilities()");
  const spawn = main.indexOf("subprocess.Popen(command, close_fds=True)");

  assert.ok(loopback >= 0);
  assert.ok(filesystem > loopback);
  assert.ok(landlock > filesystem);
  assert.ok(capabilities > landlock);
  assert.ok(spawn > capabilities);
  assert.match(containment, /forbidden_exact_roots = \{/);
  assert.match(containment, /"\/run",/);
  assert.match(containment, /os\.symlink\("\/run", root_path\(sandbox_root, "\/var\/run"\)\)/);
});
