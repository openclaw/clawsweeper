import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("job sweep uses explicit security metadata, not raw job prose", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-security-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jobs = path.join(dir, "jobs");
  fs.mkdirSync(jobs);
  const fixtures = [
    { name: "prose", metadata: "", body: "Security advisory CVE-2026-12345 GHSA-1234-5678-abcd" },
    { name: "marker", metadata: "", body: "<!-- clawsweeper-security:security -->" },
    { name: "route", metadata: "route: security\n", body: "Ordinary task" },
    { name: "verdict", metadata: "verdict: security\n", body: "Ordinary task" },
    { name: "sensitive", metadata: "security_sensitive: true\n", body: "Ordinary task" },
  ];
  for (const fixture of fixtures) {
    fs.writeFileSync(
      path.join(jobs, `${fixture.name}.md`),
      `---\nrepo: openclaw/openclaw\ncluster_id: exact-security-test-${fixture.name}\nmode: autonomous\nallowed_actions:\n  - comment\ncandidates:\n  - "#123"\n${fixture.metadata}---\n${fixture.body}\n`,
    );
  }
  const result = spawnSync(
    process.execPath,
    [
      path.join(process.cwd(), "dist/repair/sweep-openclaw-jobs.js"),
      "--jobs",
      jobs,
      "--report",
      path.join(dir, "report.json"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const names = (rows: { job: string }[]) => rows.map((row) => path.basename(row.job)).sort();
  assert.deepEqual(names(report.security_hold_jobs), ["route.md", "verdict.md"]);
  assert.deepEqual(names(report.stuck_jobs), ["marker.md", "prose.md"]);
  assert.deepEqual(names(report.invalid_jobs), ["sensitive.md"]);
});
