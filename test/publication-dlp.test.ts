import assert from "node:assert/strict";
import test from "node:test";
import { markdownFor } from "../dist/clawsweeper-report-document.js";
import { renderReviewCommentFromReport } from "../dist/clawsweeper-report-comment-presentation.js";
import { readReviewRecord } from "../dist/review-record.js";
import { isApplyCloseCandidateReport } from "../dist/clawsweeper-record-metadata.js";
import { closeDecision, item } from "./helpers.ts";

function report(summary: string): string {
  return markdownFor({
    item: item(),
    decision: { ...closeDecision({ summary }), localCheckoutAccess: "verified" },
    context: { issue: {}, comments: [], timeline: [] },
    git: { mainSha: "a".repeat(40), latestRelease: null, releaseStateComplete: true },
    action: { actionTaken: "proposed_close" },
    reviewMode: "propose",
    snapshotHash: "synthetic-snapshot",
    contentDigest: "synthetic-content",
    reviewPolicy: "synthetic-policy",
    runtime: { model: "Codex", reasoningEffort: "high" },
  } as Parameters<typeof markdownFor>[0]);
}

test("publication redacts runtime capabilities and token shapes and blocks apply", () => {
  const original = process.env;
  const token = "synthetic-runtime-capability-for-dlp";
  const shaped = `ghs_${"x".repeat(36)}`;
  try {
    process.env = { PATH: original.PATH, GH_TOKEN: token };
    const markdown = report(`Evidence ${token} and ${shaped}`);
    const comment = renderReviewCommentFromReport(markdown, "implemented_on_main");
    for (const output of [markdown, comment]) {
      assert.ok(!output.includes(token));
      assert.ok(!output.includes(shaped));
      assert.ok(output.includes("[redacted credential]"));
    }
    assert.match(markdown, /^review_status: failed$/m);
    assert.equal(readReviewRecord(markdown)?.decision.decision, "keep_open");
    assert.equal(isApplyCloseCandidateReport(markdown), false);
  } finally {
    process.env = original;
  }
});

test("benign token terminology remains unchanged", () => {
  const summary = "The token refresh handler accepts a token parameter without a password prompt.";
  const markdown = report(summary);
  assert.ok(markdown.includes(summary));
  assert.ok(!markdown.includes("[redacted credential]"));
  assert.match(markdown, /^review_status: complete$/m);
});

test("credential patterns and nested multiline capabilities are redacted before serialization", async () => {
  const { redactPublication } = await import("../dist/publication-dlp.js");
  const original = process.env;
  const multiline = "synthetic line one\nsynthetic line two";
  const credentials = [
    ...["ghs_", "ghp_", "gho_", "ghu_", "ghr_", "github_pat_"].map((p) => p + "a".repeat(36)),
    `sk-proj-${"b".repeat(40)}`,
    `sk-${"c".repeat(40)}`,
    `AKIA${"D".repeat(16)}`,
    `ASIA${"E".repeat(16)}`,
    "-----BEGIN RSA PRIVATE KEY-----\nfake-only\n-----END RSA PRIVATE KEY-----",
    multiline,
  ];
  try {
    process.env = { SOME_NEW_SECRET: multiline };
    const safe = redactPublication({ evidence: credentials.map((detail) => ({ detail })) });
    assert.equal(safe.redactions, credentials.length);
    assert.deepEqual(
      safe.value.evidence,
      credentials.map(() => ({ detail: "[redacted credential]" })),
    );
  } finally {
    process.env = original;
  }
});

test("the explicit child token remains protected if absent from publisher env", async () => {
  const { codexEnv } = await import("../dist/codex-env.js");
  const original = process.env;
  try {
    process.env = {};
    const token = "synthetic-explicit-child-capability";
    codexEnv({ ghToken: token });
    const markdown = report(`Evidence ${token}`);
    assert.ok(!markdown.includes(token));
    assert.match(markdown, /^review_status: failed$/m);
  } finally {
    process.env = original;
  }
});

test("apply cannot promote a compromised record back into an eligible close", async () => {
  const { validateReportClose } = await import("../dist/clawsweeper-apply-close-decision.js");
  const { validateCloseDecision } = await import("../dist/clawsweeper-close-decision.js");
  const markdown = report(`Evidence ghs_${"a".repeat(36)}`);
  const validation = validateReportClose(
    { validateCloseDecision },
    item(),
    markdown,
    "implemented_on_main",
    { requireCloseComment: false },
  );
  assert.deepEqual(validation, {
    ok: false,
    actionTaken: "skipped_invalid_decision",
    reason: "review attempted to publish a credential; fresh review required",
  });
});

test("inline OpenClaw provider capabilities remain protected after environment removal", async () => {
  const { codexEnv } = await import("../dist/codex-env.js");
  const original = process.env;
  const key = "synthetic-inline-provider-capability";
  const header = "synthetic-authorization-header";
  try {
    process.env = {
      CLAWSWEEPER_RUNNER: "openclaw",
      CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON: JSON.stringify({
        custom: { apiKey: key, headers: { Authorization: header } },
      }),
    };
    codexEnv();
    process.env = {};
    const markdown = report(`Provider ${key} and ${header}`);
    assert.ok(!markdown.includes(key));
    assert.ok(!markdown.includes(header));
    assert.match(markdown, /^review_status: failed$/m);
  } finally {
    process.env = original;
  }
});

test("raw model credentials are detected before Markdown normalization", async () => {
  const { reviewDecisionParser } = await import("../dist/clawsweeper-decision-parser.js");
  const original = process.env;
  const token = "synthetic<capability>\n## Credential line";
  try {
    process.env = { GH_TOKEN: token };
    const decision = reviewDecisionParser.parseDecision(closeDecision({ summary: token }));
    assert.ok(decision.summary.startsWith("Codex review failed: credential output"));
    assert.equal(decision.decision, "keep_open");
    assert.ok(!decision.summary.includes("capability"));
    assert.ok(decision.summary.includes("[redacted credential]"));
  } finally {
    process.env = original;
  }
});

test("Codex operational sandbox flags are not credentials", async () => {
  const { redactPublication } = await import("../dist/publication-dlp.js");
  const original = process.env;
  try {
    process.env = { CODEX_SANDBOX_NETWORK_DISABLED: "1", CODEX_SANDBOX: "seatbelt" };
    const safe = redactPublication("Test 123 under seatbelt.");
    assert.deepEqual(safe, { value: "Test 123 under seatbelt.", redactions: 0 });
  } finally {
    process.env = original;
  }
});

test("authenticated proxy capabilities are redacted and block review publication", () => {
  const original = process.env;
  const proxy = "http://proxy-user:synthetic%2Dproxy-password@proxy.example:8080";
  try {
    process.env = { https_proxy: proxy, HTTP_PROXY: "http://public.proxy.example:8080" };
    const markdown = report(
      `Proxy ${proxy}; decoded synthetic-proxy-password; encoded synthetic%2Dproxy-password`,
    );
    assert.ok(!markdown.includes(proxy));
    assert.ok(!markdown.includes("synthetic-proxy-password"));
    assert.ok(!markdown.includes("synthetic%2Dproxy-password"));
    assert.match(markdown, /^review_status: failed$/m);
    assert.equal(isApplyCloseCandidateReport(markdown), false);
    assert.ok(
      report("Use http://public.proxy.example:8080").includes("http://public.proxy.example:8080"),
    );
  } finally {
    process.env = original;
  }
});
