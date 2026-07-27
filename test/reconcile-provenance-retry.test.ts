import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  decideRecordAuthority,
  loadGitCommitTimes,
  reconcileWorkerRecordAuthority,
  type GhCommandResult,
} from "../scripts/reconcile-worker-records.ts";
import type { WorkerRecord } from "../scripts/worker-records.ts";

const repoSlug = "openclaw-openclaw";

function ghSuccess(committedDates: readonly (string | null)[]): GhCommandResult {
  const object: Record<string, { nodes: Array<{ committedDate: string }> }> = {};
  committedDates.forEach((committedDate, index) => {
    object[`p${index}`] = { nodes: committedDate ? [{ committedDate }] : [] };
  });
  return {
    status: 0,
    stdout: JSON.stringify({ data: { repository: { object } } }),
    stderr: "",
  };
}

function ghHttpFailure(status: number): GhCommandResult {
  return {
    status: 1,
    stdout: "",
    stderr: `gh: HTTP ${status} (https://api.github.com/graphql)`,
  };
}

test("git provenance read retries transient 502s with exponential backoff and then succeeds", () => {
  const responses = [ghHttpFailure(502), ghHttpFailure(502), ghSuccess(["2026-07-26T10:00:00Z"])];
  let calls = 0;
  const sleeps: number[] = [];
  const result = loadGitCommitTimes("unused", repoSlug, ["items/44.md"], {
    runGh: () => responses[calls++]!,
    sleep: (ms) => sleeps.push(ms),
  });

  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [2000, 4000]);
  assert.deepEqual(result.times, new Map([["items/44.md", "2026-07-26T10:00:00Z"]]));
  assert.deepEqual(result.unavailable, new Set());
});

test("persistent 502s exhaust retries and degrade to provenance-unavailable instead of throwing", () => {
  let calls = 0;
  const sleeps: number[] = [];
  const result = loadGitCommitTimes("unused", repoSlug, ["items/44.md", "plans/44.md"], {
    runGh: () => {
      calls += 1;
      return ghHttpFailure(502);
    },
    sleep: (ms) => sleeps.push(ms),
  });

  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [2000, 4000, 8000]);
  assert.deepEqual(result.times, new Map());
  assert.deepEqual(result.unavailable, new Set(["items/44.md", "plans/44.md"]));

  const canonical = workerRecord("items", "44", "canonical body\n", 7);
  canonical.updatedAt = "2026-07-26T12:00:00.000Z";
  const authority = decideRecordAuthority({
    mismatches: [
      { path: "items/44.md", gitDigest: "d".repeat(64), workerDigest: canonical.digest },
    ],
    canonicalRecords: new Map([["items/44.md", canonical]]),
    gitRecordPaths: new Set(["items/44.md"]),
    githubStates: new Map([["44", "open"]]),
    gitCommitTimes: result.times,
    provenanceUnavailable: result.unavailable,
  });
  assert.deepEqual(authority.tuples, [
    {
      itemId: "44",
      verdict: "canonical-wins",
      reason:
        "provenance-unavailable: git commit recency could not be read; canonical stays authoritative",
    },
  ]);
  assert.deepEqual(authority.degraded, ["items/44.md"]);
});

test("a 4xx provenance failure throws immediately without retrying", () => {
  let calls = 0;
  const sleeps: number[] = [];
  assert.throws(
    () =>
      loadGitCommitTimes("unused", repoSlug, ["items/44.md"], {
        runGh: () => {
          calls += 1;
          return ghHttpFailure(404);
        },
        sleep: (ms) => sleeps.push(ms),
      }),
    /gh api failed while reading git provenance: gh: HTTP 404/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

test("reconciliation degrades unavailable provenance to canonical-wins with replay and a summary note", async () => {
  const item = "---\nnumber: 44\n---\ncanonical body\n";
  const gitItem = "---\nnumber: 44\n---\ndiverged git body\n";
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-provenance-degrade-test-"));
  const stateRoot = path.join(root, "state");
  write(path.join(stateRoot, "records", repoSlug, "items", "44.md"), gitItem);
  const parityReport = path.join(root, "parity.json");
  writeFileSync(
    parityReport,
    JSON.stringify({
      repoSlug,
      gitRecords: 1,
      workerRecords: 1,
      mismatches: [
        {
          path: "items/44.md",
          gitDigest: createHash("sha256").update(gitItem).digest("hex"),
          workerDigest: createHash("sha256").update(item).digest("hex"),
        },
      ],
    }),
  );
  const summaryFile = path.join(root, "summary.md");
  writeFileSync(summaryFile, "");
  const tupleRequests: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    if (url.pathname === "/internal/state/records/export") {
      return Response.json({
        repoSlug,
        revision: 4,
        nextCursor: null,
        records: [workerRecord("items", "44", item, 3)],
      });
    }
    assert.equal(url.pathname, "/internal/state/records/tuples");
    tupleRequests.push(JSON.parse(String(init?.body ?? "{}")));
    return Response.json({ ok: true, accepted: true, deduped: false, revision: 5, sequence: 9 });
  }) as typeof fetch;

  try {
    const result = await reconcileWorkerRecordAuthority({
      stateRoot,
      targetRepo: "openclaw/openclaw",
      repoSlug,
      baseUrl: "https://worker.example",
      webhookSecret: "fixture-secret",
      parityReport,
      summaryFile,
      fetch: fetchImpl,
      githubStates: () => new Map([["44", "open"]]),
      gitCommitTimes: () => ({ times: new Map(), unavailable: new Set(["items/44.md"]) }),
    });

    assert.deepEqual(result.decisions, [
      {
        path: "items/44.md",
        itemId: "44",
        verdict: "canonical-wins",
        reason:
          "provenance-unavailable: git commit recency could not be read; canonical stays authoritative",
      },
    ]);
    assert.deepEqual(result.degradedPaths, ["items/44.md"]);
    assert.equal(result.degradedCount, 1);
    assert.deepEqual(result.corrections, []);
    assert.equal(result.replay?.attempted, 1);
    assert.equal(result.replay?.failed, 0);
    assert.equal(tupleRequests.length, 1);
    const summary = readFileSync(summaryFile, "utf8");
    assert.match(summary, /provenance degradations: 1/);
    assert.match(summary, /provenance-unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function workerRecord(
  section: WorkerRecord["section"],
  id: string,
  content: string,
  storeRevision: number,
  revision = 1,
): WorkerRecord {
  return {
    section,
    id,
    content,
    digest: createHash("sha256").update(content).digest("hex"),
    revision,
    storeRevision,
    deleted: false,
  };
}

function write(filePath: string, content: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}
