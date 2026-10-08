import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSpamModelInput,
  commentVersionKey,
  graphqlNodesToleratingNotFound,
  deterministicSpamSignals,
  isProtectedSpamAuthor,
  legitimateTechnicalContextSignals,
  normalizeModelResults,
  prioritizeSpamScanComments,
  redactSpamModelError,
  shouldSendToCheapModel,
  SPAM_MODEL_SYSTEM_PROMPT,
  type SpamScanComment,
} from "../../dist/repair/spam-scanner-core.js";

function comment(overrides: Partial<SpamScanComment> = {}): SpamScanComment {
  return {
    kind: "issue_comment",
    id: "123",
    node_id: "IC_123",
    html_url: "https://github.com/openclaw/openclaw/issues/1#issuecomment-123",
    issue_url: "https://api.github.com/repos/openclaw/openclaw/issues/1",
    pull_request_url: null,
    body: "I specialize in web scraping & data extraction. Fast turnaround, clean output.\n\n$5 flash sale -> https://tinyurl.com/example",
    author: "matisaar",
    author_association: "NONE",
    created_at: "2026-05-11T00:00:00Z",
    updated_at: "2026-05-11T00:00:00Z",
    ...overrides,
  };
}

test("deterministic spam facts label solicitation shortener comments", () => {
  const signals = deterministicSpamSignals(comment());
  assert.ok(signals.signals.includes("url_shortener"));
  assert.ok(signals.signals.includes("solicitation_language"));
  assert.ok(signals.signals.includes("priced_service_pitch"));
  assert.equal(shouldSendToCheapModel(comment()), true);
});

test("protected authors are not sent to cheap spam model", () => {
  const owner = comment({ author: "maintainer", author_association: "OWNER" });
  assert.equal(isProtectedSpamAuthor(owner), true);
  assert.equal(shouldSendToCheapModel(owner), false);
  const contributor = comment({ author: "contributor", author_association: "CONTRIBUTOR" });
  assert.equal(isProtectedSpamAuthor(contributor), true);
  assert.equal(shouldSendToCheapModel(contributor), false);
});

test("admission uses facts, not keywords: every non-protected comment above the floor is sent", () => {
  // No spam keyword at all: the model still judges it.
  assert.equal(
    shouldSendToCheapModel(comment({ body: "See https://github.com/openclaw/openclaw" })),
    true,
  );
  assert.equal(shouldSendToCheapModel(comment({ body: "Thanks, this fixed it for me." })), true);
  // Below the length floor: only a link or a GitHub minimization admits it.
  assert.equal(shouldSendToCheapModel(comment({ body: "+1" })), false);
  assert.equal(shouldSendToCheapModel(comment({ body: "https://t.co/x" })), true);
  assert.equal(
    shouldSendToCheapModel(comment({ body: "buy now", minimized_reason: "spam" })),
    true,
  );
});

test("outside author external links are recorded as facts for the model", () => {
  const signals = deterministicSpamSignals(
    comment({
      author: "external-contributor",
      author_association: "NONE",
      body: `Still reproducible with the current gateway logs.

Endpoint: https://open.feishu.cn/open-apis/bot/v1/openclaw_bot/ping
Provider: https://api.minimaxi.com/anthropic/v1/messages
Run: https://github.com/openclaw/clawsweeper/actions/runs/123`,
    }),
  );

  assert.deepEqual(signals.signals, [
    "multiple_external_links",
    "outside_author_with_external_link",
  ]);
});

