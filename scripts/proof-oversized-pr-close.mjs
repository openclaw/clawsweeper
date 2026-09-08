import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] || ".artifacts/oversized-pr-proof");
mkdirSync(root, { recursive: true });
const calls = join(root, "calls.jsonl");
const fake = join(root, "boundary.mjs");
writeFileSync(
  fake,
  `import { appendFileSync } from 'node:fs';
const [kind, ...args] = process.argv.slice(2);
appendFileSync(process.env.PROOF_CALLS, JSON.stringify({kind,args})+'\\n');
if (kind === 'git') {
  if (args.includes('--is-shallow-repository')) console.log('false');
  else if (args[0] === 'symbolic-ref' || args.includes('--abbrev-ref')) console.log('main');
  else if (args[0] !== 'fetch') console.log('a'.repeat(40));
} else if (kind === 'gh' && args.includes('release')) console.log('[]');
else { console.error('CONTROL_REACHED_NORMAL_HYDRATION'); process.exit(91); }
`,
);
const pull = {
  number: 141913,
  title: "Synthetic oversized PR",
  state: "open",
  locked: false,
  additions: 45791,
  deletions: 120895,
  changed_files: 2747,
  head: { sha: "b".repeat(40) },
  base: { ref: "main", sha: "a".repeat(40) },
  user: { login: "synthetic-owner" },
  author_association: "OWNER",
  draft: true,
  created_at: "2026-02-01T00:00:00Z",
  updated_at: "2026-05-01T00:00:00Z",
  labels: [],
};
const environment = {
  ...process.env,
  CLAWSWEEPER_OVERSIZED_PR_CLOSE_ENABLED: "false",
  CLAWSWEEPER_MAX_PR_CHANGED_LINES: "30000",
  PROOF_CALLS: calls,
};
for (const kind of ["gh", "git", "codex"]) {
  environment[`${kind.toUpperCase()}_BIN`] = process.execPath;
  environment[`${kind.toUpperCase()}_BIN_ARGS`] = JSON.stringify([fake, kind]);
}
const transcript = [];
const run = (label, args) => {
  const result = spawnSync(process.execPath, ["dist/clawsweeper.js", ...args], {
    env: environment,
    encoding: "utf8",
  });
  const normalized = `${result.stdout}${result.stderr}`
    .replaceAll(root, "<proof>")
    .replaceAll(process.cwd(), "<checkout>")
    .replaceAll(process.execPath, "<node>");
  transcript.push(
    `$ node dist/clawsweeper.js ${args.join(" ").replaceAll(root, "<proof>")}\nexit=${result.status}\n${normalized}`,
  );
  writeFileSync(join(root, `${label}.log`), normalized);
  return result;
};
writeFileSync(calls, "");
const oversized = join(root, "oversized.json");
writeFileSync(oversized, JSON.stringify({ repo: "openclaw/openclaw", pull }, null, 2));
const items = join(root, "items");
const reviewArgs = [
  "review",
  "--target-repo",
  "openclaw/openclaw",
  "--item-number",
  String(pull.number),
  "--skip-start-comment",
];
const result = run("oversized", [
  ...reviewArgs,
  "--artifact-dir",
  items,
  "--pr-admission-file",
  oversized,
]);
assert.equal(result.status, 0, result.stderr);
assert.equal(
  readFileSync(calls, "utf8"),
  "",
  "oversized admission must not invoke git/GitHub/model subprocesses",
);
const reportPath = join(items, `${pull.number}.md`);
const report = readFileSync(reportPath, "utf8");
assert.match(report, /action_taken: proposed_close/);
assert.match(report, /review_model: none/);
assert.match(report, /local_checkout_access: unverified/);
const metadata = report.match(/^oversized_pull_request: (.+)$/m)?.[1];
assert.deepEqual(JSON.parse(metadata), {
  additions: 45791,
  deletions: 120895,
  changedFiles: 2747,
  threshold: 30000,
  head: "b".repeat(40),
});
const closeComment = report.slice(report.indexOf("ClawSweeper closed this pull request"));
transcript.push(
  `Metadata: ${metadata}\nComment: ${closeComment.trim()}\nOversized subprocess counts: git=0 gh=0 codex=0; runtime hydration=0 scanner=0 codex=0.`,
);
const closed = join(root, "closed");
const apply = run("apply-disabled", [
  "apply-decisions",
  "--target-repo",
  "openclaw/openclaw",
  "--items-dir",
  items,
  "--closed-dir",
  closed,
  "--plans-dir",
  join(root, "plans"),
  "--report-path",
  join(root, "apply.json"),
  "--item-number",
  String(pull.number),
  "--apply-kind",
  "all",
  "--min-age-minutes",
  "0",
  "--skip-dashboard",
  "--dry-run",
]);
assert.equal(apply.status, 0, apply.stderr);
assert.ok(existsSync(reportPath));
assert.equal(existsSync(join(closed, `${pull.number}.md`)), false);
assert.equal(readFileSync(calls, "utf8"), "");
transcript.push(
  `Apply: ${readFileSync(join(root, "apply.json"), "utf8").trim()}\nProposal remains in items; no GitHub mutation.`,
);
const control = join(root, "control.json");
writeFileSync(
  control,
  JSON.stringify(
    { repo: "openclaw/openclaw", pull: { ...pull, additions: 29999, deletions: 0 } },
    null,
    2,
  ),
);
const controlResult = run("control", [
  ...reviewArgs,
  "--artifact-dir",
  join(root, "control"),
  "--target-dir",
  root,
  "--pr-admission-file",
  control,
]);
assert.notEqual(controlResult.status, 0);
const observed = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
assert.ok(
  observed.some(
    ({ kind, args }) =>
      kind === "gh" && args.includes(`repos/openclaw/openclaw/issues/${pull.number}`),
  ),
  JSON.stringify(observed),
);
assert.ok(observed.every(({ kind }) => kind !== "codex"));
transcript.push(
  `Control admitted: entered normal issue hydration and stopped at the synthetic GitHub boundary. Calls: ${JSON.stringify(observed)}\nLimits: synthetic GitHub and Git boundaries; no live GitHub close, workflow dispatch, scanner or model execution. Control stops at hydration entry.`,
);
writeFileSync(join(root, "transcript.txt"), transcript.join("\n\n") + "\n");
console.log(transcript.join("\n\n"));
