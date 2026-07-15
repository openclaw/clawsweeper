import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LINUX_SUBREAPER_SCRIPT } from "../../dist/repair/process-tree-containment.js";
import { parseContainmentProtocol } from "../../dist/repair/contained-command-worker.js";
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
  assert.match(containment, /error\.errno not in \{errno\.ENOSYS, errno\.EOPNOTSUPP\}/);
  assert.match(containment, /if abi is None:\s+return/);
  assert.match(containment, /ruleset_fd = checked_syscall/);
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

  const loopback = main.indexOf('run_stage("namespace_setup", bring_up_loopback)');
  const filesystem = main.indexOf("isolate_filesystem(");
  const landlock = main.indexOf("restrict_filesystem_writes(canonical_roots)");
  const capabilities = main.indexOf('run_stage("capability_drop", drop_capabilities)');
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

test("embedded containment runtime imports without executing its production entrypoint", () => {
  const result = runLandlockScenario("import");

  assert.deepEqual(result, { status: "imported" });
});

test("Landlock capability probe selects fallback only for unsupported syscalls", () => {
  for (const scenario of ["probe_enosys", "probe_eopnotsupp"]) {
    const result = runLandlockScenario(scenario);
    assert.deepEqual(result, { calls: [444], result: "unavailable", status: "ok" });
  }

  for (const [scenario, errorNumber] of [
    ["probe_eperm", 1],
    ["probe_eacces", 13],
    ["probe_einval", 22],
  ] as const) {
    const result = runLandlockScenario(scenario);
    assert.deepEqual(result, {
      errno: errorNumber,
      stage: "landlock_capability_probe",
      status: "error",
      syscall: 444,
    });
  }
});

test("Landlock enforcement remains fail closed after a successful probe", () => {
  assert.deepEqual(runLandlockScenario("abi_2"), {
    errno: null,
    stage: "landlock_capability_probe",
    status: "error",
    syscall: 444,
  });
  assert.deepEqual(runLandlockScenario("success"), {
    calls: [444, 444, 445, 446],
    result: "abi-3",
    status: "ok",
  });

  for (const [scenario, stage, syscall, errorNumber] of [
    ["create_enosys", "landlock_ruleset_creation", 444, 38],
    ["add_eacces", "landlock_add_rule", 445, 13],
    ["restrict_eperm", "landlock_restrict_self", 446, 1],
  ] as const) {
    const result = runLandlockScenario(scenario);
    assert.deepEqual(result, {
      errno: errorNumber,
      stage,
      status: "error",
      syscall,
    });
  }
});

test("mount and mandatory-stage failures retain actionable safe diagnostics", () => {
  assert.deepEqual(runLandlockScenario("mount_native"), {
    result: "native",
    status: "ok",
  });
  assert.deepEqual(runLandlockScenario("mount_legacy"), {
    result: "legacy",
    status: "ok",
  });
  assert.deepEqual(runLandlockScenario("mount_eperm"), {
    errno: 1,
    stage: "mount_setattr",
    status: "error",
    syscall: 442,
  });
  assert.deepEqual(runLandlockScenario("legacy_eacces"), {
    errno: 13,
    stage: "legacy_remount",
    status: "error",
    syscall: 165,
  });
  assert.deepEqual(runLandlockScenario("capability_drop_eperm"), {
    errno: 1,
    stage: "capability_drop",
    status: "error",
    syscall: null,
  });
});

test("containment diagnostics expose only validated stage, syscall, and errno fields", () => {
  assert.throws(
    () =>
      parseContainmentProtocol(
        [
          Buffer.from(
            JSON.stringify({
              containmentError: {
                errno: 38,
                stage: "landlock_capability_probe",
                syscall: 444,
                unsafe: "/home/runner/secret command",
              },
            }),
          ),
        ],
        { signal: null, status: 125 },
      ),
    (error: Error) => {
      assert.equal(
        error.message,
        "validation process containment failed: stage=landlock_capability_probe syscall=444 errno=38",
      );
      assert.doesNotMatch(error.message, /runner|secret|command/);
      return true;
    },
  );

  assert.throws(
    () => parseContainmentProtocol([], { signal: null, status: 1 }),
    /stage=namespace_setup exit=1/,
  );
});

