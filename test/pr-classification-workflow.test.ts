import { PrClassificationError } from "../dist/pr-classification-error.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  runPrClassificationWorkflow,
  type PrClassificationWorkflowOptions,
} from "../dist/pr-classification-workflow.js";
import { getMutationReceiptRunner } from "../dist/clawsweeper-github-execution.js";
import { readAllSpooledActionEvents } from "../dist/action-ledger.js";
import { classifyPullRequest } from "../dist/pr-classification.js";
import { useFakeScanner } from "./agent-input-scan-helpers.ts";
import type { IntakeSnapshot } from "../dist/intake-triage-workflow.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pr-classification-"));
  const values = {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_DISABLED: "0",
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-11-23",
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "classification",
    GITHUB_ACTION: "classification",
    GITHUB_JOB: "classify",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_WORKFLOW_REF:
      "openclaw/clawsweeper/.github/workflows/pr-classification.yml@refs/heads/main",
    GITHUB_RUN_ID: "4242",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "a".repeat(40),
  };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const live: IntakeSnapshot = {
    repository: "openclaw/openclaw",
    number: 42,
    kind: "pull_request",
    title: "Fix private startup crash",
    body: "Private fixture prose",
    state: "open",
    locked: false,
    updatedAt: "2026-11-23T00:00:00Z",
    labels: ["maintainer", "human-label"],
    headSha: "b".repeat(40),
  };
  const writes: string[] = [];
  let calls = 0;
  let afterDefinition = () => {};
  const options: PrClassificationWorkflowOptions = {
    repository: live.repository,
    number: live.number,
    apiKey: "synthetic",
    waitBeforeRetry: async () => {},
    root,
    readSnapshot: () => structuredClone(live),
    readSource: () => ({
      headSha: live.headSha,
      baseSha: "a".repeat(40),
      diff: "private-patch",
      readTool: () => "context",
      assertCurrent() {},
    }),
    infer: async ({ recordAttempt, packet, readTool }) => {
      assert.equal(packet.diff, "private-patch");
      assert.equal(readTool("read_file", {}), "context");
      recordAttempt();
      calls++;
      return {
        outcome: "classified",
        classification: { priority: "P1", impact: ["impact:crash-loop"] },
        usage: { inputTokens: 100, outputTokens: 12 },
      };
    },
    gh: {
      readLabelCatalogPages: () => [[]],
      ghObservedMutationCommand: (mutation) => {
        const runner = getMutationReceiptRunner();
        assert.ok(runner);
        return runner({
          identity: mutation.identity,
          idempotencyIdentity: mutation.identity,
          operation: () => {
            writes.push(mutation.args.join(" "));
            if (mutation.args[0] === "label") afterDefinition();
            else {
              live.labels.push("P1", "impact:crash-loop");
              live.updatedAt = "2026-11-23T00:00:01Z";
            }
            return "";
          },
        });
      },
    },
  };
  return {
    root,
    live,
    options,
    writes,
    calls: () => calls,
    afterDefinition: (callback: () => void) => {
      afterDefinition = callback;
    },
  };
}

test("maintainer PR gets additive classification without a review; repeat spends nothing", async (t) => {
  const f = fixture(t);
  const result = await runPrClassificationWorkflow(f.options);
  assert.deepEqual(result, { outcome: "published", labels: ["P1", "impact:crash-loop"] });
  assert.equal(f.writes.filter((write) => write.startsWith("issue edit")).length, 1);
  assert.ok(f.live.labels.includes("maintainer"));
  assert.ok(f.live.labels.includes("human-label"));
  assert.equal((await runPrClassificationWorkflow(f.options)).outcome, "already_classified");
  assert.equal(f.calls(), 1);
  const events = JSON.stringify(readAllSpooledActionEvents(f.root));
  assert.ok(events.includes("pr-classification"));
  assert.ok(events.includes("input_tokens"));
  assert.ok(!events.includes(f.live.title));
  assert.ok(!events.includes(f.live.body));
  assert.ok(!f.writes.some((write) => /review|comment|remove-label|proof:|ready/.test(write)));
});

for (const kind of ["priority", "closed", "locked", "disabled"] as const) {
  test(kind + " skips inference and mutations", async (t) => {
    const f = fixture(t);
    if (kind === "priority") f.live.labels.push("p0");
    if (kind === "closed") f.live.state = "closed";
    if (kind === "locked") f.live.locked = true;
    if (kind === "disabled") f.options.model = "off";
    await runPrClassificationWorkflow(f.options);
    assert.equal(f.calls(), 0);
    assert.deepEqual(f.writes, []);
  });
}

