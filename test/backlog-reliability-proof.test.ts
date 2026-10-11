import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import {
  ensureReviewTreeCommit,
  hydratePullRequestReviewBlobs,
} from "../dist/clawsweeper-review-blobs.js";
import {
  ExactReviewQueue,
  MemoryDurableStorage,
  leasedExactReviewPublicationItem,
} from "./dashboard-worker-harness.ts";
import { runCopyProof } from "../scripts/e2e/exact-review-selected-tuple-copy.mjs";

const originalCoverageDirectory = process.env.NODE_V8_COVERAGE;
beforeEach(() => {
  delete process.env.NODE_V8_COVERAGE;
});
afterEach(() => {
  if (originalCoverageDirectory === undefined) delete process.env.NODE_V8_COVERAGE;
  else process.env.NODE_V8_COVERAGE = originalCoverageDirectory;
});

test(
  "backlog source recovery retries only missing blobs and rejects corrupt scanner downloads",
  { skip: process.platform === "win32", timeout: 180_000 },
  async () => {
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

      server = spawn(
        process.execPath,
        [
          "-e",
          'const { createServer } = require("node:http");\nlet requests = 0;\nconst server = createServer((request, response) => {\n  if (request.url === "/count") return response.end(String(requests));\n  requests++;\n  response.statusCode = requests === 1 ? 503 : 200;\n  response.end(requests === 1 ? "unavailable" : "corrupt archive");\n});\nserver.listen(0, "127.0.0.1", () => {\n  const port = server.address().port;\n  server.close(() => {\n    console.log(port);\n    process.once("message", () => server.listen(port, "127.0.0.1"));\n  });\n});',
        ],
        {
          stdio: ["ignore", "pipe", "inherit", "ipc"],
        },
      );
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
      const downloads = Number(
        execFileSync("curl", ["-fsS", `${url}/count`], { encoding: "utf8" }),
      );
      assert.equal(downloads, 2);
    } finally {
      process.env.PATH = previousPath;
      if (server) {
        server.kill();
        await once(server, "exit");
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "backlog dead-letter inventory reads only recovery membership keys",
  { skip: process.platform === "win32" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "backlog-inventory-proof-"));
    try {
      const storage = new MemoryDurableStorage(join(root, "queue.sqlite"));
      const item = leasedExactReviewPublicationItem(792, "7920");
      Object.assign(item, {
        attempts: 2,
        publicationFailureAttempts: 2,
        firstFailureAt: Date.now() - 360_000,
      });
      await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
      const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_RETRY_POLICY_EPOCH: "2" });
      const post = (path, body) =>
        queue.fetch(
          new Request(`https://queue/${path}`, { method: "POST", body: JSON.stringify(body) }),
        );
      assert.deepEqual(
        await (
          await post("complete", {
            lease_id: item.leaseId,
            item_key: item.key,
            lease_revision: item.leaseRevision,
            claim_generation: item.claimGeneration,
            run_id: item.claimedRunId,
            run_attempt: item.claimedRunAttempt,
            outcome: "failure",
            completion_kind: "permanent_failure",
            reason_code: "invalid_artifact",
          })
        ).json(),
        { ok: true, requeued: false },
      );
      for (let n = 0; n < 1000; n++)
        storage.sql.exec(
          "INSERT INTO exact_review_queue_items (item_key,item_json) VALUES (?,?)",
          `unrelated-${n}`,
          JSON.stringify({ key: `unrelated-${n}`, payload: "x".repeat(32_768) }),
        );
      const observations = [];
      for (const [key, expected] of [
        [null, "eligible"],
        [item.key, "publication_item_active"],
        ["openclaw/openclaw#792", "fresh_review_already_active"],
      ]) {
        if (key)
          storage.sql.exec(
            "INSERT INTO exact_review_queue_items (item_key,item_json) VALUES (?,?)",
            key,
            JSON.stringify({ key }),
          );
        storage.sql.resetQueryHistory();
        const response = await post("dead-letters/list", { limit: 10 });
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.equal(data.dead_letters[0].fresh_recovery.reason, expected);
        assert.equal(storage.sql.queriesMatching(/SELECT item_key, item_json/).length, 0);
        const reads = storage.sql.queriesMatching(/SELECT item_key FROM exact_review_queue_items/);
        assert.equal(reads.length, 1);
        assert.equal(JSON.parse(reads[0].bindings[0]).length, 2);
        observations.push({ reason: expected, membershipKeys: 2, activePayloadScans: 0 });
        if (key) storage.sql.exec("DELETE FROM exact_review_queue_items WHERE item_key=?", key);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "backlog batch concurrency preserves serial effects and fences",
  { skip: process.platform === "win32" },
  () => {
    const serial = runCopyProof({ concurrency: 1 });
    const parallel = runCopyProof({ concurrency: 2 });
    assert.deepEqual(parallel.plans, serial.plans);
    assert.deepEqual(parallel.outcomes, serial.outcomes);
    assert.deepEqual(parallel.actions, serial.actions);
    assert.equal(parallel.telemetry.observedPeakWorkers, 2);
    runCopyProof({ concurrency: 2, mode: "circuit" });
    runCopyProof({ concurrency: 2, mode: "mixed-circuit" });
    runCopyProof({ concurrency: 2, mode: "heartbeat" });
  },
);
