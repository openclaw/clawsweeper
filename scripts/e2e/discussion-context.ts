#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { reviewPromptForTest } from "../../dist/clawsweeper.js";
import { truncateText } from "../../dist/clawsweeper-text.js";
import { reviewContentCacheHit } from "../../dist/scheduler-policy.js";
import {
  hydratePrimaryBody,
  inertTrace,
  longProofBody,
  sha256,
  sourceTools,
} from "../../test/primary-body-fixture.ts";

const git = { mainSha: "a".repeat(40), releaseStateComplete: true, latestRelease: null };
const synthetic = [
  {
    id: 1,
    user: { login: "reporter" },
    body: "Context.\n".padEnd(6500, ".") + "\n## Evidence\n" + inertTrace,
  },
  { id: 2, user: { login: "reporter" }, body: longProofBody() },
];
const live = process.argv.includes("--live")
  ? ([
      JSON.parse(
        execFileSync("gh", ["api", "repos/openclaw/openclaw/issues/comments/5558604945"], {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
        }),
      ),
    ] as { id: number; body: string; user: { login: string } }[])
  : [];
const receipts = [];
for (const [source, comments] of [
  ["synthetic", synthetic],
  ["github", live],
] as const) {
  for (const comment of comments) {
    for (const kind of ["issue", "pull_request"] as const) {
      const fixture = hydratePrimaryBody("Discussion evidence delivery", kind, {
        comments: [comment],
      });
      const prompt = reviewPromptForTest(fixture.target, fixture.context, git);
      const json = prompt.split("## GitHub Context\n")[1]?.match(/```json\n([\s\S]*?)\n```/)?.[1];
      assert.ok(json);
      const retained = JSON.parse(json).comments[0] as {
        body: string;
        bodyCoverage?: { sourceBodySha256: string; complete: false; omittedUnits: number };
      };
      if (comment.body.length <= 12_000) {
        assert.equal(retained.body, comment.body);
        assert.equal(retained.bodyCoverage, undefined);
      } else {
        assert.equal(retained.bodyCoverage?.sourceBodySha256, sha256(comment.body));
        assert.equal(retained.bodyCoverage?.complete, false);
        assert.ok(retained.bodyCoverage.omittedUnits > 0);
      }
      if (source === "synthetic") {
        assert.ok(!truncateText(comment.body, 6000).includes(inertTrace));
        assert.ok(json.includes(JSON.stringify(inertTrace).slice(1, -1)));
      }
      receipts.push({
        source,
        kind,
        commentId: comment.id,
        originalUnits: comment.body.length,
        prefixUnits: retained.body.length,
        complete: retained.bodyCoverage === undefined,
        sourceSha256: sha256(comment.body),
        promptSha256: sha256(prompt),
      });
    }
  }
}
if (process.argv.includes("--live")) {
  assert.ok(
    live.some(({ body }) => body.length > 6000),
    "Live input must exercise the old cutoff",
  );
}
const inlineBody = longProofBody();
const inline = (body: string) =>
  hydratePrimaryBody("Inline evidence", "pull_request", {
    pullReviewComments: [{ id: 19, body, user: { login: "reporter" } }],
  });
const original = inline(inlineBody);
const originalDigest = sourceTools.itemContentDigest(original.target, original.context);
const now = Date.now();
const cachedReview = {
  reviewStatus: "complete" as const,
  reviewPolicy: "discussion-proof",
  decision: "keep_open" as const,
  contentDigest: originalDigest,
  lastFullReviewAt: new Date(now).toISOString(),
  lastFullReviewDecision: "keep_open" as const,
};
const cacheHit = (contentDigest: string) =>
  reviewContentCacheHit({
    review: cachedReview,
    reviewPolicy: "discussion-proof",
    contentDigest,
    now,
    explicitDispatch: false,
    maintainerRequest: false,
  });
assert.equal(cacheHit(originalDigest), true);
const cacheInvalidation = [inlineBody.indexOf("queued"), inlineBody.length - 1].map((offset) => {
  const edited = inline(inlineBody.slice(0, offset) + "!" + inlineBody.slice(offset + 1));
  const digest = sourceTools.itemContentDigest(edited.target, edited.context);
  assert.equal(cacheHit(digest), false);
  return { offset, cacheHit: false, originalDigest, editedDigest: digest };
});
console.log(
  JSON.stringify(
    {
      head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      node: process.version,
      proof: "compiled hydration and final prompt; no model, scan or publication invoked",
      receipts,
      cacheInvalidation,
    },
    null,
    2,
  ),
);
