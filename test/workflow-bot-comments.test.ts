import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mockCommandBinEnv } from "./mock-command-bin-env.ts";

import {
  CLAWSWEEPER_APP_BOT_LOGINS,
  CLAWSWEEPER_APP_SLUG,
  CLAWSWEEPER_BOT_LOGINS,
} from "../dist/clawsweeper-bot-identity.js";
import {
  commandReviewStartLeaseCommentMarker,
  reviewStartLeaseCommentMarker,
} from "../dist/review-comment-markers.js";
import { withQuietReviewStartStatusLease } from "../dist/clawsweeper-review-comment-state.js";

test("workflow failure cleanup discovers only owned in-place leases without selecting them for DELETE", () => {
  const body = withQuietReviewStartStatusLease(
    "Codex review: keep open.\n\n<!-- clawsweeper-review item=42 -->",
    {
      number: 42,
      kind: "issue",
      title: "fixture",
      headSha: "a".repeat(64),
      leaseOwner: "run-1",
      startedAt: "2026-10-01T00:00:00Z",
      leaseExpiresAt: "2026-10-01T01:00:00Z",
    },
  );
  const input = JSON.stringify({ id: 10, user: { login: "clawsweeper[bot]" }, body });
  assert.equal(
    workflowBotComments(
      ["review-lease-comment-ids", "--item-number", "42", "--owner", "run-1", "--in-place"],
      input,
    ),
    "10\n",
  );
  assert.equal(
    workflowBotComments(
      ["review-lease-comment-ids", "--item-number", "42", "--owner", "other", "--in-place"],
      input,
    ),
    "",
  );
  assert.equal(
    workflowBotComments(
      ["review-lease-comment-ids", "--item-number", "42", "--owner", "run-1"],
      input,
    ),
    "",
  );
});

// Workflow steps run the source file with the runner Node before any build.
function workflowBotComments(args: string[], input = ""): string {
  return execFileSync(process.execPath, ["src/workflow-bot-comments.ts", ...args], {
    input,
    encoding: "utf8",
  });
}

test("workflow bot logins print every login ClawSweeper writes as", () => {
  assert.deepEqual(JSON.parse(workflowBotComments(["bot-logins"])), [...CLAWSWEEPER_BOT_LOGINS]);
});

test("workflow lease lookup selects only App-authored lease comments for the item and owner", () => {
  const [bot] = CLAWSWEEPER_APP_BOT_LOGINS;
  const status = (owner: string) =>
    `<!-- clawsweeper-review-status:started item=42 owner=${owner} v=1 -->`;
  const comments = [
    {
      id: 1,
      user: { login: bot },
      body: `${status("run-1")}\n${reviewStartLeaseCommentMarker(42)}`,
    },
    {
      id: 2,
      user: { login: bot },
      body: `${status("run-1")}\n${commandReviewStartLeaseCommentMarker(42)}`,
    },
    {
      id: 3,
      user: { login: "octocat" },
      body: `${status("run-1")}\n${reviewStartLeaseCommentMarker(42)}`,
    },
    {
      id: 4,
      user: { login: CLAWSWEEPER_APP_SLUG },
      body: `${status("run-1")}\n${reviewStartLeaseCommentMarker(42)}`,
    },
    {
      id: 5,
      user: { login: bot },
      body: `${status("run-1")}\n${reviewStartLeaseCommentMarker(420)}`,
    },
    {
      id: 6,
      user: { login: bot },
      body: `${status("run-2")}\n${reviewStartLeaseCommentMarker(42)}`,
    },
  ];
  const input = comments.map((comment) => JSON.stringify(comment)).join("\n");

  assert.deepEqual(
    workflowBotComments(["review-lease-comment-ids", "--item-number", "42"], input).split("\n"),
    ["1", "2", "6", ""],
  );
  assert.deepEqual(
    workflowBotComments(
      ["review-lease-comment-ids", "--item-number", "42", "--owner", "run-1"],
      input,
    ).split("\n"),
    ["1", "2", ""],
  );
});

