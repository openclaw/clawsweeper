import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { filterClusterCandidatesLive } from "../../dist/repair/filter-cluster-candidates-live.js";

function job(root: string, clusterId: number, refs: number[], clusterRefs = refs): string {
  const relative = `jobs/openclaw/inbox/gitcrawl-${clusterId}-candidate.md`;
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    `---\ncandidates:\n${refs.map((ref) => `  - "#${ref}"`).join("\n")}\ncluster_refs:\n${clusterRefs.map((ref) => `  - "#${ref}"`).join("\n")}\n---\n`,
  );
  return relative;
}

test("live fence rejects a cluster fixed after its stale gitcrawl snapshot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-live-cluster-"));
  const pathValue = job(root, 42, [100, 101]);
  const items = new Map([
    [
      100,
      {
        number: 100,
        state: "closed",
        title: "Bug",
        updated_at: "2026-07-25T00:00:00Z",
        labels: [],
      },
    ],
    [
      101,
      {
        number: 101,
        state: "closed",
        title: "Fix",
        updated_at: "2026-07-25T00:00:00Z",
        labels: [],
        pull_request: {},
      },
    ],
  ]);
  const previous = process.cwd();
  process.chdir(root);
  try {
    const result = filterClusterCandidatesLive({
      repo: "openclaw/openclaw",
      paths: [pathValue],
      now: new Date("2026-07-26T00:00:00Z"),
      readItem: (number) => items.get(number),
      readPull: () => ({ draft: false, maintainer_can_modify: true }),
    });
    assert.deepEqual(result.accepted, []);
    assert.match(result.rejected[0].reasons.join("\n"), /closed or merged/);
  } finally {
    process.chdir(previous);
  }
});

test("live fence accepts two recent open non-security candidates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-live-cluster-"));
  const pathValue = job(root, 43, [200, 201]);
  const previous = process.cwd();
  process.chdir(root);
  try {
    const result = filterClusterCandidatesLive({
      repo: "openclaw/openclaw",
      paths: [pathValue],
      now: new Date("2026-07-26T00:00:00Z"),
      readItem: (number) => ({
        number,
        state: "open",
        title: number === 200 ? "Telegram upload crashes" : "Fix Telegram upload crash",
        updated_at: "2026-07-25T00:00:00Z",
        labels: [{ name: "bug" }],
        ...(number === 201 ? { pull_request: {} } : {}),
      }),
      readPull: () => ({ draft: false, maintainer_can_modify: true }),
    });
    assert.deepEqual(result.accepted, [pathValue]);
    assert.deepEqual(result.rejected, []);
  } finally {
    process.chdir(previous);
  }
});

test("live fence fills only the requested limit after rejecting a stale first choice", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-live-cluster-"));
  const paths = [job(root, 44, [300, 301]), job(root, 45, [400, 401]), job(root, 46, [500, 501])];
  const previous = process.cwd();
  process.chdir(root);
  try {
    const result = filterClusterCandidatesLive({
      repo: "openclaw/openclaw",
      paths,
      maxAccepted: 1,
      now: new Date("2026-07-26T00:00:00Z"),
      readItem: (number) => ({
        number,
        state: number < 400 ? "closed" : "open",
        title: "Telegram upload crash",
        updated_at: "2026-07-25T00:00:00Z",
        labels: [{ name: "bug" }],
      }),
      readPull: () => ({ draft: false, maintainer_can_modify: true }),
    });
    assert.deepEqual(result.accepted, [paths[1]]);
    assert.match(result.rejected[0].reasons.join("\n"), /closed or merged/);
    assert.match(result.rejected[1].reasons.join("\n"), /beyond intake limit/);
  } finally {
    process.chdir(previous);
  }
});

test("live fence rejects implementation PRs the worker cannot update", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-live-cluster-"));
  const pathValue = job(root, 47, [600, 601]);
  const previous = process.cwd();
  process.chdir(root);
  try {
    const result = filterClusterCandidatesLive({
      repo: "openclaw/openclaw",
      paths: [pathValue],
      now: new Date("2026-07-26T00:00:00Z"),
      readItem: (number) => ({
        number,
        state: "open",
        title: number === 600 ? "Telegram upload crashes" : "Fix Telegram upload crash",
        updated_at: "2026-07-25T00:00:00Z",
        labels: [{ name: "bug" }],
        ...(number === 601 ? { pull_request: {} } : {}),
      }),
      readPull: () => ({
        draft: false,
        maintainer_can_modify: false,
        head: { repo: { full_name: "contributor/openclaw" } },
      }),
    });
    assert.deepEqual(result.accepted, []);
    assert.match(result.rejected[0].reasons.join("\n"), /no repairable open implementation PR/);
  } finally {
    process.chdir(previous);
  }
});

