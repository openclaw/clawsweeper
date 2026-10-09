import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const source = path.resolve(".");
fs.mkdirSync(path.join(source, ".artifacts"), { recursive: true });
const root = fs.mkdtempSync(path.join(source, ".artifacts/implementation-backfill-"));
fs.cpSync("dist", path.join(root, "dist"), { recursive: true });
fs.cpSync("config", path.join(root, "config"), { recursive: true });
fs.mkdirSync(path.join(root, "scripts"));
fs.copyFileSync(
  "scripts/dispatch-issue-implementation-candidates.mjs",
  path.join(root, "scripts/dispatch-issue-implementation-candidates.mjs"),
);
const workflow = YAML.parse(fs.readFileSync(".github/workflows/sweep.yml", "utf8"));
const step = workflow.jobs.plan.steps.find(
  (candidate) => candidate.name === "Backfill existing implementation candidates",
);
const capture = path.join(root, "dispatch.jsonl");
const gh = path.join(root, "gh.mjs");
// Lane health lists recent worker runs; an empty history keeps the lane open.
fs.writeFileSync(
  gh,
  `import fs from "node:fs"; const args = process.argv.slice(2);
if (args[0] === "api") { process.stdout.write(JSON.stringify({ total_count: 0, workflow_runs: [] })); process.exit(0); }
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(args)+"\\n");`,
);
const pnpm = path.join(root, "pnpm.mjs");
fs.writeFileSync(
  pnpm,
  `import {execFileSync} from "node:child_process";
const args=process.argv.slice(2); if(args[2]!=="repair:issue-implementation-intake") throw Error("unexpected package command");
process.stdout.write(execFileSync(process.execPath,[${JSON.stringify(path.join(root, "dist/repair/issue-implementation-intake.js"))},...args.slice(4)],{encoding:"utf8"}));`,
);
const results = [];
for (const [repo, kind] of [
  ["openclaw/openclaw", "vision_fit"],
  ["openclaw/synthetic", "viable"],
]) {
  const reports = path.join(root, "records", repo.replace("/", "-"), "items");
  fs.mkdirSync(reports, { recursive: true });
  for (const number of [41, 42, 43]) {
    const fields = {
      number,
      repository: repo,
      type: "issue",
      state_at_review: "open",
      review_status: "complete",
      decision: "keep_open",
      close_reason: "none",
      confidence: "high",
      work_candidate: "queue_fix_pr",
      work_confidence: "high",
      work_validation: '["pnpm test"]',
      work_likely_files: '["src/example.ts"]',
      work_cluster_refs: `['#${number}']`,
      labels: "[]",
      item_category: "feature",
      reproduction_status: "not_applicable",
      requires_new_feature: "true",
      requires_new_config_option: "false",
      requires_product_decision: "false",
      auto_implementation_candidate: kind,
      vision_fit: "aligned",
      vision_fit_evidence: '["Synthetic narrow product direction"]',
      implementation_complexity: "small",
      ...(number === 41 ? { publication_policy: "record_comment_only" } : {}),
    };
    fs.writeFileSync(
      path.join(reports, `${number}.md`),
      `---\n${Object.entries(fields)
        .map(([key, value]) => `${key}: ${value}`)
        .join(
          "\n",
        )}\n---\n\n## Security Review\n\nStatus: not_applicable\n\nSummary: No patch security review is needed for this issue.\n\n## Repair Work Prompt\n\nImplement the narrow reviewed behavior.\n`,
    );
  }
  fs.writeFileSync(capture, "");
  execFileSync("bash", ["-euo", "pipefail", "-c", step.run], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      TARGET_REPO: repo,
      CANDIDATE_KIND: kind,
      MAX_DISPATCH: "1",
      GH_BIN: process.execPath,
      GH_BIN_ARGS: JSON.stringify([gh]),
      PNPM_BIN: process.execPath,
      PNPM_BIN_ARGS: JSON.stringify([pnpm]),
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
    },
    encoding: "utf8",
  });
  const dispatches = fs.readFileSync(capture, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(dispatches.length, 1);
  assert.deepEqual(dispatches[0].slice(0, 3), [
    "workflow",
    "run",
    "repair-issue-implementation-intake.yml",
  ]);
  assert.ok(dispatches[0].includes(`target_repo=${repo}`));
  assert.ok(dispatches[0].includes(`candidate_kind=${kind}`));
  assert.ok(!dispatches[0].includes("item_number=41"));
  results.push({ repo, kind, dispatched: 1, manualRecordExcluded: true, limitRespected: true });
}
const receipt = {
  ok: true,
  results,
  surface:
    "Actual workflow Bash, shared dispatcher and compiled canonical-report discovery; GitHub writes captured locally",
  source_sha256: Object.fromEntries(
    [".github/workflows/sweep.yml", "scripts/dispatch-issue-implementation-candidates.mjs"].map(
      (file) => [file, createHash("sha256").update(fs.readFileSync(file)).digest("hex")],
    ),
  ),
  artifact: root,
};
fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
