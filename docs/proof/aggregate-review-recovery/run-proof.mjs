import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { baselineSha, targetRepo, digest, producerEnv, fixtureIssue } from "./fixture.mjs";

const repo = resolve(import.meta.dirname, "../../..");
const baseline = process.argv.includes("--baseline");
const source = baseline
  ? execFileSync("git", ["show", `${baselineSha}:.github/workflows/sweep.yml`], {
      cwd: repo,
      encoding: "utf8",
    })
  : readFileSync(join(repo, ".github/workflows/sweep.yml"), "utf8");
const workflow = YAML.parse(source);
const temp = realpathSync(mkdtempSync(join(tmpdir(), "review-recovery-proof-")));
const secret = "synthetic-recovery-proof-only";
const receipt = {
  baseline,
  baseline_sha: baselineSha,
  head_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  workflow_sha256: digest(source),
  fixture_sha256: digest(readFileSync(join(import.meta.dirname, "fixture.mjs"))),
  harness_sha256: digest(readFileSync(import.meta.filename)),
  recovery_source_sha256: digest(readFileSync(join(repo, "src/review-recovery.ts"))),
  scenarios: [],
};

async function scenario(kind, ack = "accepted") {
  const root = join(temp, `${kind}-${ack}`);
  mkdirSync(root, { recursive: true });
  const produced = await run(
    process.execPath,
    [
      join(import.meta.dirname, "fixture.mjs"),
      "--produce-failure",
      join(root, "review-producer"),
      kind,
    ],
    {
      cwd: repo,
      env: { PATH: process.env.PATH, HOME: root },
    },
  );
  assert.equal(produced.code, 79, produced.stderr);
  const seeded = JSON.parse(produced.stdout);
  for (const name of ["dist", "config", "schema", "prompts", "package.json"]) {
    cpSync(join(repo, name), join(root, name), { recursive: true });
  }
  for (const name of ["yaml", "yauzl"]) {
    cpSync(realpathSync(join(repo, "node_modules", name)), join(root, "node_modules", name), {
      recursive: true,
    });
  }
  cpSync(seeded.ledgerDir, join(root, "recovery-ledgers/action-ledger-review-0"), {
    recursive: true,
  });
  const requests = [];
  const failures = [];
  const comments = new Map();
  const recordKeys = new Set();
  const blobs = new Map();
  const provePublication =
    !baseline && ack === "accepted" && ["mixed", "late-completed"].includes(kind);
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      if (request.url === "/gh") {
        const input = JSON.parse(raw);
        const args = input.args[0] === "--repo" ? input.args.slice(2) : input.args;
        const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1];
        const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
        const number = path?.match(/^repos\/openclaw\/clawsweeper\/issues\/([12])(?:\/|\?|$)/)?.[1];
        const issue = {
          ...fixtureIssue(number),
          comments: (comments.get(number) ?? []).length,
        };
        let value;
        if (args[0] === "api" && number && /\/issues\/[12]$/.test(path) && method === "GET") {
          value = issue;
        } else if (
          provePublication &&
          args[0] === "api" &&
          number &&
          /\/comments(?:\?|$)/.test(path)
        ) {
          const rows = comments.get(number) ?? [];
          if (method === "POST") {
            value = {
              id: 9000 + Number(number),
              body: input.payload.body,
              user: { login: "clawsweeper[bot]" },
              created_at: producerEnv.GITHUB_RUN_STARTED_AT,
              updated_at: producerEnv.GITHUB_RUN_STARTED_AT,
              html_url: `https://github.com/${targetRepo}/issues/${number}#issuecomment-${9000 + Number(number)}`,
            };
            rows.push(value);
            comments.set(number, rows);
          } else {
            assert.equal(method, "GET");
            value = args.includes("--slurp") ? [rows] : rows;
          }
        } else if (
          provePublication &&
          args[0] === "api" &&
          number &&
          /\/timeline(?:\?|$)/.test(path)
        ) {
          assert.equal(method, "GET");
          value = args.includes("--slurp") ? [[]] : [];
        } else if (provePublication && args[0] === "api" && path.startsWith("search/issues?")) {
          assert.equal(method, "GET");
          value = { total_count: 0, items: [] };
        } else if (
          provePublication &&
          args[0] === "api" &&
          /\/collaborators\/reporter\/permission$/.test(path)
        ) {
          assert.equal(method, "GET");
          value = { permission: "read" };
        } else if (provePublication && args[0] === "issue" && args[1] === "view") {
          value = { closedByPullRequestsReferences: [] };
        } else if (provePublication && args[0] === "label" && args[1] === "create") {
          value = { name: args[2] };
        } else if (provePublication && args[0] === "issue" && args[1] === "edit") {
          value = "";
        } else assert.fail("unexpected publisher GitHub command");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ stdout: typeof value === "string" ? value : JSON.stringify(value) }),
        );
        return;
      }
      assert.equal(
        request.headers["x-clawsweeper-exact-review-signature"],
        `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
      );
      if (
        [
          "/internal/state/github-read-model/item",
          "/internal/state/github-read-model/repair",
        ].includes(request.url)
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, usable: false, hit: false }));
        return;
      }
      if (provePublication && request.url === "/internal/state/records/tuples") {
        const body = JSON.parse(raw);
        assert.match(body.key, /^openclaw-clawsweeper\/[12]$/);
        recordKeys.add(body.key);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, revision: 1, deduped: false }));
        return;
      }
      if (provePublication && request.url === "/internal/state/blobs/put") {
        const body = JSON.parse(raw);
        assert.equal(digest(Buffer.from(body.contentBase64, "base64")), body.digest);
        const prior = blobs.get(body.path);
        assert.ok(!prior || prior === body.digest, "receipt replay must be immutable");
        blobs.set(body.path, body.digest);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ unchanged: prior === body.digest }));
        return;
      }
      assert.equal(request.url, "/internal/exact-review/enqueue");
      const body = JSON.parse(raw);
      assert.equal(body.decision.supersedesInProgress, false);
      assert.equal(
        body.delivery_id,
        `router:failed-review-recovery-123456-1-${body.decision.itemNumber}`,
      );
      requests.push(body.decision.itemNumber);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          {
            accepted: { ok: true, queued: true },
            deduped: { ok: true, deduped: true },
            shed: { ok: true, shed: true },
            disabled: { ok: true, accepted: false },
            failed: { ok: false },
          }[ack],
        ),
      );
    } catch (error) {
      failures.push(error.message);
      response.writeHead(500).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    mkdirSync(join(root, "failed-review-shards"));
    writeFileSync(join(root, "failed-review-shards/shard-0.json"), '{"shard":0}');
    const values = {
      "needs.plan.outputs.target_repo": targetRepo,
      "needs.plan.outputs.target_branch": "main",
      "needs.plan.outputs.codex_timeout_ms": "1200000",
      "needs.plan.outputs.planned_shards": "1",
      "matrix.shard": "0",
    };
    const command = workflow.jobs["recover-review-failures"].steps.find((step) =>
      step.name?.startsWith("Requeue "),
    );
    assert.ok(command);
    const resolveScript = (text) =>
      text.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, key) => {
        assert.ok(key in values, `unbound workflow expression: ${key}`);
        return values[key];
      });
    const script = resolveScript(command.run);
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      ...producerEnv,
      GH_TOKEN: "synthetic",
      QUEUE_URL: endpoint,
      PROOF_ENDPOINT: endpoint,
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
      ADDITIONAL_PROMPT: "",
      MATRIX_JSON: JSON.stringify([{ shard: 0, item_numbers: seeded.planned.join(",") }]),
      GITHUB_STEP_SUMMARY: join(root, "summary.md"),
      NODE_OPTIONS: `--import=${join(repo, "docs/proof/review-publisher-ledger-isolation/local-transport.mjs")}`,
      GH_BIN: process.execPath,
      GH_BIN_ARGS: JSON.stringify([
        join(repo, "docs/proof/review-publisher-ledger-isolation/local-transport.mjs"),
      ]),
    };
    if (kind === "foreign-attempt") env.GITHUB_RUN_ATTEMPT = "2";
    if (kind === "foreign-sha") env.GITHUB_SHA = "a".repeat(40);
    const holdAll = [
      "filtered",
      "foreign-attempt",
      "foreign-sha",
      "missing",
      "incomplete",
      "wrong-shard",
      "missing-terminal",
      "foreign-batch",
    ].includes(kind);
    let staged = [];
    if (!baseline) {
      cpSync(seeded.ledgerDir, join(root, "runner/clawsweeper-action-ledger/123456/1/review"), {
        recursive: true,
      });
      cpSync(seeded.reports, join(root, "review-artifacts/shard-0"), { recursive: true });
      mkdirSync(join(root, "clawsweeper"));
      for (const name of ["dist", "config", "node_modules", "package.json"]) {
        cpSync(join(root, name), join(root, "clawsweeper", name), { recursive: true });
      }
      const prefix = workflow.jobs.review.steps.find((entry) => entry.id === "completed-prefix");
      assert.ok(prefix);
      const result = await run("bash", ["-e", "-o", "pipefail", "-c", resolveScript(prefix.run)], {
        cwd: join(root, "clawsweeper"),
        env: {
          ...env,
          RUNNER_TEMP: join(root, "runner"),
          TARGET_REPO: targetRepo,
          ITEM_NUMBERS: seeded.planned.join(","),
        },
      });
      assert.equal(result.code, 0, result.stderr);
      const stagedDir = join(root, "review-artifacts/completed-0");
      staged = existsSync(stagedDir) ? readdirSync(stagedDir).sort() : [];
      assert.deepEqual(
        staged,
        holdAll
          ? []
          : ["late-completed", "report-identity", "report-digest"].includes(kind)
            ? ["2.md"]
            : ["1.md", "2.md"],
      );
      for (const filename of staged) {
        assert.equal(
          readFileSync(join(stagedDir, filename), "utf8"),
          readFileSync(join(seeded.reports, filename), "utf8"),
        );
      }
      // The real apply-artifacts CLI, not an alternate copy path, consumes the retained prefix.
      if (staged.length) {
        mkdirSync(join(root, ".artifacts/baseline"), { recursive: true });
        mkdirSync(join(root, "publisher-ledger"));
        const publisherEnv = {
          ...env,
          GITHUB_JOB: "publish",
          CLAWSWEEPER_ACTION_LEDGER_FORCE: provePublication ? "1" : "0",
          CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: join(root, "publisher-ledger"),
          CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR: join(root, ".artifacts/baseline"),
        };
        const publishReceipt = async (name) => {
          const priorBlobCount = blobs.size;
          const step = workflow.jobs.publish.steps.find((entry) => entry.name === name);
          assert.ok(step);
          const cli =
            'pnpm() { shift; [ "$1" = "--silent" ] && shift; local command="$1"; shift; [ "${1:-}" = "--" ] && shift; node dist/clawsweeper.js "$command" "$@"; }';
          const outcome = await run("bash", ["-e", "-o", "pipefail", "-c", `${cli}\n${step.run}`], {
            cwd: root,
            env: publisherEnv,
          });
          assert.equal(outcome.code, 0, outcome.stderr);
          assert.ok(blobs.size > priorBlobCount, `${name} must publish its own required receipts`);
        };
        const applied = await run(
          process.execPath,
          [
            "dist/clawsweeper.js",
            "apply-artifacts",
            "--artifact-dir",
            stagedDir,
            "--target-repo",
            targetRepo,
            "--skip-dashboard",
            "--skip-reconcile",
          ],
          { cwd: root, env: publisherEnv },
        );
        assert.equal(applied.code, 0, applied.stderr);
        if (provePublication) await publishReceipt("Publish review artifact action ledger");
        const reconciled = await run(
          process.execPath,
          [
            "dist/clawsweeper.js",
            "reconcile",
            "--target-repo",
            targetRepo,
            "--item-numbers",
            staged.map((name) => name.slice(0, -3)).join(","),
            "--only-item-numbers",
            "--skip-closed-at",
          ],
          { cwd: root, env: publisherEnv },
        );
        assert.equal(reconciled.code, 0, reconciled.stderr);
        assert.deepEqual(
          readdirSync(join(root, "records/openclaw-clawsweeper/items"))
            .filter((name) => name.endsWith(".md"))
            .sort(),
          staged,
        );
        if (provePublication) {
          const committed = await run(
            process.execPath,
            [
              "dist/repair/publish-main.js",
              "--message",
              "proof completed prefix",
              "--path",
              "records/openclaw-clawsweeper",
              "--rebase-strategy",
              "normal",
            ],
            { cwd: root, env: publisherEnv },
          );
          assert.equal(committed.code, 0, committed.stderr);
          assert.deepEqual(
            [...recordKeys].sort(),
            staged.map((name) => `openclaw-clawsweeper/${name.slice(0, -3)}`),
          );
          const synced = await run(
            process.execPath,
            [
              "dist/clawsweeper.js",
              "apply-decisions",
              "--target-repo",
              targetRepo,
              "--skip-dashboard",
              "--item-numbers",
              staged.map((name) => name.slice(0, -3)).join(","),
              "--sync-comments-only",
              "--apply-kind",
              "all",
              "--limit",
              "0",
              "--processed-limit",
              String(staged.length),
              "--comment-sync-min-age-days",
              "0",
            ],
            { cwd: root, env: publisherEnv },
          );
          assert.equal(synced.code, 0, synced.stderr);
          assert.deepEqual(
            [...comments.keys()].sort(),
            staged.map((name) => name.slice(0, -3)),
            `${synced.stderr}\n${readFileSync(join(root, "apply-report.json"), "utf8")}`,
          );
          assert.ok([...comments.values()].every((rows) => rows.length === 1));
          await publishReceipt("Publish selected review comment action ledger");
          assert.ok(blobs.size > 0, "required publisher receipt blobs reached the signed endpoint");
        }
      }
    }
    const child = spawn("bash", ["-e", "-o", "pipefail", "-c", script], {
      cwd: root,
      env,
      timeout: 90_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.deepEqual(failures, []);
    assert.equal(code, ack === "failed" ? 1 : 0, stderr);
    const intended = holdAll
      ? []
      : ["mutation-only", "unsupported", "ambiguous"].includes(kind)
        ? [4]
        : kind === "receipt-reason"
          ? [3]
          : [3, 4];
    const unique = [...new Set(requests)].sort((a, b) => a - b);
    if (baseline) {
      assert.deepEqual(unique, seeded.planned);
      assert.ok(
        unique.includes(kind === "filtered" ? 1 : 7),
        "original must enqueue terminal refusal",
      );
    } else {
      assert.deepEqual(unique, intended, "only native retryable item terminals may enqueue");
      assert.equal(requests.length, intended.length * (ack === "failed" ? 3 : 1));
      const summary = readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
      assert.match(
        summary,
        /Review step failed; retained reports still require normal publisher guards/,
      );
      if (intended.length) {
        const message = {
          accepted: "recovery admission queued",
          deduped: "recovery admission deduplicated",
          shed: "Recovery shed by exact-review queue backpressure",
          disabled: "Recovery skipped because the target is disabled",
          failed: "Unable to queue failed review recovery for item numbers: 3 4",
        }[ack];
        assert.ok(summary.includes(message), "the actual acknowledgement remains operator-visible");
      }
    }
    receipt.scenarios.push({
      kind,
      acknowledgement: ack,
      planned: seeded.planned,
      selected: seeded.selected,
      original_review_exit: produced.code,
      recovery_exit: code,
      requests,
      retained_reports: staged,
      published_records: [...recordKeys].sort(),
      published_comments: [...comments.keys()].sort(),
      required_receipt_blobs: blobs.size,
      original_failure_visible: baseline ? "producer exit only" : true,
      terminal_exclusion: baseline ? "FAIL (intended baseline)" : "PASS",
    });
    console.error(
      `${baseline ? "baseline" : "candidate"} ${kind}/${ack}: ${requests.length} requests, ${staged.length} retained reports`,
    );
    return { root, seeded, stdout, stderr };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function run(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

try {
  await scenario("mixed");
  await scenario("filtered");
  if (!baseline) {
    for (const ack of ["deduped", "shed", "disabled", "failed"]) await scenario("mixed", ack);
    for (const kind of [
      "late-completed",
      "unmatched",
      "accepted-mutation",
      "mutation-only",
      "unsupported",
      "ambiguous",
      "receipt-reason",
      "missing",
      "incomplete",
      "missing-terminal",
      "foreign-batch",
      "foreign-attempt",
      "foreign-sha",
      "wrong-shard",
      "report-identity",
      "report-digest",
    ]) {
      await scenario(kind);
    }
  }
  const output = process.argv.indexOf("--output");
  if (output >= 0)
    writeFileSync(resolve(process.argv[output + 1]), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
