import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  commandReviewLeaseHeadSha,
  exactReviewQueueAuthorityFence,
  mergeCommandProgressSection,
  parseOptions,
  selectCommandStatusComment,
  terminalLockedConversationSkip,
  verifiedTerminalStatusReceipt,
} from "../../dist/repair/update-command-status.js";

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

test("parseOptions preserves empty string arguments", () => {
  const options = parseOptions([
    "--repo",
    "openclaw/openclaw",
    "--item-number",
    "81564",
    "--marker",
    "",
    "--status-comment-id",
    "",
  ]);

  assert.equal(options.marker, "");
  assert.equal(options.statusCommentId, null);
  assert.equal(options.requireMutation, false);
});

test("parseOptions requires a status mutation only when explicitly requested", () => {
  const options = parseOptions([
    "--repo",
    "openclaw/openclaw",
    "--item-number",
    "81564",
    "--require-mutation",
  ]);

  assert.equal(options.requireMutation, true);
});

test("parseOptions can refuse terminal command rewrites", () => {
  assert.equal(parseOptions(["--refuse-terminal-state"]).refuseTerminalState, true);
  assert.equal(parseOptions([]).refuseTerminalState, false);
  assert.equal(parseOptions(["--require-queue-authority-fence"]).requireQueueAuthorityFence, true);
});

test("exact review queue fence allows the owner and rejects supersession", async () => {
  let responseStatus = 200;
  let invocation: { file: string; args: string[] } | undefined;
  const execute = (file: string, args: string[]) => {
    invocation = { file, args };
    return `${JSON.stringify(responseStatus === 200 ? { ok: true } : { error: "lease_superseded" })}\n${responseStatus}`;
  };
  const env = {
    QUEUE_URL: "https://clawsweeper.example",
    EXACT_REVIEW_ITEM_KEY: "openclaw/clawsweeper#1675",
    EXACT_REVIEW_LEASE_ID: "lease-1",
    EXACT_REVIEW_LEASE_REVISION: "8",
    EXACT_REVIEW_CLAIM_GENERATION: "2",
    EXACT_REVIEW_SOURCE_HEAD_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "4242",
    GITHUB_RUN_ATTEMPT: "3",
  };
  assert.equal(await exactReviewQueueAuthorityFence(env, execute), true);
  assert.equal(invocation?.file, "bash");
  assert.match(invocation?.args.join(" ") ?? "", /control-plane-curl\.sh/);
  responseStatus = 409;
  assert.equal(await exactReviewQueueAuthorityFence(env, execute), false);
});

test("terminal receipt verification is opt-in", () => {
  const options = parseOptions([
    "--repo",
    "openclaw/openclaw",
    "--item-number",
    "81564",
    "--verify-terminal-status-receipt",
  ]);

  assert.equal(options.verifyTerminalStatusReceipt, true);
});

test("terminal receipt verification accepts only the selected trusted final status", () => {
  const marker = "<!-- clawsweeper-command-status:81564:re_review:320c867f -->";
  const options = parseOptions([
    "--repo",
    "openclaw/openclaw",
    "--item-number",
    "81564",
    "--marker",
    marker,
    "--status-comment-id",
    "4466202000",
    "--state",
    "Complete",
    "--detail",
    "Durable review routing completed.",
    "--verify-terminal-status-receipt",
  ]);
  const comment = {
    id: 4466201000,
    body: [
      "<!-- clawsweeper-command-ack:4466201487 -->",
      marker,
      "ClawSweeper re-review requested.",
      "<!-- clawsweeper-command-progress:start -->",
      "Re-review progress:",
      "- State: Complete",
      "- Detail: Durable review routing completed.",
      "- Run: https://github.com/openclaw/clawsweeper/actions/runs/older-run",
      "- Updated: 2026-08-01T00:00:00.000Z",
      "<!-- clawsweeper-command-progress:end -->",
    ].join("\n"),
  };

  assert.deepEqual(verifiedTerminalStatusReceipt(comment, options), {
    commandCommentId: 4466201487,
    completionCommentId: 4466201000,
  });
  assert.equal(
    verifiedTerminalStatusReceipt(
      {
        ...comment,
        body: comment.body.replace("Durable review routing completed.", "Still pending."),
      },
      options,
    ),
    null,
  );
  assert.equal(
    verifiedTerminalStatusReceipt(
      { ...comment, body: comment.body.replace(marker, "<!-- stale -->") },
      options,
    ),
    null,
  );
  assert.equal(
    verifiedTerminalStatusReceipt(
      {
        ...comment,
        body: comment.body.replace("<!-- clawsweeper-command-ack:4466201487 -->\n", ""),
      },
      options,
    ),
    null,
  );
  assert.equal(
    verifiedTerminalStatusReceipt(
      {
        ...comment,
        body: comment.body.replace("- State: Complete", "- State: Complete\n- State: Failed"),
      },
      options,
    ),
    null,
  );
  assert.equal(
    verifiedTerminalStatusReceipt(
      {
        ...comment,
        body: comment.body.replace(
          "- Detail: Durable review routing completed.",
          "- Detail: Durable review routing completed.\n- Detail: Still pending.",
        ),
      },
      options,
    ),
    null,
  );
  assert.equal(
    verifiedTerminalStatusReceipt({ ...comment, body: `${marker}\n${comment.body}` }, options),
    null,
  );
  assert.equal(
    verifiedTerminalStatusReceipt(
      {
        ...comment,
        body: comment.body.replace(
          "<!-- clawsweeper-command-ack:4466201487 -->",
          "<!-- clawsweeper-command-ack:4466201487 -->\n<!-- clawsweeper-command-ack:4466201488 -->",
        ),
      },
      options,
    ),
    null,
  );
});

