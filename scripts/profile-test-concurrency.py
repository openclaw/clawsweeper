#!/usr/bin/env python3
"""Disposable four-trial experiment; not part of the workload or normal CI."""

import collections
import hashlib
import json
import os
from pathlib import Path
import re
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
COVERAGE_OWNER = "0b0cb4db9f27afe295cbe77cc3a6ba206f9c260b129f175b5799202e53b5b287"
ORDER = [4, 2, 2, 4]
OUTPUT_ROOTS = (".artifacts", "artifacts", "records", "apply-report.json")
OUTPUT_DIRS = {".artifacts", ".artifacts/exact-review-dlq", "artifacts", "artifacts/apply",
               "artifacts/apply/pr-close-coverage-proof", "records",
               "records/openclaw-clawsweeper", "records/openclaw-clawsweeper/plans"}
# Frozen owners write these generated payloads/reports, not prepared inputs.
# No other addition is removable, even beneath an otherwise known output root.
OUTPUT_FILE = re.compile(
    r"(?:\.artifacts/comment-[1-9][0-9]*-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:md|json)"
    r"|\.artifacts/close-[1-9][0-9]*\.json|\.artifacts/exact-review-dlq/inventory\.json"
    r"|artifacts/apply/pr-close-coverage-proof/[1-9][0-9]*-[1-9][0-9]*\.proof\.json"
    r"|apply-report\.json)")


def digest(value):
    return hashlib.sha256(json.dumps(value, separators=(",", ":")).encode()).hexdigest()


def write(path, value):
    temporary = path.with_suffix(".pending")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def command(args, cwd=None, check=True, stdin=None):
    return subprocess.run(args, cwd=cwd, text=True, capture_output=True,
                          timeout=30, check=check, input=stdin)


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


def pid_limits(cgroup):
    ancestors = []
    for parent in [cgroup, *cgroup.parents]:
        if parent == Path("/sys/fs/cgroup"):
            break
        maximum = parent / "pids.max"
        if maximum.exists():
            value = maximum.read_text().strip()
            events = parent / "pids.events"
            ancestors.append({"path": str(parent), "inode": parent.stat().st_ino,
                              "max": None if value == "max" else int(value),
                              "current": int((parent / "pids.current").read_text()),
                              "events": dict(line.split() for line in events.read_text().splitlines())
                              if events.exists() else None})
    finite = [item["max"] for item in ancestors if item["max"] is not None]
    return {"configuredCeiling": min(finite) if finite else None, "ancestors": ancestors}


def resources():
    relative = Path("/proc/self/cgroup").read_text().strip().removeprefix("0::/")
    cgroup = Path("/sys/fs/cgroup") / relative
    limits = {"cpu.max": [], "memory.max": [], "memory.high": []}
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
            "limits": {key: sorted(set(value)) for key, value in limits.items()},
            "pids": pid_limits(cgroup)}


def admit_resources(actual, expected):
    assert all(actual[key] == expected[key] for key in ["affinity", "nice", "limits"]), \
        "Scope changed CPU/memory/affinity/nice controls"
    # PID limits are hierarchical: an extra looser ancestor does not change
    # the configured ceiling. This does not assert equal shared headroom.
    assert actual["pids"]["configuredCeiling"] == expected["pids"]["configuredCeiling"], \
        "Scope changed the configured PID ceiling"


def admit_pid_events(before, after):
    assert before["configuredCeiling"] == after["configuredCeiling"], "PID ceiling drifted"
    assert len(before["ancestors"]) == len(after["ancestors"]), "PID ancestry drifted"
    for initial, final in zip(before["ancestors"], after["ancestors"]):
        assert all(initial[key] == final[key] for key in ["path", "inode", "max"]), "PID ancestry drifted"
        assert initial["events"] is not None and final["events"] is not None, "PID event evidence unavailable"
        assert int(initial["events"]["max"]) >= 0 and int(final["events"]["max"]) >= 0
        assert initial["events"] == final["events"], "PID limit interference"


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
            state = scope_properties(unit)
            assert state["ActiveState"] == "active" and state["ControlGroup"].startswith("/"), state
            cgroup = Path("/sys/fs/cgroup") / state["ControlGroup"].lstrip("/")
            assert str(cgroup.resolve()).startswith("/sys/fs/cgroup/"), state
            assert str(ready["pid"]) in (cgroup / "cgroup.procs").read_text().split(), ready
            receipt.update(ready=ready, initialScope=state, cgroupInode=cgroup.stat().st_ino)
            assert ready["uid"] == os.getuid() and ready["gid"] == os.getgid(), ready
            assert ready["cwd"] == str(root), ready
            receipt["parentResources"] = resources()
            admit_resources(ready["resources"], receipt["parentResources"])
            admit_pid_events(ready["resources"]["pids"], ready["resources"]["pids"])
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
            receipt["finalPids"] = pid_limits(cgroup)
            admit_pid_events(ready["resources"]["pids"], receipt["finalPids"])
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