test("existing impact labels are preserved, not supplemented or removed", async (t) => {
  const f = fixture(t);
  f.live.labels.push("impact:security");
  assert.deepEqual((await runPrClassificationWorkflow(f.options)).labels, ["P1"]);
  assert.ok(!f.writes.some((write) => write.includes("crash-loop")));
});

test("drift before paid intent prevents inference", async (t) => {
  const f = fixture(t);
  let reads = 0;
  f.options.readSnapshot = () => {
    if (++reads > 1) f.live.body += " edited";
    return structuredClone(f.live);
  };
  await assert.rejects(runPrClassificationWorkflow(f.options), /snapshot-drift|source changed/);
  assert.equal(f.calls(), 0);
  assert.deepEqual(f.writes, []);
});

test("drift after label definitions prevents item mutation", async (t) => {
  const f = fixture(t);
  f.afterDefinition(() => {
    f.live.headSha = "c".repeat(40);
  });
  await assert.rejects(runPrClassificationWorkflow(f.options), /snapshot-drift|source changed/);
  assert.ok(!f.writes.some((write) => write.startsWith("issue edit")));
});

test("unclear or unavailable results do not publish labels", async (t) => {
  const f = fixture(t);
  f.options.infer = async ({ recordAttempt }) => {
    recordAttempt();
    return {
      outcome: "classified",
      classification: { priority: "unclear", impact: [] },
      usage: null,
    };
  };
  assert.equal((await runPrClassificationWorkflow(f.options)).outcome, "unclear");
  assert.deepEqual(f.writes, []);
});

test("source/base drift blocks paid intent and writes", async (t) => {
  const f = fixture(t);
  f.options.readSource = () => ({
    headSha: f.live.headSha,
    baseSha: "a".repeat(40),
    diff: "private-patch",
    readTool: () => "context",
    assertCurrent() {
      throw Error("source changed");
    },
  });
  await assert.rejects(runPrClassificationWorkflow(f.options), /snapshot-drift|source changed/);
  assert.equal(f.calls(), 0);
  assert.deepEqual(f.writes, []);
});

for (const failure of [
  "provider-http",
  "transport",
  "source-tool",
  "input-scan",
  "attempt-guard",
] as const) {
  test(failure + " retains paid usage in durable results without label writes", async (t) => {
    useFakeScanner(
      t,
      failure === "input-scan"
        ? "if(inputs.some(x=>x.bytes.toString('utf8').includes('tool-secret-marker')))process.exit(1);"
        : "",
    );
    const f = fixture(t);
    let requests = 0;
    const source = f.options.readSource!();
    f.options.readSource = () => ({
      ...source,
      readTool() {
        if (failure === "source-tool") throw Error("private-source-error");
        return failure === "input-scan" ? "tool-secret-marker" : "source-context";
      },
    });
    f.options.infer = (options) =>
      classifyPullRequest({
        ...options,
        cwd: process.cwd(),
        fetch: async () => {
          requests++;
          if (requests > 1) {
            if (failure === "transport") throw Error("private-transport-error");
            return new Response(null, { status: 429 });
          }
          if (failure === "attempt-guard") f.live.headSha = "c".repeat(40);
          return Response.json({
            status: "completed",
            usage: { input_tokens: 100, output_tokens: 20 },
            output: [
              {
                type: "function_call",
                name: "read_file",
                call_id: "call_1",
                arguments: JSON.stringify({
                  path: "src/start.ts",
                  revision: "head",
                  start_line: 1,
                }),
              },
            ],
          });
        },
      });
    const result = await runPrClassificationWorkflow(f.options);
    assert.equal(result.outcome, failure === "input-scan" ? "refused" : "unavailable");
    assert.equal(
      requests,
      ["provider-http", "transport"].includes(failure) ? 3 : failure === "attempt-guard" ? 2 : 1,
    );
    assert.deepEqual(f.writes, []);
    const events = readAllSpooledActionEvents(f.root);
    const receipt = events.filter((event) => event.attributes?.status_kind === failure);
    assert.equal(receipt.length, ["provider-http", "transport"].includes(failure) ? 2 : 1);
    const paid = receipt.find((event) => event.attributes.input_tokens === 100);
    assert.ok(paid);
    assert.equal(paid.attributes.output_tokens, 20);
    assert.doesNotMatch(
      JSON.stringify(events),
      /private-source-error|private-transport-error|tool-secret-marker|source-context/,
    );
  });
}

