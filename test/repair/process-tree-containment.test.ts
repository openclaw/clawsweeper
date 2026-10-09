import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LINUX_SUBREAPER_SCRIPT } from "../../dist/repair/process-tree-containment.js";
import { parseContainmentProtocol } from "../../dist/repair/contained-command-worker.js";
import { readText } from "../helpers.ts";

const MS_RDONLY = 1;
const MS_NOSUID = 2;
const MS_NODEV = 4;
const MS_NOEXEC = 8;
const MS_REMOUNT = 32;
const MS_BIND = 4096;

// Linux behavior tests skip on runners without delegated namespaces, so pin the namespace set.
test("validation worker enters fresh user, mount, PID and network namespaces", () => {
  const worker = readText("src/repair/contained-command-worker.ts");
  for (const flag of [
    "--user",
    "--map-root-user",
    "--mount",
    "--pid",
    "--fork",
    "--mount-proc",
    "--kill-child=SIGKILL",
  ]) {
    assert.ok(worker.includes(`"${flag}"`), flag);
  }
  assert.match(worker, /input\.isolateNetwork \? \["--net"\] : \[\]/);
});

test("namespace init applies every fail-closed stage before it spawns the target", () => {
  assert.deepEqual(runLandlockScenario("main_ok"), {
    events: [
      "subreaper",
      "loopback",
      "filesystem",
      "landlock",
      "capabilities",
      ["spawn", ["/bin/echo", "ok"], true],
      {
        backgroundProcesses: 0,
        capabilitySummary: { landlock: "abi-3", mount_readonly: "native" },
        signal: null,
        status: 0,
      },
    ],
  });
  assert.deepEqual(runLandlockScenario("main_landlock_fails"), {
    events: [
      "subreaper",
      "loopback",
      "filesystem",
      "landlock",
      { containmentError: { errno: 1, stage: "landlock", syscall: null } },
      ["exit", 125],
    ],
  });
});

test("filesystem isolation rejects unsafe writable roots before any mount", () => {
  assert.deepEqual(runLandlockScenario("filesystem_cwd_outside"), {
    error: "validation working directory is outside writable roots",
    events: [],
  });
  assert.deepEqual(runLandlockScenario("filesystem_host_root"), {
    error: "validation writable root is unsafe: /",
    events: [],
  });
  assert.deepEqual(runLandlockScenario("filesystem_root_contains_sandbox"), {
    error: "validation writable root is unsafe: <base>",
    events: [],
  });
});

test("private directories accept only new direct children of /tmp outside writable roots", () => {
  assert.deepEqual(runLandlockScenario("private_directories"), {
    lock: ["/tmp/pnpm-store-operation-locks-0"],
    not_list: "validation private directories are invalid",
    outside_tmp: "validation private directory is invalid",
    nested: "validation private directory is invalid",
    traversal: "validation private directory is invalid",
    tmp_itself: "validation private directory is invalid",
    duplicate: "validation private directory is invalid",
    covers_root: "validation private directory overlaps a writable root",
    same_as_root: "validation private directory overlaps a writable root",
  });
});

test("private directories get a small writable tmpfs inside the read-only sandbox", () => {
  const lock = "<base>/sandbox/tmp/pnpm-store-operation-locks-0";
  assert.deepEqual(runLandlockScenario("private_directory_mount"), {
    events: [
      ["mount", "tmpfs", lock, MS_NOSUID | MS_NODEV | MS_NOEXEC, "tmpfs", "mode=0700,size=1m"],
      ["readonly", "<base>/sandbox", true],
      ["readonly", lock, false, false],
    ],
    mode: "0o700",
  });
});

test("legacy read-only remounts keep the existing nosuid, nodev and noexec flags", () => {
  assert.deepEqual(runLandlockScenario("legacy_flags"), {
    mounts: [
      ["/sandbox/work", MS_BIND | MS_REMOUNT | MS_NOEXEC | MS_RDONLY],
      ["/sandbox", MS_BIND | MS_REMOUNT | MS_NOSUID | MS_NODEV | MS_RDONLY],
    ],
  });
});

test("namespace init counts every reaped child except the target as a background process", () => {
  assert.deepEqual(runLandlockScenario("reap_exited"), { done: false, tracked: [25] });
});

test("embedded containment runtime imports without executing its production entrypoint", () => {
  const result = runLandlockScenario("import");

  assert.deepEqual(result, { status: "imported" });
});

test("procfs enumeration tolerates only tasks that disappear during stat reads", () => {
  assert.deepEqual(runLandlockScenario("process_rows_esrch"), {
    rows: [[102, 1]],
    status: "ok",
  });
  assert.deepEqual(runLandlockScenario("process_rows_eacces"), {
    errno: 13,
    status: "error",
  });
});

