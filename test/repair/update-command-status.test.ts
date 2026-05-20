import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeCommandProgressSection,
  parseOptions,
  selectCommandStatusComment,
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
});

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
