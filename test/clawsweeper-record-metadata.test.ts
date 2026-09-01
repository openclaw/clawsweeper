import assert from "node:assert/strict";
import test from "node:test";

import { createRecordMetadata } from "../dist/clawsweeper-record-metadata.js";

const metadata = createRecordMetadata({
  reportFileName: () => "unused.md",
  markdownRepository: () => "openclaw/clawsweeper",
  isVerifiedFixedCloseReason: () => false,
  isOlderThanDays: () => false,
  timestampMs: () => null,
  pullHeadShaFromReport: () => null,
  reviewLeaseRevisionFromReport: () => null,
  lockedConversationApplyReason: () => null,
  markdownFiles: () => [],
  numberForMarkdownFile: () => 0,
});

test("front matter fields are ambiguous when the same key occurs after the leading block", () => {
  const report = `---
fixed_release: v1
real_behavior_proof_status: sufficient
---
real_behavior_proof_status: missing
---
`;

  assert.deepEqual(metadata.frontMatterField(report, "real_behavior_proof_status"), {
    status: "ambiguous",
  });
});

test("front matter fields preserve current-format, duplicate, and no-block behavior", () => {
  assert.deepEqual(
    metadata.frontMatterField(
      "---\nreal_behavior_proof_status: missing\n---\n\n## Summary\n\nUnproven.\n",
      "real_behavior_proof_status",
    ),
    { status: "value", value: "missing" },
  );
  assert.deepEqual(
    metadata.frontMatterField(
      "---\nreal_behavior_proof_status: sufficient\nreal_behavior_proof_status: missing\n---\n",
      "real_behavior_proof_status",
    ),
    { status: "ambiguous" },
  );
  assert.deepEqual(
    metadata.frontMatterField(
      "real_behavior_proof_status: sufficient\n\n## Summary\n\nNo leading block.\n",
      "real_behavior_proof_status",
    ),
    { status: "absent" },
  );
});

test("label names containing replacement patterns survive a front matter write", () => {
  // `labels` is written as replaceFrontMatterValue(markdown, "labels", JSON.stringify(
  // item.labels)), and those names come from the reviewed repository. GitHub permits
  // `$`, a backtick and a quote in a label, so `$&`, "$`" and "$'" reach this writer as
  // ordinary data and must not be expanded against the match.
  const report = ["---", "repository: openclaw/openclaw", "labels: []", "---", "", "body", ""].join(
    "\n",
  );

  for (const labels of [["bug"], ["$&"], ["$`"], ["$'"], ["a$&b"], ["$$"], ["P$1"]]) {
    const written = JSON.stringify(labels);
    const next = metadata.replaceFrontMatterValue(report, "labels", written);
    assert.equal(
      metadata.frontMatterValue(next, "labels"),
      written,
      `labels ${written} must be stored verbatim`,
    );
    assert.deepEqual(
      metadata.frontMatterStringArray(next, "labels"),
      labels,
      `labels ${written} must read back unchanged`,
    );
  }
});

test("front matter keys are matched literally, not as regular expressions", () => {
  // No shipped caller passes a key with regex syntax, but the helpers advertise a plain
  // `key: string` contract; interpolating it raw makes them throw or match the wrong line.
  for (const key of ["a.c", "a+b", "x(y", "k[0]", "q|r", "-detail", "-k[0]"]) {
    const report = ["---", `${key}: original`, "---", "", "body", ""].join("\n");

    assert.deepEqual(
      metadata.frontMatterField(report, key),
      { status: "value", value: "original" },
      `key ${key} must be readable`,
    );

    const next = metadata.replaceFrontMatterValue(report, key, "updated");
    assert.equal(
      metadata.frontMatterValue(next, key),
      "updated",
      `key ${key} must be updated in place`,
    );
    assert.equal(next.includes(`${key}: original`), false, `key ${key} must not be duplicated`);
  }

  // A literal key must not match a different, regex-equivalent line.
  const decoy = ["---", "aXc: decoy", "---", "", "body", ""].join("\n");
  assert.deepEqual(metadata.frontMatterField(decoy, "a.c"), { status: "absent" });
});

test("report prose that quotes a front matter key does not mask the real value", () => {
  // The body is model-authored review text. A quoted PR field, a fenced YAML
  // sample, or a findings row can legitimately start a line with `key:`, and that
  // must not make the record's own front matter unreadable.
  const frontMatter = [
    "---",
    "repository: openclaw/openclaw",
    "type: pull_request",
    "title: Fix the thing",
    "url: https://github.com/openclaw/openclaw/pull/42",
    "---",
  ].join("\n");

  const bodies = {
    "quoted PR field": "Codex review: ready.\n\nThe PR body says:\n\ntitle: quoted by the model\n",
    "fenced yaml sample": "Codex review: ready.\n\n```yaml\ntype: bug\n```\n",
    "findings row": "Codex review: ready.\n\nurl: see the linked run\n",
  };

  for (const [name, body] of Object.entries(bodies)) {
    const report = `${frontMatter}\n\n${body}`;
    assert.deepEqual(
      metadata.frontMatterField(report, "type"),
      { status: "value", value: "pull_request" },
      `${name} must not mask type`,
    );
    assert.deepEqual(
      metadata.frontMatterField(report, "title"),
      { status: "value", value: "Fix the thing" },
      `${name} must not mask title`,
    );
    assert.deepEqual(
      metadata.frontMatterField(report, "url"),
      { status: "value", value: "https://github.com/openclaw/openclaw/pull/42" },
      `${name} must not mask url`,
    );
  }
});

