import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const dist = resolve(process.argv[2] || "dist");
const expected = process.argv[3] || "fixed";
const { runCodexProcess } = await import(pathToFileURL(join(dist, "codex-process.js")));
const root = mkdtempSync(join(tmpdir(), "app-server-lifecycle-proof-"));
const portFile = join(root, "port");
const eventsFile = join(root, "events");
const fixture = join(root, process.platform === "win32" ? "codex.cmd" : "codex");
const fixtureScript = join(root, "app-server-peer.cjs");
const serverFile = join(root, "server.cjs");
mkdirSync(join(root, "session"));
const peerSource = `
const readline = require('node:readline');
const send = values => process.stdout.write(values.map(value=>JSON.stringify(value)).join('\\n')+'\\n');
readline.createInterface({input:process.stdin}).on('line', line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send([{id:m.id,result:{userAgent:'synthetic'}}]);
 if(m.method==='thread/start')send([{id:m.id,result:{thread:{id:'thread-1',sessionId:'session-1'}}}]);
 if(m.method==='turn/start')send([
  {id:m.id,result:{turn:{id:'turn-1',status:'inProgress',items:[]}}},
  {method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',item:{type:'agentMessage',id:'message-1',text:'{"status":"planned"}'}}},
  {method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed',items:[]}}}
 ]);
});
`;
if (process.platform === "win32") {
  writeFileSync(fixtureScript, peerSource);
  writeFileSync(fixture, `@echo off\r\n"${process.execPath}" "%~dp0app-server-peer.cjs" %*\r\n`);
} else writeFileSync(fixture, `#!${process.execPath}\n${peerSource}`, { mode: 0o755 });
writeFileSync(
  serverFile,
  `
const fs=require('node:fs');
const http=require('node:http');
const server=http.createServer((req,res)=>{
 let data='';req.on('data',chunk=>data+=chunk);req.on('end',()=>{
  const payload=JSON.parse(data);
  const commit=()=>{
   fs.appendFileSync(process.env.PROOF_EVENTS,JSON.stringify({summary:payload.summary,phase:payload.phase})+'\\n');
   res.writeHead(204);res.end();
  };
  if(payload.summary==='Codex turn active')setTimeout(commit,250);
  else commit();
 });
});
server.listen(0,'127.0.0.1',()=>{
 const temporary=process.env.PROOF_PORT+'.tmp';
 fs.writeFileSync(temporary,String(server.address().port));
 fs.renameSync(temporary,process.env.PROOF_PORT);
});
`,
);
const server = spawn(process.execPath, [serverFile], {
  env: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    PROOF_PORT: portFile,
    PROOF_EVENTS: eventsFile,
  },
  stdio: "ignore",
});
const exited = new Promise((resolve) => server.once("exit", resolve));
try {
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await delay(25);
  const port = Number(readFileSync(portFile, "utf8"));
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, "fixture listener must be ready");
  const output = join(root, "result.json");
  const result = runCodexProcess({
    args: ["exec", "--cd", root, "--output-last-message", output, "--json", "-"],
    cwd: root,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CODEX_BIN: fixture },
    input: "Synthetic lifecycle fixture.",
    timeoutMs: 10000,
    appServer: {
      statePath: join(root, "session/state.json"),
      workStateUrl: `http://127.0.0.1:${port}/work-state`,
      agentToken: "synthetic-proof-token",
    },
  });
  assert.equal(result.status, 0, "compiled app-server worker must complete");
  assert.equal(result.error, undefined, result.stderr);
  assert.doesNotMatch(
    result.stderr,
    /work-state update failed/,
    "fixture state writes must succeed",
  );
  assert.equal(readFileSync(output, "utf8"), '{"status":"planned"}');
  for (let i = 0; i < 200; i++) {
    if (readFileSync(eventsFile, "utf8").trim().split("\n").length === 3) break;
    await delay(25);
  }
  const events = readFileSync(eventsFile, "utf8").trim().split("\n").map(JSON.parse);
  const phases = events.map((x) => x.phase);
  const ordered = JSON.stringify(phases) === JSON.stringify(["codex", "codex", "validating"]);
  console.log(
    JSON.stringify({
      fixture:
        "atomic turn/start acknowledgement and completion notifications with delayed active-state storage",
      phases,
      ordered,
      result_valid: true,
      source_sha256: Object.fromEntries(
        ["src/codex-app-server-worker.ts", "src/codex-work-state.ts"].map((path) => {
          const source = resolve(dist, "..", path);
          return [
            path,
            existsSync(source)
              ? createHash("sha256").update(readFileSync(source)).digest("hex")
              : null,
          ];
        }),
      ),
      limits:
        "Real compiled ClawSweeper worker and HTTP transport; synthetic protocol peer and 250ms active-state storage delay; no inference or production mutation.",
    }),
  );
  assert.equal(ordered, expected === "fixed", "lifecycle ordering expectation");
} finally {
  server.kill();
  await exited;
  rmSync(root, { recursive: true, force: true });
}
