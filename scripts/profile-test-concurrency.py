#!/usr/bin/env python3
"""Disposable four-trial experiment; not part of the workload or normal CI."""

import collections
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET

SOURCE = "e312d173d51876ee8e061d55e81d8cd9650edcaf"
ALL_FILES = "b6ba845fc554616f08d869ac52fcefa202cc9d0bdd49369b2486409a76de888b"
SHARD_FILES = "b83ba8088134fae28625836401c4ef3c135e2154457cf1f4406730261b7470c1"
LOCK = "197a392e96a81c6c7d017a6ada1b7c95dd741ac9b49417b7f95e821c75f82274"
ORDER = [4, 2, 2, 4]


def digest(value):
    return hashlib.sha256(json.dumps(value, separators=(",", ":")).encode()).hexdigest()


def write(path, value):
    temporary = path.with_suffix(".pending")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def command(args, cwd=None, check=True):
    return subprocess.run(args, cwd=cwd, text=True, capture_output=True,
                          timeout=30, check=check)


def wait_file(path, process, seconds):
    deadline = time.monotonic() + seconds
    while not path.exists():
        if process.poll() is not None:
            raise RuntimeError(f"Scope launcher exited {process.returncode} before {path.name}")
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Missing {path.name} after {seconds} seconds")
        time.sleep(0.05)
    return json.loads(path.read_text())


def scope_properties(unit):
    result = command(["systemctl", "--user", "show", unit, "-p", "LoadState",
                      "-p", "ActiveState", "-p", "ControlGroup", "-p", "FreezerState"],
                     check=False)
    state = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if result.returncode and state.get("LoadState") != "not-found":
        raise RuntimeError(f"Cannot inspect task scope: {result.stderr.strip()}")
    return state


def scope_empty(unit, cgroup):
    state = scope_properties(unit)
    assert state.get("ActiveState") == "inactive", state
    assert not cgroup.exists() or not any(
        path.read_text().strip() for path in cgroup.rglob("cgroup.procs")), "Scope has descendants"
    return state


def resources():
    relative = Path("/proc/self/cgroup").read_text().strip().removeprefix("0::/")
    cgroup = Path("/sys/fs/cgroup") / relative
    limits = {"cpu.max": [], "memory.max": [], "memory.high": [], "pids.max": []}
    for parent in [cgroup, *cgroup.parents]:
        if parent == Path("/sys/fs/cgroup"):
            break
        for name in limits:
            path = parent / name
            if path.exists():
                value = path.read_text().strip()
                if not value.startswith("max"):
                    limits[name].append(value)
    return {"affinity": sorted(os.sched_getaffinity(0)), "nice": os.getpriority(os.PRIO_PROCESS, 0),
            "limits": {key: sorted(set(value)) for key, value in limits.items()}}


def worker(directory, argv):
    # Remain alive at the finish barrier so the controller can freeze and
    # inspect the exact scope before systemd garbage-collects the unit.
    write(directory / "ready.json", {"pid": os.getpid(), "uid": os.getuid(),
                                    "gid": os.getgid(), "cwd": os.getcwd(), "resources": resources()})
    deadline = time.monotonic() + 30
    while not (directory / "start").exists():
        if time.monotonic() > deadline:
            raise TimeoutError("Controller did not release start barrier")
        time.sleep(0.05)
    started = time.monotonic()
    child = subprocess.Popen(argv)
    try:
        code = child.wait(timeout=600)
        result = {"exitCode": code, "seconds": time.monotonic() - started, "timeout": False}
    except subprocess.TimeoutExpired:
        # The controller stops the entire scope, including detached children.
        result = {"exitCode": None, "seconds": time.monotonic() - started, "timeout": True}
    write(directory / "result.json", result)
    deadline = time.monotonic() + 30
    while not (directory / "release").exists():
        if time.monotonic() > deadline:
            raise TimeoutError("Controller did not release finish barrier")
        time.sleep(0.05)