test("long technical patch evidence is framed as legitimate context, not spam", () => {
  const empiricalPatch = comment({
    author: "external-debugger",
    author_association: "NONE",
    html_url: "https://github.com/openclaw/openclaw/pull/78595#issuecomment-4412929836",
    body: `# Empirical migration test on a populated install + working merge patch

I ran this branch against a snapshot of my real ~/.openclaw. Goal: turn flagged
P1s on the legacy-import paths into measured numbers and a tested fix.

| Metric | Unpatched migration | Patched |
| --- | --- | --- |
| transcript_events rows | 6,901 | 8,325 |

The patch adds mergeSqliteSessionTranscriptEvents and preserves newer SQLite
events. git apply --check is clean.

\`\`\`sh
git apply migrate-fix.patch
pnpm exec vitest run src/commands/doctor-session-transcripts.test.ts
\`\`\`

\`\`\`diff
diff --git a/src/config/sessions/transcript-store.sqlite.ts b/src/config/sessions/transcript-store.sqlite.ts
+export function mergeSqliteSessionTranscriptEvents() {
+  return { merged: 1, skipped: 0 };
+}
\`\`\`
`,
  });

  const contextSignals = legitimateTechnicalContextSignals(empiricalPatch);
  assert.ok(contextSignals.includes("code_block_or_patch"));
  assert.ok(contextSignals.includes("patch_or_diff"));
  assert.ok(contextSignals.includes("test_command"));
  assert.ok(contextSignals.includes("reproduction_or_evidence"));
  assert.ok(contextSignals.includes("debugging_or_migration_context"));
  assert.ok(contextSignals.includes("technical_table"));

  const input = buildSpamModelInput([empiricalPatch]);
  assert.match(input.policy, /Technical repros, patches, logs, tests/);
  assert.match(SPAM_MODEL_SYSTEM_PROMPT, /Classify on-topic technical contributions as not spam/);
  assert.deepEqual(input.comments[0]?.technical_context_facts, contextSignals);
  assert.match(input.policy, /inputs for your judgement, not verdicts/);
});

test("broad scan priority skips processed comments before capping", () => {
  const processedOne = comment({
    id: "1",
    updated_at: "2026-05-11T00:03:00Z",
  });
  const processedTwo = comment({
    id: "2",
    updated_at: "2026-05-11T00:02:00Z",
  });
  const unprocessedSpam = comment({
    id: "3",
    updated_at: "2026-05-11T00:01:00Z",
  });
  const ordinaryComment = comment({
    id: "4",
    updated_at: "2026-05-11T00:00:00Z",
    body: "Thanks, I added a regression test in https://github.com/openclaw/openclaw/pull/1",
  });

  const prioritized = prioritizeSpamScanComments({
    comments: [processedOne, processedTwo, unprocessedSpam, ordinaryComment],
    maxComments: 2,
    processedCommentVersionKeys: new Set([
      commentVersionKey(processedOne),
      commentVersionKey(processedTwo),
    ]),
  });

  assert.deepEqual(
    prioritized.map((entry) => entry.id),
    ["3", "4"],
  );
});

test("model input is compact and keeps deterministic facts", () => {
  const input = buildSpamModelInput([comment()]);
  assert.equal(input.comments.length, 1);
  assert.equal(input.comments[0]?.comment_id, "123");
  assert.ok(input.comments[0]?.deterministic_facts.includes("url_shortener"));
});

test("model results are normalized and clamped", () => {
  const results = normalizeModelResults({
    results: [
      {
        comment_id: 123,
        spam_signal: "high",
        confidence: 2,
        reasons: ["solicitation"],
        should_investigate: true,
      },
    ],
  });
  assert.deepEqual(results, [
    {
      comment_id: "123",
      spam_signal: "high",
      confidence: 1,
      reasons: ["solicitation"],
      should_investigate: true,
    },
  ]);
});

test("graphql nodes tolerate comments deleted mid-scan (NOT_FOUND -> null nodes)", () => {
  const nodes = graphqlNodesToleratingNotFound({
    data: {
      nodes: [{ id: "IC_alive", isMinimized: true, minimizedReason: "spam" }, null],
    },
    errors: [
      {
        type: "NOT_FOUND",
        message: "Could not resolve to a node with the global id of 'IC_gone'",
      },
    ],
  });
  assert.deepEqual(nodes, [{ id: "IC_alive", isMinimized: true, minimizedReason: "spam" }]);
});