test("description edit after inference retries once from fresh source and retains both usages", async (t) => {
  const f = fixture(t);
  const infer = f.options.infer!;
  let calls = 0;
  const bodies: string[] = [];
  f.options.infer = async (options) => {
    bodies.push(options.packet.body);
    const result = await infer(options);
    if (++calls === 1) f.live.body += " edited";
    return result;
  };
  assert.equal((await runPrClassificationWorkflow(f.options)).outcome, "published");
  assert.deepEqual(bodies, ["Private fixture prose", "Private fixture prose edited"]);
  const events = readAllSpooledActionEvents(f.root);
  assert.equal(events.filter((e) => e.attributes.input_tokens === 100).length, 2);
  assert.equal(events.filter((e) => e.attributes.status_kind === "snapshot-drift").length, 1);
  assert.equal(f.writes.filter((s) => s.startsWith("issue edit")).length, 1);
});

test("repeated drift stops after exactly two attempts", async (t) => {
  const f = fixture(t);
  const infer = f.options.infer!;
  f.options.infer = async (options) => {
    const result = await infer(options);
    f.live.body += " edited";
    return result;
  };
  await assert.rejects(runPrClassificationWorkflow(f.options), /snapshot-drift/);
  assert.equal(f.calls(), 2);
  assert.deepEqual(f.writes, []);
});

test("priority arriving before retry avoids second inference", async (t) => {
  const f = fixture(t);
  const infer = f.options.infer!;
  f.options.infer = async (options) => {
    const result = await infer(options);
    f.live.body += " edited";
    return result;
  };
  f.options.waitBeforeRetry = async () => {
    f.live.labels.push("P2");
  };
  assert.equal((await runPrClassificationWorkflow(f.options)).outcome, "already_classified");
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.writes, []);
});

for (const failure of ["source-limit", "receipt-unavailable"] as const) {
  test(failure + " is recorded before inference and never retried", async (t) => {
    const f = fixture(t);
    let reads = 0;
    f.options.readSource = () => {
      reads++;
      throw new PrClassificationError(failure);
    };
    await assert.rejects(runPrClassificationWorkflow(f.options), new RegExp(failure));
    assert.equal(reads, 1);
    assert.equal(f.calls(), 0);
    const receipts = readAllSpooledActionEvents(f.root);
    assert.equal(receipts.filter((e) => e.attributes.status_kind === failure).length, 1);
  });
}

test("uncertain mutation is never replayed", async (t) => {
  const f = fixture(t);
  let writes = 0;
  f.options.gh!.ghObservedMutationCommand = (mutation) =>
    getMutationReceiptRunner()!({
      identity: mutation.identity,
      idempotencyIdentity: mutation.identity,
      operation() {
        writes++;
        throw new PrClassificationError("source-drift", true);
      },
    });
  await assert.rejects(runPrClassificationWorkflow(f.options), /source-drift/);
  assert.equal(writes, 1);
  assert.equal(f.calls(), 1);
});

for (const status of [401, 403, 429, 500, 503]) {
  test("provider HTTP " + status + " retries only rate-limit/server failures once", async (t) => {
    useFakeScanner(t);
    const f = fixture(t);
    let calls = 0;
    f.options.infer = (options) =>
      classifyPullRequest({
        ...options,
        cwd: process.cwd(),
        fetch: async () => {
          calls++;
          return new Response(null, { status });
        },
      });
    assert.equal((await runPrClassificationWorkflow(f.options)).outcome, "unavailable");
    assert.equal(calls, status === 429 || status >= 500 ? 2 : 1);
    assert.deepEqual(f.writes, []);
  });
}

for (const outcome of ["refused", "invalid"] as const) {
  test(outcome + " is never retried", async (t) => {
    const f = fixture(t);
    let calls = 0;
    f.options.infer = async () => {
      calls++;
      return { outcome, classification: null, usage: null };
    };
    assert.equal((await runPrClassificationWorkflow(f.options)).outcome, outcome);
    assert.equal(calls, 1);
    assert.deepEqual(f.writes, []);
  });
}
