import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { runCodexProcess } from "../dist/codex-process.js";

async function exercise(mode: "boundaries" | "deadline" | "selection") {
  const root = mkdtempSync(join(tmpdir(), "review-proof-boundary-"));
  const requestsPath = join(root, "requests.jsonl");
  const outputPath = join(root, "decision.json");
  const server = spawn(
    process.execPath,
    [
      "-e",
      `
    const http=require('node:http'),fs=require('node:fs');
    const server=http.createServer((req,res)=>{
      let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
        if(JSON.parse(body).operation==='capabilities'){res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,allowedScenarios:${JSON.stringify(mode)}==='selection'?['web-ui-chat-proof']:['telegram-bot-e2e-proof']}));return;}
        fs.appendFileSync(${JSON.stringify(requestsPath)},body+'\\n');
        if(${JSON.stringify(mode)}==='deadline')return;
        setTimeout(()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({state:'completed',expiresAt:Date.now()+20*60000,observations:['observed']}));},100);
      });
    });server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("HTTP fixture startup timed out")), 5000);
      const lines = createInterface({ input: server.stdout! });
      lines.once("line", (line) => {
        clearTimeout(timer);
        lines.close();
        resolve(line);
      });
      server.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const source = `
      const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
      const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
      const responses={};
      let tools=[];
      const ownHandoffs=fs.readdirSync(require('node:os').tmpdir()).filter(n=>n.startsWith('clawsweeper-codex-process-')).some(n=>{
        try{return fs.readFileSync(path.join(require('node:os').tmpdir(),n,'options.json'),'utf8').includes(${JSON.stringify(outputPath)});}catch{return false;}
      });
      if(ownHandoffs)throw Error('Capability handoff file remains readable');
      const plan={claim:'help',actions:[{type:'send',atMs:0,text:'/help'}],modelReplies:[],settings:{streaming:'off',nativeCommands:true},maxDurationMs:1000,expectations:['help response']};
      const call=(id,overrides={})=>send({id,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:id,tool:'request_behavior_proof',arguments:plan,...overrides}});
      const finish=()=>{
        send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'agentMessage',text:JSON.stringify({responses,tools,handoffRemoved:!ownHandoffs})}}});
        send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
      };
      readline.createInterface({input:process.stdin}).on('line',line=>{
        const message=JSON.parse(line);
        if(message.method==='initialize')send({id:message.id,result:{}});
        if(message.method==='thread/start'){tools=message.params.dynamicTools.map(t=>t.name);send({id:message.id,result:{thread:{id:'thread'}}});}
        if(message.method==='turn/start'){
          send({id:message.id,result:{turn:{id:'turn'}}});
          setTimeout(()=>{
            if(${JSON.stringify(mode)}==='deadline'){call('late');return;}
            if(${JSON.stringify(mode)}==='selection'){call('unselected');return;}
            call('wrong-thread',{threadId:'other'});call('wrong-turn',{turnId:'other'});call('missing-id',{callId:''});
            call('first');call('concurrent');
          },20);
        }
        if(typeof message.id==='string' && message.result){
          responses[message.id]=JSON.parse(message.result.contentItems[0].text);
          if(message.id==='late'){finish();return;}
          if(message.id==='unselected'){call('selected',{tool:'request_web_ui_chat_proof',arguments:{}});return;}
          if(message.id==='selected'){finish();return;}
          if(message.id==='first'){call('replay',{callId:'first'});call('second');}
          if(message.id==='second')call('third');
          if(message.id==='third')call('over-budget');
          if(message.id==='over-budget')finish();
        }
      });
    `;
    const script = join(root, "fixture.cjs");
    const binary = join(root, process.platform === "win32" ? "codex.cmd" : "codex");
    writeFileSync(script, source);
    writeFileSync(
      binary,
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "%~dp0fixture.cjs" %*\r\n`
        : `#!/usr/bin/env node\n${source}`,
      { mode: 0o755 },
    );
    const result = runCodexProcess({
      args: [
        "exec",
        "--cd",
        root,
        "--sandbox",
        "read-only",
        "--output-last-message",
        outputPath,
        "-",
      ],
      cwd: root,
      env: { ...process.env, CODEX_BIN: binary },
      input: "Review this PR.",
      timeoutMs: mode === "deadline" ? 5000 : 10000,
      appServer: {
        statePath: join(root, "thread.json"),
        reviewProof: {
          queueUrl: `http://127.0.0.1:${port}`,
          lease: {
            itemKey: "openclaw/openclaw#12",
            leaseId: "boundary-lease",
            leaseRevision: 1,
            claimGeneration: 1,
            runId: "100",
            runAttempt: 1,
            sourceHeadSha: "a".repeat(40),
          },
        },
      },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(result.error, undefined);
    return {
      decision: JSON.parse(readFileSync(outputPath, "utf8")),
      requests: readFileSync(requestsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    };
  } finally {
    const exited = new Promise<void>((resolve) => {
      if (server.exitCode !== null) resolve();
      else server.once("exit", () => resolve());
    });
    server.kill();
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
}

test("inline proof rejects foreign, replayed, concurrent and over-budget calls and consumes its capability handoff", async () => {
  const { decision, requests } = await exercise("boundaries");
  assert.equal(decision.handoffRemoved, true);
  for (const id of [
    "wrong-thread",
    "wrong-turn",
    "missing-id",
    "concurrent",
    "replay",
    "over-budget",
  ]) {
    assert.equal(decision.responses[id].status, "inconclusive", id);
  }
  for (const id of ["first", "second", "third"])
    assert.equal(decision.responses[id].state, "completed", id);
  assert.equal(requests.length, 3);
});

test("inline proof returns inconclusive while time remains for the original final decision", async () => {
  const { decision, requests } = await exercise("deadline");
  assert.equal(decision.responses.late.status, "inconclusive");
  assert.match(decision.responses.late.reason, /budget|expired/);
  assert.equal(requests.length, 1);
});

test("explicit Web UI capability hides and rejects unselected Telegram calls", async () => {
  const { decision, requests } = await exercise("selection");
  assert.deepEqual(decision.tools, ["request_web_ui_chat_proof"]);
  assert.equal(decision.responses.unselected.status, "inconclusive");
  assert.equal(decision.responses.selected.state, "completed");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].scenario, "web-ui-chat-proof");
});
