import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  existingGitcrawlClusterIds,
  existingGitcrawlMemberRefs,
} from "../../dist/repair/gitcrawl-cluster-history.js";

test("member history spans inbox, archived jobs, and durable result roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-history-"));
  const inbox = path.join(root, "jobs", "openclaw", "inbox");
  const closed = path.join(root, "jobs", "openclaw", "closed");
  const results = path.join(root, "results", "openclaw");
  for (const directory of [inbox, closed, results]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(inbox, "gitcrawl-1.md"), report([101, 102]));
  fs.writeFileSync(path.join(closed, "gitcrawl-2.md"), report([201, 202]));
  fs.writeFileSync(path.join(results, "gitcrawl-3-result.md"), report([301, 302, 101]));
  fs.writeFileSync(
    path.join(results, "gitcrawl-4-foreign.md"),
    report([101, 401], "openclaw/gogcli"),
  );

  const refs = existingGitcrawlMemberRefs(
    [inbox, path.join(root, "jobs"), results],
    "openclaw/openclaw",
    root,
  );
  assert.deepEqual(
    [...refs.keys()].sort((left, right) => left - right),
    [101, 102, 201, 202, 301, 302],
  );
  assert.deepEqual(refs.get(201), ["jobs/openclaw/closed/gitcrawl-2.md"]);
  assert.deepEqual(refs.get(301), ["results/openclaw/gitcrawl-3-result.md"]);
  assert.deepEqual(refs.get(101), [
    "jobs/openclaw/inbox/gitcrawl-1.md",
    "results/openclaw/gitcrawl-3-result.md",
  ]);
});

test("cluster history scopes repository-local IDs and reads the durable intake ledger", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-id-history-"));
  fs.writeFileSync(
    path.join(root, "gitcrawl-42-openclaw.md"),
    report([101], "openclaw/openclaw", 42),
  );
  fs.writeFileSync(path.join(root, "gitcrawl-43-foreign.md"), report([101], "openclaw/gogcli", 43));
  fs.writeFileSync(
    path.join(root, "openclaw-openclaw.json"),
    JSON.stringify({
      target_repo: "openclaw/openclaw",
      clusters: { 44: { status: "dispatched" } },
      stores: [
        {
          selector_decision: {
            rationale: "One useful cluster; one already fixed.",
            assessments: [
              { cluster_id: 44, decision: "selected" },
              { cluster_id: 46, decision: "rejected" },
            ],
          },
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(root, "openclaw-gogcli.json"),
    JSON.stringify({ target_repo: "openclaw/gogcli", clusters: { 45: { status: "dispatched" } } }),
  );

  assert.deepEqual(
    [...existingGitcrawlClusterIds([root], "openclaw/openclaw")].sort(
      (left, right) => left - right,
    ),
    [42, 44, 46],
  );
});

function report(refs: readonly number[], repo = "openclaw/openclaw", clusterId?: number): string {
  const cluster = clusterId ? `cluster_id: gitcrawl-${clusterId}-proof\n` : "";
  return `---\nrepo: ${repo}\n${cluster}cluster_refs:\n${refs.map((ref) => `  - #${ref}`).join("\n")}\n---\n`;
}
