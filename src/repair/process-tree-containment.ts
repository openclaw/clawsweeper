export const LINUX_SUBREAPER_SCRIPT = String.raw`
import ctypes
import errno
import fcntl
import json
import os
import signal
import shutil
import socket
import stat
import struct
import subprocess
import sys
import time

PR_CAPBSET_DROP = 24
PR_SET_CHILD_SUBREAPER = 36
PR_SET_NO_NEW_PRIVS = 38
PR_CAP_AMBIENT = 47
PR_CAP_AMBIENT_CLEAR_ALL = 4
PROTOCOL_FD = 3
AT_FDCWD = -100
AT_RECURSIVE = 0x8000
MOUNT_ATTR_RDONLY = 1 << 0
MS_RDONLY = 1 << 0
MS_NOSUID = 1 << 1
MS_NODEV = 1 << 2
MS_NOEXEC = 1 << 3
MS_NOATIME = 1 << 10
MS_NODIRATIME = 1 << 11
MS_BIND = 1 << 12
MS_REMOUNT = 1 << 5
MS_REC = 1 << 14
MS_PRIVATE = 1 << 18
MS_RELATIME = 1 << 21
MS_NOSYMFOLLOW = 1 << 8
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1
LANDLOCK_ACCESS_FS_WRITE_FILE = 1 << 1
LANDLOCK_ACCESS_FS_REMOVE_DIR = 1 << 4
LANDLOCK_ACCESS_FS_REMOVE_FILE = 1 << 5
LANDLOCK_ACCESS_FS_MAKE_CHAR = 1 << 6
LANDLOCK_ACCESS_FS_MAKE_DIR = 1 << 7
LANDLOCK_ACCESS_FS_MAKE_REG = 1 << 8
LANDLOCK_ACCESS_FS_MAKE_SOCK = 1 << 9
LANDLOCK_ACCESS_FS_MAKE_FIFO = 1 << 10
LANDLOCK_ACCESS_FS_MAKE_BLOCK = 1 << 11
LANDLOCK_ACCESS_FS_MAKE_SYM = 1 << 12
LANDLOCK_ACCESS_FS_REFER = 1 << 13
LANDLOCK_ACCESS_FS_TRUNCATE = 1 << 14
LANDLOCK_WRITE_ACCESS = (
    LANDLOCK_ACCESS_FS_WRITE_FILE
    | LANDLOCK_ACCESS_FS_REMOVE_DIR
    | LANDLOCK_ACCESS_FS_REMOVE_FILE
    | LANDLOCK_ACCESS_FS_MAKE_CHAR
    | LANDLOCK_ACCESS_FS_MAKE_DIR
    | LANDLOCK_ACCESS_FS_MAKE_REG
    | LANDLOCK_ACCESS_FS_MAKE_SOCK
    | LANDLOCK_ACCESS_FS_MAKE_FIFO
    | LANDLOCK_ACCESS_FS_MAKE_BLOCK
    | LANDLOCK_ACCESS_FS_MAKE_SYM
    | LANDLOCK_ACCESS_FS_REFER
    | LANDLOCK_ACCESS_FS_TRUNCATE
)
SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446
SYS_MOUNT_SETATTR = 442
LINUX_CAPABILITY_VERSION_3 = 0x20080522
SIOCGIFFLAGS = 0x8913
SIOCSIFFLAGS = 0x8914
IFF_UP = 1


class LandlockRulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class CapabilityHeader(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]


class CapabilityData(ctypes.Structure):
    _fields_ = [
        ("effective", ctypes.c_uint32),
        ("permitted", ctypes.c_uint32),
        ("inheritable", ctypes.c_uint32),
    ]


libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
libc.mount.restype = ctypes.c_int
libc.capset.restype = ctypes.c_int


def checked_syscall(number, *arguments):
    result = libc.syscall(ctypes.c_long(number), *arguments)
    if result < 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))
    return result


def landlock_abi():
    return checked_syscall(
        SYS_LANDLOCK_CREATE_RULESET,
        ctypes.c_void_p(),
        ctypes.c_size_t(0),
        ctypes.c_uint32(LANDLOCK_CREATE_RULESET_VERSION),
    )


def checked_mount(source, target, flags, filesystem_type=None, data=None):
    encoded_source = None if source is None else os.fsencode(source)
    encoded_filesystem_type = (
        None if filesystem_type is None else os.fsencode(filesystem_type)
    )
    encoded_data = None if data is None else os.fsencode(data)
    if libc.mount(
        encoded_source,
        os.fsencode(target),
        encoded_filesystem_type,
        ctypes.c_ulong(flags),
        encoded_data,
    ) != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))


def set_mount_readonly(path, readonly, recursive=True):
    attributes = (ctypes.c_ubyte * 32).from_buffer_copy(
        struct.pack(
            "=QQQQ",
            MOUNT_ATTR_RDONLY if readonly else 0,
            0 if readonly else MOUNT_ATTR_RDONLY,
            0,
            0,
        )
    )
    try:
        checked_syscall(
            SYS_MOUNT_SETATTR,
            ctypes.c_int(AT_FDCWD),
            ctypes.c_char_p(os.fsencode(path)),
            ctypes.c_uint32(AT_RECURSIVE if recursive else 0),
            ctypes.byref(attributes),
            ctypes.c_size_t(len(attributes)),
        )
    except OSError as error:
        if error.errno != errno.ENOSYS:
            raise
        # Some ephemeral VM kernels expose delegated mount namespaces but not
        # mount_setattr. Preserve the same fail-closed policy by remounting every
        # concrete mount below the bind target; do not weaken other syscall errors.
        legacy_set_mount_readonly(path, readonly, recursive)


def decoded_mountinfo_path(value):
    return (
        value.replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
    )


def mount_points_below(path, recursive):
    canonical = os.path.normpath(path)
    if not recursive:
        recursive = False
    targets = []
    with open("/proc/self/mountinfo", "r", encoding="utf-8") as handle:
        for line in handle:
            fields = line.split()
            if len(fields) < 5:
                continue
            mount_point = os.path.normpath(decoded_mountinfo_path(fields[4]))
            if mount_point != canonical and (not recursive or not path_within(mount_point, canonical)):
                continue
            mount_options = set(fields[5].split(","))
            preserved_flags = 0
            for option, flag in (
                ("nosuid", MS_NOSUID),
                ("nodev", MS_NODEV),
                ("noexec", MS_NOEXEC),
                ("noatime", MS_NOATIME),
                ("nodiratime", MS_NODIRATIME),
                ("relatime", MS_RELATIME),
                ("nosymfollow", MS_NOSYMFOLLOW),
            ):
                if option in mount_options:
                    preserved_flags |= flag
            targets.append((mount_point, preserved_flags))
    if not any(target == canonical for target, _flags in targets):
        raise RuntimeError("validation mount target is absent: " + canonical)
    return sorted(set(targets), key=lambda entry: entry[0].count(os.sep), reverse=True)


def legacy_set_mount_readonly(path, readonly, recursive):
    for target, preserved_flags in mount_points_below(path, recursive):
        checked_mount(
            None,
            target,
            MS_BIND | MS_REMOUNT | preserved_flags | (MS_RDONLY if readonly else 0),
        )


def path_within(path, root):
    try:
        return os.path.commonpath((path, root)) == root
    except ValueError:
        return False


def root_path(sandbox_root, absolute_path):
    if not os.path.isabs(absolute_path):
        raise RuntimeError("validation mount path must be absolute: " + absolute_path)
    return os.path.join(sandbox_root, absolute_path.lstrip("/"))


def ensure_mount_target(sandbox_root, source, target_path):
    target = root_path(sandbox_root, target_path)
    os.makedirs(os.path.dirname(target), mode=0o755, exist_ok=True)
    source_stat = os.stat(source)
    if stat.S_ISDIR(source_stat.st_mode):
        os.makedirs(target, mode=0o755, exist_ok=True)
        return True
    if not stat.S_ISREG(source_stat.st_mode) and not stat.S_ISCHR(source_stat.st_mode):
        raise RuntimeError("unsupported validation runtime mount: " + source)
    with open(target, "ab"):
        pass
    return False


def bind_mount(sandbox_root, source, target_path=None):
    target_path = target_path or source
    recursive = ensure_mount_target(sandbox_root, source, target_path)
    target = root_path(sandbox_root, target_path)
    checked_mount(source, target, MS_BIND | (MS_REC if recursive else 0))
    return target, recursive


def selected_runtime_paths(command):
    selected = [
        "/usr",
        "/etc/alternatives",
        "/etc/group",
        "/etc/hosts",
        "/etc/ld.so.cache",
        "/etc/ld.so.conf",
        "/etc/ld.so.conf.d",
        "/etc/localtime",
        "/etc/nsswitch.conf",
        "/etc/os-release",
        "/etc/passwd",
        "/etc/resolv.conf",
        "/etc/ssl/certs",
    ]
    for system_path in ("/bin", "/sbin", "/lib", "/lib64"):
        if os.path.exists(system_path) and not os.path.islink(system_path):
            selected.append(system_path)
    path_entries = []
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        if not entry or not os.path.isabs(entry) or not os.path.exists(entry):
            continue
        normalized = os.path.abspath(entry)
        if os.path.basename(normalized) not in {"bin", "sbin", ".bin"}:
            continue
        path_entries.append(normalized)
    selected.extend(path_entries)
    executable = command[0]
    resolved_executable = (
        executable
        if os.path.isabs(executable)
        else shutil.which(executable, path=os.environ.get("PATH", ""))
    )
    if resolved_executable and os.path.exists(resolved_executable):
        selected.append(resolved_executable)
        executable_parent = os.path.dirname(resolved_executable)
        if os.path.basename(executable_parent) in {"bin", "sbin", ".bin"}:
            selected.append(executable_parent)
        canonical_executable = os.path.realpath(resolved_executable)
        selected.append(canonical_executable)
        canonical_parent = os.path.dirname(canonical_executable)
        if os.path.basename(canonical_parent) in {"bin", "sbin", ".bin"}:
            selected.append(canonical_parent)
        node_modules_marker = os.sep + "node_modules" + os.sep
        if node_modules_marker in canonical_executable:
            package_suffix = canonical_executable.split(node_modules_marker, 1)[1]
            package_parts = package_suffix.split(os.sep)
            package_depth = 2 if package_parts[0].startswith("@") else 1
            package_root = canonical_executable.split(node_modules_marker, 1)[0]
            selected.append(
                os.path.join(
                    package_root,
                    "node_modules",
                    *package_parts[:package_depth],
                )
            )
    for entry in path_entries:
        marker_roots = (
            (os.sep + ".rustup" + os.sep + "toolchains" + os.sep, 1),
            (os.sep + ".nvm" + os.sep + "versions" + os.sep + "node" + os.sep, 1),
            (os.sep + "hostedtoolcache" + os.sep + "node" + os.sep, 2),
        )
        for marker, component_count in marker_roots:
            if marker not in entry:
                continue
            prefix, suffix = entry.split(marker, 1)
            components = [part for part in suffix.split(os.sep) if part]
            selected.append(
                prefix
                + marker
                + os.path.join(*components[:component_count])
            )
    return selected


def normalized_runtime_paths(command, canonical_roots, sandbox_root):
    forbidden_exact_roots = {
        "/",
        "/dev",
        "/home",
        "/media",
        "/mnt",
        "/proc",
        "/root",
        "/run",
        "/srv",
        "/tmp",
        "/var",
    }
    candidates = []
    for source in selected_runtime_paths(command):
        normalized = os.path.normpath(source)
        if normalized in forbidden_exact_roots or not os.path.exists(normalized):
            continue
        canonical = os.path.realpath(normalized)
        if path_within(canonical, sandbox_root):
            raise RuntimeError("validation runtime path overlaps sandbox root")
        if any(path_within(canonical, root) for root in canonical_roots):
            continue
        if normalized not in candidates:
            candidates.append(normalized)
    directories = [
        path
        for path in candidates
        if stat.S_ISDIR(os.stat(path).st_mode)
    ]
    return [
        path
        for path in candidates
        if not any(
            path != parent
            and path_within(os.path.realpath(path), os.path.realpath(parent))
            for parent in directories
        )
    ]


def recreate_system_links(sandbox_root):
    for system_path in ("/bin", "/sbin", "/lib", "/lib64"):
        if not os.path.islink(system_path):
            continue
        target = root_path(sandbox_root, system_path)
        os.makedirs(os.path.dirname(target), mode=0o755, exist_ok=True)
        os.symlink(os.readlink(system_path), target)
    os.makedirs(root_path(sandbox_root, "/var"), mode=0o755, exist_ok=True)
    os.symlink("/run", root_path(sandbox_root, "/var/run"))
    os.makedirs(root_path(sandbox_root, "/etc"), mode=0o755, exist_ok=True)
    os.symlink("/proc/mounts", root_path(sandbox_root, "/etc/mtab"))
    for name, target in (
        ("fd", "/proc/self/fd"),
        ("stdin", "/proc/self/fd/0"),
        ("stdout", "/proc/self/fd/1"),
        ("stderr", "/proc/self/fd/2"),
    ):
        os.symlink(target, root_path(sandbox_root, "/dev/" + name))


def validate_filesystem_roots(canonical_roots, sandbox_root, original_cwd):
    if not path_within(original_cwd, canonical_roots[0]) and not any(
        path_within(original_cwd, root) for root in canonical_roots[1:]
    ):
        raise RuntimeError("validation working directory is outside writable roots")
    for root in canonical_roots:
        if root == "/" or path_within(sandbox_root, root) or path_within(root, sandbox_root):
            raise RuntimeError("validation writable root is unsafe: " + root)


def isolate_filesystem(canonical_roots, sandbox_root, original_cwd, command):
    validate_filesystem_roots(canonical_roots, sandbox_root, original_cwd)
    checked_mount(None, "/", MS_REC | MS_PRIVATE)
    checked_mount(
        "tmpfs",
        sandbox_root,
        MS_NOSUID | MS_NODEV,
        "tmpfs",
        "mode=0755,size=64m",
    )
    for directory in (
        "/dev",
        "/dev/shm",
        "/etc",
        "/home",
        "/proc",
        "/root",
        "/run",
        "/tmp",
        "/var",
        "/var/tmp",
    ):
        os.makedirs(root_path(sandbox_root, directory), mode=0o755, exist_ok=True)
    checked_mount(
        "tmpfs",
        root_path(sandbox_root, "/dev"),
        MS_NOSUID,
        "tmpfs",
        "mode=0755,size=1m",
    )
    checked_mount(
        "tmpfs",
        root_path(sandbox_root, "/run"),
        MS_NOSUID | MS_NODEV,
        "tmpfs",
        "mode=0755,size=1m",
    )
    recreate_system_links(sandbox_root)
    writable_targets = [
        bind_mount(sandbox_root, root)
        for root in canonical_roots
    ]
    runtime_targets = [
        bind_mount(sandbox_root, runtime_path)
        for runtime_path in normalized_runtime_paths(
            command,
            canonical_roots,
            sandbox_root,
        )
    ]
    proc_target = bind_mount(sandbox_root, "/proc")
    device_targets = [
        bind_mount(sandbox_root, device)
        for device in (
            "/dev/full",
            "/dev/null",
            "/dev/random",
            "/dev/urandom",
            "/dev/zero",
        )
        if os.path.exists(device)
    ]
    set_mount_readonly(sandbox_root, True)
    for target, recursive in writable_targets:
        set_mount_readonly(target, False, recursive)
    for target, recursive in runtime_targets:
        set_mount_readonly(target, True, recursive)
    set_mount_readonly(proc_target[0], True, proc_target[1])
    for target, recursive in device_targets:
        set_mount_readonly(target, False, recursive)
    os.chroot(sandbox_root)
    os.chdir(original_cwd)


def bring_up_loopback():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as control:
        request = struct.pack("16sh", b"lo", 0)
        response = fcntl.ioctl(control.fileno(), SIOCGIFFLAGS, request)
        _, flags = struct.unpack("16sh", response)
        fcntl.ioctl(
            control.fileno(),
            SIOCSIFFLAGS,
            struct.pack("16sh", b"lo", flags | IFF_UP),
        )


def add_writable_path(ruleset_fd, path, allowed_access):
    path_fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
    try:
        rule = (ctypes.c_ubyte * 12).from_buffer_copy(
            struct.pack("=Qi", allowed_access, path_fd)
        )
        checked_syscall(
            SYS_LANDLOCK_ADD_RULE,
            ctypes.c_int(ruleset_fd),
            ctypes.c_int(LANDLOCK_RULE_PATH_BENEATH),
            ctypes.byref(rule),
            ctypes.c_uint32(0),
        )
    finally:
        os.close(path_fd)


def canonical_writable_roots(writable_roots):
    canonical_roots = []
    for root in writable_roots:
        canonical = os.path.realpath(root)
        if not stat.S_ISDIR(os.stat(canonical).st_mode):
            raise RuntimeError("validation writable root is not a directory: " + root)
        if not os.path.isabs(canonical):
            raise RuntimeError("validation writable root must be absolute: " + root)
        if canonical not in canonical_roots:
            canonical_roots.append(canonical)
    return canonical_roots


def restrict_filesystem_writes(canonical_roots):
    abi = landlock_abi()
    if abi < 3:
        raise RuntimeError("Landlock ABI 3 or newer is required")
    ruleset = LandlockRulesetAttr(handled_access_fs=LANDLOCK_WRITE_ACCESS)
    ruleset_fd = checked_syscall(
        SYS_LANDLOCK_CREATE_RULESET,
        ctypes.byref(ruleset),
        ctypes.sizeof(ruleset),
        ctypes.c_uint32(0),
    )
    try:
        for root in canonical_roots:
            add_writable_path(ruleset_fd, root, LANDLOCK_WRITE_ACCESS)
        for device in ("/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom"):
            if os.path.exists(device):
                add_writable_path(
                    ruleset_fd,
                    device,
                    LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE,
                )
        if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number))
        checked_syscall(
            SYS_LANDLOCK_RESTRICT_SELF,
            ctypes.c_int(ruleset_fd),
            ctypes.c_uint32(0),
        )
    finally:
        os.close(ruleset_fd)


def drop_capabilities():
    with open("/proc/sys/kernel/cap_last_cap", "r", encoding="ascii") as handle:
        last_capability = int(handle.read().strip())
    for capability in range(last_capability + 1):
        if libc.prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) != 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number))
    if libc.prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))
    header = CapabilityHeader(version=LINUX_CAPABILITY_VERSION_3, pid=0)
    data = (CapabilityData * 2)()
    if libc.capset(ctypes.byref(header), ctypes.byref(data)) != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))
    with open("/proc/self/status", "r", encoding="ascii") as handle:
        status = handle.read()
    capability_sets = {}
    for line in status.splitlines():
        name, separator, value = line.partition(":")
        if separator and name in {"CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"}:
            capability_sets[name] = int(value.strip(), 16)
    if set(capability_sets) != {"CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"}:
        raise RuntimeError("validation capability status is incomplete")
    if any(capability_sets.values()):
        raise RuntimeError("validation capabilities were not fully dropped")


def write_protocol(payload):
    encoded = (json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8")
    while encoded:
        written = os.write(PROTOCOL_FD, encoded)
        encoded = encoded[written:]


def process_rows():
    rows = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open("/proc/" + entry + "/stat", "r", encoding="utf-8") as handle:
                stat = handle.read()
        except FileNotFoundError:
            continue
        fields = stat[stat.rfind(")") + 2:].split()
        if len(fields) >= 2:
            rows.append((int(entry), int(fields[1])))
    return rows


def target_pids():
    return [pid for pid, _parent_pid in process_rows() if pid != os.getpid()]


def signal_target_processes(signum):
    for pid in reversed(target_pids()):
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            pass


termination_signal = None


def request_termination(signum, _frame):
    global termination_signal
    termination_signal = signal.SIGKILL if signum == signal.SIGUSR1 else signal.SIGTERM
    signal_target_processes(termination_signal)


def reap_exited_children(primary_pid, background_pids):
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return True
        if pid == 0:
            return False
        if pid != primary_pid:
            background_pids.add(pid)


def reap_adopted_children(primary_pid, background_pids):
    for pid, parent_pid in process_rows():
        if parent_pid != os.getpid() or pid == primary_pid:
            continue
        background_pids.add(pid)
        try:
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            pass


def terminate_and_reap_descendants(primary_pid, background_pids):
    graceful_deadline = time.monotonic() + 0.25
    empty_deadline = time.monotonic() + 0.1
    while True:
        remaining_pids = target_pids()
        background_pids.update(pid for pid in remaining_pids if pid != primary_pid)
        no_children = reap_exited_children(primary_pid, background_pids)
        if no_children and not remaining_pids:
            if time.monotonic() >= empty_deadline:
                return len(background_pids)
        else:
            empty_deadline = time.monotonic() + 0.1
        if remaining_pids:
            signum = (
                signal.SIGKILL
                if termination_signal == signal.SIGKILL or time.monotonic() >= graceful_deadline
                else signal.SIGTERM
            )
            for pid in reversed(remaining_pids):
                try:
                    os.kill(pid, signum)
                except ProcessLookupError:
                    pass
        time.sleep(0.01)


def main():
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))
    signal.signal(signal.SIGTERM, request_termination)
    signal.signal(signal.SIGUSR1, request_termination)
    writable_roots = json.loads(sys.argv[1])
    if not isinstance(writable_roots, list) or not all(
        isinstance(root, str) and root for root in writable_roots
    ):
        raise RuntimeError("validation writable roots are invalid")
    isolate_network = json.loads(sys.argv[2])
    if not isinstance(isolate_network, bool):
        raise RuntimeError("validation network isolation flag is invalid")
    sandbox_root = os.path.realpath(sys.argv[3])
    if not stat.S_ISDIR(os.stat(sandbox_root).st_mode):
        raise RuntimeError("validation sandbox root is not a directory")
    command = sys.argv[4:]
    if not command:
        raise RuntimeError("validation command is missing")
    canonical_roots = canonical_writable_roots(writable_roots)
    original_cwd = os.path.realpath(os.getcwd())
    if isolate_network:
        bring_up_loopback()
    isolate_filesystem(
        canonical_roots,
        sandbox_root,
        original_cwd,
        command,
    )
    restrict_filesystem_writes(canonical_roots)
    drop_capabilities()
    child = subprocess.Popen(command, close_fds=True)
    background_pids = set()
    while True:
        reap_adopted_children(child.pid, background_pids)
        return_code = child.poll()
        if return_code is not None:
            break
        if termination_signal is not None:
            signal_target_processes(termination_signal)
        time.sleep(0.01)
    background_processes = terminate_and_reap_descendants(child.pid, background_pids)
    write_protocol(
        {
            "backgroundProcesses": background_processes,
            "signal": signal.Signals(-return_code).name if return_code < 0 else None,
            "status": return_code if return_code >= 0 else None,
        }
    )


try:
    main()
except BaseException as error:
    try:
        write_protocol({"containmentError": str(error)})
    finally:
        sys.exit(125)
`;
