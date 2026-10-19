import assert from "node:assert/strict";
import test from "node:test";
import { markdownFor } from "../dist/clawsweeper-report-document.js";
import { renderReviewCommentFromReport } from "./helpers.ts";
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

test("Codex operational launcher settings are not credentials", async () => {
  const { redactPublication } = await import("../dist/publication-dlp.js");
  const original = process.env;
  try {
    process.env = {
      CODEX_SANDBOX_NETWORK_DISABLED: "1",
      CODEX_SANDBOX: "seatbelt",
      CODEX_BIN: "codex",
      CODEX_BIN_ARGS: "exec",
      CODEX_HOME: "/home/reviewer/.codex",
    };
    const text = "Test 123 under seatbelt: codex exec in /home/reviewer/.codex.";
    const safe = redactPublication(text);
    assert.deepEqual(safe, { value: text, redactions: 0 });
    process.env.CODEX_ACCESS_TOKEN = "synthetic-codex-auth-capability";
    process.env.CODEX_UNKNOWN_CAPABILITY = "synthetic-future-codex-capability";
    assert.deepEqual(
      redactPublication("synthetic-codex-auth-capability synthetic-future-codex-capability"),
      { value: "[redacted credential] [redacted credential]", redactions: 2 },
    );
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
    assert.equal(
      readReviewRecord(report("Use http://public.proxy.example:8080"))?.decision.summary,
      "Use http://public.proxy.example:8080",
    );
  } finally {
    process.env = original;
  }
});

test("short capability values preserve structured keys and common content", async () => {
  const { redactPublication, registerPublicationCapability } =
    await import("../dist/publication-dlp.js");
  const original = process.env;
  try {
    for (const value of [
      "root",
      "true",
      "1",
      "/tmp",
      "/a/long/path/that/is/not/a/credential",
      "123456789012345678901234",
      "ordinarycommonwordvalue",
    ]) {
      process.env = { CODEX_UNKNOWN_CAPABILITY: value };
      registerPublicationCapability(value);
      const input = { rootCauseCluster: value, unchanged: "root true 1 /tmp" };
      assert.deepEqual(redactPublication(input), { value: input, redactions: 0 });
      assert.deepEqual(redactPublication(JSON.stringify(input)), {
        value: JSON.stringify(input),
        redactions: 0,
      });
    }
    process.env = { CODEX_UNKNOWN_CAPABILITY: "rootCauseClusterToken123456" };
    const json = '{"rootCauseClusterToken123456":"rootCauseClusterToken123456"}';
    assert.deepEqual(JSON.parse(redactPublication(json).value), {
      "[redacted credential]": "[redacted credential]",
    });
    assert.equal(
      redactPublication(`metadata: ${json}\n`).value,
      'metadata: {"[redacted credential]":"[redacted credential]"}\n',
    );
    const quotedToken = 'synthetic-"quoted"-token-123456';
    process.env.CODEX_UNKNOWN_CAPABILITY = quotedToken;
    assert.equal(
      JSON.parse(redactPublication(JSON.stringify(quotedToken)).value),
      "[redacted credential]",
    );
  } finally {
    process.env = original;
  }
});

test("file-backed Codex auth tokens stay registered after the auth store is removed", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { codexEnv } = await import("../dist/codex-env.js");
  const original = process.env;
  const home = mkdtempSync(join(tmpdir(), "dlp-auth-"));
  const token = "synthetic-file-auth-capability-123456";
  try {
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({ tokens: { access_token: token, refresh_token: "root" } }),
    );
    process.env = { CODEX_HOME: home };
    codexEnv({ preserveCodexAuth: true });
    rmSync(home, { recursive: true, force: true });
    process.env = {};
    const markdown = report(`Evidence ${token}`);
    assert.ok(!markdown.includes(token));
    assert.match(markdown, /^review_status: failed$/m);
  } finally {
    process.env = original;
    rmSync(home, { recursive: true, force: true });
  }
});

test("render-time body redaction invalidates the persisted close decision", async () => {
  const { publicationSafeReport } = await import("../dist/review-record.js");
  const { validateReportClose } = await import("../dist/clawsweeper-apply-close-decision.js");
  const { validateCloseDecision } = await import("../dist/clawsweeper-close-decision.js");
  const original = process.env;
  const token = "synthetic-late-body-capability-123456";
  try {
    process.env = {};
    const stored = report("Already implemented.") + `\n## Extra evidence\n${token}\n`;
    assert.equal(readReviewRecord(stored)?.decision.decision, "close");
    process.env = { GH_TOKEN: token };
    const safe = publicationSafeReport(stored);
    const comment = renderReviewCommentFromReport(safe, "implemented_on_main");
    assert.ok(!safe.includes(token));
    assert.ok(!comment.includes(token));
    assert.match(safe, /^review_status: failed$/m);
    process.env = {};
    assert.equal(readReviewRecord(safe)?.decision.decision, "keep_open");
    assert.equal(
      validateReportClose({ validateCloseDecision }, item(), safe, "implemented_on_main", {
        requireCloseComment: false,
      }).ok,
      false,
    );
  } finally {
    process.env = original;
  }
});

