import assert from "node:assert/strict";
import test from "node:test";
import {
  parseReviewPreflightBody,
  reviewBodyWithoutPreflight,
} from "../dist/review-preflight-body.js";
import {
  serializeReviewPreflightPayload,
  type ReviewPreflightPayload,
} from "../dist/review-preflight-contract.js";
import { reviewPromptContext } from "../dist/clawsweeper-prompt-context.js";
import { scheduledReviewSemanticSourceRevision } from "../dist/scheduled-review-noop.js";
import { scheduledReviewSemanticSourceRevision as sourceScheduledReview } from "../src/scheduled-review-noop.ts";
import { itemContentDigest } from "../dist/clawsweeper-source-revision.js";
import { linkedIssueNumbersForImplementationProvenance } from "../dist/clawsweeper-status-context.js";
import { exactReviewSourceRevisionMaterial } from "../dashboard/exact-review-source-revision.ts";
import { hydratePrimaryBody, sourceTools } from "./primary-body-fixture.ts";

const payload: ReviewPreflightPayload = {
  v: 1,
  repo: "openclaw/clawsweeper",
  base: "a".repeat(40),
  head: "b".repeat(40),
  tool: { name: "autoreview", version: "1.2.3" },
  completion: "partial",
  summary: "Completed at P1 threshold; lower priorities were not assessed.",
};
const block = serializeReviewPreflightPayload(payload);
const wrap = (json: string) => `<!-- openclaw-preflight:v1\n${json}\n-->`;

test("direct source scheduler entry preserves compiled semantic identity", () => {
  const issue = { title: "Title", body: `Proof\n\n${block}`, labels: [], pull_request: {} };
  assert.equal(sourceScheduledReview(issue, []), scheduledReviewSemanticSourceRevision(issue, []));
});

test("published local producer example remains readable", () => {
  const native =
    '<!-- openclaw-preflight:v1\n{"v":1,"repo":"openclaw/clawsweeper","base":"bd129c3395197feb345b67e7f6ec8d43c2e1063a","head":"5a51b89af489404f261e99222182758057daa114","tool":{"name":"clawsweeper","version":"0.3.1"},"completion":"complete","summary":"Native review complete; 0 reported findings. No summary priority filter. See the native report for coverage and policy caveats. Self-reported completion is not a clean verdict."}\n-->';
  assert.equal(Buffer.byteLength(native), 429);
  assert.equal(parseReviewPreflightBody(native).status, "valid");
});

test("closed advisory payload accepts native completion variants and optional unverified report digest", () => {
  for (const completion of ["complete", "partial", "failed"] as const) {
    const value = { ...payload, completion, report_sha256: "c".repeat(64) };
    const parsed = parseReviewPreflightBody(serializeReviewPreflightPayload(value));
    assert.equal(parsed.status, "valid");
    if (parsed.status === "valid") assert.deepEqual(parsed.payload, value);
  }
  assert.equal(
    parseReviewPreflightBody(
      serializeReviewPreflightPayload({
        ...payload,
        tool: { name: "Review Engine", version: "build 1" },
      }),
    ).status,
    "valid",
  );
});

