export const LINUX_SUBREAPER_SCRIPT = String.raw`
import ctypes
import json
import os
import signal
import stat
import struct
import subprocess
import sys
import time

PR_SET_CHILD_SUBREAPER = 36
PR_SET_NO_NEW_PRIVS = 38
PROTOCOL_FD = 3
AT_FDCWD = -100
AT_RECURSIVE = 0x8000
MOUNT_ATTR_RDONLY = 1 << 0
MS_BIND = 1 << 12
MS_REC = 1 << 14
MS_PRIVATE = 1 << 18
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


class LandlockRulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
libc.mount.restype = ctypes.c_int


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


def checked_mount(source, target, flags):
    encoded_source = None if source is None else os.fsencode(source)
    if libc.mount(
        encoded_source,
        os.fsencode(target),
        None,
        ctypes.c_ulong(flags),
        None,
    ) != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))


def set_mount_readonly(path, readonly):
    attributes = (ctypes.c_ubyte * 32).from_buffer_copy(
        struct.pack(
            "=QQQQ",
            MOUNT_ATTR_RDONLY if readonly else 0,
            0 if readonly else MOUNT_ATTR_RDONLY,
            0,
            0,
        )
    )
    checked_syscall(
        SYS_MOUNT_SETATTR,
        ctypes.c_int(AT_FDCWD),
        ctypes.c_char_p(os.fsencode(path)),
        ctypes.c_uint32(AT_RECURSIVE),
        ctypes.byref(attributes),
        ctypes.c_size_t(len(attributes)),
    )


def isolate_filesystem_writes(canonical_roots):
    checked_mount(None, "/", MS_REC | MS_PRIVATE)
    checked_mount("/", "/", MS_BIND | MS_REC)
    for root in canonical_roots:
        checked_mount(root, root, MS_BIND | MS_REC)
    set_mount_readonly("/", True)
    for root in canonical_roots:
        set_mount_readonly(root, False)


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
    while True:
        remaining_pids = target_pids()
        background_pids.update(pid for pid in remaining_pids if pid != primary_pid)
        no_children = reap_exited_children(primary_pid, background_pids)
        if no_children and not remaining_pids:
            return len(background_pids)
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
    command = sys.argv[2:]
    if not command:
        raise RuntimeError("validation command is missing")
    canonical_roots = canonical_writable_roots(writable_roots)
    isolate_filesystem_writes(canonical_roots)
    restrict_filesystem_writes(canonical_roots)
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