test("terminal receipt verification accepts a status-ID-only final status", () => {
  const options = parseOptions([
    "--repo",
    "openclaw/openclaw",
    "--item-number",
    "81565",
    "--status-comment-id",
    "4466202001",
    "--state",
    "Complete",
    "--detail",
    "Durable review routing completed.",
    "--verify-terminal-status-receipt",
  ]);
  const comment = {
    id: 4466202001,
    body: [
      "<!-- clawsweeper-command-ack:4466201488 -->",
      "ClawSweeper re-review requested.",
      "<!-- clawsweeper-command-progress:start -->",
      "Re-review progress:",
      "- State: Complete",
      "- Detail: Durable review routing completed.",
      "- Updated: 2026-08-01T00:00:00.000Z",
      "<!-- clawsweeper-command-progress:end -->",
    ].join("\n"),
  };

  assert.deepEqual(verifiedTerminalStatusReceipt(comment, options), {
    commandCommentId: 4466201488,
    completionCommentId: 4466202001,
  });
  assert.equal(verifiedTerminalStatusReceipt({ ...comment, id: 4466202002 }, options), null);
  assert.equal(
    verifiedTerminalStatusReceipt(
      {
        ...comment,
        body: comment.body.replace("<!-- clawsweeper-command-ack:4466201488 -->\n", ""),
      },
      options,
    ),
    null,
  );
  assert.equal(
    verifiedTerminalStatusReceipt(
      {
        ...comment,
        body: comment.body.replace(
          "<!-- clawsweeper-command-ack:4466201488 -->",
          "<!-- clawsweeper-command-ack:4466201488 -->\n<!-- clawsweeper-command-ack:4466201489 -->",
        ),
      },
      options,
    ),
    null,
  );
  assert.equal(
    verifiedTerminalStatusReceipt(
      {
        ...comment,
        body: `<!-- clawsweeper-command-status:81565:re_review:unexpected -->\n${comment.body}`,
      },
      options,
    ),
    null,
  );
});

test("terminal receipt verification accepts the matching legacy command marker", () => {
  const marker =
    "<!-- clawsweeper-command-status:115286:re_review:80a1f1ecec31e5611087de2ee662eb27fec2abc1 -->";
  const legacyMarker =
    "<!-- clawsweeper-command:5150571675:2026-08-01T08:13:51Z:re_review:80a1f1ecec31e5611087de2ee662eb27fec2abc1 -->";
  const options = parseOptions([
    "--repo",
    "openclaw/openclaw",
    "--item-number",
    "115286",
    "--marker",
    marker,
    "--status-comment-id",
    "5150578737",
    "--state",
    "Complete",
    "--detail",
    "A newer review tuple already exists; this stale result was superseded.",
    "--verify-terminal-status-receipt",
  ]);
  const comment = {
    id: 5150578737,
    body: [
      marker,
      legacyMarker,
      "ClawSweeper re-review requested.",
      "<!-- clawsweeper-command-progress:start -->",
      "Re-review progress:",
      "- State: Complete",
      "- Detail: A newer review tuple already exists; this stale result was superseded.",
      "<!-- clawsweeper-command-progress:end -->",
    ].join("\n"),
  };

  assert.deepEqual(verifiedTerminalStatusReceipt(comment, options), {
    commandCommentId: 5150571675,
    completionCommentId: 5150578737,
  });
  assert.equal(verifiedTerminalStatusReceipt({ ...comment, id: 5150578738 }, options), null);
  assert.deepEqual(
    verifiedTerminalStatusReceipt(
      comment,
      parseOptions([
        "--marker",
        marker,
        "--state",
        "Complete",
        "--detail",
        "A newer review tuple already exists; this stale result was superseded.",
        "--verify-terminal-status-receipt",
      ]),
    ),
    { commandCommentId: 5150571675, completionCommentId: 5150578737 },
  );
  assert.equal(
    verifiedTerminalStatusReceipt(
      {
        ...comment,
        body: comment.body.replace(
          legacyMarker,
          legacyMarker.replace(":re_review:", ":automerge:"),
        ),
      },
      options,
    ),
    null,
  );
  assert.equal(
    verifiedTerminalStatusReceipt(
      {
        ...comment,
        body: comment.body.replace(
          legacyMarker,
          legacyMarker.replace("80a1f1ecec31e5611087de2ee662eb27fec2abc1", "mismatch"),
        ),
      },
      options,
    ),
    null,
  );
  assert.equal(
    verifiedTerminalStatusReceipt(
      { ...comment, body: `${legacyMarker}\n${comment.body}` },
      options,
    ),
    null,
  );
  for (const invalidAck of ["0", "9007199254740992", "invalid"]) {
    assert.equal(
      verifiedTerminalStatusReceipt(
        {
          ...comment,
          body: `<!-- clawsweeper-command-ack:${invalidAck} -->\n${comment.body}`,
        },
        options,
      ),
      null,
    );
  }
});

test("terminal receipt verification binds synthetic autofix commands to their status comment", () => {
  const marker =
    "<!-- clawsweeper-command-status:117443:autofix:59382f10545ffc2955fc88e828be1c649d33f581 -->";
  const syntheticMarker =
    "<!-- clawsweeper-command:repair-loop-label-sweep:autofix:117443:autofix:59382f10545ffc2955fc88e828be1c649d33f581 -->";
  const options = parseOptions([
    "--repo",
    "openclaw/openclaw",
    "--item-number",
    "117443",
    "--marker",
    marker,
    "--state",
    "Complete",
    "--detail",
    "The durable review result and its route handoff completed.",
    "--verify-terminal-status-receipt",
  ]);
  const comment = {
    id: 5151931725,
    body: [
      marker,
      syntheticMarker,
      "ClawSweeper autofix is enabled.",
      "<!-- clawsweeper-command-progress:start -->",
      "Re-review progress:",
      "- State: Complete",
      "- Detail: The durable review result and its route handoff completed.",
      "<!-- clawsweeper-command-progress:end -->",
    ].join("\n"),
  };

  assert.deepEqual(verifiedTerminalStatusReceipt(comment, options), {
    commandCommentId: 5151931725,
    completionCommentId: 5151931725,
  });
  for (const invalidMarker of [
    syntheticMarker.replace(":117443:", ":117444:"),
    syntheticMarker.replace(":autofix:117443:", ":automerge:117443:"),
    syntheticMarker.replace(":117443:autofix:", ":117443:automerge:"),
    syntheticMarker.replace("59382f10545ffc2955fc88e828be1c649d33f581", "mismatched"),
    `${syntheticMarker}\n${syntheticMarker}`,
    `${syntheticMarker}\n<!-- clawsweeper-command:untrusted-extra -->`,
  ]) {
    assert.equal(
      verifiedTerminalStatusReceipt(
        { ...comment, body: comment.body.replace(syntheticMarker, invalidMarker) },
        options,
      ),
      null,
    );
  }
});

