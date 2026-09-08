import assert from "node:assert/strict";
import test from "node:test";
import {
  RECORD_COMMENT_ONLY,
  reportAllowsAutomation,
  reportMatchesPublicationPolicy,
} from "../src/manual-publication-policy.ts";

function report(fields: string): string {
  return `---\nreview_status: complete\n${fields}---\nPrior review\n`;
}

for (const policy of [undefined, RECORD_COMMENT_ONLY]) {
  test(`report cache compatibility requires the same ${policy ?? "ordinary"} policy`, () => {
    const ordinary = report("");
    const restricted = report(`publication_policy: ${RECORD_COMMENT_ONLY}\n`);
    assert.equal(reportMatchesPublicationPolicy(ordinary, policy), policy === undefined);
    assert.equal(
      reportMatchesPublicationPolicy(restricted, policy),
      policy === RECORD_COMMENT_ONLY,
    );
    assert.equal(reportAllowsAutomation(ordinary), true);
    assert.equal(reportAllowsAutomation(restricted), false);
  });
}

for (const [name, markdown] of Object.entries({
  unknown: report("publication_policy: future_policy\n"),
  empty: report("publication_policy:\n"),
  null: report("publication_policy: null\n"),
  quoted: report('publication_policy: "record_comment_only"\n'),
  duplicate: report(
    "publication_policy: record_comment_only\npublication_policy: record_comment_only\n",
  ),
  conflicting: report(
    "publication_policy: record_comment_only\npublication_policy: future_policy\n",
  ),
  alternate: report("publicationPolicy: record_comment_only\n"),
  mixed: report(
    "publication_policy: record_comment_only\npublicationPolicy: record_comment_only\n",
  ),
  bodyOnly: `${report("")}publication_policy: record_comment_only\n`,
  competingHeader: `${report("publication_policy: record_comment_only\n")}\n---\npublication_policy: future_policy\n---\n`,
})) {
  test(`report cache compatibility fails closed for ${name} policy metadata`, () => {
    assert.equal(reportMatchesPublicationPolicy(markdown, undefined), false);
    assert.equal(reportMatchesPublicationPolicy(markdown, RECORD_COMMENT_ONLY), false);
    assert.equal(reportAllowsAutomation(markdown), false);
  });
}