test("graphql nodes without errors pass through unchanged", () => {
  const nodes = graphqlNodesToleratingNotFound({
    data: { nodes: [{ id: "IC_1", isMinimized: false, minimizedReason: null }] },
  });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]?.id, "IC_1");
});

test("graphql nodes fail on non-NOT_FOUND error types", () => {
  assert.throws(
    () =>
      graphqlNodesToleratingNotFound({
        data: { nodes: [null] },
        errors: [
          { type: "NOT_FOUND", message: "Could not resolve to a node" },
          { type: "FORBIDDEN", message: "Resource not accessible by integration" },
        ],
      }),
    /GraphQL nodes query failed: Resource not accessible by integration/,
  );
});

test("graphql nodes fail when the payload carries no data", () => {
  assert.throws(
    () => graphqlNodesToleratingNotFound({ errors: [{ type: "NOT_FOUND", message: "gone" }] }),
    /no data payload/,
  );
  assert.throws(() => graphqlNodesToleratingNotFound(null), /no data payload/);
});

test("spam model errors redact the configured internal model from OpenAI error bodies", () => {
  const previous = process.env.CLAWSWEEPER_INTERNAL_MODEL;
  process.env.CLAWSWEEPER_INTERNAL_MODEL = "gpt-secret-model";
  try {
    const notFound = new Error(
      'OpenAI spam scan failed: HTTP 404 {"error":{"message":"The model `gpt-secret-model` does not exist or you do not have access to it.","code":"model_not_found"}}',
    );
    const redacted = redactSpamModelError(notFound, "gpt-secret-model");
    assert.doesNotMatch(redacted, /gpt-secret-model/);
    assert.match(redacted, /HTTP 404 .*The model `\[REDACTED_INTERNAL_MODEL\]` does not exist/);
  } finally {
    if (previous === undefined) delete process.env.CLAWSWEEPER_INTERNAL_MODEL;
    else process.env.CLAWSWEEPER_INTERNAL_MODEL = previous;
  }
});

test("spam model errors redact a model that only the scan request knows", () => {
  const previous = process.env.CLAWSWEEPER_INTERNAL_MODEL;
  delete process.env.CLAWSWEEPER_INTERNAL_MODEL;
  try {
    const rateLimited = new Error(
      "OpenAI spam scan failed: HTTP 429 Rate limit reached for gpt-secret-model in organization org-x on tokens per min (TPM): Limit 30000, Used 30000, Requested 1000.",
    );
    const redacted = redactSpamModelError(rateLimited, "gpt-secret-model");
    assert.doesNotMatch(redacted, /gpt-secret-model/);
    assert.match(redacted, /Rate limit reached for \[REDACTED_INTERNAL_MODEL\] in organization/);
    assert.equal(redactSpamModelError("plain failure", "gpt-secret-model"), "plain failure");
  } finally {
    if (previous !== undefined) process.env.CLAWSWEEPER_INTERNAL_MODEL = previous;
  }
});

test("spam model errors keep the public model name untouched", () => {
  assert.equal(
    redactSpamModelError(new Error("internal server error"), "internal"),
    "internal server error",
  );
});

test("spam model errors redact overlapping requested and configured identifiers completely", () => {
  const previous = process.env.CLAWSWEEPER_OPENCLAW_MODEL;
  try {
    for (const [requested, configured] of [
      ["gpt-private", "gpt-private-tenant-secret"],
      ["gpt-private-tenant-secret", "gpt-private"],
    ]) {
      process.env.CLAWSWEEPER_OPENCLAW_MODEL = configured;
      assert.equal(
        redactSpamModelError(`requested=${requested}; configured=${configured}`, requested),
        "requested=[REDACTED_INTERNAL_MODEL]; configured=[REDACTED_INTERNAL_MODEL]",
      );
    }
  } finally {
    if (previous === undefined) delete process.env.CLAWSWEEPER_OPENCLAW_MODEL;
    else process.env.CLAWSWEEPER_OPENCLAW_MODEL = previous;
  }
});