def restore_generated_outputs(root, baseline, after, trial):
    started = time.monotonic()
    receipt = {"removed": [], "status": "incomplete"}
    try:
        assert root == Path(os.environ["GITHUB_WORKSPACE"]).resolve(), "Not the task workload checkout"
        original = {item[0]: item for item in baseline}
        observed = {item[0]: item for item in after}
        assert all(observed.get(name) == item for name, item in original.items()), "Prepared input changed"
        added = [item for item in after if item[0] not in original]
        for item in added:
            assert (item[1] == "directory" and item[0] in OUTPUT_DIRS) or (
                isinstance(item[1], int) and OUTPUT_FILE.fullmatch(item[0])), "Unrecognized generated output"
        assert input_manifest(root) == after, "Outputs changed after capture"
        # The exact scope is already empty. Unlink only recorded new files;
        # rmdir refuses any unrecorded child instead of recursively deleting it.
        for item in sorted(added, key=lambda value: (
                value[1] == "directory", -value[0].count("/"), value[0])):
            target = root / item[0]
            if item[1] == "directory":
                target.rmdir()
            else:
                assert stat.S_ISREG(target.lstat().st_mode), "Output type changed"
                target.unlink()
            receipt["removed"].append(item[0])
        restored = input_manifest(root)
        receipt["restoredInputsSha256"] = digest(restored)
        assert restored == baseline, "Prepared baseline was not restored"
        receipt["status"] = "complete"
    except Exception as error:
        receipt["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        receipt["seconds"] = time.monotonic() - started
        write(trial / "output-cleanup.json", receipt)
    return receipt


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


def coverage_gate(measured, root):
    # Raw V8 profiles include dashboard/test TS outside the canonical CI gate.
    # Ask the pinned Node coverage owner to apply the frozen exported policy.
    script = """import {coverageArguments} from './scripts/run-node-tests.mjs';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {sep} from 'node:path';
const {TestCoverage}=createRequire(import.meta.url)('internal/test_runner/coverage');
const args=coverageArguments('all');
const globs=prefix=>args.filter(arg=>arg.startsWith(prefix)).map(arg=>arg.slice(prefix.length));
const owner=new TestCoverage(null,null,{cwd:process.cwd(),
  coverageIncludeGlobs:globs('--test-coverage-include='),
  coverageExcludeGlobs:globs('--test-coverage-exclude=')});
const prefix=pathToFileURL(process.cwd()+sep).href;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
console.log(JSON.stringify({arguments:args,
  ownerSha256:sha(readFileSync('./scripts/run-node-tests.mjs')),
  nodeVersion:process.version,nodeSha256:sha(readFileSync(process.execPath)),
  sources:JSON.parse(readFileSync(0,'utf8')).filter(name=>!owner.shouldSkipFileCoverage(prefix+name))}));"""
    gate = json.loads(command(["node", "--expose-internals", "--input-type=module", "-e", script],
                              cwd=root, stdin=json.dumps(list(measured["coveredBlocks"]))).stdout)
    assert gate["ownerSha256"] == COVERAGE_OWNER and gate["nodeVersion"] == "v24.22.1", \
        "Coverage policy/runtime changed"
    assert gate["sources"], "No sources inside the canonical CI coverage policy"
    gate["sourcesSha256"] = digest(gate["sources"])
    gate["coveredBlocksSha256"] = digest({
        name: measured["coveredBlocks"][name] for name in gate["sources"]})
    return gate


def main(root, output):
    root, output = root.resolve(), output.resolve()
    output.mkdir(exist_ok=False)
    summary = {"source": SOURCE, "purpose": "same-host-concurrency-comparison",
               "order": ORDER, "trials": [], "status": "incomplete"}
    try:
        if not __debug__:
            raise RuntimeError("Python assertion checks must remain enabled")
        assert os.environ.get("GITHUB_ACTIONS") == "true" and sys.platform == "linux"
        assert root == Path(os.environ["GITHUB_WORKSPACE"]).resolve(), "Not the task workload checkout"
        assert not any(os.path.lexists(root / name) for name in OUTPUT_ROOTS), "Output root already exists"
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
        synthetic_sources = ["dist/coverage-policy-preflight.js",
                             "dist/repair/coverage-policy-preflight.test.js",
                             "dashboard/coverage-policy-preflight.ts"]
        policy_probe = coverage_gate({"coveredBlocks": {name: [] for name in synthetic_sources}}, root)
        write(output / "coverage-policy-preflight.json", dict(policy_probe, syntheticSources=synthetic_sources))
        assert policy_probe["sources"] == synthetic_sources[:1], "Native coverage filter preflight failed"
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
            after = input_manifest(root)
            write(trial / "inputs-after.json", after)
            before_by_path = {item[0]: item for item in baseline}
            after_by_path = {item[0]: item for item in after}
            write(trial / "input-changes.json", {
                "beforeSha256": digest(baseline), "afterSha256": digest(after),
                "changes": [{"path": name, "before": before_by_path.get(name),
                             "after": after_by_path.get(name)}
                            for name in sorted(before_by_path.keys() | after_by_path.keys())
                            if before_by_path.get(name) != after_by_path.get(name)]})
            gated_coverage = coverage_gate(measured_coverage, root)
            write(trial / "coverage-gate.json", gated_coverage)
            if index == 1:
                expected_cases, expected_coverage = cases, gated_coverage
            else:
                assert cases == expected_cases, "Case identities or outcomes changed"
                assert gated_coverage == expected_coverage, "Canonical CI covered source blocks changed"
            cleanup = restore_generated_outputs(root, baseline, after, trial)
            observed.update(status="complete", seconds=receipt["seconds"],
                            cases=len(cases), outcomesSha256=digest(cases),
                            outputCleanupSeconds=cleanup["seconds"])
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
