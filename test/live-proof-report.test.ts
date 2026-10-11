import assert from "node:assert/strict";
import test from "node:test";

import { renderReviewCommentFromReport } from "../dist/clawsweeper-report-comment-presentation.js";
import { reviewAutomationMarkersFromReport } from "../dist/clawsweeper-review-comment-automation.js";
import { reportRealBehaviorProofPolicy } from "../dist/clawsweeper-proof-policy.js";
import { pullRequestProofReport } from "./helpers.ts";

test("retired proof plans and attachments do not affect current review authority or presentation", () => {
  for (const status of ["missing", "sufficient"] as const) {
    for (const association of ["CONTRIBUTOR", "MEMBER"]) {
      for (const labels of [[], ["proof: override"]]) {
        const options = {
          author: "reviewed-author",
          association,
          status,
          frontMatter: { labels: JSON.stringify(labels) },
        };
        const report = pullRequestProofReport(options);
        for (const payload of [
          "invalid!",
          "",
          Buffer.from(JSON.stringify({ overall_pass: true })).toString("base64url"),
          Buffer.from(JSON.stringify({ overall_pass: false })).toString("base64url"),
        ]) {
          const historical = pullRequestProofReport({
            ...options,
            sections: `## Live Proof\n\nStatus: recommended\n\nSurface: terminal\n\nEntry: untrusted-command\n\n<!-- clawsweeper-live-verification -->\nResult: ${payload}\n\n<!-- clawsweeper-live-proof-recording -->\n\n[![Live proof recording](https://example.test/poster.jpg)](https://example.test/proof.mp4)\n\n`,
          });
          assert.deepEqual(
            reportRealBehaviorProofPolicy(historical),
            reportRealBehaviorProofPolicy(report),
          );
          assert.equal(
            reviewAutomationMarkersFromReport(historical),
            reviewAutomationMarkersFromReport(report),
          );
          assert.equal(
            renderReviewCommentFromReport(historical, "none"),
            renderReviewCommentFromReport(report, "none"),
          );
        }
      }
    }
  }
});