function runLandlockScenario(scenario: string): Record<string, unknown> {
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-containment-python-"));
  const modulePath = path.join(root, "containment_runtime.py");
  writeFileSync(modulePath, LINUX_SUBREAPER_SCRIPT);
  try {
    const harness = String.raw`
import errno
import importlib.util
import json
import sys

module_path, scenario = sys.argv[1:]
spec = importlib.util.spec_from_file_location("containment_runtime", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
if scenario == "import":
    print(json.dumps({"status": "imported"}, separators=(",", ":")))
    raise SystemExit(0)

def error_payload(error):
    return {
        "errno": error.error_number,
        "stage": error.stage,
        "status": "error",
        "syscall": error.syscall_number,
    }

if scenario.startswith("mount_") or scenario == "legacy_eacces":
    def mount_syscall(_number, *_arguments):
        if scenario in {"mount_legacy", "legacy_eacces"}:
            raise OSError(errno.ENOSYS, "mount_setattr")
        if scenario == "mount_eperm":
            raise OSError(errno.EPERM, "mount_setattr")
        return 0
    def legacy_mount(_path, _readonly, _recursive):
        if scenario == "legacy_eacces":
            raise OSError(errno.EACCES, "legacy")
    module.checked_syscall = mount_syscall
    module.legacy_set_mount_readonly = legacy_mount
    try:
        payload = {"result": module.set_mount_readonly("/sandbox", True), "status": "ok"}
    except module.ContainmentStageError as error:
        payload = error_payload(error)
    print(json.dumps(payload, separators=(",", ":")))
    raise SystemExit(0)

if scenario == "capability_drop_eperm":
    def fail_capability_drop():
        raise OSError(errno.EPERM, "capability")
    try:
        module.run_stage("capability_drop", fail_capability_drop)
    except module.ContainmentStageError as error:
        print(json.dumps(error_payload(error), separators=(",", ":")))
        raise SystemExit(0)

calls = []
probe_errors = {
    "probe_enosys": errno.ENOSYS,
    "probe_eopnotsupp": errno.EOPNOTSUPP,
    "probe_eperm": errno.EPERM,
    "probe_eacces": errno.EACCES,
    "probe_einval": errno.EINVAL,
}

def fake_syscall(number, *arguments):
    calls.append(number)
    if len(calls) == 1:
        if scenario in probe_errors:
            raise OSError(probe_errors[scenario], "probe")
        return 2 if scenario == "abi_2" else 3
    if number == module.SYS_LANDLOCK_CREATE_RULESET:
        if scenario == "create_enosys":
            raise OSError(errno.ENOSYS, "create")
        return 91
    if number == module.SYS_LANDLOCK_ADD_RULE and scenario == "add_eacces":
        raise OSError(errno.EACCES, "add")
    if number == module.SYS_LANDLOCK_RESTRICT_SELF and scenario == "restrict_eperm":
        raise OSError(errno.EPERM, "restrict")
    return 0

module.checked_syscall = fake_syscall
module.os.open = lambda _path, _flags: 17
module.os.close = lambda _fd: None
module.os.path.exists = lambda _path: False
module.libc.prctl = lambda *_arguments: 0
try:
    result = module.restrict_filesystem_writes(["/work"])
    payload = {"calls": calls, "result": result, "status": "ok"}
except module.ContainmentStageError as error:
    payload = error_payload(error)
print(json.dumps(payload, separators=(",", ":")))
`;
    const child = spawnSync("/usr/bin/python3", ["-c", harness, modulePath, scenario], {
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout) as Record<string, unknown>;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