test("parseOptions enables the terminal locked-conversation skip only when requested", () => {
  const options = parseOptions([
    "--repo",
    "openclaw/openclaw",
    "--item-number",
    "81564",
    "--locked-conversation-terminal-skip",
  ]);

  assert.equal(options.lockedConversationTerminalSkip, true);
  assert.equal(
    terminalLockedConversationSkip(options, {
      stderr: "gh: Unable to update comment because issue is locked. (HTTP 403)",
    }),
    true,
  );
  assert.equal(
    terminalLockedConversationSkip(options, {
      stderr: "gh: Resource not accessible by integration (HTTP 403)",
    }),
    false,
  );
});

test("terminal locked-conversation skip covers status selection", () => {
  for (const skip of [true, false]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-update-command-status-"));
    try {
      const result = runUpdateCommandStatus(
        tmp,
        [
          "--repo",
          "openclaw/openclaw",
          "--item-number",
          "81564",
          "--marker",
          "<!-- clawsweeper-command-status:81564:automerge:320c867f -->",
          "--state",
          "Complete",
          ...(skip ? ["--locked-conversation-terminal-skip"] : []),
        ],
        undefined,
        [],
        { GH_TEST_LIST_ERROR: "gh: Issue is locked. (HTTP 403)" },
      );

      assert.equal(result.status === 0, skip, result.stderr);
      assert.equal(/^locked_conversation=true$/m.test(result.output), skip);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
});

function runUpdateCommandStatus(
  tmp: string,
  args: string[],
  comment?: { id: number; body: string; user: { login: string }; updated_at?: string },
  additionalComments: Array<{
    id: number;
    body: string;
    user: { login: string };
    updated_at?: string;
  }> = [],
  extraEnv: Record<string, string> = {},
) {
  const ghPath = path.join(tmp, "gh.js");
  const patchPath = path.join(tmp, "patched-comment.json");
  fs.writeFileSync(
    ghPath,
    [
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (!args.join(' ').includes('/comments')) process.exit(1);",
      "const comment = JSON.parse(process.env.GH_TEST_STATUS_COMMENT || 'null');",
      "const comments = JSON.parse(process.env.GH_TEST_STATUS_COMMENTS || '[]');",
      "if (args.includes('PATCH')) {",
      "  const payload = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf8'));",
      "  fs.writeFileSync(process.env.GH_TEST_STATUS_PATCH_PATH, JSON.stringify(payload));",
      "  process.stdout.write(JSON.stringify({ ...comment, body: payload.body, updated_at: '2026-08-01T08:14:07Z' }));",
      "} else if (args.some((arg) => /\\/issues\\/comments\\/\\d+$/.test(arg))) {",
      "  const commentId = Number(args.find((arg) => /\\/issues\\/comments\\/\\d+$/.test(arg)).split('/').at(-1));",
      "  const exact = comments.find((candidate) => Number(candidate.id) === commentId);",
      "  if (!exact) { console.error('HTTP 404: Not Found'); process.exit(1); }",
      "  process.stdout.write(JSON.stringify({ ...exact, issue_url: process.env.GH_TEST_ISSUE_URL }));",
      "} else if (process.env.GH_TEST_LIST_ERROR) {",
      "  console.error(process.env.GH_TEST_LIST_ERROR); process.exit(1);",
      "} else {",
      "  process.stdout.write(JSON.stringify([comments]));",
      "}",
    ].join("\n"),
  );
  const outputPath = path.join(tmp, "github-output");
  fs.writeFileSync(outputPath, "");
  const script = path.join(process.cwd(), "dist/repair/update-command-status.js");
  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GH_BIN: process.execPath,
        GH_BIN_ARGS: JSON.stringify([ghPath]),
        GH_TEST_STATUS_COMMENT: JSON.stringify(comment ?? null),
        GH_TEST_STATUS_COMMENTS: JSON.stringify([
          ...additionalComments,
          ...(comment ? [comment] : []),
        ]),
        GH_TEST_ISSUE_URL: `https://api.github.com/repos/openclaw/openclaw/issues/${args[args.indexOf("--item-number") + 1]}`,
        GH_TEST_STATUS_PATCH_PATH: patchPath,
        GITHUB_OUTPUT: outputPath,
        CLAWSWEEPER_ACTION_LEDGER_DISABLED: "1",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    status = failure.status ?? 1;
    stderr = String(failure.stderr ?? "");
  }
  return {
    status,
    stderr,
    output: fs.readFileSync(outputPath, "utf8"),
    patchedBody: fs.existsSync(patchPath)
      ? (JSON.parse(fs.readFileSync(patchPath, "utf8")) as { body: string }).body
      : null,
  };
}

test("legacy command updates verify their receipt without creating duplicate acknowledgements", () => {
  for (const alreadyComplete of [false, true]) {
    for (const statusAddress of ["exact", "marker-only", "deleted", "replaced"]) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-legacy-command-status-"));
      try {
        const marker = "<!-- clawsweeper-command-status:115286:re_review:80a1f1 -->";
        const comment = {
          id: 5150578737,
          user: { login: "clawsweeper[bot]" },
          updated_at: "2026-08-01T08:13:59Z",
          body: [
            marker,
            "<!-- clawsweeper-command:5150571675:2026-08-01T08:13:51Z:re_review:80a1f1 -->",
            "<!-- clawsweeper-command-progress:start -->",
            `- State: ${alreadyComplete ? "Complete" : "In progress"}`,
            `- Detail: ${alreadyComplete ? "Done." : "Waiting."}`,
            "<!-- clawsweeper-command-progress:end -->",
          ].join("\n"),
        };
        const result = runUpdateCommandStatus(
          tmp,
          [
            "--repo",
            "openclaw/openclaw",
            "--item-number",
            "115286",
            "--marker",
            marker,
            ...(statusAddress === "marker-only"
              ? []
              : ["--status-comment-id", statusAddress === "exact" ? "5150578737" : "5150578738"]),
            "--state",
            "Complete",
            "--detail",
            "Done.",
            "--require-mutation",
            "--verify-terminal-status-receipt",
          ],
          comment,
          statusAddress === "replaced"
            ? [
                {
                  id: 5150578738,
                  user: { login: "clawsweeper[bot]" },
                  body: "<!-- clawsweeper-command-status:115286:re_review:old -->\n<!-- clawsweeper-command-ack:999 -->",
                },
              ]
            : [],
        );

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.output, /^terminal_status_verified=true$/m);
        assert.match(result.output, /^command_comment_id=5150571675$/m);
        assert.match(result.output, /^completion_comment_id=5150578737$/m);
        assert.match(
          result.output,
          new RegExp(
            `^completion_completed_at=2026-08-01T08:${alreadyComplete ? "13:59" : "14:07"}Z$`,
            "m",
          ),
        );
        if (alreadyComplete) {
          assert.equal(result.patchedBody, null);
        } else {
          assert.doesNotMatch(result.patchedBody ?? "", /clawsweeper-command-ack:/);
          assert.match(result.patchedBody ?? "", /clawsweeper-command:5150571675:/);
        }
        assert.match(result.patchedBody ?? comment.body, /- State: Complete\n- Detail: Done\./);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  }
});

test("refusal mode exposes a verified terminal receipt as terminal state", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-terminal-command-status-"));
  try {
    const marker = "<!-- clawsweeper-command-status:115286:re_review:80a1f1 -->";
    const comment = {
      id: 5_150_578_737,
      user: { login: "clawsweeper[bot]" },
      updated_at: "2026-08-01T08:13:59Z",
      body: [
        marker,
        "<!-- clawsweeper-command:5150571675:2026-08-01T08:13:51Z:re_review:80a1f1 -->",
        "<!-- clawsweeper-command-progress:start -->",
        "- State: Complete",
        "- Detail: Done.",
        "<!-- clawsweeper-command-progress:end -->",
      ].join("\n"),
    };
    const result = runUpdateCommandStatus(
      tmp,
      [
        "--repo",
        "openclaw/openclaw",
        "--item-number",
        "115286",
        "--marker",
        marker,
        "--status-comment-id",
        String(comment.id),
        "--state",
        "Complete",
        "--detail",
        "Done.",
        "--verify-terminal-status-receipt",
        "--refuse-terminal-state",
      ],
      comment,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /^terminal_state=true$/m);
    assert.match(result.output, new RegExp(`^status_comment_id=${comment.id}$`, "m"));
    assert.match(result.output, /^terminal_status_verified=true$/m);
    assert.equal(result.patchedBody, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("mixed-generation legacy command updates finalize through the CLI", () => {
  for (const alreadyComplete of [false, true]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-mixed-command-status-"));
    try {
      const commandCommentId = 5_290_152_372;
      const updatedAt = "2026-08-14T06:17:22Z";
      const marker =
        `<!-- clawsweeper-command-status:120900:re_review:` +
        `command-${commandCommentId}-${Date.parse(updatedAt).toString(36)}-${"1".repeat(64)} -->`;
      const comment = {
        id: 5_290_154_476,
        user: { login: "clawsweeper[bot]" },
        updated_at: "2026-09-02T05:21:13Z",
        body: [
          marker,
          `<!-- clawsweeper-command:${commandCommentId}:${updatedAt}:re_review:${"8".repeat(40)} -->`,
          "<!-- clawsweeper-command-progress:start -->",
          `- State: ${alreadyComplete ? "Complete" : "In progress"}`,
          `- Detail: ${alreadyComplete ? "Done." : "Waiting."}`,
          "<!-- clawsweeper-command-progress:end -->",
        ].join("\n"),
      };
      const result = runUpdateCommandStatus(
        tmp,
        [
          "--repo",
          "openclaw/openclaw",
          "--item-number",
          "120900",
          "--marker",
          marker,
          "--status-comment-id",
          String(comment.id),
          "--state",
          "Complete",
          "--detail",
          "Done.",
          "--require-mutation",
          "--verify-terminal-status-receipt",
        ],
        comment,
      );

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.output, /^terminal_status_verified=true$/m);
      assert.match(result.output, new RegExp(`^command_comment_id=${commandCommentId}$`, "m"));
      assert.match(result.output, new RegExp(`^completion_comment_id=${comment.id}$`, "m"));
      if (alreadyComplete) {
        assert.equal(result.patchedBody, null);
      } else {
        assert.doesNotMatch(result.patchedBody ?? "", /clawsweeper-command-ack:/);
        assert.match(result.patchedBody ?? "", /- State: Complete\n- Detail: Done\./);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test("missing status comment completes the terminal acknowledgement as a skip", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-update-command-status-"));
  try {
    const result = runUpdateCommandStatus(tmp, [
      "--repo",
      "openclaw/openclaw",
      "--item-number",
      "113663",
      "--marker",
      "<!-- clawsweeper-command-status:113663:automerge:320c867f -->",
      "--state",
      "Complete",
      "--detail",
      "Durable review routing completed.",
      "--require-mutation",
      "--locked-conversation-terminal-skip",
      "--verify-terminal-status-receipt",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /^missing_status_comment=true$/m);
    assert.doesNotMatch(result.output, /terminal_status_verified/);
    assert.doesNotMatch(result.output, /locked_conversation/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("missing status comment still fails non-terminal required mutations", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-update-command-status-"));
  try {
    const result = runUpdateCommandStatus(tmp, [
      "--repo",
      "openclaw/openclaw",
      "--item-number",
      "113663",
      "--marker",
      "<!-- clawsweeper-command-status:113663:automerge:320c867f -->",
      "--state",
      "Complete",
      "--detail",
      "Durable review routing completed.",
      "--require-mutation",
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /command status mutation required but no comment was found/);
    assert.doesNotMatch(result.output, /missing_status_comment/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("command status updates record the write attempt and its outcome", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-status-ledger-")));
  const marker = "<!-- clawsweeper-command-status:113663:automerge:320c867f -->";
  const receipts = (
    invocation: string,
    comment?: { id: number; body: string; user: { login: string } },
  ) => {
    const root = path.join(tmp, invocation);
    const outputRoot = path.join(root, "output");
    fs.mkdirSync(outputRoot, { recursive: true });
    const result = runUpdateCommandStatus(
      root,
      [
        "--repo",
        "openclaw/openclaw",
        "--item-number",
        "113663",
        "--marker",
        marker,
        "--state",
        "Complete",
        "--detail",
        "Durable review routing completed.",
      ],
      comment,
      [],
      {
        CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
        CLAWSWEEPER_ACTION_LEDGER_DISABLED: "0",
        CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
        CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
        CLAWSWEEPER_ACTION_LEDGER_INVOCATION: invocation,
        GITHUB_REPOSITORY: "openclaw/clawsweeper",
        GITHUB_SHA: "a".repeat(40),
        GITHUB_WORKFLOW: "repair comment router",
        GITHUB_WORKFLOW_REF: "",
        GITHUB_JOB: "route-comments",
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_ACTION: "status",
        GITHUB_RUN_STARTED_AT: "2026-09-05T00:00:00Z",
        CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
        CLAWSWEEPER_CRABFLEET_SESSION_ID: "",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return readLedgerEvents(outputRoot).map((event) => [
      event.event_type,
      event.action.status,
      event.action.mutation,
    ]);
  };
  try {
    assert.deepEqual(
      receipts("update", {
        id: 7001,
        body: `${marker}\nQueued.`,
        user: { login: "clawsweeper[bot]" },
      }),
      [
        ["command.mutation", "started", false],
        ["command.mutation", "executed", true],
        ["command.progress", "completed", true],
      ],
    );
    assert.deepEqual(receipts("missing"), [["command.progress", "skipped", false]]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function readLedgerEvents(root: string): Record<string, any>[] {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .flatMap((entry) =>
      fs
        .readFileSync(path.join(entry.parentPath, entry.name), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    )
    .sort((left, right) => left.phase_seq - right.phase_seq);
}

test("parseOptions reads STATUS_COMMENT_ID env fallback", () => {
  withEnv({ STATUS_COMMENT_ID: "4466202000" }, () => {
    const options = parseOptions(["--repo", "openclaw/openclaw", "--item-number", "81564"]);

    assert.equal(options.statusCommentId, 4466202000);
  });
});

test("empty markers do not target human comments that mention true", () => {
  const options = parseOptions([
    "--repo",
    "openclaw/openclaw",
    "--item-number",
    "81564",
    "--marker",
    "",
  ]);
  const selected = selectCommandStatusComment(
    [
      {
        id: 4465717559,
        user: { login: "hxy91819" },
        body: [
          "## Maintainer additions on top of this PR",
          "",
          "This maintainer note mentions `isError: true` twice.",
        ].join("\n"),
      },
    ],
    {
      marker: options.marker,
      statusCommentId: options.statusCommentId,
      trustedBots: options.trustedBots,
    },
  );

  assert.equal(selected, null);
});

test("selectCommandStatusComment prefers exact status comment ids", () => {
  const marker = "<!-- clawsweeper-command-status:81564:re_review:320c867f -->";
  const options = parseOptions(["--marker", marker, "--status-comment-id", "4466202000"]);
  const selected = selectCommandStatusComment(
    [
      {
        id: 4465717559,
        user: { login: "hxy91819" },
        body: marker,
      },
      {
        id: 4466202000,
        user: { login: "clawsweeper[bot]" },
        body: "<!-- clawsweeper-command-ack:4466201487 -->\nClawSweeper picked this up.",
      },
    ],
    {
      marker: options.marker,
      statusCommentId: options.statusCommentId,
      trustedBots: options.trustedBots,
    },
  );

  assert.equal(selected?.id, 4466202000);
});

test("selectCommandStatusComment converges duplicate bare fast ack comments to the oldest", () => {
  const marker = "<!-- clawsweeper-command-status:81564:re_review:320c867f -->";
  const options = parseOptions(["--marker", marker, "--status-comment-id", "4466202000"]);
  const selected = selectCommandStatusComment(
    [
      {
        id: 4466202000,
        created_at: "2026-05-29T19:19:48Z",
        user: { login: "clawsweeper[bot]" },
        body: "<!-- clawsweeper-command-ack:4466201487 -->\nClawSweeper picked this up.",
      },
      {
        id: 4466201000,
        created_at: "2026-05-29T19:19:39Z",
        user: { login: "clawsweeper[bot]" },
        body: "<!-- clawsweeper-command-ack:4466201487 -->\nClawSweeper picked this up.",
      },
    ],
    {
      marker: options.marker,
      statusCommentId: options.statusCommentId,
      trustedBots: options.trustedBots,
    },
  );

  assert.equal(selected?.id, 4466201000);
});

test("selectCommandStatusComment preserves status-bearing fast ack comments", () => {
  const marker = "<!-- clawsweeper-command-status:81564:re_review:320c867f -->";
  const options = parseOptions(["--marker", marker, "--status-comment-id", "4466201000"]);
  const selected = selectCommandStatusComment(
    [
      {
        id: 4466201000,
        created_at: "2026-05-29T19:19:39Z",
        updated_at: "2026-05-29T19:19:39Z",
        user: { login: "clawsweeper[bot]" },
        body: "<!-- clawsweeper-command-ack:4466201487 -->\nClawSweeper picked this up.",
      },
      {
        id: 4466202000,
        created_at: "2026-05-29T19:19:48Z",
        updated_at: "2026-05-29T19:21:00Z",
        user: { login: "clawsweeper[bot]" },
        body: [
          "<!-- clawsweeper-command-status:81564:re_review:320c867f -->",
          "<!-- clawsweeper-command-ack:4466201487 -->",
          "ClawSweeper re-review requested.",
          "<!-- clawsweeper-command-progress:start -->",
          "Re-review progress:",
          "- State: Complete",
          "<!-- clawsweeper-command-progress:end -->",
        ].join("\n"),
      },
    ],
    {
      marker: options.marker,
      statusCommentId: options.statusCommentId,
      trustedBots: options.trustedBots,
    },
  );

  assert.equal(selected?.id, 4466202000);
});

test("selectCommandStatusComment scopes shared ack markers to the requested status marker", () => {
  const oldMarker = "<!-- clawsweeper-command-status:81564:re_review:old -->";
  const newMarker = "<!-- clawsweeper-command-status:81564:re_review:new -->";
  const options = parseOptions(["--marker", oldMarker, "--status-comment-id", "4466201000"]);
  const selected = selectCommandStatusComment(
    [
      {
        id: 4466201000,
        created_at: "2026-05-29T19:19:39Z",
        updated_at: "2026-05-29T19:20:00Z",
        user: { login: "clawsweeper[bot]" },
        body: [
          oldMarker,
          "<!-- clawsweeper-command-ack:4466201487 -->",
          "ClawSweeper re-review requested.",
          "<!-- clawsweeper-command-progress:start -->",
          "Re-review progress:",
          "- State: In progress",
          "<!-- clawsweeper-command-progress:end -->",
        ].join("\n"),
      },
      {
        id: 4466202000,
        created_at: "2026-05-29T19:21:00Z",
        updated_at: "2026-05-29T19:22:00Z",
        user: { login: "clawsweeper[bot]" },
        body: [
          newMarker,
          "<!-- clawsweeper-command-ack:4466201487 -->",
          "ClawSweeper re-review requested.",
          "<!-- clawsweeper-command-progress:start -->",
          "Re-review progress:",
          "- State: Complete",
          "<!-- clawsweeper-command-progress:end -->",
        ].join("\n"),
      },
    ],
    {
      marker: options.marker,
      statusCommentId: options.statusCommentId,
      trustedBots: options.trustedBots,
    },
  );

  assert.equal(selected?.id, 4466201000);
});

test("selectCommandStatusComment skips stale exact status-bearing ack comments", () => {
  const oldMarker = "<!-- clawsweeper-command-status:81564:re_review:old -->";
  const newMarker = "<!-- clawsweeper-command-status:81564:re_review:new -->";
  const options = parseOptions(["--marker", newMarker, "--status-comment-id", "4466201000"]);
  const selected = selectCommandStatusComment(
    [
      {
        id: 4466201000,
        created_at: "2026-05-29T19:19:39Z",
        updated_at: "2026-05-29T19:20:00Z",
        user: { login: "clawsweeper[bot]" },
        body: [
          oldMarker,
          "<!-- clawsweeper-command-ack:4466201487 -->",
          "ClawSweeper re-review requested.",
          "<!-- clawsweeper-command-progress:start -->",
          "Re-review progress:",
          "- State: In progress",
          "<!-- clawsweeper-command-progress:end -->",
        ].join("\n"),
      },
      {
        id: 4466202000,
        created_at: "2026-05-29T19:21:00Z",
        updated_at: "2026-05-29T19:22:00Z",
        user: { login: "clawsweeper[bot]" },
        body: [newMarker, "ClawSweeper re-review requested."].join("\n"),
      },
    ],
    {
      marker: options.marker,
      statusCommentId: options.statusCommentId,
      trustedBots: options.trustedBots,
    },
  );

  assert.equal(selected?.id, 4466202000);
});

test("selectCommandStatusComment matches full fast ack markers", () => {
  const marker = "<!-- clawsweeper-command-status:81564:re_review:320c867f -->";
  const options = parseOptions(["--marker", marker, "--status-comment-id", "12"]);
  const selected = selectCommandStatusComment(
    [
      {
        id: 12,
        created_at: "2026-05-29T19:19:39Z",
        user: { login: "clawsweeper[bot]" },
        body: "<!-- clawsweeper-command-ack:12 -->\nClawSweeper picked this up.",
      },
      {
        id: 123,
        created_at: "2026-05-29T19:19:48Z",
        user: { login: "clawsweeper[bot]" },
        body: "<!-- clawsweeper-command-ack:123 -->\nClawSweeper picked this up.",
      },
    ],
    {
      marker: options.marker,
      statusCommentId: options.statusCommentId,
      trustedBots: options.trustedBots,
    },
  );

  assert.equal(selected?.id, 12);
});

test("selectCommandStatusComment ignores human comments during marker fallback", () => {
  const marker = "<!-- clawsweeper-command-status:81564:re_review:320c867f -->";
  const options = parseOptions(["--marker", marker]);
  const selected = selectCommandStatusComment(
    [
      {
        id: 4465717559,
        user: { login: "hxy91819" },
        body: marker,
      },
      {
        id: 4466202000,
        user: { login: "openclaw-clawsweeper[bot]" },
        body: `${marker}\nClawSweeper picked this up.`,
      },
    ],
    {
      marker: options.marker,
      statusCommentId: options.statusCommentId,
      trustedBots: options.trustedBots,
    },
  );

  assert.equal(selected?.id, 4466202000);
});

test("selectCommandStatusComment honors custom trusted bots for exact ids", () => {
  const marker = "<!-- clawsweeper-command-status:81564:re_review:320c867f -->";
  const options = parseOptions([
    "--marker",
    marker,
    "--status-comment-id",
    "4466202000",
    "--trusted-bots",
    "custom-clawsweeper[bot]",
  ]);
  const selected = selectCommandStatusComment(
    [
      {
        id: 4466202000,
        user: { login: "custom-clawsweeper[bot]" },
        body: "<!-- clawsweeper-command-ack:4466201487 -->\nClawSweeper picked this up.",
      },
    ],
    {
      marker: options.marker,
      statusCommentId: options.statusCommentId,
      trustedBots: options.trustedBots,
    },
  );

  assert.equal(selected?.id, 4466202000);
});

test("selectCommandStatusComment honors custom trusted bots during marker fallback", () => {
  const marker = "<!-- clawsweeper-command-status:81564:re_review:320c867f -->";
  withEnv({ CLAWSWEEPER_TRUSTED_BOTS: "custom-clawsweeper[bot]" }, () => {
    const options = parseOptions(["--marker", marker]);
    const selected = selectCommandStatusComment(
      [
        {
          id: 4465717559,
          user: { login: "hxy91819" },
          body: marker,
        },
        {
          id: 4466202000,
          user: { login: "custom-clawsweeper[bot]" },
          body: `${marker}\nClawSweeper picked this up.`,
        },
      ],
      {
        marker: options.marker,
        statusCommentId: options.statusCommentId,
        trustedBots: options.trustedBots,
      },
    );

    assert.equal(selected?.id, 4466202000);
  });
});

test("selectCommandStatusComment does not append progress to Mantis proof comments", () => {
  const marker = "<!-- mantis-telegram-desktop-proof -->";
  const options = parseOptions(["--marker", marker]);
  const selected = selectCommandStatusComment(
    [
      {
        id: 4471379948,
        user: { login: "clawsweeper[bot]" },
        body: [
          marker,
          "## Mantis Telegram Desktop Proof",
          "",
          "Summary: Mantis did not generate before/after GIFs.",
        ].join("\n"),
      },
    ],
    {
      marker: options.marker,
      statusCommentId: options.statusCommentId,
      trustedBots: options.trustedBots,
    },
  );

  assert.equal(selected, null);
});

test("command review lease head prefers the decision, then the live head, then the marker", () => {
  const decisionHead = "a".repeat(40);
  const liveHead = "b".repeat(40);
  const markerHead = "b0ac90ba938351ad694e975431fead2251cffa70";
  const marker = `<!-- clawsweeper-command-status:159972:automerge:${markerHead} -->`;
  const base = { repo: "openclaw/openclaw", itemNumber: 159972, marker };
  assert.equal(
    commandReviewLeaseHeadSha({ ...base, sourceHeadSha: decisionHead, liveHeadSha: liveHead }),
    decisionHead,
  );
  const issueRevision = "c".repeat(64);
  assert.equal(
    commandReviewLeaseHeadSha({ ...base, sourceRevision: issueRevision }),
    issueRevision,
  );
  assert.equal(commandReviewLeaseHeadSha({ ...base, liveHeadSha: liveHead }), liveHead);
  // The failing 2026-09-28 automerge runs: empty decision head and source revision.
  assert.equal(
    commandReviewLeaseHeadSha({ ...base, sourceHeadSha: "", sourceRevision: "" }),
    markerHead,
  );
  for (const unusable of [
    `<!-- clawsweeper-command-status:159973:automerge:${markerHead} -->`,
    "<!-- clawsweeper-command-status:159972:re_review:command-1-abc-" + "d".repeat(64) + " -->",
    "<!-- clawsweeper-command-status:159972:automerge:na -->",
    "",
  ]) {
    assert.throws(
      () => commandReviewLeaseHeadSha({ ...base, marker: unusable }),
      /queue-owned command review lease for openclaw\/openclaw#159972 has no valid head SHA/,
    );
  }
  assert.throws(
    () => commandReviewLeaseHeadSha({ ...base, sourceHeadSha: "not-a-sha" }),
    /has no valid head SHA/,
  );
});

test("queue-owned command progress leases the marker head when the decision has none", async () => {
  const markerHead = "b0ac90ba938351ad694e975431fead2251cffa70";
  const heartbeats: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      heartbeats.push({ path: request.url, ...JSON.parse(body || "{}") });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const queueUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const scenario of ["marker-head", "no-head"] as const) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-command-lease-head-"));
      try {
        const marker =
          scenario === "marker-head"
            ? `<!-- clawsweeper-command-status:159972:automerge:${markerHead} -->`
            : "<!-- clawsweeper-command-status:159972:automerge:na -->";
        const comment = {
          id: 5861599003,
          user: { login: "clawsweeper[bot]" },
          body: [
            marker,
            "Automerge queued.",
            "<!-- clawsweeper-command-progress:start -->",
            "- State: Queued",
            "- Detail: Waiting.",
            "<!-- clawsweeper-command-progress:end -->",
          ].join("\n"),
        };
        const result = await runQueueOwnedCommandStatus(tmp, marker, comment, {
          QUEUE_URL: queueUrl,
          EXACT_REVIEW_SOURCE_HEAD_SHA: "",
          EXACT_REVIEW_SOURCE_REVISION: "",
          EXACT_REVIEW_LIVE_HEAD_SHA: "",
        });
        if (scenario === "marker-head") {
          assert.equal(result.status, 0, result.stderr);
          assert.match(
            result.patchedBody ?? "",
            new RegExp(
              `<!-- clawsweeper-review-status:started item=159972 sha=${markerHead} .* owner=github-run-36365358286-1 v=1 -->\\n<!-- clawsweeper-command-review-lease item=159972 -->$`,
            ),
          );
        } else {
          assert.notEqual(result.status, 0);
          assert.match(
            result.stderr,
            /queue-owned command review lease for openclaw\/openclaw#159972 has no valid head SHA/,
          );
          assert.equal(result.patchedBody, null);
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    // The queue fence keeps sending only the decision head, never the fallback.
    assert.ok(heartbeats.length >= 2);
    for (const heartbeat of heartbeats) {
      assert.equal(heartbeat.path, "/internal/exact-review/heartbeat");
      assert.equal(Object.hasOwn(heartbeat, "source_head_sha"), false);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function runQueueOwnedCommandStatus(
  tmp: string,
  marker: string,
  comment: { id: number; body: string; user: { login: string } },
  env: Record<string, string>,
) {
  const ghPath = path.join(tmp, "gh.js");
  const patchPath = path.join(tmp, "patched-comment.json");
  fs.writeFileSync(
    ghPath,
    [
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "const comment = JSON.parse(process.env.GH_TEST_STATUS_COMMENT);",
      "if (args.includes('PATCH')) {",
      "  const payload = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf8'));",
      "  fs.writeFileSync(process.env.GH_TEST_STATUS_PATCH_PATH, JSON.stringify(payload));",
      "  process.stdout.write(JSON.stringify({ ...comment, body: payload.body }));",
      "} else if (args.some((arg) => /\\/issues\\/comments\\/\\d+$/.test(arg))) {",
      "  process.stdout.write(JSON.stringify({ ...comment, issue_url: 'https://api.github.com/repos/openclaw/openclaw/issues/159972' }));",
      "} else {",
      "  process.stdout.write(JSON.stringify([[comment]]));",
      "}",
    ].join("\n"),
  );
  const outputPath = path.join(tmp, "github-output");
  fs.writeFileSync(outputPath, "");
  try {
    await promisify(execFile)(
      process.execPath,
      [
        path.join(process.cwd(), "dist/repair/update-command-status.js"),
        "--repo",
        "openclaw/openclaw",
        "--item-number",
        "159972",
        "--marker",
        marker,
        "--status-comment-id",
        String(comment.id),
        "--state",
        "Review in progress",
        "--detail",
        "The exact-review queue leased this run; Codex is reviewing the item.",
        "--run-url",
        "https://github.com/openclaw/clawsweeper/actions/runs/36365358286",
        "--refuse-terminal-state",
        "--require-queue-authority-fence",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GH_BIN: process.execPath,
          GH_BIN_ARGS: JSON.stringify([ghPath]),
          GH_TEST_STATUS_COMMENT: JSON.stringify(comment),
          GH_TEST_STATUS_PATCH_PATH: patchPath,
          GITHUB_OUTPUT: outputPath,
          GITHUB_RUN_ID: "36365358286",
          GITHUB_RUN_ATTEMPT: "1",
          EXACT_REVIEW_ITEM_KEY: "openclaw/openclaw#159972",
          EXACT_REVIEW_LEASE_ID: "da809554-2fd4-4cee-baac-1d600f37cf53",
          EXACT_REVIEW_LEASE_REVISION: "3",
          EXACT_REVIEW_CLAIM_GENERATION: "1",
          CLAWSWEEPER_ACTION_LEDGER_DISABLED: "1",
          ...env,
        },
      },
    );
    return { status: 0, stderr: "", patchedBody: readPatchedBody(patchPath) };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return {
      status: typeof failure.code === "number" ? failure.code : 1,
      stderr: String(failure.stderr ?? ""),
      patchedBody: readPatchedBody(patchPath),
    };
  }
}

function readPatchedBody(patchPath: string) {
  return fs.existsSync(patchPath)
    ? (JSON.parse(fs.readFileSync(patchPath, "utf8")) as { body: string }).body
    : null;
}

test("mergeCommandProgressSection replaces existing progress blocks in place", () => {
  const body = mergeCommandProgressSection(
    [
      "<!-- clawsweeper-command-ack:4466201487 -->",
      "Queued.",
      "",
      "<!-- clawsweeper-command-progress:start -->",
      "Re-review progress:",
      "- State: Review in progress",
      "- Detail: Old detail",
      "<!-- clawsweeper-command-progress:end -->",
    ].join("\n"),
    {
      state: "Complete",
      detail: "Updated detail",
      runUrl: "https://github.com/openclaw/clawsweeper/actions/runs/25957571980",
    },
  );

  assert.match(body, /- State: Complete/);
  assert.match(body, /- Detail: Updated detail/);
  assert.equal((body.match(/clawsweeper-command-progress:start/g) ?? []).length, 1);
});

test("terminal command progress releases its command-owned review lease", () => {
  const body = mergeCommandProgressSection(
    [
      "<!-- clawsweeper-command-ack:4466201487 -->",
      "Exact review queued.",
      "<!-- clawsweeper-command-progress:start -->",
      "Re-review progress:",
      "- State: Review in progress",
      "- Detail: Reviewing",
      "<!-- clawsweeper-command-progress:end -->",
      "<!-- clawsweeper-review-status:started item=42 sha=abc started_at=2026-09-23T00:00:00Z lease_expires_at=2026-09-23T01:00:00Z owner=worker-1 v=1 -->",
      "<!-- clawsweeper-command-review-lease item=42 -->",
    ].join("\n"),
    {
      state: "Complete",
      detail: "Published",
      runUrl: "https://github.com/openclaw/clawsweeper/actions/runs/1",
      verifyTerminalStatusReceipt: true,
    },
  );

  assert.match(body, /- State: Complete/);
  assert.doesNotMatch(body, /clawsweeper-review-status:started/);
  assert.doesNotMatch(body, /clawsweeper-command-review-lease/);
  assert.match(body, /clawsweeper-command-ack:4466201487/);

  const firstProgress = mergeCommandProgressSection(
    [
      "<!-- clawsweeper-command-ack:4466201487 -->",
      "Exact review queued.",
      "<!-- clawsweeper-review-status:started item=42 sha=abc started_at=2026-09-23T00:00:00Z lease_expires_at=2026-09-23T01:00:00Z owner=worker-1 v=1 -->",
      "<!-- clawsweeper-command-review-lease item=42 -->",
    ].join("\n"),
    {
      state: "Complete",
      detail: "Published",
      runUrl: "https://github.com/openclaw/clawsweeper/actions/runs/1",
      verifyTerminalStatusReceipt: true,
    },
  );
  assert.match(firstProgress, /- State: Complete/);
  assert.doesNotMatch(firstProgress, /clawsweeper-command-review-lease/);
});

test("queue-owned command progress exposes one hidden lease and failure removes it", () => {
  const active = mergeCommandProgressSection("Exact review queued.", {
    state: "Review in progress",
    detail: "Reviewing.",
    runUrl: "https://github.com/openclaw/clawsweeper/actions/runs/1",
    queueLease: {
      itemNumber: 42,
      headSha: "a".repeat(40),
      owner: "github-run-1-1",
      startedAt: "2026-09-24T00:00:00.000Z",
      expiresAt: "2026-09-24T01:00:00.000Z",
    },
  });
  assert.match(active, /clawsweeper-review-status:started item=42/);
  assert.match(active, /clawsweeper-command-review-lease item=42/);
  const failed = mergeCommandProgressSection(active, {
    state: "Failed",
    detail: "Retry later.",
    runUrl: "https://github.com/openclaw/clawsweeper/actions/runs/1",
  });
  assert.doesNotMatch(failed, /clawsweeper-(?:review-status:started|command-review-lease)/);
  assert.match(failed, /- State: Failed/);

  const foreign = active.replace("owner=github-run-1-1", "owner=github-run-2-1");
  const refreshed = mergeCommandProgressSection(foreign, {
    state: "Review in progress",
    detail: "Reviewing again.",
    runUrl: "https://github.com/openclaw/clawsweeper/actions/runs/2",
    queueLease: {
      itemNumber: 42,
      headSha: "a".repeat(40),
      owner: "github-run-1-1",
      startedAt: "2026-09-24T00:01:00.000Z",
      expiresAt: "2026-09-24T02:01:00.000Z",
    },
  });
  assert.match(refreshed, /owner=github-run-1-1/);
  assert.doesNotMatch(refreshed, /owner=github-run-2-1/);
});
