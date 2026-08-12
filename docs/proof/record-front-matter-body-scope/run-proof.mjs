// Real-behavior proof: a report body that starts a line with `<key>:` must not make
// the record's own front matter unreadable, while a genuine second front matter block
// must still be reported as ambiguous.
//
// Exercises the shipped factory in dist/clawsweeper-record-metadata.js — the same
// module every apply/review lane builds its record metadata from.
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

const FRONT_MATTER = [
  "---",
  "repository: openclaw/openclaw",
  "number: 42",
  "type: pull_request",
  "title: Fix the thing",
  "url: https://github.com/openclaw/openclaw/pull/42",
  "reviewed_at: 2026-08-01T00:00:00Z",
  "---",
].join("\n");

const KEYS = ["repository", "number", "type", "title", "url", "reviewed_at"];

// Bodies a real reviewer writes. Each one starts a line with a front matter key.
const BODIES = {
  "clean body": "Codex review: ready.\n\nAll good.\n",
  "body quotes a PR field": "Codex review: ready.\n\nThe PR body says:\n\ntitle: quoted text\n",
  "body has a fenced yaml sample": "Codex review: ready.\n\n```yaml\ntype: bug\n```\n",
  "body has a findings row": "Codex review: ready.\n\nurl: see the linked run\n",
  "body lists several keys": "Codex review: ready.\n\nnumber: 7\nreviewed_at: earlier\n",
};

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

console.log("== 1. report prose must not hide the record's own front matter ==");
for (const [name, body] of Object.entries(BODIES)) {
  const report = `${FRONT_MATTER}\n\n${body}`;
  const unreadable = KEYS.filter((key) => metadata.frontMatterValue(report, key) === undefined);
  check(unreadable.length === 0, `${name}: all ${KEYS.length} fields readable`);
  if (unreadable.length) {
    const statuses = unreadable.map((k) => `${k}=${metadata.frontMatterField(report, k).status}`);
    console.log(`        unreadable: ${statuses.join(", ")}`);
  }
}
const cleanReport = `${FRONT_MATTER}\n\n${BODIES["clean body"]}`;
check(metadata.frontMatterValue(cleanReport, "title") === "Fix the thing", "title reads correctly");
check(metadata.frontMatterValue(cleanReport, "type") === "pull_request", "type reads correctly");

console.log("\n== 2. a genuine competing record is still ambiguous ==");
const bare = ["---", "type: issue", "---", "type: pull_request", "---", ""].join("\n");
check(metadata.frontMatterField(bare, "type").status === "ambiguous", "bare second block");

const delimited = ["---", "type: issue", "---", "---", "type: pull_request", "---", ""].join("\n");
check(metadata.frontMatterField(delimited, "type").status === "ambiguous", "delimited second block");

const partial = ["---", "type: issue", "number: 7", "---", "number: 9", "---", ""].join("\n");
check(metadata.frontMatterField(partial, "number").status === "ambiguous", "competing key only");
check(
  metadata.frontMatterField(partial, "type").status === "value",
  "unrelated key stays readable next to a competing block",
);

console.log("\n== 3. an unterminated key-shaped run is prose ==");
const unterminated = ["---", "type: pull_request", "---", "type: not a record", ""].join("\n");
check(
  metadata.frontMatterValue(unterminated, "type") === "pull_request",
  "no closing delimiter -> leading value stands",
);

console.log(`\n${failures === 0 ? "PROOF PASSED" : `PROOF FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
