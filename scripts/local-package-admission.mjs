import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const operationalPaths = new Set([
  ".github/workflows/audit.yml",
  ".github/workflows/sweep.yml",
  ".github/workflows/failed-review-retry.yml",
  "test/node-build-workflows.test.ts",
]);
const sha = /^[a-f0-9]{40}$/;
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function classify() {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
    return { required: true, reason: "not-pull-request" };
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pr = event.pull_request;
  const repository = process.env.GITHUB_REPOSITORY;
  const base = pr?.base?.sha;
  const head = pr?.head?.sha;
  const merge = process.env.GITHUB_SHA;
  if (
    !repository ||
    event.repository?.full_name !== repository ||
    pr?.base?.repo?.full_name !== repository ||
    pr?.head?.repo?.full_name !== repository ||
    !Number.isSafeInteger(event.number) ||
    event.number < 1 ||
    process.env.GITHUB_REF !== `refs/pull/${event.number}/merge` ||
    !sha.test(base ?? "") ||
    !sha.test(head ?? "") ||
    !sha.test(merge ?? "")
  ) {
    return { required: true, reason: "unbound-pull-request" };
  }
  if (
    git("rev-parse", "HEAD").trim() !== merge ||
    git("show", "--no-patch", "--format=%P", merge).trim() !== `${base} ${head}`
  ) {
    return { required: true, reason: "unbound-checkout" };
  }
  // The consumers execute the PR head, not the synthetic merge. Comparing its
  // tree to the bound base also makes behind-base package changes require proof.
  // --no-renames exposes both endpoints; NUL separation preserves literal paths.
  const changed = git(
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    base,
    head,
    "--",
  );
  if (!changed || !changed.endsWith("\0")) {
    return { required: true, reason: "empty-comparison" };
  }
  const paths = changed.slice(0, -1).split("\0");
  const operational = paths.every(
    (path) =>
      operationalPaths.has(path) || /^changelog\.d\/[a-z0-9._-]+\.md$/.exec(path)?.[0] === path,
  );
  return {
    required: !operational,
    reason: operational ? "operational-only" : "package-or-unknown-surface",
    changedPaths: paths.length,
    base,
    head,
    merge,
  };
}

let result;
try {
  result = classify();
} catch {
  // Missing/shallow Git objects, unavailable Git and malformed events admit the
  // full qualification. Only a completed, bound comparison may skip consumers.
  result = { required: true, reason: "comparison-unavailable" };
}
appendFileSync(process.env.GITHUB_OUTPUT, `package-required=${result.required}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `Local package qualification: ${result.required ? "required" : "skipped"} (${result.reason}).\n`,
  );
}
console.log(JSON.stringify(result));
