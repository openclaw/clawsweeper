import assert from "node:assert/strict";
import test from "node:test";
import { renderResponse } from "../../dist/repair/comment-router-core.js";

for (const intent of ["autofix", "automerge", "fix_ci", "address_review", "implement_issue"]) {
  test(`${intent} has one short retirement reply`, () => {
    const body = renderResponse(
      { intent, retired: true, comment_id: "123", target: { head_sha: "a".repeat(40) } },
      {},
    );
    const visible = body.replace(/<!--[\s\S]*?-->/g, "").trim();
    assert.equal(
      visible,
      `\`@clawsweeper ${intent.replaceAll("_", "-")}\` is retired; ClawSweeper now only reviews.`,
    );
    assert.equal((body.match(/<!-- clawsweeper-command:/g) ?? []).length, 1);
  });
}