test("live fence keeps same-repository implementation PRs writable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-live-cluster-"));
  const pathValue = job(root, 54, [920, 921]);
  const previous = process.cwd();
  process.chdir(root);
  try {
    const result = filterClusterCandidatesLive({
      repo: "openclaw/openclaw",
      paths: [pathValue],
      now: new Date("2026-07-26T00:00:00Z"),
      readItem: (number) => ({
        number,
        state: "open",
        title: number === 920 ? "Telegram upload crashes" : "Fix Telegram upload crash",
        updated_at: "2026-07-25T00:00:00Z",
        labels: [{ name: "bug" }],
        ...(number === 921 ? { pull_request: {} } : {}),
      }),
      readPull: () => ({
        draft: false,
        maintainer_can_modify: false,
        head: { repo: { full_name: "openclaw/openclaw" } },
      }),
    });
    assert.deepEqual(result.accepted, [pathValue]);
    assert.deepEqual(result.rejected, []);
  } finally {
    process.chdir(previous);
  }
});

test("live fence rejects a security disclosure added to the current issue body", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-live-cluster-"));
  const pathValue = job(root, 48, [700, 701]);
  const previous = process.cwd();
  process.chdir(root);
  try {
    const result = filterClusterCandidatesLive({
      repo: "openclaw/openclaw",
      paths: [pathValue],
      now: new Date("2026-07-26T00:00:00Z"),
      readItem: (number) => ({
        number,
        state: "open",
        title: "Telegram upload crash",
        body: number === 700 ? "This exposes a reusable authentication token." : "Fix upload.",
        updated_at: "2026-07-25T00:00:00Z",
        labels: [{ name: "bug" }],
      }),
      readPull: () => ({ draft: false, maintainer_can_modify: true }),
    });
    assert.deepEqual(result.accepted, []);
    assert.match(result.rejected[0].reasons.join("\n"), /security signal/);
  } finally {
    process.chdir(previous);
  }
});

test("live fence rejects newly added product, protected, and injection signals", () => {
  const cases = [
    {
      clusterId: 49,
      title: "Feature request: support Telegram upload themes",
      body: "",
      labels: [{ name: "enhancement" }],
      reason: /feature or proposal/,
    },
    {
      clusterId: 50,
      title: "Telegram upload behavior",
      body: "Needs a maintainer decision before changing compatibility.",
      labels: [{ name: "clawsweeper:needs-product-decision" }],
      reason: /maintainer or product decision/,
    },
    {
      clusterId: 51,
      title: "Fix SQL injection in Telegram webhook filter",
      body: "A crafted query reaches the database.",
      labels: [{ name: "bug" }],
      reason: /security signal/,
    },
  ];
  for (const fixture of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-live-cluster-"));
    const pathValue = job(root, fixture.clusterId, [800, 801]);
    const previous = process.cwd();
    process.chdir(root);
    try {
      const result = filterClusterCandidatesLive({
        repo: "openclaw/openclaw",
        paths: [pathValue],
        now: new Date("2026-07-26T00:00:00Z"),
        readItem: (number) => ({
          number,
          state: "open",
          title: number === 800 ? fixture.title : "Fix Telegram upload behavior",
          body: number === 800 ? fixture.body : "",
          updated_at: "2026-07-25T00:00:00Z",
          labels: number === 800 ? fixture.labels : [{ name: "bug" }],
        }),
        readPull: () => ({ draft: false, maintainer_can_modify: true }),
      });
      assert.deepEqual(result.accepted, []);
      assert.match(result.rejected[0].reasons.join("\n"), fixture.reason);
    } finally {
      process.chdir(previous);
    }
  }
});

test("live fence screens closed context members outside the mutation candidates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-live-cluster-"));
  const pathValue = job(root, 52, [900, 901], [900, 901, 902]);
  const previous = process.cwd();
  process.chdir(root);
  try {
    const result = filterClusterCandidatesLive({
      repo: "openclaw/openclaw",
      paths: [pathValue],
      now: new Date("2026-07-26T00:00:00Z"),
      readItem: (number) => ({
        number,
        state: number === 902 ? "closed" : "open",
        title:
          number === 902
            ? "Webhook filter permits SQL injection"
            : "Webhook filter crashes on malformed predicates",
        updated_at: "2026-07-25T00:00:00Z",
        labels: [{ name: "bug" }],
      }),
      readPull: () => ({ draft: false, maintainer_can_modify: true }),
    });
    assert.deepEqual(result.accepted, []);
    assert.match(result.rejected[0].reasons.join("\n"), /cluster context has a security signal/);
  } finally {
    process.chdir(previous);
  }
});

test("live fence rejects a label-only security escalation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-live-cluster-"));
  const pathValue = job(root, 53, [910, 911]);
  const previous = process.cwd();
  process.chdir(root);
  try {
    const result = filterClusterCandidatesLive({
      repo: "openclaw/openclaw",
      paths: [pathValue],
      now: new Date("2026-07-26T00:00:00Z"),
      readItem: (number) => ({
        number,
        state: "open",
        title: "Webhook filter fails on malformed predicates",
        updated_at: "2026-07-25T00:00:00Z",
        labels: [{ name: number === 910 ? "impact:security" : "bug" }],
      }),
      readPull: () => ({ draft: false, maintainer_can_modify: true }),
    });
    assert.deepEqual(result.accepted, []);
    assert.match(result.rejected[0].reasons.join("\n"), /cluster context has a security signal/);
  } finally {
    process.chdir(previous);
  }
});
