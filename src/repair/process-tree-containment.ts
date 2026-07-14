export const LINUX_SUBREAPER_SCRIPT = String.raw`
import ctypes
import json
import os
import signal
import subprocess
import sys
import time

PR_SET_CHILD_SUBREAPER = 36
PROTOCOL_FD = 3


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


def descendant_pids():
    children = {}
    for pid, parent_pid in process_rows():
        children.setdefault(parent_pid, []).append(pid)
    descendants = []
    pending = list(children.get(os.getpid(), []))
    while pending:
        pid = pending.pop()
        descendants.append(pid)
        pending.extend(children.get(pid, []))
    return descendants


def signal_descendants(signum):
    for pid in reversed(descendant_pids()):
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            pass


termination_signal = None


def request_termination(signum, _frame):
    global termination_signal
    termination_signal = signal.SIGKILL if signum == signal.SIGUSR1 else signal.SIGTERM
    signal_descendants(termination_signal)


def reap_exited_children():
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return True
        if pid == 0:
            return False


def reap_adopted_children(primary_pid, background_pids):
    for pid, parent_pid in process_rows():
        if parent_pid != os.getpid() or pid == primary_pid:
            continue
        background_pids.add(pid)
        try:
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            pass


def terminate_and_reap_descendants(background_pids):
    graceful_deadline = time.monotonic() + 0.25
    while True:
        if reap_exited_children():
            return len(background_pids)
        descendants = descendant_pids()
        background_pids.update(descendants)
        if descendants:
            signum = (
                signal.SIGKILL
                if termination_signal == signal.SIGKILL or time.monotonic() >= graceful_deadline
                else signal.SIGTERM
            )
            for pid in reversed(descendants):
                try:
                    os.kill(pid, signum)
                except ProcessLookupError:
                    pass
        time.sleep(0.01)


def main():
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))
    signal.signal(signal.SIGTERM, request_termination)
    signal.signal(signal.SIGUSR1, request_termination)
    command = sys.argv[1:]
    if not command:
        raise RuntimeError("validation command is missing")
    child = subprocess.Popen(command, close_fds=True)
    background_pids = set()
    while True:
        reap_adopted_children(child.pid, background_pids)
        return_code = child.poll()
        if return_code is not None:
            break
        if termination_signal is not None:
            signal_descendants(termination_signal)
        time.sleep(0.01)
    background_processes = terminate_and_reap_descendants(background_pids)
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