test("containment does not classify reaped transient helpers as surviving background processes", () => {
  assert.deepEqual(runLandlockScenario("adopted_child_reaped"), {
    tracked: [],
    status: "ok",
  });
  assert.deepEqual(runLandlockScenario("adopted_child_alive"), {
    tracked: [25],
    status: "ok",
  });
  assert.deepEqual(runLandlockScenario("adopted_child_already_reaped"), {
    tracked: [],
    status: "ok",
  });
  assert.deepEqual(runLandlockScenario("adopted_child_primary_exited"), {
    tracked: [25],
    status: "ok",
  });
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
  assert.deepEqual(runLandlockScenario("success_private"), {
    calls: [444, 444, 445, 445, 446],
    result: "abi-3",
    status: "ok",
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
import ctypes
import importlib.util
import io
import json
import os
import sys

module_path, scenario = sys.argv[1:]
if sys.platform != "linux":
    errno.ENOSYS = 38
    if not hasattr(os, "O_PATH"):
        os.O_PATH = 0
    original_cdll = ctypes.CDLL
    class PortableLibc:
        def __init__(self, *args, **kwargs):
            self.real = original_cdll(*args, **kwargs)
        def __getattr__(self, name):
            try:
                return getattr(self.real, name)
            except AttributeError:
                if name not in {"capset", "prctl"}:
                    raise
                return lambda *_arguments: 0
    ctypes.CDLL = PortableLibc
spec = importlib.util.spec_from_file_location("containment_runtime", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
if scenario == "import":
    print(json.dumps({"status": "imported"}, separators=(",", ":")))
    raise SystemExit(0)

if scenario.startswith("main_"):
    work = os.path.realpath(os.path.dirname(module_path))
    events = []
    def failing_stage(name, result=None):
        def run(*_arguments):
            events.append(name)
            if scenario == "main_" + name + "_fails":
                raise module.ContainmentStageError(name, OSError(errno.EPERM, name))
            return result
        return run
    class Child:
        pid = 2
        def poll(self):
            return 0
    def spawn(command, close_fds):
        events.append(["spawn", command, close_fds])
        return Child()
    module.libc.prctl = lambda option, *_arguments: events.append(
        "subreaper" if option == module.PR_SET_CHILD_SUBREAPER else "prctl"
    ) or 0
    module.signal.signal = lambda *_arguments: None
    module.bring_up_loopback = failing_stage("loopback")
    module.isolate_filesystem = failing_stage("filesystem", "native")
    module.restrict_filesystem_writes = failing_stage("landlock", "abi-3")
    module.drop_capabilities = failing_stage("capabilities")
    module.subprocess.Popen = spawn
    module.reap_adopted_children = lambda *_arguments: None
    module.terminate_and_reap_descendants = lambda *_arguments: 0
    module.write_protocol = events.append
    module.sys.exit = lambda code: events.append(["exit", code])
    module.sys.argv = ["init", json.dumps([work]), "true", "[]", work, "/bin/echo", "ok"]
    os.chdir(work)
    module.run_entrypoint()
    print(json.dumps({"events": events}, separators=(",", ":")))
    raise SystemExit(0)

if scenario.startswith("filesystem_"):
    base = os.path.realpath(os.path.dirname(module_path))
    work = os.path.join(base, "work")
    sandbox = os.path.join(base, "sandbox")
    os.makedirs(work)
    os.makedirs(sandbox)
    events = []
    # Record privileged calls. Do not run them on the test host.
    module.checked_mount = lambda *arguments: events.append(["mount", *arguments])
    module.set_mount_readonly = lambda *arguments: events.append(["readonly", *arguments])
    module.os.chroot = lambda path: events.append(["chroot", path])
    roots = {"filesystem_host_root": ["/"], "filesystem_root_contains_sandbox": [base]}
    cwd = base if scenario == "filesystem_cwd_outside" else work
    try:
        module.isolate_filesystem(roots.get(scenario, [work]), sandbox, cwd, ["/bin/true"])
        payload = {"events": events}
    except RuntimeError as error:
        payload = {"error": str(error), "events": events}
    print(json.dumps(payload, separators=(",", ":")).replace(base, "<base>"))
    raise SystemExit(0)

if scenario == "private_directories":
    results = {}
    for name, directories in (
        ("lock", ["/tmp/pnpm-store-operation-locks-0"]),
        ("not_list", "/tmp/pnpm-store-operation-locks-0"),
        ("outside_tmp", ["/var/tmp/locks"]),
        ("nested", ["/tmp/locks/inner"]),
        ("traversal", ["/tmp/../etc"]),
        ("tmp_itself", ["/tmp"]),
        ("duplicate", ["/tmp/locks", "/tmp/locks"]),
        ("covers_root", ["/tmp/work"]),
        ("same_as_root", ["/tmp/work"]),
    ):
        roots = ["/tmp/work/checkout"] if name == "covers_root" else ["/tmp/work"]
        try:
            results[name] = module.validate_private_directories(directories, roots)
        except RuntimeError as error:
            results[name] = str(error)
    print(json.dumps(results, separators=(",", ":")))
    raise SystemExit(0)

if scenario == "private_directory_mount":
    base = os.path.realpath(os.path.dirname(module_path))
    work = os.path.join(base, "work")
    sandbox = os.path.join(base, "sandbox")
    os.makedirs(work)
    os.makedirs(sandbox)
    events = []
    module.checked_mount = lambda *arguments: events.append(["mount", *arguments])
    module.set_mount_readonly = lambda *arguments: events.append(["readonly", *arguments]) or "native"
    module.os.chroot = lambda path: None
    module.os.chdir = lambda path: None
    module.normalized_runtime_paths = lambda *_arguments: []
    module.recreate_system_links = lambda _sandbox: None
    module.bind_mount = lambda sandbox_root, source: (module.root_path(sandbox_root, source), True)
    module.isolate_filesystem([work], sandbox, work, ["/bin/true"], ["/tmp/pnpm-store-operation-locks-0"])
    lock = os.path.join(sandbox, "tmp", "pnpm-store-operation-locks-0")
    print(json.dumps({
        "events": [event for event in events if lock in event or sandbox in event[1:2]],
        "mode": oct(os.stat(lock).st_mode & 0o777),
    }, separators=(",", ":")).replace(base, "<base>"))
    raise SystemExit(0)

if scenario == "legacy_flags":
    mounts = []
    module.open = lambda *_arguments, **_options: io.StringIO(
        "1 0 0:1 / /sandbox rw,nosuid,nodev - tmpfs tmpfs rw\n"
        "2 1 0:2 / /sandbox/work rw,noexec - ext4 /dev/sda rw\n"
        "3 0 0:3 / /other rw,nosuid - ext4 /dev/sdb rw\n"
    )
    module.checked_mount = lambda _source, target, flags: mounts.append([target, flags])
    module.legacy_set_mount_readonly("/sandbox", True, True)
    print(json.dumps({"mounts": mounts}, separators=(",", ":")))
    raise SystemExit(0)

if scenario == "reap_exited":
    results = [(25, 0), (20, 0), (0, 0)]
    module.os.waitpid = lambda *_arguments: results.pop(0)
    tracked = set()
    done = module.reap_exited_children(20, tracked)
    print(json.dumps({"done": done, "tracked": sorted(tracked)}, separators=(",", ":")))
    raise SystemExit(0)

if scenario in {"process_rows_esrch", "process_rows_eacces"}:
    module.os.listdir = lambda _path: ["101", "102", "self"]
    def fake_open(path, _mode, encoding=None):
        if path == "/proc/101/stat":
            error_number = errno.ESRCH if scenario == "process_rows_esrch" else errno.EACCES
            raise OSError(error_number, "simulated procfs race")
        if path == "/proc/102/stat":
            return io.StringIO("102 (worker) S 1 0 0 0")
        raise AssertionError("unexpected procfs path: " + path)
    module.open = fake_open
    try:
        payload = {"rows": module.process_rows(), "status": "ok"}
    except OSError as error:
        payload = {"errno": error.errno, "status": "error"}
    print(json.dumps(payload, separators=(",", ":")))
    raise SystemExit(0)

if scenario.startswith("adopted_child_"):
    module.os.getpid = lambda: 10
    module.process_rows = lambda: [(25, 10)]
    def fake_waitpid(_pid, _flags):
        if scenario == "adopted_child_already_reaped":
            raise ChildProcessError()
        return (0, 0) if scenario == "adopted_child_alive" else (25, 0)
    module.os.waitpid = fake_waitpid
    tracked = {25}
    class PrimaryProcess:
        def poll(self):
            return 0 if scenario == "adopted_child_primary_exited" else None
    module.reap_adopted_children(20, tracked, PrimaryProcess())
    print(json.dumps({"tracked": sorted(tracked), "status": "ok"}, separators=(",", ":")))
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
    private_directories = ["/tmp/pnpm-store-operation-locks-0"] if scenario == "success_private" else []
    result = module.restrict_filesystem_writes(["/work"], private_directories)
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
