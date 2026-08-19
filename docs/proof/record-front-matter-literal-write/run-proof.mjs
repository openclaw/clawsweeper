// Real-behavior proof: a GitHub label name containing a `$`-replacement pattern must
// be stored in a record's front matter verbatim, and a front matter key must be
// matched literally rather than compiled as a regular expression.
//
// Exercises the shipped factory in dist/clawsweeper-record-metadata.js — the module
// the label apply lane writes `labels:` through.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// `--module <path>` swaps in a differently compiled build of the same module so the
// runner can be pointed at the pre-fix source for a before/after contrast.
const moduleFlag = process.argv.indexOf("--module");
const modulePath =
  moduleFlag === -1
    ? new URL("../../../dist/clawsweeper-record-metadata.js", import.meta.url).href
    : pathToFileURL(resolve(process.argv[moduleFlag + 1] ?? "")).href;
const { createRecordMetadata } = await import(modulePath);
console.log(`module under test: ${modulePath.replace(/^file:\/\//, "")}\n`);

const noop = () => null;
const metadata = createRecordMetadata({
  reportFileName: (repo, number) => `${number}.md`,
  markdownRepository: () => "openclaw/openclaw",
  isVerifiedFixedCloseReason: () => false,
  isOlderThanDays: () => false,
  timestampMs: (value) => (value ? Date.parse(value) : null),
  pullHeadShaFromReport: noop,
  reviewLeaseRevisionFromReport: noop,
  lockedConversationApplyReason: noop,
  markdownFiles: () => [],
  numberForMarkdownFile: () => 0,
});

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    failures += 1;
    if (detail) console.log(`        ${detail}`);
  }
};

const RECORD = [
  "---",
  "repository: openclaw/openclaw",
  "number: 42",
  "labels: []",
  "title: Fix the thing",
  "---",
  "",
  "Codex review: ready.",
  "",
].join("\n");

console.log("== 1. label names are stored verbatim ==");
// The apply lane writes labels as replaceFrontMatterValue(markdown, "labels",
// JSON.stringify(item.labels)). Those names come from the reviewed repository and
// GitHub permits `$`, a backtick and a quote inside a label name.
for (const labels of [
  ["bug"],
  ["$&"],
  ["$`"],
  ["$'"],
  ["a$&b"],
  ["$$"],
  ["P$1"],
  ["needs-triage", "$&"],
]) {
  const written = JSON.stringify(labels);
  const next = metadata.replaceFrontMatterValue(RECORD, "labels", written);
  const raw = metadata.frontMatterValue(next, "labels");
  const readBack = metadata.frontMatterStringArray(next, "labels");
  const ok = raw === written && JSON.stringify(readBack) === written;
  check(ok, `labels ${written}`, `stored ${JSON.stringify(raw)}, read back ${JSON.stringify(readBack)}`);
}

console.log("\n== 2. the stored value stays valid JSON ==");
for (const labels of [["$`"], ["$'"], ["$&"]]) {
  const written = JSON.stringify(labels);
  const next = metadata.replaceFrontMatterValue(RECORD, "labels", written);
  const raw = metadata.frontMatterValue(next, "labels") ?? "";
  let parsed = null;
  let error = null;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    error = String(cause);
  }
  check(
    error === null && JSON.stringify(parsed) === written,
    `JSON.parse round-trips ${written}`,
    error ?? `parsed ${JSON.stringify(parsed)}`,
  );
}

console.log("\n== 3. the rest of the record is untouched ==");
{
  const next = metadata.replaceFrontMatterValue(RECORD, "labels", JSON.stringify(["$'"]));
  check(metadata.frontMatterValue(next, "title") === "Fix the thing", "title survives");
  check(metadata.frontMatterValue(next, "number") === "42", "number survives");
  check(next.includes("Codex review: ready."), "body survives");
  check(next.split("---").length === RECORD.split("---").length, "delimiters are unchanged");
}

console.log("\n== 4. keys are matched literally ==");
for (const key of ["a.c", "a+b", "x(y", "k[0]", "q|r", "n*m"]) {
  const record = ["---", `${key}: original`, "---", "", "body", ""].join("\n");
  let readOk = false;
  let writeOk = false;
  let error = null;
  try {
    readOk = metadata.frontMatterValue(record, key) === "original";
    const next = metadata.replaceFrontMatterValue(record, key, "updated");
    writeOk = metadata.frontMatterValue(next, key) === "updated" && !next.includes(`${key}: original`);
  } catch (cause) {
    error = String(cause);
  }
  check(readOk && writeOk, `key ${JSON.stringify(key)} reads and updates in place`, error);
}
{
  // A literal key must not match a different, regex-equivalent line.
  const decoy = ["---", "aXc: decoy", "---", "", "body", ""].join("\n");
  check(metadata.frontMatterField(decoy, "a.c").status === "absent", "`a.c` does not match `aXc`");
}

console.log(`\n${failures === 0 ? "PROOF PASSED" : `PROOF FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