test("a second front matter block still makes a field ambiguous", () => {
  // The competing-record guard is the point of the check and must survive, in both
  // the delimiter-first and bare-run shapes.
  const bare = ["---", "type: issue", "---", "type: pull_request", "---", ""].join("\n");
  assert.deepEqual(metadata.frontMatterField(bare, "type"), { status: "ambiguous" });

  const delimited = ["---", "type: issue", "---", "---", "type: pull_request", "---", ""].join(
    "\n",
  );
  assert.deepEqual(metadata.frontMatterField(delimited, "type"), { status: "ambiguous" });

  // A competing block that does not mention the key leaves other keys readable.
  const other = ["---", "type: issue", "number: 7", "---", "number: 9", "---", ""].join("\n");
  assert.deepEqual(metadata.frontMatterField(other, "type"), { status: "value", value: "issue" });
  assert.deepEqual(metadata.frontMatterField(other, "number"), { status: "ambiguous" });
});

test("an unterminated key-shaped run in the body is prose, not a competing block", () => {
  // Without a closing `---` there is no second record, so the leading value stands.
  const report = ["---", "type: pull_request", "---", "type: not a record", ""].join("\n");
  assert.deepEqual(metadata.frontMatterField(report, "type"), {
    status: "value",
    value: "pull_request",
  });
});

test("a complete competing block after review prose is still ambiguous", () => {
  // The guard exists to stop a second record impersonating the first. A block
  // appended after paragraphs of prose impersonates just as well as one pasted
  // directly onto the leading block, so the scan must cover the whole body.
  const shapes = {
    "after one prose line": ["Codex review: ready.", ""],
    "after several paragraphs": ["Codex review: ready.", "", "Looks good to me.", ""],
    "after a findings row": ["Codex review: ready.", "", "url: see the linked run", ""],
    "after a fenced sample": ["Codex review: ready.", "", "```yaml", "type: bug", "```", ""],
    "after a thematic break": ["Codex review: ready.", "", "---", "", "More prose.", ""],
  };

  for (const [name, body] of Object.entries(shapes)) {
    const report = [
      "---",
      "type: pull_request",
      "number: 42",
      "---",
      "",
      ...body,
      "---",
      "type: issue",
      "---",
      "",
    ].join("\n");

    assert.deepEqual(
      metadata.frontMatterField(report, "type"),
      { status: "ambiguous" },
      `${name}: a complete competing block must fail closed`,
    );
    // A key the competing block does not claim stays readable.
    assert.deepEqual(
      metadata.frontMatterField(report, "number"),
      { status: "value", value: "42" },
      `${name}: an unclaimed key stays readable`,
    );
  }
});

test("a fenced metadata sample is illustration, not a competing record", () => {
  // A complete block inside a code fence is quoted text. Failing closed on it would
  // take a record offline for showing an example, which is the defect being fixed.
  const report = [
    "---",
    "type: pull_request",
    "---",
    "",
    "A record looks like this:",
    "",
    "```markdown",
    "---",
    "type: issue",
    "---",
    "```",
    "",
    "That is all.",
    "",
  ].join("\n");

  assert.deepEqual(metadata.frontMatterField(report, "type"), {
    status: "value",
    value: "pull_request",
  });

  // The fence must be closed for that to hold: an unterminated fence leaves the
  // rest of the body quoted, so a later block is not reachable as a record either.
  const tildeFenced = report.replace(/```markdown/, "~~~markdown").replace(/```/, "~~~");
  assert.deepEqual(metadata.frontMatterField(tildeFenced, "type"), {
    status: "value",
    value: "pull_request",
  });
});

for (const body of [
  "title: Quoted title\nrepository: example/quoted\n",
  "```yaml\n---\ntitle: Quoted title\nrepository: example/quoted\n---\n```\n",
  "   ~~~~yaml\n---\ntitle: Quoted title\n---\n   ~~~~~\n",
  "````yaml\n```\n---\ntitle: Quoted title\n---\n````\n",
  "```yaml\n~~~\n```not-a-closer\n---\ntitle: Quoted title\n---\n```\n",
]) {
  test(`header-owned metadata survives body quotes: ${JSON.stringify(body)}`, () => {
    const report = `---\ntitle: "Original"\nrepository: openclaw/clawsweeper\n---\n\n## Summary\n\n${body}`;
    assert.equal(metadata.frontMatterValue(report, "title"), "Original");
    assert.equal(metadata.frontMatterValue(report, "repository"), "openclaw/clawsweeper");
  });
}