def scoped_run(root, directory, argv, label):
    identity = f"{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}"
    unit = f"csw-concurrency-{identity}-{label}.scope"
    # Socket fixtures need the ordinary short /tmp path budget, not RUNNER_TEMP.
    temporary = Path(tempfile.mkdtemp(prefix="csw-", dir="/tmp"))
    env = dict(os.environ, TMPDIR=str(temporary))
    cgroup = process = None
    receipt = {"unit": unit, "command": argv, "temporaryDirectory": str(temporary)}
    try:
        assert scope_properties(unit).get("LoadState") == "not-found", "Task scope already exists"
        with (directory / "stdout.log").open("w") as stdout, (directory / "stderr.log").open("w") as stderr:
            process = subprocess.Popen([
                "systemd-run", "--user", "--scope", "--quiet", "--unit", unit,
                "--property=RuntimeMaxSec=660", "--property=TimeoutStopSec=30s",
                sys.executable, str(Path(__file__).resolve()), "--worker", str(directory), *argv,
            ], cwd=root, env=env, stdout=stdout, stderr=stderr)
            ready = wait_file(directory / "ready.json", process, 15)
            assert ready["uid"] == os.getuid() and ready["gid"] == os.getgid(), ready
            assert ready["cwd"] == str(root), ready
            assert ready["resources"] == resources(), "Scope changed effective resource controls"
            state = scope_properties(unit)
            assert state["ActiveState"] == "active" and state["ControlGroup"].startswith("/"), state
            cgroup = Path("/sys/fs/cgroup") / state["ControlGroup"].lstrip("/")
            assert str(cgroup.resolve()).startswith("/sys/fs/cgroup/"), state
            assert str(ready["pid"]) in (cgroup / "cgroup.procs").read_text().split(), ready
            receipt.update(ready=ready, initialScope=state, cgroupInode=cgroup.stat().st_ino)
            (directory / "start").touch()
            result = wait_file(directory / "result.json", process, 615)
            receipt.update(result)
            assert not result["timeout"] and result["exitCode"] == 0, result
            command(["systemctl", "--user", "freeze", unit])
            state = scope_properties(unit)
            assert state["FreezerState"] == "frozen", state
            assert cgroup.stat().st_ino == receipt["cgroupInode"], "Scope identity changed"
            members = sorted(int(pid) for path in cgroup.rglob("cgroup.procs")
                             for pid in path.read_text().split())
            assert members == [ready["pid"]], {"unexpectedScopeMembers": members}
            receipt.update(frozenScope=state, terminalMembers=members)
            command(["systemctl", "--user", "thaw", unit])
            (directory / "release").touch()
            assert process.wait(timeout=15) == 0, "Scope launcher failed"
            receipt["terminalScope"] = scope_empty(unit, cgroup)
            receipt["cleanupVerified"] = True
            return receipt
    finally:
        # Stop only this task's named scope. Unknown cleanup ends the experiment.
        if not receipt.get("cleanupVerified") and process is not None:
            try:
                stop = command(["systemctl", "--user", "stop", unit], check=False)
                receipt["cleanupExitCode"] = stop.returncode
            except Exception as error:
                # The manager can finish its stop after the client times out.
                # Preserve that uncertainty and still observe the exact scope.
                receipt["cleanupCommandError"] = f"{type(error).__name__}: {error}"
            try:
                process.wait(timeout=30)
                if cgroup is not None:
                    receipt["terminalScope"] = scope_empty(unit, cgroup)
                    receipt["cleanupVerified"] = True
            except Exception as error:
                receipt["cleanupError"] = str(error)
        write(directory / "scope.json", receipt)
        if receipt.get("cleanupVerified") or process is None:
            shutil.rmtree(temporary)


