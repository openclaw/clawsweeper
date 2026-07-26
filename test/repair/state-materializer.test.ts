import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { actionLedgerJson } from "../../dist/action-ledger.js";
import {
  DEFAULT_STATE_MATERIALIZER_MAX_BYTES,
  DEFAULT_STATE_MATERIALIZER_MAX_ROWS,
  planStateMaterialization,
  runStateMaterializer,
  type StateAppendRecord,
} from "../../dist/repair/state-materializer.js";

const webhookSecret = "state-materializer-test-secret";
const producedAt = "2026-07-20T12:00:00.000Z";
const proofPath = `ledger/v1/import-bindings/events/${"a".repeat(64)}.json`;

test("materializer preserves canonical apply-proof content supplied as a string", () => {
  const content = `${actionLedgerJson({
    event_id: "proof-event-string",
    schema: "clawsweeper.action-ledger-import-event-binding",
    schema_version: 1,
  })}\n`;

  const plan = planStateMaterialization([record(1, "apply_proof", proofPath, content)]);

  assert.deepEqual(plan, {
    deletes: [],
    publishPaths: [proofPath],
    writes: [{ path: proofPath, content }],
    selected: 1,
    skipped: 0,
  });
});

test("materializer applies every record kind in sequence and keeps the last value per key", async () => {
  const fixture = createStateFixture();
  const records = [
    record(1, "sweep_status", "openclaw-openclaw", sweepStatus("old", "12:00:00.000")),
    record(2, "comment_router", "router-a", routerLedger("router-a", "12:00:01.000")),
    record(3, "apply_proof", proofPath, {
      event_id: "proof-event",
      schema: "clawsweeper.action-ledger-import-event-binding",
      schema_version: 1,
    }),
    record(4, "sweep_status", "openclaw-openclaw", sweepStatus("new", "12:00:04.000")),
    record(5, "comment_router", "router-b", routerLedger("router-b", "12:00:05.000")),
  ];
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let drainCalls = 0;
  let ackCalls = 0;
  const fetchImpl = signedQueueFetch(async (url, body) => {
    requests.push({ path: url.pathname, body });
    if (url.pathname === "/internal/state/drain") {
      drainCalls += 1;
      return drainCalls === 1
        ? Response.json({ ok: true, drain_token: "drain-1", records })
        : Response.json({ ok: true, drain_token: null, records: [] });
    }
    assert.equal(url.pathname, "/internal/state/ack");
    ackCalls += 1;
    assert.deepEqual(body, { drain_token: "drain-1" });
    return Response.json({ ok: true, acked: records.length });
  });

  const summary = await withMaterializerFixture(fixture, () =>
    runStateMaterializer({ env: materializerEnv(), fetchImpl }),
  );

  assert.deepEqual(summary, { drained: 5, committed: 4, acked: 5, skipped: 1, errors: 0 });
  assert.equal(ackCalls, 1);
  assert.deepEqual(requests[0]?.body, {
    max_rows: DEFAULT_STATE_MATERIALIZER_MAX_ROWS,
    max_bytes: DEFAULT_STATE_MATERIALIZER_MAX_BYTES,
  });
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "rev-list", "--count", "state"], fixture.root),
    "2\n",
  );

  const status = JSON.parse(showState(fixture, "results/sweep-status/openclaw-openclaw.json"));
  assert.equal(status.detail, "new");
  assert.equal(status.updated_at, "2026-07-20T12:00:04.000Z");

  const router = JSON.parse(showState(fixture, "results/comment-router.json"));
  assert.deepEqual(
    router.commands.map((command: { comment_version_key: string }) => command.comment_version_key),
    ["base", "router-a", "router-b"],
  );
  assert.equal(
    showState(fixture, proofPath),
    `${actionLedgerJson({
      event_id: "proof-event",
      schema: "clawsweeper.action-ledger-import-event-binding",
      schema_version: 1,
    })}\n`,
  );
  assert.equal(statePathExists(fixture, "results/comment-router-latest.json"), false);
  assert.match(
    run("git", ["--git-dir", fixture.origin, "log", "-1", "--format=%B", "state"], fixture.root),
    /chore: materialize queued state[\s\S]*\[skip ci\]/,
  );
});

