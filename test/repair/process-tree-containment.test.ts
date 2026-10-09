import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LINUX_SUBREAPER_SCRIPT } from "../../dist/repair/process-tree-containment.js";
import { parseContainmentProtocol } from "../../dist/repair/contained-command-worker.js";

const MS_RDONLY = 1;
const MS_NOSUID = 2;
const MS_NODEV = 4;
const MS_NOEXEC = 8;
const MS_REMOUNT = 32;
const MS_BIND = 4096;
const MS_REC = 16384;
const MS_PRIVATE = 262144;

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

test("filesystem isolation exposes only writable roots and read-only runtime paths", () => {
  const plan = runLandlockScenario("filesystem_plan").events as unknown[][];
  const binds = plan.filter((event) => event[0] === "bind").map((event) => event[1]);
  const readonly = plan.filter((event) => event[0] === "readonly");
  const lastBind = plan.findLastIndex((event) => event[0] === "bind");

  assert.deepEqual(plan[0], ["mount", null, "/", MS_REC | MS_PRIVATE, null]);
  assert.deepEqual(
    plan.filter((event) => event[4] === "tmpfs").map((event) => [event[2], event[3]]),
    [
      ["<sandbox>", MS_NOSUID | MS_NODEV],
      ["<sandbox>/dev", MS_NOSUID],
      ["<sandbox>/run", MS_NOSUID | MS_NODEV],
    ],
  );
  assert.deepEqual(binds.slice(0, 3), ["<work>", "/usr", "/proc"]);
  assert.ok(binds.slice(3).every((source) => String(source).startsWith("/dev/")));
  assert.deepEqual(readonly.slice(0, 4), [
    ["readonly", "<sandbox>", true],
    ["readonly", "<sandbox><work>", false],
    ["readonly", "<sandbox>/usr", true],
    ["readonly", "<sandbox>/proc", true],
  ]);
  assert.ok(plan.indexOf(readonly[0]!) > lastBind);
  assert.deepEqual(plan.slice(-2), [
    ["chroot", "<sandbox>"],
    ["chdir", "<work>"],
  ]);

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

test("legacy read-only remounts keep the existing nosuid, nodev and noexec flags", () => {
  assert.deepEqual(runLandlockScenario("legacy_flags"), {
    mounts: [
      ["/sandbox/work", MS_BIND | MS_REMOUNT | MS_NOEXEC | MS_RDONLY],
      ["/sandbox", MS_BIND | MS_REMOUNT | MS_NOSUID | MS_NODEV | MS_RDONLY],
    ],
  });
});

test("capability drop clears every set and fails closed when one stays", () => {
  assert.deepEqual(runLandlockScenario("capabilities_retained"), {
    calls: [[24, 0, 0, 0, 0], [24, 1, 0, 0, 0], [47, 4, 0, 0, 0], ["capset"]],
    error: "validation capabilities were not fully dropped",
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
    module.sys.argv = ["init", json.dumps([work]), "true", work, "/bin/echo", "ok"]
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
    def mount(source, target, flags, filesystem_type=None, _data=None):
        events.append(["mount", source, target, flags, filesystem_type])
    def bind(sandbox_root, source, target_path=None):
        events.append(["bind", source])
        return module.root_path(sandbox_root, source), True
    def readonly(target, value, _recursive=True):
        events.append(["readonly", target, value])
        return "native"
    module.checked_mount = mount
    module.bind_mount = bind
    module.set_mount_readonly = readonly
    module.normalized_runtime_paths = lambda *_arguments: ["/usr"]
    module.os.chroot = lambda path: events.append(["chroot", path])
    module.os.chdir = lambda path: events.append(["chdir", path])
    roots = {"filesystem_host_root": ["/"], "filesystem_root_contains_sandbox": [base]}
    cwd = base if scenario == "filesystem_cwd_outside" else work
    try:
        module.isolate_filesystem(roots.get(scenario, [work]), sandbox, cwd, ["/bin/true"])
        payload = {"events": events}
    except RuntimeError as error:
        payload = {"error": str(error), "events": events}
    output = json.dumps(payload, separators=(",", ":"))
    print(output.replace(sandbox, "<sandbox>").replace(work, "<work>").replace(base, "<base>"))
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

if scenario == "capabilities_retained":
    calls = []
    status = "".join(
        name + ":\t" + ("0000000000000400" if name == "CapEff" else "0" * 16) + "\n"
        for name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")
    )
    files = {"/proc/sys/kernel/cap_last_cap": "1\n", "/proc/self/status": status}
    module.open = lambda path, *_arguments, **_options: io.StringIO(files[path])
    module.libc.prctl = lambda *arguments: calls.append(list(arguments)) or 0
    module.libc.capset = lambda *_arguments: calls.append(["capset"]) or 0
    try:
        module.drop_capabilities()
        payload = {"calls": calls, "status": "ok"}
    except RuntimeError as error:
        payload = {"calls": calls, "error": str(error)}
    print(json.dumps(payload, separators=(",", ":")))
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