def inventory(root):
    script = """import {resolveTestFiles,selectShard} from './scripts/run-node-tests.mjs';
const all=resolveTestFiles('all');
console.log(JSON.stringify({all,selected:selectShard(all,{index:1,total:4})}));"""
    result = json.loads(command(["node", "--input-type=module", "-e", script], cwd=root).stdout)
    assert len(result["all"]) == 370 and digest(result["all"]) == ALL_FILES, result
    assert len(result["selected"]) == 93 and digest(result["selected"]) == SHARD_FILES, result
    return result


def input_manifest(root):
    result = []
    # Include ignored build/dependency inputs and unexpected scratch, not only Git's diff.
    for directory, dirs, files in os.walk(root, followlinks=False):
        if Path(directory) == root:
            dirs[:] = [name for name in dirs if name != ".git"]
            files = [name for name in files if name != ".git"]
        for name in sorted(dirs + files):
            path = Path(directory) / name
            info = path.lstat()
            relative = path.relative_to(root).as_posix()
            if stat.S_ISLNK(info.st_mode):
                if relative == "node_modules" or relative.startswith("node_modules/"):
                    assert path.resolve().is_relative_to(root), f"External dependency target: {relative}"
                result.append([relative, "symlink", os.readlink(path)])
            elif stat.S_ISREG(info.st_mode):
                with path.open("rb") as handle:
                    checksum = hashlib.file_digest(handle, "sha256").hexdigest()
                result.append([relative, stat.S_IMODE(info.st_mode), info.st_size, checksum])
            else:
                assert stat.S_ISDIR(info.st_mode), f"Unexpected input type: {relative}"
                result.append([relative, "directory", stat.S_IMODE(info.st_mode)])
    return sorted(result)


def outcomes(path, root):
    document = ET.parse(path).getroot()
    assert document.tag == "testsuites", "Incomplete JUnit document"
    result = []

    def visit(element, ancestors):
        if element.tag == "testsuite":
            assert int(element.get("failures", "0")) == 0 and int(element.get("errors", "0")) == 0
            ancestors = ancestors + [element.get("name", "")]
        if element.tag == "testcase":
            assert element.find("failure") is None and element.find("error") is None, element.attrib
            filename = (root / element.attrib["file"]).resolve().relative_to(root).as_posix()
            skipped = [(node.get("type"), node.get("message")) for node in element.findall("skipped")]
            result.append([filename, ancestors, element.get("classname"), element.get("name"), skipped])
        for child in element:
            visit(child, ancestors)

    visit(document, [])
    assert result, "No terminal test cases"
    return sorted(result, key=lambda item: json.dumps(item))


def coverage(directory, root):
    scripts = collections.defaultdict(set)
    profiles = sorted(directory.glob("coverage-*.json"))
    assert profiles, "No raw coverage profiles"
    prefix = root.as_uri() + "/"
    for profile in profiles:
        for script in json.loads(profile.read_text())["result"]:
            assert script["url"].startswith(prefix), "Profile pruning did not finish"
            name = script["url"][len(prefix):]
            for function in script["functions"]:
                for block in function["ranges"]:
                    if block["count"] > 0:
                        scripts[name].add((block["startOffset"], block["endOffset"]))
    return {"profiles": len(profiles), "coveredBlocks": {
        name: sorted(blocks) for name, blocks in sorted(scripts.items())}}