test("materializer commits one canonical record tuple atomically", async () => {
  const fixture = createStateFixture();
  const tuple = canonicalTuplePayload(42, "incoming", "2026-07-20T12:10:00.000Z");
  const records = [record(1, "record_tuple", "openclaw-openclaw/42", tuple)];
  let drainCalls = 0;
  const fetchImpl = signedQueueFetch(async (url) => {
    if (url.pathname === "/internal/state/drain") {
      drainCalls += 1;
      return drainCalls === 1
        ? Response.json({ ok: true, drain_token: "tuple-inline", records })
        : Response.json({ ok: true, drain_token: null, records: [] });
    }
    assert.equal(url.pathname, "/internal/state/ack");
    return Response.json({ ok: true, acked: 1 });
  });

  const summary = await withMaterializerFixture(fixture, () =>
    runStateMaterializer({ env: materializerEnv(), fetchImpl }),
  );

  assert.deepEqual(summary, { drained: 1, committed: 1, acked: 1, skipped: 0, errors: 0 });
  assert.match(showState(fixture, "records/openclaw-openclaw/items/42.md"), /# incoming/);
  assert.match(showState(fixture, "records/openclaw-openclaw/plans/42.md"), /Plan incoming/);
  assert.match(
    showState(fixture, "records/openclaw-openclaw/decision-packets/42.json"),
    /"marker": "incoming"/,
  );
  const commitPaths = run(
    "git",
    ["--git-dir", fixture.origin, "diff-tree", "--no-commit-id", "--name-only", "-r", "state"],
    fixture.root,
  )
    .trim()
    .split("\n")
    .filter((value) => value.startsWith("records/openclaw-openclaw/"));
  assert.deepEqual(commitPaths.sort(), tuple.operations.map((operation) => operation.path).sort());
});

test("materializer fetches oversize canonical tuple content before projection", async () => {
  const fixture = createStateFixture();
  const tuple = canonicalTuplePayload(43, "oversize", "2026-07-20T12:11:00.000Z");
  const primary = tuple.operations.find((operation) => operation.section === "items")!;
  delete primary.content;
  primary.oversize = true;
  const records = [record(1, "record_tuple", "openclaw-openclaw/43", tuple)];
  let drainCalls = 0;
  let fetchCalls = 0;
  const expectedContent = canonicalTuplePayload(
    43,
    "oversize",
    "2026-07-20T12:11:00.000Z",
  ).operations.find((operation) => operation.section === "items")!.content!;
  const fetchImpl = signedQueueFetch(async (url) => {
    if (url.pathname === "/internal/state/drain") {
      drainCalls += 1;
      return drainCalls === 1
        ? Response.json({ ok: true, drain_token: "tuple-oversize", records })
        : Response.json({ ok: true, drain_token: null, records: [] });
    }
    if (url.pathname === "/internal/state/records/openclaw-openclaw/items/43") {
      fetchCalls += 1;
      return Response.json({
        content: expectedContent,
        digest: primary.digest,
        revision: 1,
        updatedAt: producedAt,
      });
    }
    assert.equal(url.pathname, "/internal/state/ack");
    return Response.json({ ok: true, acked: 1 });
  });

  const summary = await withMaterializerFixture(fixture, () =>
    runStateMaterializer({ env: materializerEnv(), fetchImpl }),
  );

  assert.deepEqual(summary, { drained: 1, committed: 1, acked: 1, skipped: 0, errors: 0 });
  assert.equal(fetchCalls, 1);
  assert.equal(showState(fixture, primary.path), expectedContent);
});

test("materializer preserves a fresher concurrent git tuple through winner semantics", async () => {
  const fixture = createStateFixture();
  writeTupleFiles(fixture.state, canonicalTuplePayload(44, "base", "2026-07-20T12:00:00.000Z"));
  run("git", ["add", "records/openclaw-openclaw"], fixture.state);
  run("git", ["commit", "-m", "base tuple"], fixture.state);
  run("git", ["push", "origin", "HEAD:state"], fixture.state);
  fs.cpSync(path.join(fixture.state, "records"), path.join(fixture.source, "records"), {
    recursive: true,
  });

  const other = path.join(fixture.root, "concurrent");
  run("git", ["clone", fixture.origin, other], fixture.root);
  configureUser(other);
  run("git", ["checkout", "-B", "state", "origin/state"], other);
  writeTupleFiles(other, canonicalTuplePayload(44, "remote-newer", "2026-07-20T12:20:00.000Z"));
  run("git", ["add", "records/openclaw-openclaw"], other);
  run("git", ["commit", "-m", "concurrent newer tuple"], other);
  const hook = path.join(fixture.state, ".git/hooks/pre-push");
  const marker = path.join(fixture.state, ".git/hooks/materializer-race-fired");
  fs.writeFileSync(
    hook,
    `#!/bin/sh\nif [ ! -f '${marker}' ]; then\n  touch '${marker}'\n  git -C '${other}' push origin HEAD:state\nfi\n`,
  );
  fs.chmodSync(hook, 0o755);

  const incoming = canonicalTuplePayload(44, "incoming-older", "2026-07-20T12:10:00.000Z");
  const records = [record(1, "record_tuple", "openclaw-openclaw/44", incoming)];
  let drainCalls = 0;
  const fetchImpl = signedQueueFetch(async (url) => {
    if (url.pathname === "/internal/state/drain") {
      drainCalls += 1;
      return drainCalls === 1
        ? Response.json({ ok: true, drain_token: "tuple-race", records })
        : Response.json({ ok: true, drain_token: null, records: [] });
    }
    return Response.json({ ok: true, acked: 1 });
  });

  const summary = await withMaterializerFixture(fixture, () =>
    runStateMaterializer({ env: materializerEnv(), fetchImpl }),
  );

  assert.deepEqual(summary, { drained: 1, committed: 1, acked: 1, skipped: 0, errors: 0 });
  assert.match(showState(fixture, "records/openclaw-openclaw/items/44.md"), /# remote-newer/);
  assert.doesNotMatch(
    showState(fixture, "records/openclaw-openclaw/items/44.md"),
    /incoming-older/,
  );
});

test("materializer does not ack a drain when the state push fails", async () => {
  const fixture = createStateFixture();
  run(
    "git",
    ["remote", "set-url", "origin", path.join(fixture.root, "unreachable-state.git")],
    fixture.state,
  );
  let ackCalls = 0;
  let drainCalls = 0;
  const records = [
    record(1, "sweep_status", "openclaw-openclaw", sweepStatus("blocked", "12:00:01.000")),
  ];
  const fetchImpl = signedQueueFetch(async (url) => {
    if (url.pathname === "/internal/state/drain") {
      drainCalls += 1;
      assert.equal(drainCalls, 1);
      return Response.json({ ok: true, drain_token: "drain-failed", records });
    }
    ackCalls += 1;
    return Response.json({ ok: true, acked: records.length });
  });

  const summary = await withMaterializerFixture(fixture, () =>
    runStateMaterializer({
      env: materializerEnv({
        CLAWSWEEPER_STATE_MATERIALIZER_PUBLISH_MAX_ATTEMPTS: "1",
        CLAWSWEEPER_STATE_MATERIALIZER_PUSH_ATTEMPTS: "1",
      }),
      fetchImpl,
    }),
  );

  assert.deepEqual(summary, { drained: 1, committed: 0, acked: 0, skipped: 0, errors: 1 });
  assert.equal(ackCalls, 0);
  assert.equal(
    JSON.parse(showState(fixture, "results/sweep-status/openclaw-openclaw.json")).detail,
    "initial",
  );
});

test("materializer no-ops when the drain is empty", async () => {
  let calls = 0;
  const fetchImpl = signedQueueFetch(async (url) => {
    calls += 1;
    assert.equal(url.pathname, "/internal/state/drain");
    return Response.json({ ok: true, drain_token: null, records: [] });
  });

  const summary = await runStateMaterializer({ env: materializerEnv(), fetchImpl });

  assert.deepEqual(summary, { drained: 0, committed: 0, acked: 0, skipped: 0, errors: 0 });
  assert.equal(calls, 1);
});

test("materializer stops before another drain when its runtime budget is exhausted", async () => {
  const fixture = createStateFixture();
  const records = [
    record(1, "sweep_status", "openclaw-openclaw", sweepStatus("budget", "12:00:01.000")),
  ];
  let drainCalls = 0;
  let ackCalls = 0;
  const fetchImpl = signedQueueFetch(async (url) => {
    if (url.pathname === "/internal/state/drain") {
      drainCalls += 1;
      return Response.json({ ok: true, drain_token: "drain-budget", records });
    }
    ackCalls += 1;
    return Response.json({ ok: true, acked: 1 });
  });
  const instants = [0, 0, 1_001];
  const now = () => new Date(instants.shift() ?? 1_001);

  const summary = await withMaterializerFixture(fixture, () =>
    runStateMaterializer({
      env: materializerEnv({ CLAWSWEEPER_STATE_MATERIALIZER_MAX_RUNTIME_MS: "1000" }),
      fetchImpl,
      now,
    }),
  );

  assert.deepEqual(summary, { drained: 1, committed: 1, acked: 1, skipped: 0, errors: 0 });
  assert.equal(drainCalls, 1);
  assert.equal(ackCalls, 1);
});

function record(
  seq: number,
  kind: StateAppendRecord["kind"],
  key: string,
  payload: unknown,
): StateAppendRecord {
  return {
    seq,
    kind,
    key,
    payload,
    produced_at: producedAt,
    delivery_id: `delivery-${seq}`,
  };
}

type TupleTestOperation = {
  path: string;
  repoSlug: string;
  section: "items" | "plans" | "decision-packets";
  itemId: number;
  digest: string;
  revision: number;
  bytes: number;
  deleted: false;
  content?: string;
  oversize?: boolean;
};

type TupleTestPayload = {
  itemKey: string;
  revision: number;
  claimGeneration: number;
  operations: TupleTestOperation[];
};

function canonicalTuplePayload(
  number: number,
  marker: string,
  timestamp: string,
): TupleTestPayload {
  const packet = `${JSON.stringify(
    {
      version: 1,
      generatedAt: timestamp,
      updatedAt: timestamp,
      subject: { repo: "openclaw/openclaw", number },
      source: {
        reportPath: `records/openclaw-openclaw/items/${number}.md`,
        reviewedAt: timestamp,
      },
      marker,
    },
    null,
    2,
  )}\n`;
  const packetDigest = createHash("sha256").update(packet).digest("hex");
  const primary = [
    "---",
    `decision_packet_sha256: ${packetDigest}`,
    `decision_packet_path: records/openclaw-openclaw/decision-packets/${number}.json`,
    `number: ${number}`,
    "repository: openclaw/openclaw",
    `item_updated_at: ${timestamp}`,
    `reviewed_at: ${timestamp}`,
    "---",
    "",
    `# ${marker}`,
    "",
  ].join("\n");
  const plan = [
    "---",
    `number: ${number}`,
    "repository: openclaw/openclaw",
    `reviewed_at: ${timestamp}`,
    "---",
    "",
    `# Plan ${marker}`,
    "",
  ].join("\n");
  const values = [
    { section: "items" as const, extension: "md", content: primary },
    { section: "plans" as const, extension: "md", content: plan },
    { section: "decision-packets" as const, extension: "json", content: packet },
  ];
  return {
    itemKey: `openclaw/openclaw#${number}`,
    revision: 1,
    claimGeneration: 1,
    operations: values.map(({ section, extension, content }) => ({
      path: `records/openclaw-openclaw/${section}/${number}.${extension}`,
      repoSlug: "openclaw-openclaw",
      section,
      itemId: number,
      digest: createHash("sha256").update(content).digest("hex"),
      revision: 1,
      bytes: Buffer.byteLength(content),
      deleted: false,
      content,
      oversize: false,
    })),
  };
}

function writeTupleFiles(root: string, tuple: TupleTestPayload): void {
  for (const operation of tuple.operations) {
    if (operation.content === undefined)
      throw new Error(`missing tuple content: ${operation.path}`);
    const target = path.join(root, operation.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, operation.content);
  }
}

function sweepStatus(detail: string, time: string): Record<string, unknown> {
  return {
    schema_version: 1,
    slug: "openclaw-openclaw",
    display_name: "OpenClaw",
    target_repo: "openclaw/openclaw",
    state: "running",
    detail,
    updated_at: `2026-07-20T${time}Z`,
  };
}

function routerLedger(key: string, time: string): Record<string, unknown> {
  const timestamp = `2026-07-20T${time}Z`;
  return {
    updated_at: timestamp,
    commands: [
      {
        comment_version_key: key,
        comment_id: key,
        comment_updated_at: timestamp,
        status: "executed",
        processed_at: timestamp,
      },
    ],
  };
}

function signedQueueFetch(
  handler: (url: URL, body: Record<string, unknown>) => Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const bodyText = String(init?.body ?? "");
    const expected = `sha256=${createHmac("sha256", webhookSecret).update(bodyText).digest("hex")}`;
    assert.equal(init?.method === "POST" || init?.method === "GET", true);
    assert.equal(new Headers(init?.headers).get("x-clawsweeper-exact-review-signature"), expected);
    return handler(url, bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {});
  }) as typeof fetch;
}

function materializerEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    QUEUE_URL: "https://queue.test/",
    CLAWSWEEPER_WEBHOOK_SECRET: webhookSecret,
    CLAWSWEEPER_PUBLISH_BRANCH: "state",
    ...overrides,
  };
}

function createStateFixture(): {
  root: string;
  origin: string;
  source: string;
  state: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-state-materializer-"));
  const origin = path.join(root, "origin.git");
  const source = path.join(root, "source");
  const state = path.join(root, "state");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  writeJson(
    path.join(state, "results/sweep-status/openclaw-openclaw.json"),
    sweepStatus("initial", "11:59:00.000"),
  );
  writeJson(path.join(state, "results/comment-router.json"), {
    updated_at: "2026-07-20T11:59:00.000Z",
    commands: [
      {
        comment_version_key: "base",
        comment_id: "base",
        comment_updated_at: "2026-07-20T11:59:00.000Z",
        status: "executed",
        processed_at: "2026-07-20T11:59:00.000Z",
      },
    ],
  });
  writeJson(path.join(state, "results/comment-router-latest.json"), {
    generated_at: "2026-07-20T11:59:00.000Z",
    commands_seen: 1,
  });
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "initial state"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["checkout", "-B", "state", "origin/state"], state);
  fs.cpSync(path.join(state, "results"), path.join(source, "results"), { recursive: true });
  return { root, origin, source, state };
}

