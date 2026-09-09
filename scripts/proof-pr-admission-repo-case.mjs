// Proof: the built `review` entrypoint accepts the exact-event PR admission handoff when the
// workflow spells the target repo in mixed case (steipete/CodexBar) while the fallback
// repository profile carries the lowercased slug. Git/GitHub/model boundaries are synthetic.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] || ".artifacts/pr-admission-repo-case-proof");
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
const repo = "steipete/CodexBar";
const pull = {
  number: 3246,
  title: "Synthetic mixed-case repo PR",
  body: "Synthetic body",
  comments: 0,
  review_comments: 0,
  state: "open",
  locked: false,
  additions: 1200,
  deletions: 839,
  changed_files: 12,
  head: { sha: "a881c63d08d36e3926aaa7b97a2eef2e438cd53b" },
  base: { ref: "main", sha: "a".repeat(40) },
  user: { login: "synthetic-contributor" },
  author_association: "CONTRIBUTOR",
  draft: false,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-09T14:52:19Z",
  labels: [],
};
const environment = {
  ...process.env,
  CLAWSWEEPER_OVERSIZED_PR_CLOSE_ENABLED: "false",
  CLAWSWEEPER_MAX_PR_CHANGED_LINES: "50000",
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
    `$ node dist/clawsweeper.js ${args.join(" ").replaceAll(root, "<proof>")}\nexit=${result.status}\n${normalized.trim()}`,
  );
  writeFileSync(join(root, `${label}.log`), normalized);
  return result;
};
// Mirrors the production exact-event invocation: --target-repo as GitHub spells it, --item-numbers, handoff file.
const reviewArgs = (admission, artifactDir) => [
  "review",
  "--target-repo",
  repo,
  "--item-numbers",
  String(pull.number),
  "--skip-start-comment",
  "--artifact-dir",
  artifactDir,
  "--target-dir",
  root,
  "--pr-admission-file",
  admission,
];

writeFileSync(calls, "");
const admitted = join(root, "admitted.json");
writeFileSync(
  admitted,
  JSON.stringify({ repo, observedAt: "2026-09-09T15:11:31.000Z", pull }, null, 2),
);
const admittedResult = run("admitted", reviewArgs(admitted, join(root, "admitted")));
const admittedOutput = `${admittedResult.stdout}${admittedResult.stderr}`;
assert.doesNotMatch(
  admittedOutput,
  /PR admission metadata does not match/,
  "mixed-case handoff must not be rejected as a repo mismatch",
);
assert.match(
  admittedOutput,
  /CONTROL_REACHED_NORMAL_HYDRATION/,
  "admitted PR must proceed past admission into normal hydration",
);
const observed = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
assert.ok(observed.length > 0, "admitted PR must reach the synthetic Git/GitHub boundary");
transcript.push(
  `Admitted mixed-case handoff: passed readPrAdmissionInput and stopped at the synthetic boundary after ${observed.length} git/gh calls.`,
);

writeFileSync(calls, "");
const oversized = join(root, "oversized.json");
writeFileSync(
  oversized,
  JSON.stringify(
    {
      repo,
      observedAt: "2026-09-09T15:11:31.000Z",
      pull: { ...pull, additions: 60000, deletions: 1 },
    },
    null,
    2,
  ),
);
const oversizedItems = join(root, "oversized-items");
const oversizedResult = run("oversized", reviewArgs(oversized, oversizedItems));
assert.equal(oversizedResult.status, 0, oversizedResult.stderr);
assert.equal(readFileSync(calls, "utf8"), "", "oversized admission must not invoke subprocesses");
const report = readFileSync(join(oversizedItems, `${pull.number}.md`), "utf8");
assert.match(report, /^close_reason: oversized_pull_request$/m);
assert.match(report, /^review_model: none$/m);
// Fallback repository profiles do not list oversized_pull_request in their apply close rules,
// so the metadata-only decision is recorded but not proposed for close.
assert.match(report, /^action_taken: skipped_invalid_decision$/m);
transcript.push(
  "Oversized mixed-case handoff: metadata-only oversized decision written with zero git/gh/codex calls; the fallback profile's apply policy does not allow that close reason, so action_taken is skipped_invalid_decision.",
);
transcript.push(
  "Limits: synthetic Git/GitHub/model boundaries; no live GitHub reads or mutations. The admitted case deliberately stops at hydration entry.",
);
writeFileSync(join(root, "transcript.txt"), transcript.join("\n\n"));
console.log(transcript.join("\n\n"));
