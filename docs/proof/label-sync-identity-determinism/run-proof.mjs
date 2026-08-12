// Real-behavior proof: the `issue_labels_sync` mutation identity depends only on the
// label set, not on the order the labels were queued or on the runner's locale.
//
// Exercises the shipped factory in dist/clawsweeper-label-mutations.js — the module
// that batches issue label edits and stamps each published mutation with the identity
// the action ledger dedupes on.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// `--module <path>` swaps in a differently compiled build of the same module so the
// runner can be pointed at the pre-fix source for a before/after contrast.
const moduleFlag = process.argv.indexOf("--module");
const modulePath =
  moduleFlag === -1
    ? new URL("../../../dist/clawsweeper-label-mutations.js", import.meta.url).href
    : pathToFileURL(resolve(process.argv[moduleFlag + 1] ?? "")).href;
const { createLabelMutationOperations } = await import(modulePath);
const EMIT_ONLY = process.argv.includes("--emit-identity");
if (!EMIT_ONLY) {
  console.log(`module under test: ${modulePath.replace(/^file:\/\//, "")}`);
  console.log(`ICU default locale: ${new Intl.Collator().resolvedOptions().locale}\n`);
}

function identityFor(additions, removals) {
  const mutations = [];
  const operations = createLabelMutationOperations({
    ghJson: () => [],
    ghObservedMutationCommand: (mutation) => {
      mutations.push(mutation);
      mutation.onMutation?.();
    },
    normalizeLabelName: (label) => label.trim().toLowerCase(),
    prStatusLabelForKind: () => ({
      name: "status:ready",
      color: "1F883D",
      description: "Ready for maintainer review.",
    }),
  });
  operations.beginIssueLabelMutationBatch(321);
  for (const label of additions) operations.addIssueLabel(321, label);
  for (const label of removals) operations.removeIssueLabel(321, label);
  operations.flushIssueLabelMutationBatch(321);
  return mutations.find((m) => m.identity?.startsWith("issue_labels_sync:"))?.identity ?? "";
}

// `--emit-identity` turns this file into a one-shot probe, printing nothing but the
// key, so the parent can run it again under a different ICU locale and compare.
if (EMIT_ONLY) {
  process.stdout.write(identityFor(["zulu", "Alpha", "äpple", "apple"], []));
  process.exit(0);
}

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    failures += 1;
    if (detail) console.log(`        ${detail}`);
  }
};

// Real ClawSweeper label names, plus the kind of third-party label a reviewed
// repository can already carry.
const ADDITIONS = ["P2", "impact:message-loss", "maturity:stable", "proof: sufficient", "Accent"];
const REMOVALS = ["P1", "impact:data-loss", "status:stale"];

console.log("== 1. the identity does not depend on queue order ==");
const baseline = identityFor(ADDITIONS, REMOVALS);
console.log(`  baseline: ${baseline}`);
check(baseline !== "", "a batch publishes an issue_labels_sync mutation");
for (const [name, add, remove] of [
  ["reversed", [...ADDITIONS].reverse(), [...REMOVALS].reverse()],
  ["default sort", [...ADDITIONS].sort(), [...REMOVALS].sort()],
  [
    "rotated",
    [...ADDITIONS.slice(2), ...ADDITIONS.slice(0, 2)],
    [...REMOVALS.slice(1), REMOVALS[0]],
  ],
]) {
  const actual = identityFor(add, remove);
  check(actual === baseline, `${name} queue order yields the same identity`, actual);
}

console.log("\n== 2. collator ties still get a total order ==");
// GitHub allows emoji in label names, and a zero-width joiner makes two visually
// similar names distinct strings that many collators nonetheless rank as equal.
const TIED = ["status: \u{1F440}‍ ready", "status: \u{1F440} ready"];
check(TIED[0] !== TIED[1], "the two names really are different strings");
console.log(`  localeCompare(a, b) = ${TIED[0].localeCompare(TIED[1])}`);
const tiedBaseline = identityFor(TIED, []);
check(identityFor([...TIED].reverse(), []) === tiedBaseline, "tied names sort deterministically");

console.log("\n== 3. the identity is byte-for-byte reproducible ==");
// Code unit order is fully specified, so the exact key can be asserted. A collator
// places "apple" next to "apple" in most locales and after "zulu" in sv-SE.
const exact = identityFor(["zulu", "Alpha", "äpple", "apple"], []);
check(
  exact === "issue_labels_sync:321:add=Alpha|apple|zulu|äpple:remove=",
  "uppercase sorts first and non-ASCII last",
  exact,
);

console.log("\n== 4. two differently configured runners agree ==");
// This is the failure that matters in production: the same label set, batched the
// same way, must not produce two different idempotency keys on two runners.
const identities = ["en_US.UTF-8", "sv_SE.UTF-8"].map((locale) => {
  const child = spawnSync(
    process.execPath,
    [new URL(import.meta.url).pathname, "--emit-identity", ...process.argv.slice(2)],
    { encoding: "utf8", env: { ...process.env, LANG: locale, LC_ALL: locale } },
  );
  console.log(`  ${locale.padEnd(12)} ${child.stdout || `(exit ${child.status})`}`);
  return child.stdout;
});
check(
  identities[0] === identities[1] && identities[0] !== "",
  "en_US and sv_SE produce the same identity",
);

console.log(`\n${failures === 0 ? "PROOF PASSED" : `PROOF FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