async function withMaterializerFixture<T>(
  fixture: ReturnType<typeof createStateFixture>,
  operation: () => Promise<T>,
): Promise<T> {
  const previousCwd = process.cwd();
  const previousStateDir = process.env.CLAWSWEEPER_STATE_DIR;
  const previousPriority = process.env.CLAWSWEEPER_STATE_LEASE_PRIORITY;
  process.chdir(fixture.source);
  process.env.CLAWSWEEPER_STATE_DIR = fixture.state;
  process.env.CLAWSWEEPER_STATE_LEASE_PRIORITY = "1";
  try {
    return await operation();
  } finally {
    process.chdir(previousCwd);
    if (previousStateDir === undefined) delete process.env.CLAWSWEEPER_STATE_DIR;
    else process.env.CLAWSWEEPER_STATE_DIR = previousStateDir;
    if (previousPriority === undefined) delete process.env.CLAWSWEEPER_STATE_LEASE_PRIORITY;
    else process.env.CLAWSWEEPER_STATE_LEASE_PRIORITY = previousPriority;
  }
}

function showState(fixture: ReturnType<typeof createStateFixture>, file: string): string {
  return run("git", ["--git-dir", fixture.origin, "show", `state:${file}`], fixture.root);
}

function statePathExists(fixture: ReturnType<typeof createStateFixture>, file: string): boolean {
  try {
    run("git", ["--git-dir", fixture.origin, "cat-file", "-e", `state:${file}`], fixture.root);
    return true;
  } catch {
    return false;
  }
}

function configureUser(cwd: string): void {
  run("git", ["config", "user.name", "Tester"], cwd);
  run("git", ["config", "user.email", "tester@example.com"], cwd);
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
