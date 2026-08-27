import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { implementedCloseReport } from "../../test/helpers.ts";

// node scripts/e2e/apply-memory.mjs OUTPUT BUILD_ROOT LABEL [SCENARIO] [--expect-baseline-oom]
// BUILD_ROOT contains dist, config, schema, prompts, package.json and node_modules.
// Output must be disposable: it contains generated corpus and isolated runtime copies.
function main() {
  const args = process.argv.slice(2);
  const expectBaselineOom = args.at(-1) === "--expect-baseline-oom";
  if (expectBaselineOom) args.pop();
  const [outputArg, buildArg, label, onlyScenario] = args;
  if (!outputArg || !buildArg || !/^[a-z0-9-]+$/.test(label ?? "")) {
    throw new Error(
      "usage: apply-memory.mjs OUTPUT BUILD_ROOT LABEL [SCENARIO] [--expect-baseline-oom]",
    );
  }
  assert.ok(args.length <= 4, "too many arguments");
  const scenarios = ["proof", "comment-sync", "partial", "budget", "exact", "empty", "broad"];
  if (onlyScenario) assert.ok(scenarios.includes(onlyScenario));
  if (expectBaselineOom)
    assert.ok(onlyScenario, "expected baseline OOM requires one explicit scenario");
  mkdirSync(resolve(outputArg), { recursive: true });
  // The CLI entry-point check compares argv with import.meta.url; resolve macOS /tmp.
  const output = realpathSync(resolve(outputArg));
  const build = resolve(buildArg);
  const transport = fileURLToPath(new URL("./apply-memory-gh.cjs", import.meta.url));
  const observer = fileURLToPath(new URL("./apply-memory-observer.cjs", import.meta.url));
  const corpus = join(output, "corpus");
  ensureMemoryCorpus(corpus);

  const summary = [];
  for (const scenario of onlyScenario ? [onlyScenario] : scenarios) {
    const root = join(output, `${label}-${scenario}`);
    assert.ok(!existsSync(root), `refusing to overwrite proof case ${root}`);
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { recursive: true });
    for (const name of ["dist", "config", "schema", "prompts", "package.json"]) {
      cpSync(join(build, name), join(runtime, name), { recursive: true });
    }
    symlinkSync(join(build, "node_modules"), join(runtime, "node_modules"), "dir");
    const records = join(root, "records");
    const itemsDir = join(records, "items");
    const closedDir = join(records, "closed");
    mkdirSync(itemsDir, { recursive: true });
    symlinkSync(join(corpus, "closed"), closedDir, "dir");
    if (scenario !== "broad") {
      for (const name of readdirSync(join(corpus, "items"))) {
        symlinkSync(join(corpus, "items", name), join(itemsDir, name));
      }
    }
    const count = ["comment-sync", "broad", "partial", "budget"].includes(scenario)
      ? 40
      : scenario === "empty"
        ? 0
        : 2;
    const numbers = Array.from({ length: count }, (_, index) => 101 + index);
    for (const number of numbers) {
      writeFileSync(
        join(itemsDir, `${number}.md`),
        implementedCloseReport({
          repository: "openclaw/openclaw",
          number,
          title: "Memory proof",
          type: scenario === "proof" ? "pull_request" : "issue",
          reviewed_at: "2026-05-01T03:00:00Z",
          action_taken: "skipped_protected_label",
          labels: JSON.stringify(
            scenario === "proof"
              ? ["security"]
              : ["security", "issue-rating: 🦀 challenger crab", "clawsweeper:current-main-repro"],
          ),
          author_association: "CONTRIBUTOR",
        }),
      );
    }
    const reportPath = join(root, "apply-report.json");
    const cursorPath = join(root, "cursor.json");
    const metricsPath = join(root, "memory.json");
    mkdirSync(join(root, "ledger"));
    const args = [
      "--max-old-space-size=256",
      "--require",
      observer,
      join(runtime, "dist/clawsweeper.js"),
      "apply-decisions",
      "--target-repo",
      "openclaw/openclaw",
      "--skip-dashboard",
      "--apply-kind",
      "all",
      "--record-root",
      runtime,
      "--items-dir",
      itemsDir,
      "--closed-dir",
      closedDir,
      "--plans-dir",
      join(records, "plans"),
      "--report-path",
      reportPath,
      "--artifact-dir",
      join(root, "artifacts"),
      "--cursor-trace",
      cursorPath,
      "--canonical-record-baseline-dir",
      join(root, "baselines"),
      "--close-delay-ms",
      "0",
      "--processed-limit",
      "40",
      "--progress-every",
      "1",
      ...(scenario === "broad"
        ? []
        : ["--item-numbers", numbers.length ? numbers.join(",") : "99"]),
      ...(scenario === "proof"
        ? ["--dry-run", "--limit", "2", "--event-apply-proof"]
        : ["--sync-comments-only", "--limit", "0"]),
      ...(scenario === "exact" ? ["--exact-event-publication"] : []),
      ...(scenario === "budget" ? ["--max-runtime-ms", "3000"] : []),
    ];
    // Deliberately do not inherit credentials, provider configuration, hooks, or PATH shims.
    const env = {
      PATH: "/usr/bin:/bin",
      TMPDIR: root,
      GH_BIN: process.execPath,
      GH_BIN_ARGS: JSON.stringify([transport]),
      APPLY_MEMORY_CASE: root,
      APPLY_MEMORY_RECORDS: records,
      APPLY_MEMORY_METRICS: metricsPath,
      APPLY_MEMORY_TRANSPORT: transport,
      ...(["comment-sync", "broad"].includes(scenario) ? { APPLY_MEMORY_DRIFT: "1" } : {}),
      APPLY_MEMORY_KIND: scenario === "proof" ? "pull_request" : "issue",
      ...(scenario === "partial" || scenario === "budget"
        ? { APPLY_MEMORY_INTERRUPT: scenario }
        : {}),
      CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
      CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: join(root, "ledger"),
      CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-08-27",
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_SHA: "afe976209aa58a5629041b42b66f6ee11b2812a7",
      GITHUB_WORKFLOW: "apply-memory-proof",
      GITHUB_JOB: scenario,
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
    };
    writeFileSync(
      join(root, "command.json"),
      JSON.stringify({ node: process.execPath, version: process.version, args, env }, null, 2),
    );
    const started = Date.now();
    const result = spawnSync(process.execPath, args, {
      cwd: runtime,
      env,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    });
    writeFileSync(join(root, "stdout.log"), result.stdout ?? "");
    writeFileSync(join(root, "stderr.log"), result.stderr ?? "");
    const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath)) : null;
    const cursor = existsSync(cursorPath) ? JSON.parse(readFileSync(cursorPath)) : null;
    const memory = JSON.parse(readFileSync(metricsPath));
    const events = [];
    const readEvents = (dir) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) readEvents(path);
        else if (entry.name.endsWith(".jsonl"))
          events.push(
            ...readFileSync(path, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line)),
          );
      }
    };
    readEvents(join(root, "ledger"));
    const row = {
      provider: "local-process",
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      heapLimitMiB: 256,
      expectation: expectBaselineOom ? "baseline-oom" : "candidate-success",
      buildSha256: Object.fromEntries(
        [
          "clawsweeper-apply-decision-workflow.js",
          "clawsweeper-apply-records.js",
          "clawsweeper-apply-close-guards.js",
        ].map((name) => [
          name,
          createHash("sha256")
            .update(readFileSync(join(runtime, "dist", name)))
            .digest("hex"),
        ]),
      ),
      scenario,
      exit: result.status,
      signal: result.signal,
      error: result.error?.message,
      elapsedMs: Date.now() - started,
      memory,
      resultCount: report?.length ?? 0,
      actions: report?.reduce(
        (counts, item) => ({ ...counts, [item.action]: (counts[item.action] ?? 0) + 1 }),
        {},
      ),
      cursor,
      eventCount: events.length,
      batchTerminal: events.find(
        (event) => event.event_type === "apply.batch" && event.action.status !== "started",
      ),
      commentsWritten: readdirSync(root).filter((name) => /^comment-\d+\.json$/.test(name)).length,
    };
    try {
      const baselineOom = assertMemoryProcessOutcome(result, {
        expectBaselineOom,
        expectedStatus: scenario === "partial" ? 1 : 0,
      });
      if (!baselineOom) {
        assert.doesNotMatch(
          result.stderr,
          /unexpected fixture request|best-effort finalization failed/,
        );
        assert.ok(row.batchTerminal, "the real ledger must finalize, even with no candidates");
        assert.ok(report && cursor, "the CLI must write its report and cursor");
        assert.equal(memory.counts.closed, 0, "unrelated archived bodies must not be read");
        const terminalItems = events.filter(
          (event) =>
            event.event_type === "apply.action" &&
            event.action.status !== "started" &&
            event.subject.number,
        );
        assert.ok(terminalItems.every((event) => numbers.includes(event.subject.number)));
        if (["comment-sync", "broad"].includes(scenario)) {
          assert.deepEqual(row.actions, {
            review_comment_synced: 20,
            skipped_changed_since_review: 20,
          });
          assert.equal(row.commentsWritten, 20);
          assert.deepEqual(cursor.examined_item_numbers, numbers);
          assert.equal(row.batchTerminal.action.mutation, true);
        } else if (scenario === "proof") {
          assert.deepEqual(row.actions, { skipped_protected_label: 2 });
          assert.equal(row.commentsWritten, 0);
        } else if (scenario === "partial") {
          assert.equal(row.commentsWritten, 1);
          assert.equal(row.batchTerminal.attributes.partial, true);
          assert.equal(row.batchTerminal.action.mutation, true);
          assert.ok(
            terminalItems.some((event) => event.subject.number === 102 && event.action.retryable),
          );
          assert.ok(
            !report.some((item) => item.number === 102),
            "in-flight identity must survive without a result row",
          );
        } else if (scenario === "budget") {
          assert.equal(row.batchTerminal.action.status, "yielded");
          const interrupted = report.find(
            (item) => item.number > 0 && item.action === "skipped_runtime_budget",
          );
          assert.ok(interrupted);
          assert.ok(!cursor.examined_item_numbers.includes(interrupted.number));
          assert.ok(
            terminalItems.some(
              (event) =>
                event.subject.number === interrupted.number && event.action.status === "yielded",
            ),
          );
        } else if (scenario === "empty") {
          assert.deepEqual(report, []);
          assert.equal(row.batchTerminal.action.status, "skipped");
        } else if (scenario === "exact") {
          assert.deepEqual(row.actions, { kept_open: 2 });
          assert.ok(
            report.every(
              (item) =>
                item.reason === "exact event review artifact lacks a durable reviewed revision",
            ),
          );
        }
      }
      row.validation = { passed: true };
    } catch (error) {
      row.validation = { passed: false, error: String(error) };
      throw error;
    } finally {
      writeFileSync(join(root, "result.json"), JSON.stringify(row, null, 2));
      summary.push(row);
      writeFileSync(
        join(output, `${label}${onlyScenario ? `-${onlyScenario}` : ""}-summary.json`),
        JSON.stringify(summary, null, 2),
      );
      console.log(
        JSON.stringify({
          scenario,
          exit: row.exit,
          signal: row.signal,
          memory: memory.peakHeapUsed,
          reads: memory.counts,
          actions: row.actions,
          comments: row.commentsWritten,
          expectation: row.expectation,
          validation: row.validation,
        }),
      );
    }
  }
}

