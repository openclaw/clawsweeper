#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureReviewTreeCommit,
  hydratePullRequestReviewBlobs,
} from "../../dist/clawsweeper-review-blobs.js";

if (process.argv.includes("--server")) {
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/count") return response.end(String(requests));
    requests++;
    response.statusCode = requests === 1 ? 503 : 200;
    response.end(requests === 1 ? "unavailable" : "corrupt archive");
  });
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => {
      console.log(port);
      process.once("message", () => server.listen(port, "127.0.0.1"));
    });
  });
} else {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "backlog-source-proof-")));
  const previousPath = process.env.PATH;
  let server;
  try {
    const nativeGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const git = (cwd, ...args) =>
      execFileSync(nativeGit, args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const origin = join(root, "origin.git");
    const source = join(root, "source");
    const target = join(root, "target");
    const bin = join(root, "bin");
    mkdirSync(source);
    mkdirSync(bin);
    git(root, "init", "--bare", "-q", origin);
    git(origin, "config", "uploadpack.allowFilter", "true");
    git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    git(source, "init", "-q", "-b", "main");
    git(source, "config", "user.name", "Synthetic fixture");
    git(source, "config", "user.email", "fixture@example.invalid");
    git(source, "config", "commit.gpgsign", "false");
    writeFileSync(join(source, "changed.txt"), "before\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "base");
    const baseSha = git(source, "rev-parse", "HEAD");
    writeFileSync(join(source, "changed.txt"), "after\n");
    writeFileSync(join(source, "added.txt"), "new implementation\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "head");
    const headSha = git(source, "rev-parse", "HEAD");
    git(source, "push", "-q", origin, "main");
    git(
      root,
      "clone",
      "-q",
      "--filter=blob:none",
      "--no-checkout",
      "--branch",
      "main",
      `file://${origin}`,
      target,
    );
    const trace = join(root, "fetches.jsonl");
    writeFileSync(trace, "");
    writeFileSync(
      join(bin, "git"),
      `#!${process.execPath}
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const args=process.argv.slice(2);
let input;
let partial=false;
if(args.includes('fetch') && args.includes('--stdin')) {
  input=fs.readFileSync(0,'utf8');
  partial=fs.readFileSync(${JSON.stringify(trace)},'utf8')==='';
  fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(input.trim().split('\\n'))+'\\n');
  if(partial) input=input.split('\\n')[0]+'\\n';
}
const r=spawnSync(${JSON.stringify(nativeGit)},args,{input,stdio:input===undefined?'inherit':['pipe','inherit','inherit']});
if(partial && r.status===0){console.error('fatal: The requested URL returned error: 503');process.exit(128);}
process.exit(r.status??1);
`,
      { mode: 0o700 },
    );
    process.env.PATH = `${bin}:${previousPath}`;
    assert.equal(
      ensureReviewTreeCommit({
        targetDir: target,
        sha: headSha,
        sourceRef: "refs/heads/main",
        destinationRef: "refs/clawsweeper/proof",
      }),
      true,
    );
    const options = {
      targetDir: target,
      baseSha,
      headSha,
      resolveBlobSizes: (ids) =>
        new Map(ids.map((id) => [id, Number(git(source, "cat-file", "-s", id))])),
    };
    const objects = hydratePullRequestReviewBlobs(options);
    const fetches = readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(fetches.length, 2);
    assert.deepEqual(fetches[1], fetches[0].slice(1));
    assert.equal(hydratePullRequestReviewBlobs(options), objects);
    assert.equal(readFileSync(trace, "utf8").trim().split("\n").length, 2);
    for (const id of fetches[0]) git(target, "cat-file", "-e", id);
    process.env.PATH = previousPath;

    server = spawn(process.execPath, [fileURLToPath(import.meta.url), "--server"], {
      stdio: ["ignore", "pipe", "inherit", "ipc"],
    });
    const port = Number(String((await once(server.stdout, "data"))[0]).trim());
    assert.ok(port > 0);
    const url = `http://127.0.0.1:${port}`;
    const scannerScript = readFileSync(
      ".github/actions/setup-review-tools/install.sh",
      "utf8",
    ).replace(
      "https://github.com/trufflesecurity/trufflehog/releases/download/v3.97.4/trufflehog_3.97.4_linux_amd64.tar.gz",
      `${url}/archive`,
    );
    writeFileSync(
      join(bin, "uname"),
      '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi\n',
      { mode: 0o700 },
    );
    if (process.platform === "darwin")
      writeFileSync(join(bin, "sha256sum"), '#!/bin/sh\nexec /usr/bin/shasum -a 256 "$@"\n', {
        mode: 0o700,
      });
    const runnerTemp = join(root, "runner-temp");
    mkdirSync(runnerTemp);
    const scanner = await new Promise((resolve, reject) => {
      const child = spawn("/bin/bash", ["-c", scannerScript], {
        env: {
          PATH: `${bin}:${previousPath}`,
          RUNNER_TEMP: runnerTemp,
          GITHUB_WORKSPACE: source,
          GITHUB_PATH: join(root, "github-path"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let listening = false;
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
        // A timer can race a loaded runner and skip the refused connection.
        if (!listening && /curl: \(7\)/.test(stderr)) {
          listening = true;
          server.send("listen");
        }
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.notEqual(scanner.code, 0);
    assert.match(scanner.stdout + scanner.stderr, /FAILED|did NOT match/);
    assert.match(scanner.stderr, /curl: \(7\)/);
    const downloads = Number(execFileSync("curl", ["-fsS", `${url}/count`], { encoding: "utf8" }));
    assert.equal(downloads, 2);
    console.log(
      JSON.stringify(
        {
          provider: "local-native-git-and-loopback-http",
          node: process.version,
          objects,
          fetchObjects: fetches.map((ids) => ids.length),
          warmFetches: 0,
          scannerDownloads: downloads,
          scannerConnectionRefusalRecovered: true,
          corruptScannerRejected: true,
          limits:
            "Synthetic local transport faults; no GitHub writes or production throughput claim.",
        },
        null,
        2,
      ),
    );
  } finally {
    process.env.PATH = previousPath;
    if (server) {
      server.kill();
      await once(server, "exit");
    }
    rmSync(root, { recursive: true, force: true });
  }
}
