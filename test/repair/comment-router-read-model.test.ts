import assert from "node:assert/strict";
import test from "node:test";

import { readRepairLoopComments } from "../../dist/repair/comment-router-read-model.js";

test("repair-loop comment snapshots preserve router decisions and reduce GitHub reads", () => {
  const comments = [
    { id: 1, body: "ordinary", updated_at: "2026-08-14T00:00:00Z" },
    { id: 2, body: "<!-- clawsweeper-verdict:keep_open -->", updated_at: "2026-08-14T00:01:00Z" },
  ];
  let snapshot = null;
  let githubReads = 0;
  let repairs = 0;
  const request = (operation, payload) => {
    if (operation === "comments") {
      return snapshot ? { usable: true, comments: structuredClone(snapshot) } : { usable: false };
    }
    repairs += 1;
    snapshot = payload.objects.map((object) => object.snapshot);
    return { usable: false };
  };
  const read = () =>
    readRepairLoopComments({
      repository: "openclaw/openclaw",
      number: 42,
      readModelRequest: request,
      liveRead: () => {
        githubReads += 1;
        return structuredClone(comments);
      },
    });

  const repaired = read();
  const cached = read();
  assert.deepEqual(cached, repaired);
  assert.equal(githubReads, 1);
  assert.equal(repairs, 1);
  assert.deepEqual(
    cached.filter((comment) => String(comment.body).includes("clawsweeper-verdict")),
    [comments[1]],
  );
});