export function assertMemoryProcessOutcome(
  result,
  { expectBaselineOom = false, expectedStatus = 0 } = {},
) {
  assert.equal(result.error, undefined, result.error?.message);
  const oom = result.signal === "SIGABRT" && /heap out of memory/.test(result.stderr ?? "");
  if (expectBaselineOom) {
    assert.ok(oom, "baseline measurement must fail with the expected heap OOM");
    assert.equal(result.status, null);
    return true;
  }
  assert.equal(result.signal, null, `candidate process failed: ${result.signal}\n${result.stderr}`);
  assert.equal(result.status, expectedStatus, result.stderr);
  return false;
}

const corpusSpec = { open: 5500, archived: 12000, bytesPerRecord: 32768 };
const retained = (number) => {
  const header = `---\nrepository: openclaw/openclaw\nnumber: ${number}\ntype: issue\nreview_status: complete\ndecision: keep_open\naction_taken: kept_open\n---\n\n## Summary\n\n`;
  return (
    header +
    "Retained review evidence and command output.\n"
      .repeat(800)
      .slice(0, corpusSpec.bytesPerRecord - header.length)
  );
};

export function ensureMemoryCorpus(corpus) {
  const manifest = {
    ...corpusSpec,
    sampleSha256: createHash("sha256").update(retained(100000)).digest("hex"),
  };
  const corpusStat = lstatSync(corpus, { throwIfNoEntry: false });
  if (corpusStat) {
    assert.ok(corpusStat.isDirectory(), `refusing unowned corpus path ${corpus}`);
    const manifestPath = join(corpus, "manifest.json");
    assert.ok(
      lstatSync(manifestPath, { throwIfNoEntry: false })?.isFile(),
      `refusing unowned corpus without a regular manifest: ${corpus}`,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(manifestPath, "utf8")),
      manifest,
      "refusing corpus with an invalid manifest",
    );
    for (const section of ["items", "closed"]) {
      assert.ok(
        lstatSync(join(corpus, section)).isDirectory(),
        "corpus section must be a real directory",
      );
    }
    assert.equal(
      createHash("sha256")
        .update(readFileSync(join(corpus, "items", "100000.md")))
        .digest("hex"),
      manifest.sampleSha256,
      "corpus sample does not match manifest",
    );
    return;
  }
  // Claim a fresh path exclusively; an interrupted generation is not reusable.
  mkdirSync(corpus);
  for (const section of ["items", "closed"]) mkdirSync(join(corpus, section));
  for (let index = 0; index < corpusSpec.open + corpusSpec.archived; index++) {
    const section = index < corpusSpec.open ? "items" : "closed";
    writeFileSync(join(corpus, section, `${100000 + index}.md`), retained(100000 + index), {
      flag: "wx",
    });
  }
  writeFileSync(join(corpus, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main();