for (const prefix of [
  "",
  "Prose first.\n",
  "``yaml\n",
  "```bad`info\n",
  "    ```yaml\n",
  "\t```yaml\n",
]) {
  test(`unfenced competing records fail closed after ${JSON.stringify(prefix)}`, () => {
    const report = `---\ntitle: Original\ntype: pull_request\n---\n\n${prefix}---\ntitle: Competing\nrepository: other/record\nnumber: 999\n---\n`;
    assert.deepEqual(metadata.frontMatterField(report, "title"), { status: "ambiguous" });
    assert.equal(metadata.frontMatterValue(report, "type"), "pull_request");
  });
}

test("missing body lookalikes remain ambiguous while genuinely absent fields permit legacy handling", () => {
  for (const body of ["title: Quoted", "```yaml\ntitle: Quoted\n```", "---\ntitle: Quoted\n---"]) {
    assert.deepEqual(metadata.frontMatterField(`---\nnumber: 321\n---\n\n${body}\n`, "title"), {
      status: "ambiguous",
    });
  }
  assert.deepEqual(metadata.frontMatterField("---\nnumber: 321\n---\n\nPlain body.\n", "title"), {
    status: "absent",
  });
});

test("raw empty fields never consume the next line and paired quotes retain their existing decoding", () => {
  for (const value of ["", " ", "\t"]) {
    const report = `---\ntitle:${value}\nrepository: openclaw/clawsweeper\n---\n`;
    assert.deepEqual(metadata.frontMatterField(report, "title"), { status: "ambiguous" });
    assert.equal(metadata.frontMatterValue(report, "repository"), "openclaw/clawsweeper");
  }
  for (const [raw, value] of [
    ['""', ""],
    ['"a\\nb"', "a\\nb"],
    ['"unpaired', '"unpaired'],
    ["'single'", "'single'"],
  ]) {
    assert.deepEqual(metadata.frontMatterField(`---\ntitle: ${raw}\n---\n`, "title"), {
      status: "value",
      value,
    });
  }
});

test("literal keys, CRLF, and nested multiline metadata retain top-level ownership", () => {
  const report = [
    "---",
    "a.c: literal",
    "title: Original",
    "pr_surface_files: [",
    '  {"path":"src/example.ts","additions":1,"deletions":0},',
    '  {"path":"src/other.ts","additions":2,"deletions":1}',
    "]",
    "details: |",
    "  title: Nested",
    "  repository: nested/data",
    "---",
    "",
    "## Summary",
    "",
    "a.c: Quoted",
    "title: Quoted",
  ].join("\r\n");
  assert.equal(metadata.frontMatterValue(report, "title"), "Original");
  assert.equal(metadata.frontMatterValue(report, "a.c"), "literal");
  assert.deepEqual(metadata.frontMatterField(report, "repository"), { status: "absent" });
  assert.deepEqual(metadata.frontMatterField(report, "aXc"), { status: "absent" });
});

test("cache-control lookalikes cannot disable unique header fields or supply missing cache fields", () => {
  const report =
    "---\nreview_cache_hit: false\nreview_policy: current\n---\n\n## Summary\n\nreview_cache_hit: true\nreview_policy: quoted\nreview_structural_fingerprint: body-only\n";
  assert.equal(metadata.frontMatterValue(report, "review_cache_hit"), "false");
  assert.equal(metadata.frontMatterValue(report, "review_policy"), "current");
  assert.deepEqual(metadata.frontMatterField(report, "review_structural_fingerprint"), {
    status: "ambiguous",
  });
});

test("false fence closers cannot conceal a later unfenced competing record", () => {
  const quoted = "```yaml\n    ```\n~~~\n```not-a-close\n---\ntitle: Quoted\n---\n```\n";
  const header = "---\ntitle: Original\ntype: pull_request\n---\n\n";
  assert.equal(metadata.frontMatterValue(header + quoted, "title"), "Original");
  const competing = header + quoted + "\nProse.\n---\ntitle: Competing\n---\n";
  assert.deepEqual(metadata.frontMatterField(competing, "title"), { status: "ambiguous" });
  assert.equal(metadata.frontMatterValue(competing, "type"), "pull_request");
});

test("metadata fragments cannot be hidden by pseudo-fences or metadata comments", () => {
  for (const fragment of [
    "```bad`info\ntitle: Competing\n---\n",
    "``yaml\ntitle: Competing\n---\n",
    "---\n# Record metadata\ntitle: Competing\n---\n",
  ]) {
    assert.deepEqual(metadata.frontMatterField(`---\ntitle: Original\n---\n${fragment}`, "title"), {
      status: "ambiguous",
    });
  }
});
