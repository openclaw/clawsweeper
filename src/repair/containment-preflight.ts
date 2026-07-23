#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runContainedCommandResult } from "./command-runner.js";

const PREFLIGHT_PROBE = [
  "import os, socket, sys",
  "host_marker, work, profile = sys.argv[1:]",
  "assert not os.path.exists(host_marker), 'host marker remained visible'",
  "assert os.listdir('/run') == [], 'host /run entries remained visible'",
  "open(os.path.join(work, 'work-write'), 'w').write('ok')",
  "open(os.path.join(profile, 'profile-write'), 'w').write('ok')",
  "try:",
  "    open('/tmp/escape', 'w').write('unsafe')",
  "    raise AssertionError('non-writable path accepted a write')",
  "except OSError:",
  "    pass",
  "status = open('/proc/self/status', encoding='ascii').read().splitlines()",
  "caps = {line.split(':', 1)[0]: int(line.split(':', 1)[1].strip(), 16) for line in status if line.split(':', 1)[0] in {'CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'}}",
  "assert set(caps) == {'CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'}",
  "assert not any(caps.values()), 'validation capabilities were not fully dropped'",
  "with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:",
  "    listener.bind(('127.0.0.1', 0))",
  "print('contained')",
].join("\n");

export function runContainmentPreflight(): string {
  if (process.platform !== "linux") {
    throw new Error("containment preflight requires Linux");
  }
  for (const tool of ["/usr/bin/unshare", "/usr/bin/python3"]) {
    if (!fs.existsSync(tool)) throw new Error(`containment preflight requires ${tool}`);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-containment-preflight-"));
  const hostMarker = `${root}.host-marker`;
  const work = path.join(root, "work");
  const profile = path.join(root, "profile");
  try {
    fs.mkdirSync(work);
    fs.mkdirSync(profile);
    fs.writeFileSync(hostMarker, "host-visible\n");
    const result = runContainedCommandResult(
      "/usr/bin/python3",
      ["-c", PREFLIGHT_PROBE, hostMarker, work, profile],
      {
        cwd: work,
        env: {
          CI: "true",
          HOME: profile,
          LANG: "C.UTF-8",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          TEMP: profile,
          TMP: profile,
          TMPDIR: profile,
        },
        isolateNetwork: true,
        maxBuffer: 1024 * 1024,
        timeoutMs: 30_000,
        writableRoots: [work, profile],
      },
    );
    // Worker transport and target-process errors are not part of the validated
    // containment protocol, so keep them opaque instead of echoing their text.
    if (
      result.status !== 0 ||
      result.signal !== null ||
      result.error !== undefined ||
      result.backgroundProcesses !== 0 ||
      result.stdout !== "contained\n" ||
      result.capabilitySummary === undefined
    ) {
      throw new Error("containment preflight failed closed");
    }
    return `mount_readonly=${result.capabilitySummary.mountReadonly} landlock=${result.capabilitySummary.landlock}`;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(hostMarker, { force: true });
  }
}

function main(): void {
  process.stdout.write(`${runContainmentPreflight()}\n`);
}

export function safePreflightErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    /^validation process containment failed: stage=[a-z_]+(?:(?: syscall| errno)=[0-9]+)*(?: exit=(?:[0-9]+|[A-Z0-9]+|unknown))?$/.test(
      message,
    ) ||
    message === "containment preflight requires Linux" ||
    /^containment preflight requires \/usr\/bin\/(?:python3|unshare)$/.test(message)
  ) {
    return message;
  }
  return "containment preflight failed closed";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${safePreflightErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