def main(root, output):
    root, output = root.resolve(), output.resolve()
    output.mkdir(exist_ok=False)
    summary = {"source": SOURCE, "order": ORDER, "trials": [], "status": "incomplete"}
    try:
        if not __debug__:
            raise RuntimeError("Python assertion checks must remain enabled")
        assert os.environ.get("GITHUB_ACTIONS") == "true" and sys.platform == "linux"
        assert command(["git", "rev-parse", "HEAD"], root).stdout.strip() == SOURCE
        command(["git", "diff", "--exit-code", "HEAD", "--"], root)
        assert hashlib.sha256((root / "pnpm-lock.yaml").read_bytes()).hexdigest() == LOCK
        assert command(["node", "--version"]).stdout.strip() == "v24.22.1"
        assert command(["pnpm", "--version"]).stdout.strip() == "12.15.0"
        assert not any(os.environ.get(key) for key in [
            "NODE_OPTIONS", "NODE_COMPILE_CACHE", "CLAWSWEEPER_TEST_CONCURRENCY", "NODE_TEST_CONTEXT"])
        host = json.loads(command(["node", "-e", "const o=require('node:os');console.log(JSON.stringify({parallelism:o.availableParallelism(),memory:o.totalmem(),arch:o.arch()}))"]).stdout)
        assert host["parallelism"] == 4 and host["arch"] == "x64" and 14 * 1024**3 <= host["memory"] <= 18 * 1024**3, host
        summary.update(host=host, image=os.environ.get("ImageVersion"),
                       run=os.environ["GITHUB_RUN_ID"], attempt=os.environ["GITHUB_RUN_ATTEMPT"],
                       controlSha=os.environ["GITHUB_SHA"], resources=resources(),
                       driverSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
        selected = inventory(root)
        write(output / "inventory.json", selected)
        baseline = input_manifest(root)
        write(output / "inputs.json", baseline)
        summary["inputsSha256"] = digest(baseline)
        preflight = output / "scope-preflight"
        preflight.mkdir()
        scoped_run(root, preflight, ["node", "-e", "if(process.getuid()!==Number(process.env.UID_CHECK))process.exit(1)"], "preflight")
        for index, concurrency in enumerate(ORDER, 1):
            assert inventory(root) == selected and input_manifest(root) == baseline, "Trial inputs drifted"
            trial = output / f"trial-{index}"
            trial.mkdir()
            observed = {"index": index, "concurrency": concurrency, "status": "started"}
            summary["trials"].append(observed)
            write(output / "summary.json", summary)
            print(f"Trial {index}/4: concurrency {concurrency}, unchanged shard 1/4", flush=True)
            argv = ["node", "scripts/run-node-tests.mjs", "all", "--shard", "1/4",
                    "--test-concurrency", str(concurrency), "--coverage-out", str(trial / "coverage"),
                    "--", "--test-reporter=spec", "--test-reporter-destination=stdout",
                    "--test-reporter=junit", f"--test-reporter-destination={trial / 'junit.xml'}"]
            receipt = scoped_run(root, trial, argv, f"trial-{index}")
            cases = outcomes(trial / "junit.xml", root)
            measured_coverage = coverage(trial / "coverage", root)
            write(trial / "outcomes.json", cases)
            write(trial / "coverage.json", measured_coverage)
            assert input_manifest(root) == baseline, "Trial mutated shared inputs"
            if index == 1:
                expected_cases, expected_coverage = cases, measured_coverage["coveredBlocks"]
            else:
                assert cases == expected_cases, "Case identities or outcomes changed"
                assert measured_coverage["coveredBlocks"] == expected_coverage, "Covered source blocks changed"
            observed.update(status="complete", seconds=receipt["seconds"],
                            cases=len(cases), outcomesSha256=digest(cases))
            print(json.dumps(observed), flush=True)
            # Retain normalized coverage evidence, not duplicate raw V8 payloads.
            shutil.rmtree(trial / "coverage")
            write(output / "summary.json", summary)
        times = [trial["seconds"] for trial in summary["trials"]]
        pairs = [(times[0], times[1]), (times[3], times[2])]
        summary.update(status="complete",
                       gainDemonstrated=all(b <= a * 0.9 and a - b >= 30 for a, b in pairs),
                       pairs=[{"baseline": a, "candidate": b, "savedSeconds": a - b,
                               "ratio": b / a} for a, b in pairs])
    except Exception as error:
        summary["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        write(output / "summary.json", summary)
        print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "--worker":
        worker(Path(sys.argv[2]), sys.argv[3:])
    else:
        os.environ["UID_CHECK"] = str(os.getuid())
        main(Path(sys.argv[1]), Path(sys.argv[2]))