test("render-only compromised reports cannot synchronize PR labels after reload", async () => {
  const { prepareReviewCommentFromReport } =
    await import("../dist/clawsweeper-report-comment-presentation.js");
  const { syncApplyPullRequestLabels } =
    await import("../dist/clawsweeper-apply-pull-request-labels.js");
  const original = process.env;
  const prefix = "synthetic-label-render-capability-123456";
  const token = `${prefix}.`;
  try {
    process.env = {};
    const stored = report(prefix).replaceAll(token, prefix);
    process.env = { GH_TOKEN: token };
    const safe = prepareReviewCommentFromReport(stored, "implemented_on_main").markdown;
    process.env = {};
    const result = syncApplyPullRequestLabels(
      new Proxy(
        {},
        {
          get() {
            return () => assert.fail("No label operation is allowed");
          },
        },
      ) as Parameters<typeof syncApplyPullRequestLabels>[0],
      {
        markdown: safe,
        item: item({ kind: "pull_request" }),
        number: 123,
        dryRun: false,
        staleReviewHead: null,
        labelSyncFreshEnough: () => true,
        currentItemContext: () => ({ issue: {}, comments: [], timeline: [] }),
        onMutation: () => assert.fail("No mutation is allowed"),
      },
    );
    assert.equal(result.changed, false);
  } finally {
    process.env = original;
  }
});

test("registered capabilities in JSON keys are counted and collisions preserve every value", async () => {
  const { redactPublication, registerPublicationCapability } =
    await import("../dist/publication-dlp.js");
  const first = "synthetic-object-key-capability-123456";
  const second = "synthetic-object-key-capability-654321";
  registerPublicationCapability(first);
  registerPublicationCapability(second);
  const input = {
    [first]: "first",
    [second]: "second",
    "[redacted credential]": "existing",
    "[redacted credential]-2": "also existing",
  };
  const safe = redactPublication(JSON.stringify(input) + "\n");
  assert.equal(safe.redactions, 2);
  assert.deepEqual(JSON.parse(safe.value), {
    "[redacted credential]-3": "first",
    "[redacted credential]-4": "second",
    "[redacted credential]": "existing",
    "[redacted credential]-2": "also existing",
  });
  assert.equal(redactPublication(input).redactions, 2);
});

test("composite provider references and authorization payloads register bare capabilities", async () => {
  const { registerOpenclawProviderCapabilities, redactPublication } =
    await import("../dist/publication-dlp.js");
  const opaque = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
  const other = "P6o5N4m3L2k1J0i9H8g7F6e5D4c3B2a1";
  const literal = "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6";
  registerOpenclawProviderCapabilities(
    JSON.stringify({
      custom: {
        apiKey: "prefix-${OPAQUE_AUTH}-${OTHER_AUTH}",
        headers: { Authorization: "Bearer ${OPAQUE_AUTH}", "X-Custom-Auth": `Basic ${literal}` },
      },
    }),
    { OPAQUE_AUTH: opaque, OTHER_AUTH: other },
  );
  assert.deepEqual(redactPublication([opaque, other, literal]), {
    value: Array(3).fill("[redacted credential]"),
    redactions: 3,
  });
});

test("env references anywhere in a provider block register, plain literals do not", async () => {
  const { registerOpenclawProviderCapabilities, redactPublication } =
    await import("../dist/publication-dlp.js");
  const signature = "S9i8G7n6E5d4U3r2L1s0Z9x8C7v6B5n4";
  const baseUrl = "https://llm.example.invalid/v1/chat-completions";
  const model = "provider-model-name-2026-10-preview";
  registerOpenclawProviderCapabilities(
    JSON.stringify({
      signed: {
        baseUrl: baseUrl + "?sig=${PROVIDER_AUTH}",
        models: [{ id: model, options: { region: "${PROVIDER_REGION_TOKEN}" } }],
      },
    }),
    { PROVIDER_AUTH: signature, PROVIDER_REGION_TOKEN: "short" },
  );
  assert.deepEqual(redactPublication([signature, baseUrl, model]), {
    value: ["[redacted credential]", baseUrl, model],
    redactions: 1,
  });
});