test("strict payload rejects ambiguous JSON, unknown fields and malformed identities", () => {
  const json = JSON.stringify(payload);
  const invalid = [
    json.replace('"v":1', '"v":2'),
    json.replace('"v":1', '"v":1,"v":1'),
    json.replace('"head":', '"he\\u0061d":"b","head":'),
    json.replace('"name":"autoreview"', '"name":"autoreview","na\\u006de":"autoreview"'),
    json.replace('"v":1', '"__proto__":{},"v":1'),
    json.replace('"v":1', '"unknown":true,"v":1'),
    json.replace('"partial"', '"clean"'),
    json.replace('"partial"', "null"),
    json.replace('"autoreview"', "[]"),
    JSON.stringify({ ...payload, tool: { ...payload.tool, model: "private" } }),
    JSON.stringify({ ...payload, tool: { ...payload.tool, name: "" } }),
    JSON.stringify({ ...payload, tool: { ...payload.tool, version: "x".repeat(65) } }),
    JSON.stringify({ ...payload, base: "A".repeat(40) }),
    JSON.stringify({ ...payload, head: "b".repeat(64) }),
    JSON.stringify({ ...payload, repo: "https://example.com/repo" }),
    JSON.stringify({ ...payload, summary: "" }),
    JSON.stringify({ ...payload, summary: "\ud800" }),
    JSON.stringify({ ...payload, summary: "hidden\nline" }),
    JSON.stringify({ ...payload, report_sha256: "C".repeat(64) }),
    JSON.stringify({ ...payload, summary: "x".repeat(513) }),
    JSON.stringify({ ...payload, summary: "💥".repeat(129) }),
    json + "{}",
    "[]",
    "null",
  ];
  for (const value of invalid) {
    const body = `Human text\n\n${wrap(value)}\n`;
    assert.deepEqual(parseReviewPreflightBody(body), { status: "invalid", body }, value);
  }
});

test("decoded summary and whole encoded block have independent exact UTF-8 bounds", () => {
  for (const summary of ["x".repeat(512), "💥".repeat(128), "&".repeat(512)]) {
    assert.equal(
      parseReviewPreflightBody(serializeReviewPreflightPayload({ ...payload, summary })).status,
      "valid",
    );
  }
  const padded = block.replace("\n-->", " ".repeat(4096 - Buffer.byteLength(block)) + "\n-->");
  assert.equal(Buffer.byteLength(padded), 4096);
  assert.equal(parseReviewPreflightBody(padded).status, "valid");
  assert.equal(parseReviewPreflightBody(padded.replace("\n-->", " \n-->")).status, "invalid");
  const escaped = serializeReviewPreflightPayload({ ...payload, summary: "<tag> --> &" });
  assert.equal(parseReviewPreflightBody(escaped).status, "valid");
  assert.equal(
    parseReviewPreflightBody(wrap(JSON.stringify({ ...payload, summary: "<tag>" }))).status,
    "invalid",
  );
});

test("exactly one top-level CommonMark comment is recognized, never code or another HTML block", () => {
  for (const body of [
    `${block}\n${block}`,
    `${block}\n${block.replace(":v1", ":v2")}`,
    block.replace("\n-->", ""),
    `<!-- outer\n${block}\n-->`,
    `\`\`\`text\n${block}\n\`\`\``,
    `~~~~\n${block}\n~~~~`,
    `\`\`\`\`\n\`\`\`\n${block}\n\`\`\`\``,
    `~~~\n${block}`,
    block
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n"),
    block
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
    `- ${block.replaceAll("\n", "\n  ")}`,
    `inline \`${block}\``,
    `<pre>\n${block}\n</pre>`,
    `<div>\n${block}\n</div>`,
    `${block} trailing human text`,
  ]) {
    assert.deepEqual(parseReviewPreflightBody(body), { status: "invalid", body }, body);
  }
  // CommonMark permits Markdown between blank lines inside an HTML wrapper;
  // this is token recognition, not a browser-DOM ancestry or trust check.
  assert.equal(parseReviewPreflightBody(`<details>\n\n${block}\n\n</details>`).status, "valid");
});

test("normalization preserves every outer byte and does not own new separator whitespace", () => {
  for (const newline of ["\n", "\r\n"]) {
    const annotation = block.replaceAll("\n", newline);
    const before = `Human text.  ${newline}${newline}`;
    const after = `${newline}More text.${newline}`;
    const body = before + annotation + after;
    const parsed = parseReviewPreflightBody(body);
    assert.equal(parsed.status, "valid");
    assert.equal(parsed.body, before + after);
    const replacement = serializeReviewPreflightPayload({
      ...payload,
      completion: "failed",
    }).replaceAll("\n", newline);
    assert.equal(reviewBodyWithoutPreflight(before + replacement + after), before + after);
    assert.notEqual(reviewBodyWithoutPreflight(before + annotation + " " + after), before + after);
  }
  assert.deepEqual(parseReviewPreflightBody("no metadata"), {
    status: "missing",
    body: "no metadata",
  });
  const oversized = "text\n".repeat(26_215) + block;
  assert.deepEqual(parseReviewPreflightBody(oversized), { status: "invalid", body: oversized });
});

