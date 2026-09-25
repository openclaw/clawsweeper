import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { signalProcessGroup } from "../dist/process-group.js";

const cases = [
  { name: "same-user zombie group", output: "12345 501 Z\n12345 501 Z+\n", expected: true },
  { name: "live member among zombies", output: "12345 501 Z\n12345 501 S\n" },
  { name: "another user's zombie", output: "12345 502 Z\n" },
  { name: "unexpected process group", output: "12346 501 Z\n" },
  { name: "malformed identity", output: "12345 unknown Z\n" },
  { name: "failed process lookup", output: "", lookupStatus: 1 },
  { name: "empty successful lookup", output: "" },
  { name: "group reaped during lookup", output: "", lookupStatus: 1, gone: true, expected: false },
  { name: "non-Darwin denial", output: "12345 501 Z\n", platform: "linux" },
  { name: "expired acquisition deadline", output: "12345 501 Z\n", deadlineAt: 999 },
] as const;

for (const scenario of cases) {
  test(`process-group permission handling: ${scenario.name}`, (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const geteuid = Object.getOwnPropertyDescriptor(process, "geteuid");
    const denied = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    let lookups = 0;
    try {
      Object.defineProperty(process, "platform", {
        value: "platform" in scenario ? scenario.platform : "darwin",
      });
      Object.defineProperty(process, "geteuid", { configurable: true, value: () => 501 });
      t.mock.method(Date, "now", () => 1000);
      t.mock.method(process, "kill", (pid, signal) => {
        assert.equal(pid, -12345);
        if (signal === 0) {
          if ("gone" in scenario) {
            throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
          }
          // Permission to inspect a group does not authorize its termination.
          return true;
        }
        throw denied;
      });
      t.mock.method(childProcess, "spawnSync", (_command, _args, options) => {
        lookups++;
        assert.ok(options.timeout > 0 && options.timeout <= 100);
        return {
          pid: 12346,
          signal: null,
          status: "lookupStatus" in scenario ? scenario.lookupStatus : 0,
          stdout: scenario.output,
          stderr: "",
          output: [null, scenario.output, ""],
        };
      });
      syncBuiltinESMExports();
      const run = () =>
        signalProcessGroup(12345, "SIGKILL", "deadlineAt" in scenario ? scenario.deadlineAt : 1100);
      if ("expected" in scenario) assert.equal(run(), scenario.expected);
      else assert.throws(run, (error) => error === denied);
      if ("platform" in scenario || "deadlineAt" in scenario) assert.equal(lookups, 0);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      Object.defineProperty(process, "platform", platform);
      if (geteuid) Object.defineProperty(process, "geteuid", geteuid);
      else Reflect.deleteProperty(process, "geteuid");
    }
  });
}
