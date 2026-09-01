import assert from "node:assert/strict";
import test from "node:test";

import {
  commandAckMarkerFromBody,
  commandStatusMarkerFromBody,
  planCommandAckConvergence,
} from "../../dist/repair/command-ack-convergence.js";

test("command acknowledgement convergence preserves parsing and keeper priority", () => {
  const requestedStatus = "<!-- clawsweeper-command-status:81564:re_review:new -->";
  const otherStatus = "<!-- clawsweeper-command-status:81564:re_review:old -->";
  const comments = [
    {
      id: 101,
      created_at: "2026-05-29T10:00:00Z",
      updated_at: "2026-05-29T10:01:00Z",
      body: `${otherStatus}\n<!-- clawsweeper-command-ack:456 -->`,
    },
    {
      id: 102,
      created_at: "2026-05-29T10:02:00Z",
      updated_at: "2026-05-29T10:02:00Z",
      body: "<!-- clawsweeper-command-ack:456 -->",
    },
    {
      id: 103,
      created_at: "2026-05-29T10:03:00Z",
      updated_at: "2026-05-29T10:05:00Z",
      body: `${requestedStatus}\n<!--   clawsweeper-command-ack:456   -->`,
    },
    {
      id: 104,
      created_at: "2026-05-29T10:04:00Z",
      updated_at: "2026-05-29T10:04:00Z",
      body: "<!-- clawsweeper-command-ack:456 -->",
    },
  ];

  assert.equal(
    commandAckMarkerFromBody(comments[2].body),
    "<!--   clawsweeper-command-ack:456   -->",
  );
  assert.equal(commandStatusMarkerFromBody(comments[0].body), otherStatus);
  const plan = planCommandAckConvergence(comments, requestedStatus);
  assert.equal(plan.keep?.id, 103);
  assert.deepEqual(
    plan.prunable.map((comment) => comment.id),
    [102, 104],
  );
});

test("bare acknowledgement ties keep the earliest creation and lowest id", () => {
  const plan = planCommandAckConvergence(
    [
      { id: 12, created_at: "2026-05-29T10:00:00Z", body: "bare" },
      { id: 11, created_at: "2026-05-29T10:00:00Z", body: "bare" },
      { id: 13, created_at: "2026-05-29T10:01:00Z", body: "bare" },
    ],
    "<!-- clawsweeper-command-status:81564:re_review:new -->",
  );
  assert.equal(plan.keep?.id, 11);
});