test("comment preparation returns a persistable failed report for render-only credentials", async () => {
  const { prepareReviewCommentFromReport } =
    await import("../dist/clawsweeper-report-comment-presentation.js");
  const { publicationSafeReport } = await import("../dist/review-record.js");
  const original = process.env;
  const prefix = "synthetic-render-only-capability-123456";
  const token = `${prefix}.`;
  try {
    process.env = {};
    const stored = report(prefix).replaceAll(token, prefix);
    process.env = { GH_TOKEN: token };
    assert.equal(publicationSafeReport(stored), stored);
    assert.equal(isApplyCloseCandidateReport(stored), true);
    const prepared = prepareReviewCommentFromReport(stored, "implemented_on_main");
    assert.ok(!prepared.comment.includes(token));
    assert.match(prepared.markdown, /^review_status: failed$/m);
    assert.equal(readReviewRecord(prepared.markdown)?.decision.decision, "keep_open");
    assert.equal(isApplyCloseCandidateReport(prepared.markdown), false);
    process.env = {};
    const { validateReportClose } = await import("../dist/clawsweeper-apply-close-decision.js");
    const { validateCloseDecision } = await import("../dist/clawsweeper-close-decision.js");
    assert.equal(
      validateReportClose(
        { validateCloseDecision },
        item(),
        prepared.markdown,
        "implemented_on_main",
        { requireCloseComment: false },
      ).ok,
      false,
    );
  } finally {
    process.env = original;
  }
});

test("literal provider URL authentication registers encoded and decoded components", async () => {
  const { registerOpenclawProviderCapabilities, redactPublication } =
    await import("../dist/publication-dlp.js");
  const user = "Synthetic-URL-user-123456";
  const password = "Synthetic:URL:password:123456";
  const keys = [
    "sig",
    "signature",
    "token",
    "key",
    "api_key",
    "access_token",
    "X-Amz-Signature",
    "code",
    "auth",
    "apikey",
    "client_secret",
    "x-amz-security-token",
  ];
  const values = keys.map((_, index) => `Synthetic:URL:query:${index}:123456`);
  const url = new URL("https://provider.example.invalid/v1");
  url.username = user;
  url.password = password;
  keys.forEach((key, index) => url.searchParams.set(key, values[index]!));
  registerOpenclawProviderCapabilities(
    JSON.stringify({ custom: { models: [{ options: { endpoint: url.href } }] } }),
  );
  const capabilities = [
    user,
    password,
    encodeURIComponent(password),
    ...values,
    ...values.map(encodeURIComponent),
  ];
  const formValue = "Synthetic URL form value 123456";
  const rawValue = "Synthetic%20URL+form+value+123456";
  registerOpenclawProviderCapabilities(
    JSON.stringify({ custom: { baseUrl: `https://provider.example.invalid?token=${rawValue}` } }),
  );
  capabilities.push(formValue, rawValue);
  const result = redactPublication(capabilities);
  assert.deepEqual(
    result.value,
    capabilities.map(() => "[redacted credential]"),
  );
  assert.equal(result.redactions, capabilities.length);
  const benign = [
    "ordinarywordwithmanyletters",
    "1234567890123456789012345",
    "/ordinary/path/with/many/segments",
  ];
  const benignUrl = new URL("https://ordinary.example.invalid");
  benign.forEach((value, index) => benignUrl.searchParams.set(`param${index}`, value));
  registerOpenclawProviderCapabilities(JSON.stringify({ custom: { baseUrl: benignUrl.href } }));
  assert.equal(redactPublication(benign).redactions, 0);
  assert.equal(
    redactPublication("https://public.example.invalid/v1?model=ordinary-model-1234567890")
      .redactions,
    0,
  );
});

test("local history bootstrap persists a render-only failed record", async () => {
  const { localExactBootstrapReviewCommentBody } =
    await import("../dist/clawsweeper-review-command-workflow.js");
  const { prepareReviewCommentFromReport } =
    await import("../dist/clawsweeper-report-comment-presentation.js");
  const original = process.env;
  const prefix = "synthetic-bootstrap-render-capability-123456";
  try {
    process.env = {};
    const stored = report(prefix).replaceAll(`${prefix}.`, prefix);
    let persisted = stored;
    process.env = { GH_TOKEN: `${prefix}.` };
    const comment = localExactBootstrapReviewCommentBody(
      stored,
      item(),
      prepareReviewCommentFromReport,
      (markdown) => {
        persisted = markdown;
      },
    );
    assert.ok(!comment.includes(`${prefix}.`));
    assert.match(persisted, /^review_status: failed$/m);
    assert.equal(readReviewRecord(persisted).decision.decision, "keep_open");
    assert.equal(isApplyCloseCandidateReport(persisted), false);
  } finally {
    process.env = original;
  }
});

