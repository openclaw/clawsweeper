import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(process.platform, "linux", "this proof needs /proc and tmux");
const args = process.argv.slice(2);
const index = args.indexOf("--module");
const modulePath = index < 0 ? "scripts/hosted-review-canary-proof.mjs" : args[index + 1];
const { stopHostedTerminal, hostedProcessIdentity, recordHostedLifecycle } = await import(
  pathToFileURL(path.resolve(modulePath)).href
);
const baseline = args.includes("--expect-unfixed");
const tmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
const foreign = spawn("sleep", ["60"]);
const foreignIdentity = hostedProcessIdentity(foreign.pid);
const results = [];
try {
  for (const scenario of ["gone", "live", "changed-receipt"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-query-proof-"));
    const socket = path.join(root, "tmux.sock");
    const receipt = path.join(root, "receipt.jsonl");
    const wrapper = path.join(root, "query.mjs");
    const command = (...words) =>
      execFileSync(tmux, ["-S", socket, ...words], { encoding: "utf8" }).trim();
    let server;
    try {
      command("-f", "/dev/null", "new-session", "-d", "-s", "proof", "sleep 60");
      const [serverPid, panePid, tty, session] = command(
        "display-message",
        "-p",
        "-t",
        "proof:0.0",
        "#{pid}|#{pane_pid}|#{pane_tty}|#{session_id}",
      ).split("|");
      server = hostedProcessIdentity(Number(serverPid));
      const stat = fs.lstatSync(socket);
      const nonce = randomUUID();
      const identity = `${randomUUID()}|${panePid}|${tty}|1:2`;
      const shared = {
        kind: "terminal",
        fixtureNonce: nonce,
        socket,
        socketIdentity: `${stat.dev}:${stat.ino}`,
        server,
        session,
        lease: path.join(root, "proof.lease"),
        request: path.join(root, "proof.start"),
        result: path.join(root, "proof.cleanup.result"),
      };
      const records = [
        {
          ...shared,
          publication: `v1|armed|${identity}|${process.pid}\n`,
          watchdog: hostedProcessIdentity(process.pid),
        },
        { ...shared, publication: `v1|done|${identity}|controller|ok|0\n` },
      ];
      for (const record of records) recordHostedLifecycle(receipt, record);
      fs.writeFileSync(
        wrapper,
        `#!${process.execPath}
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {hostedProcessIdentity} from ${JSON.stringify(pathToFileURL(path.resolve(modulePath)).href)};
const args = process.argv.slice(2);
if (args[2] !== 'display-message') throw new Error('unexpected mutation after query');
if (${JSON.stringify(scenario)} !== 'live') {
  execFileSync(${JSON.stringify(tmux)}, ['-S', ${JSON.stringify(socket)}, 'kill-session', '-t', ${JSON.stringify(session)}]);
  const deadline = Date.now() + 2000;
  while (hostedProcessIdentity(${server.pid})) {
    if (Date.now() > deadline) throw new Error('fixture server did not exit');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  fs.rmSync(${JSON.stringify(socket)}, {force:true});
}
if (${JSON.stringify(scenario)} === 'changed-receipt') {
  const records = ${JSON.stringify(records)};
  records[1].session = '$999';
  fs.writeFileSync(${JSON.stringify(receipt)}, records.map(r => JSON.stringify(r) + '\\n').join(''));
}
process.stdout.write('|');
`,
        { mode: 0o700 },
      );
      const operation = stopHostedTerminal({ path: receipt, nonce, tmux: wrapper });
      const rejected = scenario !== "gone" || baseline;
      if (rejected) await assert.rejects(operation);
      else await operation;
      assert.deepEqual(hostedProcessIdentity(foreign.pid), foreignIdentity);
      if (scenario === "live") assert.deepEqual(hostedProcessIdentity(server.pid), server);
      results.push({
        scenario,
        outcome: rejected ? "refused" : "verified_quiescent",
        foreignPreserved: true,
      });
    } finally {
      if (server && hostedProcessIdentity(server.pid)) {
        assert.deepEqual(hostedProcessIdentity(server.pid), server);
        command("kill-session", "-t", "proof");
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
} finally {
  assert.deepEqual(hostedProcessIdentity(foreign.pid), foreignIdentity);
  foreign.kill("SIGTERM");
}
console.log(
  JSON.stringify(
    { baseline, node: process.version, platform: process.platform, results, pass: true },
    null,
    2,
  ),
);
