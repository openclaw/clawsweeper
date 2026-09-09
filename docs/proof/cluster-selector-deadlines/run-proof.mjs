import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer as httpServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";

const repoRoot = process.cwd();
const cli = path.join(repoRoot, "dist/repair/select-cluster-candidate.js");
const gh = process.argv[2] || "/opt/homebrew/bin/gh";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-selector-proof-"));
const sockets = new Set();
const requests = [];
let proxyRequests = 0;
const candidate = "jobs/openclaw/inbox/gitcrawl-42-candidate.md";
const model = httpServer((request, response) => {
  const scenario = request.url.slice(1);
  requests.push(scenario);
  request.resume();
  if (scenario === "headers") return;
  response.writeHead(200, { "content-type": "application/json" });
  if (scenario === "body") return response.write("{");
  const selected = scenario === "selected";
  response.end(
    JSON.stringify({
      output_text: JSON.stringify({
        selected_path: selected ? candidate : null,
        rationale: selected ? "Synthetic actionable defect." : "Synthetic rejection.",
        assessments: [
          {
            path: candidate,
            decision: selected ? "selected" : "rejected",
            rationale: "Synthetic fixture evidence.",
          },
        ],
      }),
    }),
  );
});
model.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
const proxy = tcpServer((socket) => {
  sockets.add(socket);
  socket.once("data", () => proxyRequests++);
  socket.on("close", () => sockets.delete(socket));
});
model.listen(0, "127.0.0.1");
proxy.listen(0, "127.0.0.1");
await Promise.all([once(model, "listening"), once(proxy, "listening")]);
const origin = `http://127.0.0.1:${model.address().port}/`;
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
const preload = path.join(root, "transport.mjs");
fs.writeFileSync(
  preload,
  `import assert from 'node:assert/strict';
const nativeFetch=globalThis.fetch;
globalThis.fetch=(url,init)=>{assert.equal(url,'https://api.openai.com/v1/responses');return nativeFetch(new URL(process.env.MODEL_SCENARIO,process.env.PROOF_ORIGIN),init);};`,
);
const fixtureGh = path.join(root, "gh.cjs");
fs.writeFileSync(
  fixtureGh,
  `const fs=require('node:fs');const args=process.argv.slice(2);
if(args[0]!=='api'||args[1]!=='repos/openclaw/clawsweeper/issues/100') process.exit(99);
fs.appendFileSync(process.env.GH_TRACE,'read issue 100\\n');
console.log(JSON.stringify({number:100,state:'open',title:'Synthetic defect',body:'Synthetic reproducible issue.',html_url:'https://github.com/openclaw/clawsweeper/issues/100',labels:[]}));`,
);
const ghConfig = path.join(root, "gh-config");
fs.mkdirSync(ghConfig);
fs.writeFileSync(path.join(ghConfig, "config.yml"), "telemetry: disabled\n");
const isolatedGhEnv = {
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR,
  SystemRoot: process.env.SystemRoot,
  HOME: root,
  GH_CONFIG_DIR: ghConfig,
  XDG_STATE_HOME: path.join(root, "gh-state"),
  GH_TOKEN: "synthetic-proof-token",
  GH_NO_UPDATE_NOTIFIER: "1",
  HTTP_PROXY: proxyUrl,
  HTTPS_PROXY: proxyUrl,
  ALL_PROXY: proxyUrl,
  NO_PROXY: "",
};
const children = new Set();
async function run(scenario) {
  const dir = path.join(root, scenario);
  fs.mkdirSync(path.join(dir, path.dirname(candidate)), { recursive: true });
  fs.writeFileSync(
    path.join(dir, candidate),
    `---\nrepo: openclaw/clawsweeper\ncluster_id: gitcrawl-42-candidate\ncandidates: ["#100"]\ncluster_refs: ["#100"]\n---\nSynthetic fixture.\n`,
  );
  fs.writeFileSync(path.join(dir, "paths.txt"), candidate + "\n");
  const env = {
    ...isolatedGhEnv,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    SystemRoot: process.env.SystemRoot,
    GH_BIN: scenario === "github" ? gh : process.execPath,
    GH_BIN_ARGS: scenario === "github" ? "[]" : JSON.stringify([fixtureGh]),
    GH_TOKEN: "synthetic-proof-token",
    OPENAI_API_KEY: "synthetic-proof-key",
    GH_CONFIG_DIR: ghConfig,
    XDG_STATE_HOME: path.join(dir, "state"),
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PROMPT_DISABLED: "1",
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    NO_PROXY: "",
    CLAWSWEEPER_GH_COMMAND_TIMEOUT_MS: "30000",
    GH_TRACE: path.join(dir, "gh-trace.txt"),
    MODEL_SCENARIO: scenario,
    PROOF_ORIGIN: origin,
  };
  const start = performance.now();
  const child = spawn(
    process.execPath,
    [
      "--import",
      preload,
      cli,
      "--repo",
      "openclaw/clawsweeper",
      "--paths-file",
      "paths.txt",
      "--out",
      "selected.txt",
      "--report",
      "report.json",
      "--model",
      "gpt-5.4",
    ],
    { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(child);
  let stderr = "",
    stdout = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.on("data", (chunk) => (stdout += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 145_000);
  try {
    const [code, signal] = await once(child, "close");
    const elapsedMs = Math.round(performance.now() - start);
    assert.equal(signal, null, `${scenario} watchdog fired`);
    if (["headers", "body", "github"].includes(scenario)) {
      assert.equal(code, 1, stderr);
      assert.match(stderr, scenario === "github" ? /ETIMEDOUT/ : /timeout|abort/i);
      const budget = scenario === "github" ? 30_000 : 120_000;
      assert.ok(
        elapsedMs >= budget - 1_000 && elapsedMs < budget + 15_000,
        `${scenario} elapsed ${elapsedMs}`,
      );
      assert.equal(fs.existsSync(path.join(dir, "selected.txt")), false);
      assert.equal(fs.existsSync(path.join(dir, "report.json")), false);
      return {
        scenario,
        elapsedMs,
        result: "failed closed",
        error: scenario === "github" ? "ETIMEDOUT" : "fetch timeout/abort",
        publishedSelection: false,
      };
    }
    assert.equal(code, 0, stderr);
    const selected = fs.readFileSync(path.join(dir, "selected.txt"), "utf8");
    const report = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
    assert.equal(selected, scenario === "selected" ? candidate + "\n" : "");
    assert.equal(report.selected, scenario === "selected" ? 1 : 0);
    assert.equal(report.assessments.length, 1);
    const reads = fs.readFileSync(path.join(dir, "gh-trace.txt"), "utf8").trim().split("\n").length;
    assert.equal(reads, scenario === "selected" ? 2 : 1);
    assert.match(stdout, /cluster selector chose|cluster selector rejected/);
    return { scenario, elapsedMs, selected: report.selected, githubReads: reads };
  } finally {
    clearTimeout(timer);
    children.delete(child);
  }
}
try {
  const results = await Promise.all(["headers", "body", "github", "selected", "rejected"].map(run));
  assert.ok(proxyRequests > 0);
  assert.deepEqual([...requests].sort(), ["body", "headers", "rejected", "selected"]);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        ghVersion: execFileSync(gh, ["--version"], {
          encoding: "utf8",
          env: isolatedGhEnv,
          cwd: root,
        }).split("\n")[0],
        results,
      },
      null,
      2,
    ),
  );
} finally {
  for (const child of children) child.kill("SIGKILL");
  for (const socket of sockets) socket.destroy();
  model.close();
  proxy.close();
  fs.rmSync(root, { recursive: true, force: true });
}