test("production report writer persists render-only compromise before history and apply", async () => {
  const { writePreparedReviewReport } = await import("../dist/clawsweeper-review-item.js");
  const { prepareReviewCommentFromReport } =
    await import("../dist/clawsweeper-report-comment-presentation.js");
  const { reviewActionForDecision } = await import("../dist/clawsweeper-review-action.js");
  const { validateReportClose } = await import("../dist/clawsweeper-apply-close-decision.js");
  const { validateCloseDecision } = await import("../dist/clawsweeper-close-decision.js");
  const { syncApplyPullRequestLabels } =
    await import("../dist/clawsweeper-apply-pull-request-labels.js");
  const original = process.env;
  const prefix = "synthetic-writer-render-capability-123456";
  const token = `${prefix}.`;
  try {
    process.env = { GH_TOKEN: token };
    for (const history of [null, "history.md"]) {
      let persisted = "";
      const result = writePreparedReviewReport(
        {
          item: item({ kind: "pull_request" }),
          context: { issue: {}, comments: [], timeline: [] },
          decision: { ...closeDecision({ summary: prefix }), localCheckoutAccess: "verified" },
          git: { mainSha: "a".repeat(40), latestRelease: null, releaseStateComplete: true },
          runtime: { model: "Codex", reasoningEffort: "high" },
          artifactDir: ".",
          snapshotHash: "synthetic",
          contentDigest: "synthetic",
          reviewPolicy: "synthetic",
          structuralRecord: null,
          itemLocalReviewHistoryPath: history,
          previousLocalReviewCommentBody: "",
          localRange: false,
          metadataBytes: 1024 * 1024,
          writeOutputReport: (_item, _path, markdown) => {
            persisted = markdown;
          },
          writeOutputMetadata: () => {},
        },
        {
          markdownFor,
          reviewActionForDecision,
          reportFileName: () => "123.md",
          prepareReviewCommentFromReport,
        },
      );
      assert.equal(result.reportMarkdown, persisted);
      assert.match(persisted, /^review_status: failed$/m);
      assert.equal(readReviewRecord(persisted).decision.decision, "keep_open");
      assert.equal(
        validateReportClose({ validateCloseDecision }, item(), persisted, "implemented_on_main", {
          requireCloseComment: false,
        }).ok,
        false,
      );
      assert.equal(
        syncApplyPullRequestLabels(
          new Proxy(
            {},
            {
              get() {
                return () => assert.fail("Compromised report must not access labels");
              },
            },
          ),
          {
            markdown: persisted,
            item: item({ kind: "pull_request" }),
            number: 123,
            dryRun: false,
            staleReviewHead: null,
            labelSyncFreshEnough: () => true,
            currentItemContext: () => ({ issue: {}, comments: [], timeline: [] }),
            onMutation: () => assert.fail("No mutation allowed"),
          },
        ).changed,
        false,
      );
    }
  } finally {
    process.env = original;
  }
});

test("known provider credentials register even when all lowercase", async () => {
  const { registerOpenclawProviderCapabilities, redactPublication } =
    await import("../dist/publication-dlp.js");
  const apiKey = "lowercaseopaqueproviderkey";
  const header = "anotherlowercasesecretvalue";
  registerOpenclawProviderCapabilities(
    JSON.stringify({ lower: { apiKey, headers: { Authorization: `Bearer ${header}` } } }),
    {},
  );
  assert.deepEqual(redactPublication([apiKey, header, "ordinarylowercasewordsnotsecret"]), {
    value: ["[redacted credential]", "[redacted credential]", "ordinarylowercasewordsnotsecret"],
    redactions: 2,
  });
});

test("credential-named env values and URL userinfo use the known-credential gate", async () => {
  const { registerOpenclawProviderCapabilities, redactPublication } =
    await import("../dist/publication-dlp.js");
  const original = process.env;
  const apiKey = "lowercaseforwardedopenaikey";
  const user = "basicusershort";
  const password = "lowercasepass16ch";
  try {
    process.env = { ...original, OPENAI_API_KEY: apiKey };
    registerOpenclawProviderCapabilities(
      JSON.stringify({ basic: { baseUrl: `https://${user}:${password}@llm.example.invalid/v1` } }),
      {},
    );
    const result = redactPublication([apiKey, password, "ordinarylowercaseprose"]);
    assert.deepEqual(result.value, [
      "[redacted credential]",
      "[redacted credential]",
      "ordinarylowercaseprose",
    ]);
  } finally {
    process.env = original;
  }
});

test("credential-named provider URL parameters register lowercase values", async () => {
  const { registerOpenclawProviderCapabilities, redactPublication } =
    await import("../dist/publication-dlp.js");
  const token = "lowercasequerytokenvalue";
  const benign = "lowercasequeryregionvalue";
  registerOpenclawProviderCapabilities(
    JSON.stringify({
      q: { baseUrl: `https://llm.example.invalid/v1?api_key=${token}&region=${benign}` },
    }),
    {},
  );
  assert.deepEqual(redactPublication([token, benign]).value, ["[redacted credential]", benign]);
});