test("actual compiled hydration and semantic identities ignore only valid PR metadata replacement", () => {
  const before = `## Evidence\nNative output\n\n${block}\n`;
  const after = before.replace(
    block,
    serializeReviewPreflightPayload({
      ...payload,
      completion: "failed",
      summary: "Native review failed; findings may be incomplete.",
    }),
  );
  const first = hydratePrimaryBody(before, "pull_request");
  const second = hydratePrimaryBody(after, "pull_request");
  assert.deepEqual(
    reviewPromptContext(first.context, { agentCanReadGitHub: false }),
    reviewPromptContext(second.context, { agentCanReadGitHub: false }),
  );
  assert.equal(first.context.sourceRevision, second.context.sourceRevision);
  assert.equal(first.context.structuralItemStateDigest, second.context.structuralItemStateDigest);
  assert.equal(
    itemContentDigest(first.target, first.context),
    itemContentDigest(second.target, second.context),
  );
  assert.equal(
    scheduledReviewSemanticSourceRevision({ ...first.rawIssue, pull_request: {} }, []),
    sourceTools.itemSourceRevisionSha256(first.rawIssue, [], "pull_request"),
  );
  const humanEdit = hydratePrimaryBody(
    after.replace("Native output", "Changed proof"),
    "pull_request",
  );
  assert.notEqual(first.context.sourceRevision, humanEdit.context.sourceRevision);
  assert.notEqual(
    itemContentDigest(first.target, first.context),
    itemContentDigest(humanEdit.target, humanEdit.context),
  );
  const issue = hydratePrimaryBody(before, "issue");
  assert.ok(issue.context.issue.body.includes("openclaw-preflight:v1"));
  const comments = [{ id: 1, body: block, user: { login: "contributor" } }];
  const withComment = hydratePrimaryBody(before, "pull_request", { comments });
  assert.ok(JSON.stringify(withComment.context.comments).includes("openclaw-preflight:v1"));
  const changedComment = hydratePrimaryBody(before, "pull_request", {
    comments: [{ ...comments[0], body: after }],
  });
  assert.notEqual(withComment.context.sourceRevision, changedComment.context.sourceRevision);
  const raw = { title: "Title", locked: false, labels: [], body: before };
  assert.notDeepEqual(
    exactReviewSourceRevisionMaterial(raw),
    exactReviewSourceRevisionMaterial({ ...raw, body: after }),
  );
});

test("normalization precedes long-body compaction; discarded duplicate markers cannot become valid", () => {
  const long = `## Evidence\n${block}\n\n` + "body\n".repeat(4000);
  const first = hydratePrimaryBody(long, "pull_request");
  const second = hydratePrimaryBody(
    long.replace(block, serializeReviewPreflightPayload({ ...payload, completion: "complete" })),
    "pull_request",
  );
  assert.deepEqual(first.context.issue, second.context.issue);
  assert.equal(first.context.sourceRevision, second.context.sourceRevision);
  const duplicate = hydratePrimaryBody(long + `\n${block}`, "pull_request");
  assert.notEqual(first.context.sourceRevision, duplicate.context.sourceRevision);
  assert.ok(duplicate.context.issue.body.includes("openclaw-preflight:v1"));
});

test("existing implementation linkage ignores comment metadata without reinterpreting summary text", () => {
  const annotation = serializeReviewPreflightPayload({ ...payload, summary: "Fixes #999" });
  assert.deepEqual(
    linkedIssueNumbersForImplementationProvenance(
      `Fixes #123\n\n${annotation}`,
      "openclaw/clawsweeper",
    ),
    [123],
  );
});
