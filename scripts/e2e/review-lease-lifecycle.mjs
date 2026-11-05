#!/usr/bin/env node
// Synthetic loopback proof. No requests or credentials leave this process tree.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = "openclaw/lease-fixture",
  number = 357,
  head = "a".repeat(40);
const identity = `<!-- clawsweeper-review item=${number} -->`;
const original = `Codex review: old stored review.\n\nLiteral \\u001b and actual \u001b control; café 🦞.\n\n${identity}`;
const completed = `Codex review: completed replacement.\n\n${identity}`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const load = (name) =>
  import(pathToFileURL(resolve(process.env.PROOF_DIST_ROOT || "dist", name + ".js")));

if (process.argv[2] === "--worker") {
  const role = process.argv[3];
  const [leases, state, publication, profiles, runtime, guardsModule, github, closeModule] =
    await Promise.all([
      load("clawsweeper-review-comment-leases"),
      load("clawsweeper-review-comment-state"),
      load("clawsweeper-review-comment-publication"),
      load("repository-profiles"),
      load("clawsweeper-github-runtime"),
      load("clawsweeper-apply-lease-guards"),
      load("clawsweeper-github-execution"),
      load("clawsweeper-apply-close-execution"),
    ]);
  const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  const { withReviewRecord, reviewReportFrontMatter } = await import("../../test/helpers.ts");
  profiles.withTargetProfile(profiles.repositoryProfileFor(repo), () =>
    runtime.withGitHubRun(() => {
      const item = {
        kind: "pull_request",
        number,
        title: "Synthetic lease proof",
        labels: [],
        repo,
        authorAssociation: "NONE",
      };
      const reservation = leases.postReviewStartStatusComment(
        {
          item,
          headSha: head,
          reviewTimeoutMs: 60_000,
          position: 1,
          total: 1,
          shardIndex: 0,
          shardCount: 1,
          ...(role === "quiet"
            ? {
                backgroundReview: true,
                queueAuthority: {
                  queueUrl: process.env.LEASE_FIXTURE_URL,
                  itemKey: `${repo}#${number}`,
                  leaseId: "synthetic",
                  leaseRevision: 1,
                  claimGeneration: 1,
                  runId: "42",
                  runAttempt: 1,
                  sourceHeadSha: head,
                },
              }
            : {}),
        },
        () => head,
      );
      emit({ stage: "ready", status: reservation.status, leaseId: reservation.lease?.commentId });
      const deadline = Date.now() + 60_000;
      while (!existsSync(process.env.LEASE_CONTROL)) {
        if (Date.now() > deadline) throw new Error("fixture control timed out");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      const action = readFileSync(process.env.LEASE_CONTROL, "utf8").trim();
      if (reservation.status !== "posted") {
        emit({ stage: "done", status: "held" });
        return;
      }
      const lease = reservation.lease;
      if (action === "cleanup") {
        const released = leases.deleteOwnedDedicatedReviewStartLease(number, lease, {
          throwOnError: true,
        });
        emit({ stage: "done", status: "released", released });
        return;
      }
      let active = null;
      let markdown = withReviewRecord(
        reviewReportFrontMatter({
          repository: repo,
          number,
          type: "pull_request",
          pull_head_sha: head,
          review_lease_owner: lease.owner,
          review_lease_comment_id: String(lease.commentId),
        }),
        {
          decision: "close",
          closeReason: "stale_insufficient_info",
          closeComment: "Closing synthetic fixture.",
        },
      );
      const guards = guardsModule.createApplyLeaseGuards({
        canonicalBoundStaleReviewReason: () => null,
        closeDelayMs: 0,
        currentReviewActivityBlock: () => null,
        dryRun: false,
        getActiveApplyMutationLease: () => active,
        setActiveApplyMutationLease: (value) => {
          active = value;
        },
        ghJson: github.ghJson,
        GitHubRuntimeBudgetError: class extends Error {},
        initialReviewHeadSha: head,
        issueReviewCommentState: state.issueReviewCommentState,
        item,
        liveIssueSourceRevision: () => head,
        markdownBeforeApplyDecisionMutations: markdown,
        number,
        PATCHABLE_REVIEW_COMMENT_AUTHORS: new Set(["clawsweeper[bot]"]),
        postReviewStartStatusComment: () => {
          throw new Error("must adopt the reserved lock");
        },
        reportReviewRevision: head,
        requiresApplyMutationLease: true,
        shouldPreserveReviewStartLease: state.shouldPreserveReviewStartLease,
        targetRepo: () => repo,
      });
      const current = guards.refreshReviewStartLeaseState();
      let block = current.preserve ? "competing owner" : guards.acquireApplyMutationLease(current);
      if (!block) {
        block = guards.currentApplyMutationLeaseBlockReason();
        if (!block)
          publication.upsertReviewComment(
            number,
            completed,
            state.issueReviewComment(number),
            undefined,
            { preserveReviewStartLease: lease },
          );
        const afterPublication = guards.currentApplyMutationLeaseBlockReason();
        emit({ stage: "publication", block: afterPublication });
        if (!afterPublication) {
          // Exercise a post-publication metadata write through the same live guard.
          github.ghJson([
            "api",
            `repos/${repo}/issues/${number}/labels/recovery`,
            "--method",
            "DELETE",
          ]);
          const strict = (values) =>
            new Proxy(values, {
              get: (target, key) => {
                if (key in target) return target[key];
                return () => {
                  throw new Error(`unexpected close dependency ${String(key)}`);
                };
              },
            });
          closeModule.executeApplyClose(
            strict({
              closeReasonEnabled: () => true,
              ghJson: () => ({ body: "Synthetic stale issue." }),
              fetchIssueReviewComments: () => [],
              implementedOnMainPullRequestProvenanceApplyBlock: () => null,
              validateCloseDecision: () => ({ ok: true }),
              closeReasonApplyAgeSkipReason: () => null,
              issueRecentHumanCommentBlockSafe: () => null,
              normalizeLabelName: (value) => value,
              resetGuardReadCache: () => {},
              withGuardReadOptions: (_options, run) => run(),
              closeItem: () =>
                github.ghJson([
                  "api",
                  `repos/${repo}/issues/${number}`,
                  "--method",
                  "PATCH",
                  "-f",
                  "state=closed",
                ]),
              ensureRuntimeDelayFits: () => {},
              sleepMs: () => {},
            }),
            strict({
              applyCloseReasons: null,
              applyKind: "all",
              closeReason: "stale_insufficient_info",
              closeLimitReached: false,
              requiredMaintainerDecision: null,
              item: { ...item, kind: "issue" },
              number,
              repo,
              dryRun: false,
              isRetryableSkippedClose: false,
              getMarkdown: () => markdown,
              setMarkdown: (value) => {
                markdown = value;
              },
              itemsDir: "synthetic",
              closedDir: "synthetic",
              minAgeMs: 0,
              minAgeDescription: "0 minutes",
              staleMinAgeDays: 60,
              closeDelayMs: 0,
              reviewComment: completed,
              emitEventApplyProof: false,
              postProofCoveringPrFreshnessBlock: () => null,
              postProofFreshnessBlock: () => null,
              currentSameAuthorPairBlockReason: () => null,
              currentObsoleteFixPrBlock: () => null,
              currentStaleVersionBugBlock: () => null,
              currentAuthorPrBudgetApplyGate: () => ({ block: null }),
              setCloseMutationPolicyGuard: () => {},
              currentApplyMutationLeaseBlockReason: guards.currentApplyMutationLeaseBlockReason,
              recordReviewLeaseSkip: (reason) => {
                block = reason;
                return false;
              },
              archiveClosed: () => {},
              onClosed: () => false,
              logProgress: () => {},
            }),
          );
        } else block = afterPublication;
      }
      leases.deleteOwnedDedicatedReviewStartLease(number, lease, { throwOnError: true });
      emit({ stage: "done", status: block ? "blocked" : "published-and-closed", block });
    }),
  );
  await new Promise((done) => process.stdout.write("", done));
  process.exit(0);
}

const output = resolve(process.argv[2] || ".artifacts/review-lease-lifecycle");
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "lease-lifecycle-"));
const proxy = join(root, "proxy.cjs");
writeFileSync(
  proxy,
  `
const fs = require("node:fs"), args = process.argv.slice(2), raw = args.includes("--url");
const endpoint = raw ? new URL(args[args.indexOf("--url") + 1]).pathname : "/" + args[1];
const index = args.indexOf("--method"), method = raw || index < 0 ? "GET" : args[index + 1];
const input = args.indexOf("--input"), field = args.find(value => value.startsWith("body=") || value.startsWith("state="));
const body = input >= 0 ? fs.readFileSync(args[input + 1]) : field ? JSON.stringify({[field.split("=")[0]]: field.slice(field.indexOf("=") + 1)}) : undefined;
fetch(process.env.LEASE_FIXTURE_URL + endpoint, {method, body, headers: {"x-role": process.env.LEASE_ROLE, "x-raw": String(raw)}}).then(async response => {
  let text = await response.text();
  if (raw) text = "HTTP/1.1 " + response.status + " OK\\r\\nContent-Type: application/json\\r\\n\\r\\n" + text;
  else {
    const value = JSON.parse(text), slash = String.fromCharCode(92);
    text = JSON.stringify(value, (_key, entry) => typeof entry === "string" ? entry.replaceAll(slash + "u001b", slash + "^[").replaceAll(String.fromCharCode(27), "^[") : entry);
    if (args.includes("--slurp")) text = "[" + text + "]";
  }
  process.stdout.write(text);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
`,
);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const results = [];
try {
  for (const name of [
    "post-before-patch",
    "patch-before-post",
    "adopt-publication-close",
    "lossless-cleanup",
    "legacy-upgrade",
  ].filter(
    (name) =>
      !process.argv.includes("--case") || name === process.argv[process.argv.indexOf("--case") + 1],
  )) {
    const trace = [],
      comments = [{ id: 42, user: { login: "clawsweeper[bot]" }, body: original }];
    let nextId = 1000,
      closed = false;
    const initial = { quiet: deferred(), separate: deferred() },
      gates = {},
      seen = new Set();
    const race = name.endsWith("before-patch") || name.endsWith("before-post");
    if (name === "legacy-upgrade")
      comments.push({
        id: 900,
        user: { login: "clawsweeper[bot]" },
        updated_at: "2026-01-01T00:00:00Z",
        body: `ClawSweeper status: review started.\n\n<!-- clawsweeper-review-status:started item=${number} sha=${head} started_at=${new Date().toISOString()} lease_expires_at=${new Date(Date.now() + 600_000).toISOString()} owner=old-worker v=1 -->\n\n<!-- clawsweeper-review-lease item=${number} -->`,
      });
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const path = new URL(request.url, "http://localhost").pathname;
      const role = request.headers["x-role"] || "queue";
      const event = {
        method: request.method,
        path,
        role,
        raw: request.headers["x-raw"] === "true",
      };
      trace.push(event);
      const send = (value, code = 200) => {
        response.writeHead(code, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (path === "/internal/exact-review/heartbeat") return send({ ok: true });
      if (path === `/repos/${repo}/pulls/${number}`) return send({ head: { sha: head } });
      if (path === `/repos/${repo}/issues/${number}/labels/recovery`) {
        event.leasePresent = comments.some((entry) =>
          entry.body.includes("clawsweeper-review-status:started"),
        );
        return send({});
      }
      if (path === `/repos/${repo}/issues/${number}`) {
        closed = true;
        event.leasePresent = comments.some((entry) =>
          entry.body.includes("clawsweeper-review-status:started"),
        );
        return send({ state: "closed" });
      }
      if (path === `/repos/${repo}/issues/${number}/comments`) {
        if (request.method === "GET") {
          const snapshot = structuredClone(comments);
          if (race && !seen.has(role)) {
            seen.add(role);
            gates[role] = () => send(snapshot);
            initial[role].resolve();
            return;
          }
          return send(snapshot);
        }
        const entry = {
          id: nextId++,
          user: { login: "clawsweeper[bot]" },
          body: JSON.parse(body).body,
        };
        comments.push(entry);
        event.commentId = entry.id;
        return send(entry, 201);
      }
      const id = Number(path.split("/").at(-1)),
        entry = comments.find((value) => value.id === id);
      if (entry) {
        if (request.method === "DELETE") {
          comments.splice(comments.indexOf(entry), 1);
          event.commentId = id;
          return send({});
        }
        if (request.method === "PATCH") {
          entry.body = JSON.parse(body).body;
          event.commentId = id;
          event.bodyHash = hash(entry.body);
        }
        return send(entry);
      }
      send({ error: "unknown fixture route" }, 404);
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${server.address().port}`;
    const children = [];
    const start = (role) => {
      const ready = deferred(),
        done = deferred(),
        messages = [];
      const child = spawn(process.execPath, [process.argv[1], "--worker", role], {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: process.env.TMPDIR || tmpdir(),
          ...(process.env.PROOF_DIST_ROOT ? { PROOF_DIST_ROOT: process.env.PROOF_DIST_ROOT } : {}),
          LEASE_FIXTURE_URL: url,
          LEASE_ROLE: role,
          LEASE_CONTROL: join(root, `${name}-${role}`),
          GH_TOKEN: "synthetic-no-live-access",
          GH_BIN: process.execPath,
          GH_BIN_ARGS: JSON.stringify([proxy]),
          CURL_BIN: process.execPath,
          CURL_BIN_ARGS: JSON.stringify([proxy]),
          GITHUB_RUN_ID: role === "quiet" ? "42" : "1000",
          GITHUB_RUN_ATTEMPT: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let buffer = "",
        stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const message = JSON.parse(line);
          messages.push(message);
          if (message.stage === "ready") ready.resolve(message);
        }
      });
      child.on("close", (code) => {
        done.resolve({ code, messages, stderr });
        ready.resolve({ status: "failed", stderr });
      });
      const result = {
        child,
        ready: ready.promise,
        finish: (action) => {
          const control = join(root, `${name}-${role}`);
          writeFileSync(`${control}.pending`, action);
          renameSync(`${control}.pending`, control);
          return done.promise;
        },
      };
      children.push(child);
      return result;
    };
    try {
      if (name === "legacy-upgrade") {
        // An already-running legacy placeholder still loads through the CLI's
        // normal expiry operation, then the next reservation recovers its id.
        const { code, stderr } = await new Promise((done) => {
          const child = spawn(
            process.execPath,
            [
              resolve(process.env.PROOF_DIST_ROOT || "dist", "clawsweeper.js"),
              "expire-review-lease",
              "--repo",
              repo,
              "--item-number",
              String(number),
              "--comment-id",
              "900",
            ],
            {
              env: {
                PATH: process.env.PATH,
                HOME: root,
                GH_TOKEN: "synthetic-no-live-access",
                LEASE_FIXTURE_URL: url,
                LEASE_ROLE: "legacy",
                GH_BIN: process.execPath,
                GH_BIN_ARGS: JSON.stringify([proxy]),
                CURL_BIN: process.execPath,
                CURL_BIN_ARGS: JSON.stringify([proxy]),
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          children.push(child);
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("close", (code) => done({ code, stderr }));
        });
        assert.equal(code, 0, stderr);
        assert.ok(trace.some((event) => event.method === "PATCH" && event.commentId === 900));
      }
      const quiet = start("quiet");
      let separate, qReady, sReady;
      if (race) {
        await initial.quiet.promise;
        separate = start("separate");
        await initial.separate.promise;
        if (name === "post-before-patch") {
          gates.separate();
          sReady = await separate.ready;
          gates.quiet();
          qReady = await quiet.ready;
        } else {
          gates.quiet();
          qReady = await quiet.ready;
          gates.separate();
          sReady = await separate.ready;
        }
      } else qReady = await quiet.ready;
      const qDone = await quiet.finish(
        name === "adopt-publication-close" || race ? "publish" : "cleanup",
      );
      const sDone = separate ? await separate.finish("publish") : null;
      const record = {
        name,
        quiet: qReady,
        separate: sReady,
        quietResult: qDone,
        separateResult: sDone,
        closed,
        trace,
        final: comments.map((entry) => ({
          id: entry.id,
          bodyHash: hash(entry.body),
          body: entry.body,
        })),
      };
      writeFileSync(join(output, `${name}.json`), JSON.stringify(record, null, 2) + "\n");
      assert.equal(qDone.code, 0, qDone.stderr);
      if (race) {
        assert.equal(sReady.status, "posted", "uncoordinated POST owner must remain elected");
        assert.equal(sReady.leaseId, 1000);
        assert.equal(sDone.code, 0, sDone.stderr);
        assert.equal(sDone.messages.at(-1).status, "published-and-closed");
        assert.ok(
          ["blocked", "held"].includes(qDone.messages.at(-1).status),
          "quiet contender must yield before final comment I/O",
        );
        assert.equal(
          trace.filter((event) => event.method === "PATCH" && event.bodyHash === hash(completed))
            .length,
          1,
        );
      } else if (name === "adopt-publication-close") {
        assert.equal(qDone.messages.at(-1).status, "published-and-closed");
        assert.equal(closed, true);
        assert.ok(trace.filter((event) => event.leasePresent).length >= 2);
      } else {
        assert.equal(
          qDone.messages.at(-1).released,
          true,
          JSON.stringify({ name, ready: qReady, result: qDone }),
        );
        assert.equal(comments[0].body, original, "raw bytes survive acquisition and owner release");
      }
      assert.equal(comments.length, 1);
      if (race || name === "adopt-publication-close") assert.equal(comments[0].body, completed);
      if (name === "legacy-upgrade")
        assert.ok(trace.some((event) => event.commentId === 900 && event.method === "DELETE"));
      results.push({
        name,
        result: "passed",
        requests: trace.length,
        finalHash: hash(comments[0].body),
      });
      console.log(`PASS ${name} (${trace.length} loopback requests)`);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  }
  const sources = [
    "src/clawsweeper-review-comment-leases.ts",
    "src/clawsweeper-review-comment-publication.ts",
    "src/clawsweeper-apply-decision-workflow.ts",
    "src/clawsweeper-apply-lease-guards.ts",
    "src/repair/comment-router/admission.ts",
    "scripts/e2e/review-lease-lifecycle.mjs",
    "test/helpers.ts",
  ];
  const summary = {
    passed: results.length,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    provider: "local-loopback",
    image: null,
    lease: null,
    head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dist: process.env.PROOF_DIST_ROOT || "dist",
    sourceHashes: Object.fromEntries(sources.map((path) => [path, hash(readFileSync(path))])),
    results,
    limits:
      "Synthetic HTTP and source-defined policy fixtures; real built reservation, publisher, apply lease guards and close executor. No hosted queue, model generation, full apply orchestration, GitHub delivery, or email proof.",
  };
  writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`PASS ${results.length}/${results.length}; traces: ${output}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
