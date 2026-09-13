import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(process.platform, "linux");
const source = resolve(process.argv[2] ?? "scripts/hosted-review-canary-proof.mjs");
const before = process.argv[3] === "before";
const { hostedProcessIdentity } = await import(pathToFileURL(source));
const read = fs.readFileSync;
const child = spawn(
  process.execPath,
  ["-e", 'process.stdout.write("ready"); setInterval(() => {}, 1000);'],
  { stdio: ["ignore", "pipe", "pipe"] },
);
const closed = once(child, "close");
let descriptor;
let kernelCode;
try {
  await Promise.race([
    once(child.stdout, "data"),
    closed.then(() => {
      throw new Error("fixture exited before readiness");
    }),
  ]);
  descriptor = fs.openSync(`/proc/${child.pid}/stat`, "r");
  child.kill("SIGTERM");
  await closed;
  assert.throws(
    () => read(descriptor, "utf8"),
    (error) => {
      kernelCode = error.code;
      return kernelCode === "ESRCH";
    },
  );
  // Hold the actual proc descriptor across exit to make the open/read race deterministic.
  fs.readFileSync = (file, options) =>
    file === `/proc/${child.pid}/stat` ? read(descriptor, options) : read(file, options);
  syncBuiltinESMExports();
  if (before)
    assert.throws(
      () => hostedProcessIdentity(child.pid),
      (error) => error.code === "ESRCH",
    );
  else assert.equal(hostedProcessIdentity(child.pid), null);
  assert.equal(hostedProcessIdentity(process.pid).pid, process.pid);
  console.log(
    JSON.stringify({
      platform: process.platform,
      node: process.version,
      kernelError: kernelCode,
      result: before ? "throws" : "absent",
      liveProcessControl: "identified",
      sourceSha256: createHash("sha256").update(read(source)).digest("hex"),
    }),
  );
} finally {
  fs.readFileSync = read;
  syncBuiltinESMExports();
  if (descriptor !== undefined) fs.closeSync(descriptor);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await closed;
}
