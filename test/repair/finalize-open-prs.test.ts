import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mockGhBinEnv } from "../helpers.ts";

test("finalizer ignores an older failed run after the same check succeeds", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-finalizer-"));
  const fakeBin = path.join(temporary, "bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'pr' && args[1] === 'list') {",
      "  process.stdout.write(JSON.stringify([{ number: 123, title: 'fix: example', url: 'https://github.com/openclaw/openclaw/pull/123', headRefName: 'clawsweeper/example', updatedAt: '2026-08-10T12:00:00Z' }]));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'pr' && args[1] === 'view') {",
      "  process.stdout.write(JSON.stringify({",
      "    number: 123, title: 'fix: example', url: 'https://github.com/openclaw/openclaw/pull/123',",
      "    baseRefName: 'main', headRefName: 'clawsweeper/example', headRefOid: 'a'.repeat(40),",
      "    isDraft: false, labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',",
      "    reviewDecision: null, reviews: [], comments: [], state: 'OPEN', updatedAt: '2026-08-10T12:00:00Z',",
      "    statusCheckRollup: [",
      "      { name: 'unit', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-08-10T10:00:00Z', completedAt: '2026-08-10T10:05:00Z' },",
      "      { name: 'unit', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-08-10T11:00:00Z', completedAt: '2026-08-10T11:05:00Z' },",
      "    ],",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'graphql') {",
      "  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }));",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
      "process.exit(2);",
    ].join("\n"),
    { mode: 0o755 },
  );

  try {
    const output = execFileSync(process.execPath, ["dist/repair/finalize-open-prs.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...mockGhBinEnv(path.join(fakeBin, "gh"), fakeBin),
      },
      encoding: "utf8",
    });
    const report = JSON.parse(output);

    assert.equal(report.prs[0]?.checks.total, 1);
    assert.deepEqual(report.prs[0]?.checks.counts, { SUCCESS: 1 });
    assert.deepEqual(report.prs[0]?.checks.blockers, []);
    assert.equal(
      report.prs[0]?.blockers.some((blocker: string) => blocker.startsWith("needs_checks:")),
      false,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