test("terminal cleanup removes owned leases and eyes while preserving durable reviews and command receipts", (t) => {
  const root = mkdtempSync(join(tmpdir(), "terminal-review-leases-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lease = reviewStartLeaseCommentMarker(42);
  const durable =
    "Existing review of rate limit handling and HTTP 403.\n\n<!-- clawsweeper-review item=42 -->";
  const inPlace = withQuietReviewStartStatusLease(durable, {
    number: 42,
    kind: "issue",
    title: "fixture",
    headSha: "a".repeat(64),
    leaseOwner: "run-1",
    startedAt: "2026-10-01T00:00:00Z",
    leaseExpiresAt: "2026-10-01T01:00:00Z",
  });
  const bot = { login: "clawsweeper[bot]" };
  const comments = [
    { id: 1, user: bot, body: lease },
    { id: 2, user: bot, body: inPlace },
    { id: 3, user: bot, body: "<!-- clawsweeper-command-status:42 -->\n" + lease },
    { id: 4, user: { login: "someone" }, body: lease },
    { id: 5, user: bot, body: lease }, // Already promoted to a durable review at the live reread.
  ];
  const reactions = [
    { id: 6, content: "eyes", user: bot },
    { id: 7, content: "eyes", user: { login: "someone" } },
  ];
  const adapter = join(root, "adapter.cjs");
  writeFileSync(
    adapter,
    `
    const {appendFileSync} = require("node:fs");
    const args = process.argv.slice(2);
    const comments = ${JSON.stringify(comments)};
    if (args[1] === process.env.REFUSED_PATH) {
      console.error(process.env.REFUSAL);
      process.exit(1);
    }
    if (args.includes("--url")) {
      const id = Number(args.at(-1).split("/").at(-1));
      const comment = comments.find(c => c.id === id);
      if (id === 5) comment.body = ${JSON.stringify(durable)};
      console.log("HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n" + JSON.stringify(comment));
    } else if (args.includes("--method")) {
      appendFileSync(${JSON.stringify(join(root, "writes"))}, JSON.stringify(args) + "\\n");
    } else if (args[1].includes("/comments?")) console.log(JSON.stringify([comments]));
    else if (args[1].includes("/reactions?")) console.log(JSON.stringify([${JSON.stringify(reactions)}]));
    else if (args[1].endsWith("/issues/42")) console.log(JSON.stringify({state: process.env.ITEM_STATE, locked: process.env.LOCKED === "true"}));
    else throw new Error("unexpected request: " + args.join(" "));
  `,
  );
  const run = (state: string, fixtureEnv: NodeJS.ProcessEnv = {}) =>
    execFileSync(process.execPath, ["dist/repair/release-terminal-review-leases.js"], {
      env: {
        ...process.env,
        ...mockCommandBinEnv("gh", adapter),
        ...mockCommandBinEnv("curl", adapter),
        ...fixtureEnv,
        ITEM_STATE: state,
        TARGET_REPO: "openclaw/openclaw",
        ITEM_NUMBER: "42",
        GH_TOKEN: "fixture",
      },
      stdio: "pipe",
      encoding: "utf8",
    });
  assert.throws(() => run("open"), /Cannot release terminal review leases/);
  run("closed");
  const writes = readFileSync(join(root, "writes"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(writes, [
    ["api", "repos/openclaw/openclaw/issues/comments/1", "--method", "DELETE"],
    [
      "api",
      "repos/openclaw/openclaw/issues/comments/2",
      "--method",
      "PATCH",
      "-f",
      "body=" + durable,
    ],
    ["api", "repos/openclaw/openclaw/issues/42/reactions/6", "--method", "DELETE"],
  ]);
  const forbidden = "gh: Resource not accessible by integration (HTTP 403)";
  for (const [, path, , method] of writes) {
    writeFileSync(join(root, "writes"), "");
    const output = run("closed", { LOCKED: "true", REFUSED_PATH: path, REFUSAL: forbidden });
    assert.deepEqual(JSON.parse(output), { action: "skipped_locked_conversation", method, path });
    assert.deepEqual(
      readFileSync(join(root, "writes"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      writes.filter((write) => write[1] !== path),
    );
  }

  const refusedComment = { REFUSED_PATH: writes[0][1], REFUSAL: forbidden };
  assert.throws(() => run("closed", refusedComment), /HTTP 403/);
  assert.throws(
    () =>
      run("closed", {
        ...refusedComment,
        LOCKED: "true",
        REFUSAL: "gh: Bad credentials (HTTP 401)",
      }),
    /HTTP 401/,
  );
  assert.throws(
    () =>
      run("closed", {
        REFUSED_PATH: writes[1][1],
        LOCKED: "true",
        REFUSAL: "gh: Invalid body mentioning HTTP 403 (HTTP 422)",
      }),
    /HTTP 422/,
  );
  assert.throws(
    () =>
      run("closed", {
        ...refusedComment,
        LOCKED: "true",
        REFUSAL: "gh: API rate limit exceeded (HTTP 403)",
      }),
    /rate limit/i,
  );
  assert.throws(
    () =>
      run("closed", {
        ...refusedComment,
        LOCKED: "true",
        REFUSED_PATH: "repos/openclaw/openclaw/issues/42/comments?per_page=100",
      }),
    /HTTP 403/,
  );
});
