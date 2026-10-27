#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const self = fileURLToPath(import.meta.url);
const codeRoot = resolve(dirname(self), "../..");
const controllerPath = join(codeRoot, "scripts/prepare-exact-review-batch.mjs");
const timestamp = "2026-09-01T00:00:00.000Z";
const newerTimestamp = "2026-09-02T00:00:00.000Z";
const repos = ["OpenClaw/ClawSweeper", "OpenClaw/Some.Repo_Debug"];

function write(path, value) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, value);
}

function json(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function inventory(root, hashes = true) {
  if (!fs.existsSync(root)) return [];
  if (fs.statSync(root).isFile()) {
    return [
      {
        path: ".",
        bytes: fs.statSync(root).size,
        ...(hashes ? { sha256: digest(fs.readFileSync(root)) } : {}),
      },
    ];
  }
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return {
        path: relative(root, path).split("\\").join("/"),
        bytes: fs.statSync(path).size,
        ...(hashes ? { sha256: digest(fs.readFileSync(path)) } : {}),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function tuplePaths(repo, number) {
  const root = `records/${repo.toLowerCase().replace("/", "-")}`;
  return [
    `${root}/items/${number}.md`,
    `${root}/closed/${number}.md`,
    `${root}/plans/${number}.md`,
    `${root}/decision-packets/${number}.json`,
  ];
}

function member(repo, number, index) {
  const producerDecision = {
    targetRepo: repo,
    targetBranch: "main",
    itemNumber: number,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction: "opened",
  };
  return {
    itemKey: `${repo}#${number}@publish:${100 + index}:1`,
    revision: 1,
    claimGeneration: 1,
    outcomePath: `.artifacts/exact-review-batch/outcomes/${index}.json`,
    decision: {
      ...producerDecision,
      publication: {
        artifactName: `exact-review-${index}`,
        producerRunId: 100 + index,
        producerRunAttempt: 1,
        sourceSha: "a".repeat(40),
        itemKey: `${repo}#${number}`,
        protocolVersion: 2,
        leaseRevision: 1,
        claimGeneration: 1,
        liveProceeded: true,
        liveTerminalNoop: false,
        liveTerminalMissing: false,
        liveGuardedOpen: false,
        producerDecision,
      },
    },
  };
}

function report(repo, number, reviewedAt, packet = null) {
  return [
    "---",
    `repository: ${repo.toLowerCase()}`,
    `number: ${number}`,
    "type: issue",
    "title: Selected tuple fixture",
    `url: https://github.com/${repo.toLowerCase()}/issues/${number}`,
    "author: contributor",
    "author_association: CONTRIBUTOR",
    "labels: []",
    "review_status: complete",
    "local_checkout_access: verified",
    "local_checkout_access_source: runner_preflight_v1",
    "decision: close",
    "close_reason: implemented_on_main",
    "confidence: high",
    "action_taken: proposed_close",
    "work_candidate: none",
    "review_lease_owner: synthetic-review",
    "review_lease_comment_id: 700042",
    "item_snapshot_hash: reviewed-snapshot",
    `item_source_revision: sha256:${"a".repeat(64)}`,
    `item_created_at: ${timestamp}`,
    `item_updated_at: ${timestamp}`,
    `reviewed_at: ${reviewedAt}`,
    `decision_packet_path: ${packet ? tuplePaths(repo, number)[3] : "none"}`,
    `decision_packet_sha256: ${packet ? digest(packet) : "none"}`,
    "---",
    "",
    "## Summary",
    "",
    "Synthetic selected-publication fixture.",
    "",
  ].join("\n");
}

// Only canonical HTTP transport is simulated; hydration, validation and publication
// run through their real owners. Worker state is observed before controller cleanup.
function observeChildren() {
  const config = json(process.env.CSW_HYDRATION_PROOF_CONFIG);
  const entry = basename(process.argv[1] || "");
  const log = (value) => fs.appendFileSync(config.trace, `${JSON.stringify(value)}\n`, "utf8");
  if (entry === "clawsweeper.js" || entry === "publish-event-result.js") {
    const Clock = Date;
    globalThis.Date = class extends Clock {
      constructor(...args) {
        super(...(args.length ? args : ["2026-09-03T00:00:00.000Z"]));
      }
      static now() {
        return Clock.parse("2026-09-03T00:00:00.000Z");
      }
    };
  }
  if (entry === "prepare-exact-review-batch.mjs" && process.argv[2] === "worker") {
    const item = json(process.argv[3]);
    const root = process.argv[4];
    const selected = new Set(tuplePaths(item.decision.targetRepo, item.decision.itemNumber));
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      assert.equal(url.origin, "https://canonical.invalid");
      if (url.pathname === "/internal/exact-review/artifact-cache/receipt/lookup") {
        return Response.json({ hit: false });
      }
      if (url.pathname.startsWith("/internal/state/blobs/")) {
        return Response.json({ error: "fixture_cache_unavailable" }, { status: 403 });
      }
      assert.equal(request.method, "GET");
      assert.equal(
        request.headers.get("x-clawsweeper-exact-review-signature"),
        `sha256=${createHmac("sha256", "synthetic-hydration-secret").update("").digest("hex")}`,
      );
      const match =
        /^\/internal\/state\/records\/([^/]+)\/(items|closed|plans|decision-packets)\/(\d+)$/.exec(
          url.pathname,
        );
      assert.ok(match, `broad canonical read: ${url.pathname}`);
      const [, slug, section, number] = match;
      const path = `records/${slug}/${section}/${number}.${section === "decision-packets" ? "json" : "md"}`;
      assert.ok(selected.has(path), `unselected canonical read: ${path}`);
      log({ kind: "canonical-read", itemKey: item.itemKey, path });
      if (config.mode === "read-timeout" && item.decision.itemNumber === 42) {
        await new Promise(() => setInterval(() => {}, 1000));
      }
      if (config.mode === "forbidden" && item.decision.itemNumber === 42) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      const record = join(config.canonical, path);
      if (!fs.existsSync(record))
        return Response.json({ error: "record_not_found" }, { status: 404 });
      const content = fs.readFileSync(record, "utf8");
      return Response.json({
        content,
        digest:
          config.mode === "corrupt" && item.decision.itemNumber === 42
            ? "0".repeat(64)
            : digest(content),
        revision: 1,
      });
    };
    let observed = false;
    const observe = () => {
      if (observed) return;
      observed = true;
      log({
        kind: "worker",
        itemKey: item.itemKey,
        files: inventory(join(root, "records")),
        gitPresent: fs.existsSync(join(root, ".git")),
      });
    };
    const mkdir = fs.mkdirSync;
    fs.mkdirSync = (path, ...args) => {
      // Bundle acquisition starts immediately after canonical hydration, before
      // the real publisher mutates the isolated tuple.
      if (path === join(root, "bundles", String(item.decision.itemNumber))) observe();
      return mkdir(path, ...args);
    };
    syncBuiltinESMExports();
    process.on("exit", observe);
  } else if (entry === "publish-event-result.js") {
    const exists = fs.existsSync;
    let advanced = false;
    const workRoot = process.cwd();
    const number = Number(process.env.ITEM_NUMBER);
    const selected = tuplePaths(process.env.TARGET_REPO, number);
    fs.existsSync = (path) => {
      if (
        number >= 44 &&
        !advanced &&
        String(path).startsWith(join(workRoot, "records") + "/") &&
        exists(join(workRoot, ".artifacts/event-record-snapshot/candidate/items", `${number}.md`))
      ) {
        // Model a concurrent canonical winner after the candidate was captured,
        // before the publisher's real preflight reads the current tuple.
        advanced = true;
        for (const record of selected) {
          fs.rmSync(join(workRoot, record), { force: true });
          if (exists(join(config.canonical, record))) {
            write(join(workRoot, record), fs.readFileSync(join(config.canonical, record)));
          }
        }
        log({ kind: "remote-winner", itemKey: process.env.EXACT_REVIEW_BATCH_ITEM_KEY });
      }
      return exists(path);
    };
    syncBuiltinESMExports();
    process.on("exit", () => {
      log({
        kind: "publisher",
        itemKey: process.env.EXACT_REVIEW_BATCH_ITEM_KEY,
        base: inventory(join(process.cwd(), ".artifacts/event-record-snapshot/base")),
        actions: fs.existsSync(join(process.cwd(), ".artifacts/event-apply-report.json"))
          ? json(join(process.cwd(), ".artifacts/event-apply-report.json"))
          : [],
      });
    });
  }
}

export function fixtureGh() {
  const config = json(process.env.CSW_HYDRATION_PROOF_CONFIG);
  const raw = process.argv.slice(2);
  const args = raw[0] === "--repo" ? raw.slice(2) : raw;
  const log = (value) => fs.appendFileSync(config.trace, `${JSON.stringify(value)}\n`, "utf8");
  const waitFor = (path) => {
    const deadline = Date.now() + 25_000;
    while (!fs.existsSync(path)) {
      if (Date.now() >= deadline) throw new Error("mixed circuit proof handshake timed out");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  };
  if (args[0] === "run" && args[1] === "download") {
    const bundleDir = args[args.indexOf("--dir") + 1];
    const artifact = args[args.indexOf("--name") + 1];
    log({ kind: "download", artifact, token: process.env.GH_TOKEN });
    if (config.mode === "mixed-circuit" && artifact === "exact-review-0") {
      waitFor(join(config.workspace, "second-download-started"));
      console.error("API rate limit exceeded");
      process.exitCode = 1;
    } else if (config.mode === "mixed-circuit" && artifact === "exact-review-1") {
      write(join(config.workspace, "second-download-started"), "ready");
      waitFor(join(config.workspace, "rate-status-pending"));
      fs.cpSync(join(config.bundles, artifact), bundleDir, { recursive: true });
    } else if (config.mode === "circuit") {
      console.error("API rate limit exceeded");
      process.exitCode = 1;
    } else if (config.mode === "artifact-unavailable") {
      console.error("synthetic artifact unavailable");
      process.exitCode = 1;
    } else {
      fs.cpSync(join(config.bundles, artifact), bundleDir, { recursive: true });
    }
    return;
  }
  if (args[0] === "api" && args[1] === "rate_limit") {
    log({ kind: "rate-status" });
    if (config.mode === "mixed-circuit") {
      write(join(config.workspace, "rate-status-pending"), "ready");
      waitFor(join(config.workspace, ".artifacts/exact-review-batch/outcomes/2.json"));
    }
    console.log(JSON.stringify({ remaining: 0, reset: Math.ceil(Date.now() / 1000) + 3600 }));
    return;
  }
  const path = args[1] === "-i" ? args[2] : args[1];
  log({ kind: "github", args });
  const match = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(path || "");
  if (args[0] === "api" && match && !args.includes("-X") && !args.includes("--method")) {
    console.log(
      JSON.stringify({
        number: Number(match[2]),
        title: "Selected tuple fixture",
        html_url: `https://github.com/${match[1]}/issues/${match[2]}`,
        body: "Synthetic fixture",
        created_at: timestamp,
        updated_at: timestamp,
        closed_at: null,
        state: "open",
        locked: true,
        author_association: "CONTRIBUTOR",
        user: { login: "contributor" },
        labels: [],
        comments: 0,
      }),
    );
    return;
  }
  if (args[0] === "api" && /\/(comments|timeline)(?:\?|$)/.test(path || "")) {
    console.log(args.includes("-i") ? "HTTP/2 200\n\n[]" : "[[]]");
    return;
  }
  throw new Error(`unexpected synthetic GitHub operation: ${JSON.stringify(args)}`);
}

export function runHydrationProof({
  unrelatedRecords = 128,
  bytesPerRecord = 3582,
  mode = "publication",
  invalidDecision,
  concurrency = 1,
} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "selected-tuple-proof-")));
  try {
    const workspace = join(root, "workspace");
    const canonical = join(root, "canonical");
    const trace = join(root, "trace.jsonl");
    const bundles = join(root, "bundles");
    const configPath = join(root, "config.json");
    const items = repos.flatMap((repo) =>
      [42, 43, 44, 45].map((number) => member(repo, number, repos.indexOf(repo) * 4 + number - 42)),
    );
    if (invalidDecision) {
      items.splice(1);
      Object.assign(items[0].decision, invalidDecision);
    }
    write(trace, "");
    write(configPath, JSON.stringify({ workspace, canonical, trace, bundles, mode }));
    fs.mkdirSync(workspace, { recursive: true });
    fs.cpSync(join(codeRoot, "dist"), join(workspace, "dist"), { recursive: true });
    for (const path of ["node_modules", "config", "prompts", "schema"]) {
      fs.symlinkSync(join(codeRoot, path), join(workspace, path), "dir");
    }
    write(join(workspace, "package.json"), '{"type":"module"}\n');
    write(join(workspace, "manifest.json"), JSON.stringify({ items }));
    write(
      join(root, "bin/gh"),
      `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(self).href)}).then((m) => m.fixtureGh());\n`,
    );
    fs.chmodSync(join(root, "bin/gh"), 0o755);
    if (mode === "file-source") {
      write(join(workspace, "records"), "not a hydrated records directory\n");
    }
    {
      fs.mkdirSync(join(canonical, "records"), { recursive: true });
      for (const repo of repos) {
        for (const number of [42, 43, 44]) {
          const paths = tuplePaths(repo, number);
          const reviewedAt = number === 44 ? newerTimestamp : timestamp;
          const packet =
            number === 42
              ? `${JSON.stringify({
                  version: 1,
                  generatedAt: reviewedAt,
                  subject: { repo: repo.toLowerCase(), number },
                  source: { reportPath: paths[0], reviewedAt },
                })}\n`
              : null;
          write(join(canonical, paths[0]), report(repo, number, reviewedAt, packet));
          if (packet) {
            write(join(canonical, paths[2]), `---\nreviewed_at: ${reviewedAt}\n---\nPlan\n`);
            write(join(canonical, paths[3]), packet);
          }
        }
        write(
          join(canonical, tuplePaths(repo, 45)[1]),
          report(repo, 45, newerTimestamp).replace(
            "action_taken: proposed_close",
            `action_taken: closed\nreconciled_at: ${newerTimestamp}`,
          ),
        );
      }
      for (let index = 0; index < unrelatedRecords; index++) {
        write(
          join(canonical, tuplePaths(repos[index % 2], 100000 + index)[1]),
          Buffer.alloc(bytesPerRecord, 65 + (index % 26)),
        );
      }
    }
    const before = inventory(join(canonical, "records"));
    const localBefore = inventory(join(workspace, "records"));
    if (mode === "heartbeat") {
      write(join(workspace, ".artifacts/exact-review-batch/heartbeat-failed"), "expired\n");
    }
    if (!["artifact-unavailable", "heartbeat", "circuit"].includes(mode) && !invalidDecision) {
      const bundleModule = join(codeRoot, "dist/repair/exact-review-bundle.js");
      // Bundle creation uses the compiled owner, just like the producer.
      const create = `
        const { createExactReviewBundle, exactReviewDecisionSha256 } = await import(${JSON.stringify(pathToFileURL(bundleModule).href)});
        const items = ${JSON.stringify(items)};
        for (const [index, item] of items.entries()) {
          const p = item.decision.publication;
          createExactReviewBundle({
            bundleDir: ${JSON.stringify(bundles)} + "/" + p.artifactName,
            reviewPath: ${JSON.stringify(root)} + "/reports/" + index + ".md",
            createdAt: ${JSON.stringify(newerTimestamp)},
            context: {
              repository: "openclaw/clawsweeper", sourceSha: p.sourceSha,
              runId: String(p.producerRunId), runAttempt: 1, producerJob: "event-review-apply",
              decisionSha256: exactReviewDecisionSha256(JSON.stringify(p.producerDecision)),
              targetRepo: item.decision.targetRepo, targetBranch: "main",
              itemNumber: item.decision.itemNumber, itemKind: "issue",
              itemKey: p.itemKey, protocolVersion: 2, leaseRevision: 1, claimGeneration: 1,
              liveProceeded: true, liveTerminalNoop: false,
              liveTerminalMissing: false, liveGuardedOpen: false
            }
          });
        }`;
      for (const [index, item] of items.entries()) {
        write(
          join(root, "reports", `${index}.md`),
          report(
            item.decision.targetRepo,
            item.decision.itemNumber,
            item.decision.itemNumber < 44 ? newerTimestamp : timestamp,
          ),
        );
      }
      execFileSync(process.execPath, ["--input-type=module", "-e", create], {
        encoding: "utf8",
      });
    }
    const start = performance.now();
    const result = spawnSync(process.execPath, [controllerPath], {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: {
        PATH: `${join(root, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: root,
        TMPDIR: root,
        NODE_OPTIONS: `--import=${pathToFileURL(self).href}`,
        CSW_HYDRATION_PROOF_CONFIG: configPath,
        EXACT_REVIEW_QUEUE_URL: "https://canonical.invalid",
        CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-hydration-secret",
        ...(mode === "read-timeout" ? { EXACT_REVIEW_BATCH_ITEM_TIMEOUT_MS: "2000" } : {}),
        GITHUB_WORKSPACE: workspace,
        GITHUB_REPOSITORY: "openclaw/clawsweeper",
        REPO_TOKEN: "synthetic-fixture-token",
        // Artifact downloads must replace the ambient target token with REPO_TOKEN.
        GH_TOKEN: "ambient-target-token",
        EXACT_REVIEW_BATCH_MANIFEST: join(workspace, "manifest.json"),
        EXACT_REVIEW_BATCH_PREPARE_CONCURRENCY: String(concurrency),
        GITHUB_OUTPUT: join(root, "github-output"),
      },
    });
    const wallMs = performance.now() - start;
    const diagnostics = `${result.stdout}\n${result.stderr}`
      .replaceAll(root, "<fixture>")
      .replaceAll(codeRoot, "<checkout>");
    assert.equal(result.error, undefined, diagnostics);
    assert.equal(result.status, mode === "heartbeat" ? 1 : 0, diagnostics);
    const events = fs
      .readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    assert.ok(
      events
        .filter((event) => event.kind === "download")
        .every((event) => event.token === "synthetic-fixture-token"),
      "artifact downloads must use the repository token",
    );
    const memberOrder = new Map(items.map((item, index) => [item.itemKey, index]));
    const byMember = (left, right) =>
      memberOrder.get(left.itemKey) - memberOrder.get(right.itemKey);
    const workers = events.filter((event) => event.kind === "worker").sort(byMember);
    const publishers = events.filter((event) => event.kind === "publisher").sort(byMember);
    const outcomes = items.map((item) => json(join(workspace, item.outcomePath)));
    const telemetry = json(join(workspace, ".artifacts/exact-review-batch/prepare-telemetry.json"));
    assert.deepEqual(inventory(join(workspace, "records")), localBefore);
    assert.deepEqual(inventory(join(canonical, "records")), before);
    assert.deepEqual(fs.readdirSync(join(workspace, ".artifacts/exact-review-batch/workers")), []);
    const reads = events.filter((event) => event.kind === "canonical-read");
    if (mode === "heartbeat" || invalidDecision) {
      assert.equal(reads.length, 0, "rejected members must not read canonical records");
      assert.equal(events.filter((event) => event.kind === "download").length, 0);
      for (const outcome of outcomes) {
        assert.deepEqual(outcome, { kind: "retryable_failure", reasonCode: "unknown_failure" });
      }
    } else {
      const failedRead = ["forbidden", "corrupt", "read-timeout"].includes(mode);
      assert.equal(workers.length, items.length - (mode === "read-timeout" ? 2 : 0), diagnostics);
      for (const worker of workers) {
        const item = items.find((item) => item.itemKey === worker.itemKey);
        const selected = new Set(tuplePaths(item.decision.targetRepo, item.decision.itemNumber));
        const expected =
          failedRead && item.decision.itemNumber === 42
            ? []
            : before.filter((file) => selected.has(`records/${file.path}`));
        assert.deepEqual(worker.files, expected, "only selected bytes may enter the worker");
        assert.equal(worker.gitPresent, false);
      }
      for (const [index, item] of items.entries()) {
        const selectedReads = reads.filter((event) => event.itemKey === item.itemKey);
        assert.equal(selectedReads.length, failedRead && item.decision.itemNumber === 42 ? 1 : 4);
        if (failedRead && item.decision.itemNumber === 42) {
          assert.equal(outcomes[index].kind, "retryable_failure");
          assert.equal(outcomes[index].reasonCode, "unknown_failure");
          assert.ok(!publishers.some((entry) => entry.itemKey === item.itemKey));
        }
      }
      if (mode === "read-timeout") assert.equal(telemetry.timeouts, 2);
      if (mode === "publication" || mode === "file-source") {
        assert.equal(publishers.length, items.length, diagnostics);
        for (const [index, publisher] of publishers.entries()) {
          const item = items[index];
          const selected = tuplePaths(item.decision.targetRepo, item.decision.itemNumber);
          const expected = before
            .filter((file) => selected.includes(`records/${file.path}`))
            .map((file) => ({ ...file, path: file.path.split("/").slice(1).join("/") }));
          assert.deepEqual(publisher.base, expected, "publisher must capture the hydrated base");
          if (item.decision.itemNumber >= 44) {
            assert.deepEqual(
              outcomes[index],
              {
                kind: "superseded",
                disposition: { requeueLatestExpected: item.decision.itemNumber === 44 },
              },
              diagnostics,
            );
            assert.deepEqual(publisher.actions, []);
          } else {
            assert.equal(outcomes[index].kind, "eligible", diagnostics);
            assert.equal(outcomes[index].disposition.requeueLatestExpected, true);
            assert.equal(publisher.actions[0]?.action, "skipped_changed_since_review");
            assert.deepEqual(
              outcomes[index].plan.operations.map((operation) => operation.path).sort(),
              [...selected].sort(),
            );
          }
        }
      }
      if (mode === "artifact-unavailable") {
        assert.ok(
          outcomes.every(
            (outcome) =>
              outcome.kind === "retryable_failure" && outcome.reasonCode === "artifact_unavailable",
          ),
        );
        assert.equal(publishers.length, 0);
      } else if (mode === "mixed-circuit") {
        assert.equal(events.filter((event) => event.kind === "download").length, 2);
        assert.equal(events.filter((event) => event.kind === "rate-status").length, 1);
        assert.equal(outcomes[0].attempted, true);
        assert.equal(outcomes[0].rateLimitAuthoritative, true);
        assert.equal(outcomes[1].kind, "eligible");
        assert.ok(outcomes.slice(2).every((outcome) => outcome.attempted === false));
        assert.equal(telemetry.collapsed, 6);
        assert.equal(publishers.length, 1);
      } else if (mode === "circuit") {
        const downloads = events.filter((event) => event.kind === "download").length;
        assert.ok(downloads >= 1 && downloads <= concurrency);
        assert.equal(events.filter((event) => event.kind === "rate-status").length, 1);
        assert.equal(outcomes.filter((outcome) => outcome.attempted === true).length, downloads);
        assert.ok(outcomes.slice(concurrency).every((outcome) => outcome.attempted === false));
        assert.ok(outcomes.every((outcome) => outcome.reasonCode === "github_rate_limit"));
        assert.equal(telemetry.collapsed, items.length - downloads);
      }
    }
    assert.ok(
      events
        .filter((event) => event.kind === "github")
        .every(
          (event) =>
            event.args[0] === "api" &&
            !event.args.includes("--method") &&
            !event.args.includes("-X") &&
            !event.args.some((argument) => ["PATCH", "POST", "PUT", "DELETE"].includes(argument)),
        ),
      "guarded fixtures must not mutate GitHub",
    );
    return {
      mode,
      unrelatedRecords,
      sourceFiles: before.length,
      sourceBytes: before.reduce((sum, file) => sum + file.bytes, 0),
      hydratedFiles: workers.reduce((sum, worker) => sum + worker.files.length, 0),
      hydratedBytes: workers.reduce(
        (sum, worker) => sum + worker.files.reduce((bytes, file) => bytes + file.bytes, 0),
        0,
      ),
      wallMs,
      telemetry,
      outcomes: outcomes.map(({ kind, reasonCode, disposition }) => ({
        kind,
        ...(reasonCode ? { reasonCode } : {}),
        ...(disposition ? { disposition } : {}),
      })),
      plans: outcomes.map((outcome) => outcome.plan ?? null),
      actions: publishers.map((publisher) => publisher.actions),
      publisherCount: publishers.length,
      selectedHashesVerified: true,
      sourceHashesVerified: true,
      sourceInventoryUnchanged: true,
      externalPublication: false,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  assert.equal(process.argv.length, 2, "this fixture takes no arguments");
  console.log(JSON.stringify(runHydrationProof(), null, 2));
}

if (process.env.CSW_HYDRATION_PROOF_CONFIG && resolve(process.argv[1] || "") !== self) {
  observeChildren();
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
