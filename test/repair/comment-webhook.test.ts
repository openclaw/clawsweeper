import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";

import {
  adaptiveCodexTimeoutMsForTest,
  classifyItemWebhook,
  classifyIssueCommentWebhook,
  classifyWebhook,
  handleGitHubWebhook,
  renderFastAckComment,
  verifyGitHubSignature,
} from "../../dist/repair/comment-webhook.js";
import { REPOSITORY_PROFILES } from "../../dist/repository-profiles.js";

test("comment webhook accepts maintainer ClawSweeper commands", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw", default_branch: "trunk" },
      issue: { number: 71898 },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "@clawsweeper automerge",
        author_association: "MEMBER",
      },
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    type: "issue_comment",
    targetRepo: "openclaw/openclaw",
    targetBranch: "trunk",
    itemNumber: 71898,
    itemKind: "issue",
    itemState: "",
    commentId: 456,
    installationId: 123,
    sourceAction: "created",
    commentBody: "@clawsweeper automerge",
    commentAuthor: "",
    commentUrl: "",
    maintainerAuthorized: true,
  });
});

test("comment webhook ignores ClawSweeper proof-nudge comments", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw", default_branch: "main" },
      issue: { number: 86422 },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: [
          "@contributor thanks for the PR. ClawSweeper is still waiting on real behavior proof.",
          "",
          "Once proof is added, @clawsweeper re-review can check it.",
          "",
          '<!-- clawsweeper-proof-nudge item="86422" sha="abc123" at="2026-06-02T00:00:00.000Z" v="1" -->',
        ].join("\n"),
        author_association: "MEMBER",
        user: { login: "clawsweeper[bot]" },
      },
    },
  });

  assert.deepEqual(result, { accepted: false, reason: "proof nudge comment" });
});

test("comment webhook ignores command-bearing assist and visual publications before ack or dispatch", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error("generated publications must not reach GitHub");
  };

  try {
    for (const body of [
      "@clawsweeper automerge\n<!-- clawsweeper-assist:stable-request -->",
      "/autoclose\n<!-- clawsweeper-visual -->",
    ]) {
      const result = await handleGitHubWebhook({
        event: "issue_comment",
        payload: {
          action: "created",
          repository: { full_name: "openclaw/openclaw", default_branch: "main" },
          issue: { number: 86422 },
          installation: { id: 123 },
          comment: {
            id: 456,
            body,
            author_association: "MEMBER",
            user: { login: "clawsweeper[bot]" },
          },
        },
      });

      assert.deepEqual(result, {
        statusCode: 202,
        body: { accepted: false, reason: "assist publication comment" },
      });
    }
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("standalone webhook terminal admission blocks delayed private and missing targets", async () => {
  const restoreCredentials = installWebhookAppCredentials();
  const previousFetch = globalThis.fetch;
  let sideEffects = 0;

  try {
    globalThis.fetch = async () => {
      sideEffects += 1;
      throw new Error("ineligible targets must stop before GitHub access");
    };
    for (const payload of [
      commandWebhookPayload("@clawsweeper re-review", "not-a-repo"),
      {
        ...commandWebhookPayload("@clawsweeper re-review"),
        repository: {
          ...commandWebhookPayload("@clawsweeper re-review").repository,
          private: true,
        },
      },
    ]) {
      assert.deepEqual(
        await handleGitHubWebhook({
          event: "issue_comment",
          payload,
        }),
        {
          statusCode: 202,
          body: { accepted: false, reason: "repository not eligible" },
        },
      );
    }

    for (const liveResponse of [
      () =>
        jsonResponse({
          full_name: "openclaw/openclaw",
          private: true,
          visibility: "private",
        }),
      () => jsonResponse({}, { status: 404 }),
    ]) {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = String(init?.method ?? "GET").toUpperCase();
        if (url.pathname === "/repos/openclaw/clawsweeper/installation" && method === "GET") {
          return jsonResponse({ id: 999 });
        }
        if (url.pathname === "/app/installations/999/access_tokens" && method === "POST") {
          assert.deepEqual(JSON.parse(String(init?.body ?? "{}")), {
            repositories: ["clawsweeper"],
            permissions: { metadata: "read" },
          });
          return jsonResponse({ token: "metadata-token" });
        }
        if (url.pathname === "/repos/openclaw/openclaw" && method === "GET") {
          assert.equal(new Headers(init?.headers).get("authorization"), "Bearer metadata-token");
          return liveResponse();
        }
        sideEffects += 1;
        throw new Error(`unexpected side effect ${method} ${url.pathname}`);
      }) as typeof fetch;

      for (const commandBody of ["@clawsweeper re-review", "@clawsweeper automerge"]) {
        const result = await handleGitHubWebhook({
          event: "issue_comment",
          payload: commandWebhookPayload(commandBody),
        });
        assert.deepEqual(result, {
          statusCode: 202,
          body: { ok: false, accepted: false, reason: "private_target_unsupported" },
        });
      }
    }
    assert.equal(sideEffects, 0);
  } finally {
    globalThis.fetch = previousFetch;
    restoreCredentials();
  }
});

test("standalone webhook retryable admission defers without intake or target effects", async () => {
  const restoreCredentials = installWebhookAppCredentials();
  const previousFetch = globalThis.fetch;
  let sideEffects = 0;

  try {
    for (const liveResult of [
      jsonResponse({}, { status: 403 }),
      jsonResponse({}, { status: 429, headers: { "retry-after": "60" } }),
      jsonResponse({}, { status: 503 }),
      new Error("network unavailable"),
    ]) {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = String(init?.method ?? "GET").toUpperCase();
        if (url.pathname === "/repos/openclaw/clawsweeper/installation" && method === "GET") {
          return jsonResponse({ id: 999 });
        }
        if (url.pathname === "/app/installations/999/access_tokens" && method === "POST") {
          assert.deepEqual(JSON.parse(String(init?.body ?? "{}")), {
            repositories: ["clawsweeper"],
            permissions: { metadata: "read" },
          });
          return jsonResponse({ token: "metadata-token" });
        }
        if (url.pathname === "/repos/openclaw/openclaw" && method === "GET") {
          if (liveResult instanceof Error) throw liveResult;
          return liveResult;
        }
        sideEffects += 1;
        throw new Error(`unexpected side effect ${method} ${url.pathname}`);
      }) as typeof fetch;

      for (const commandBody of ["@clawsweeper re-review", "@clawsweeper automerge"]) {
        const result = await handleGitHubWebhook({
          event: "issue_comment",
          payload: commandWebhookPayload(commandBody),
        });
        assert.deepEqual(result, {
          statusCode: 503,
          body: { ok: false, error: "target_visibility_unverified", retryable: true },
        });
      }
    }
    assert.equal(sideEffects, 0);
  } finally {
    globalThis.fetch = previousFetch;
    restoreCredentials();
  }
});

test("standalone webhook admits public targets before durable command intake", async () => {
  const restoreCredentials = installWebhookAppCredentials();
  const previousFetch = globalThis.fetch;
  const previousQueueUrl = process.env.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL;
  const previousWebhookSecret = process.env.CLAWSWEEPER_WEBHOOK_SECRET;
  let intakeRequests = 0;
  process.env.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL = "https://queue.example.invalid";
  process.env.CLAWSWEEPER_WEBHOOK_SECRET = "command-intake-secret";

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/repos/openclaw/clawsweeper/installation" && method === "GET") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens" && method === "POST") {
      assert.deepEqual(JSON.parse(String(init?.body ?? "{}")), {
        repositories: ["clawsweeper"],
        permissions: { metadata: "read" },
      });
      return jsonResponse({ token: "metadata-token" });
    }
    if (url.pathname === "/repos/openclaw/openclaw" && method === "GET") {
      return jsonResponse({
        full_name: "openclaw/openclaw",
        private: false,
        visibility: "public",
      });
    }
    if (url.origin === "https://queue.example.invalid" && method === "POST") {
      intakeRequests += 1;
      return jsonResponse({
        ok: true,
        accepted: true,
        deduped: false,
        command_version_id: "openclaw/openclaw#71898:456:v1",
      });
    }
    throw new Error(`unexpected fetch ${method} ${url.pathname}`);
  }) as typeof fetch;

  try {
    const result = await handleGitHubWebhook({
      event: "issue_comment",
      payload: commandWebhookPayload("@clawsweeper re-review"),
    });
    assert.deepEqual(result, {
      statusCode: 202,
      body: {
        ok: true,
        kind: "accepted",
        deduped: false,
        commandVersionId: "openclaw/openclaw#71898:456:v1",
      },
    });
    assert.equal(intakeRequests, 1);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL", previousQueueUrl);
    restoreEnv("CLAWSWEEPER_WEBHOOK_SECRET", previousWebhookSecret);
    restoreCredentials();
  }
});

test("comment webhook rejects inline ClawSweeper mentions before visible ack", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw", default_branch: "main" },
      issue: { number: 87801 },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "the closed PR 87835 was closed as already implemented by PR 87890 @clawsweeper re-review and if necessary close this issue",
        author_association: "MEMBER",
      },
    },
  });

  assert.deepEqual(result, { accepted: false, reason: "no routable ClawSweeper command" });
});

test("comment webhook accepts ClawSweeper mention commands on their own line", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw", default_branch: "main" },
      issue: { number: 87801 },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "The issue may already be fixed.\n@clawsweeper re-review based on the latest comments\nThanks.",
        author_association: "MEMBER",
      },
    },
  });

  assert.equal(result.accepted, true);
});

test("comment webhook rejects contributor commands before visible ack", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw" },
      issue: { number: 71898 },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "@clawsweeper automerge",
        author_association: "CONTRIBUTOR",
      },
    },
  });

  assert.equal(result.accepted, false);
  assert.match(result.reason, /not allowed/);
});

test("comment webhook accepts author read-only re-review commands", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw" },
      issue: { number: 76991, user: { login: "nickmopen" } },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "@clawsweeper Re-run",
        author_association: "CONTRIBUTOR",
        user: { login: "NickMOpen" },
      },
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    type: "issue_comment",
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: 76991,
    itemKind: "issue",
    itemState: "",
    commentId: 456,
    installationId: 123,
    sourceAction: "created",
    commentBody: "@clawsweeper Re-run",
    commentAuthor: "NickMOpen",
    commentUrl: "",
    maintainerAuthorized: false,
  });
});

test("comment webhook rejects stale re-review commands on closed PRs before fast ack", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "edited",
      repository: { full_name: "openclaw/openclaw" },
      issue: {
        number: 76991,
        state: "closed",
        closed_at: "2026-05-19T05:02:03Z",
        pull_request: {},
      },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "@clawsweeper re-review",
        created_at: "2026-05-18T19:30:48Z",
        updated_at: "2026-05-23T18:14:04Z",
        author_association: "MEMBER",
        user: { login: "user" },
      },
    },
  });

  assert.deepEqual(result, {
    accepted: false,
    reason: "PR closed after this re_review command",
  });
});

test("comment webhook still accepts post-close re-review commands for router response", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw" },
      issue: {
        number: 76991,
        state: "closed",
        closed_at: "2026-05-19T05:02:03Z",
        pull_request: {},
      },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "@clawsweeper re-review",
        created_at: "2026-05-19T05:03:00Z",
        updated_at: "2026-05-19T05:03:00Z",
        author_association: "MEMBER",
        user: { login: "user" },
      },
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    type: "issue_comment",
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: 76991,
    itemKind: "pull_request",
    itemState: "closed",
    commentId: 456,
    installationId: 123,
    sourceAction: "created",
    commentBody: "@clawsweeper re-review",
    commentAuthor: "user",
    commentUrl: "",
    maintainerAuthorized: true,
    commentUpdatedAt: "2026-05-19T05:03:00Z",
    commentBodySha256: crypto.createHash("sha256").update("@clawsweeper re-review").digest("hex"),
  });
});

test("comment webhook rejects malformed and unconfigured repository commands before probing", () => {
  for (const targetRepo of ["not-a-repo", "other-owner/public-repo"]) {
    const result = classifyIssueCommentWebhook({
      event: "issue_comment",
      payload: {
        action: "created",
        repository: {
          full_name: targetRepo,
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 1 },
        installation: { id: 123 },
        comment: { id: 456, body: "/clawsweeper status", author_association: "MEMBER" },
      },
    });

    assert.deepEqual(result, { accepted: false, reason: "repository not eligible" }, targetRepo);
  }
});

test("comment webhook accepts an explicitly configured external-owner repository", () => {
  const profile = {
    ...REPOSITORY_PROFILES[0]!,
    targetRepo: "partner/configured-repo",
    slug: "partner-configured-repo",
    displayName: "Configured partner",
    checkoutDir: "configured-repo",
    promptNote: "Use the configured partner repository policy.",
  };
  REPOSITORY_PROFILES.push(profile);
  try {
    const result = classifyIssueCommentWebhook({
      event: "issue_comment",
      payload: {
        action: "created",
        repository: {
          full_name: "partner/configured-repo",
          default_branch: "main",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 7, state: "open" },
        installation: { id: 123 },
        comment: {
          id: 456,
          body: "@clawsweeper re-review",
          author_association: "MEMBER",
        },
      },
    });

    assert.equal(result.accepted, true);
    assert.equal("targetRepo" in result ? result.targetRepo : "", "partner/configured-repo");
  } finally {
    REPOSITORY_PROFILES.splice(REPOSITORY_PROFILES.indexOf(profile), 1);
  }
});

test("comment webhook rejects non-author read-only re-review commands", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: "openclaw/openclaw" },
      issue: { number: 76991, user: { login: "nickmopen" } },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "@clawsweeper re-run",
        author_association: "CONTRIBUTOR",
        user: { login: "somebody-else" },
      },
    },
  });

  assert.equal(result.accepted, false);
  assert.match(result.reason, /not allowed/);
});

test("webhook accepts eligible issue events for public OpenClaw repositories", () => {
  const result = classifyItemWebhook({
    event: "issues",
    payload: {
      action: "opened",
      repository: {
        full_name: "openclaw/fs-safe",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 597 },
      installation: { id: 123 },
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    type: "item",
    targetRepo: "openclaw/fs-safe",
    targetBranch: "main",
    itemNumber: 597,
    itemKind: "issue",
    installationId: 123,
    sourceEvent: "issues",
    sourceAction: "opened",
    supersedesInProgress: false,
  });
});

test("webhook accepts eligible pull request events for configured steipete repositories", () => {
  const result = classifyWebhook({
    event: "pull_request",
    payload: {
      action: "synchronize",
      repository: {
        full_name: "steipete/camsnap",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      pull_request: { number: 42, head: { sha: "a".repeat(40) } },
      installation: { id: 456 },
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    type: "item",
    targetRepo: "steipete/camsnap",
    targetBranch: "main",
    itemNumber: 42,
    itemKind: "pull_request",
    installationId: 456,
    sourceEvent: "pull_request",
    sourceAction: "synchronize",
    sourceHeadSha: "a".repeat(40),
    supersedesInProgress: true,
    codexTimeoutMs: 600_000,
    mediaProofTimeoutMs: 0,
  });
});

test("webhook carries the semantic tuple through edited pull request fallback intake", () => {
  const title = "Clarify the review request";
  const body = "The revised context is ready for review.";
  const result = classifyWebhook({
    event: "pull_request",
    payload: {
      action: "edited",
      repository: {
        full_name: "openclaw/openclaw",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      pull_request: {
        number: 857,
        head: { sha: "a".repeat(40) },
        base: { sha: "b".repeat(40) },
        draft: false,
        title,
        body,
        updated_at: "2026-07-26T09:00:00Z",
      },
      installation: { id: 456 },
    },
  });

  assert.equal(result.accepted, true);
  if (!result.accepted || result.type !== "item") return;
  assert.equal(result.sourceBaseSha, "b".repeat(40));
  assert.equal(result.sourceIsDraft, false);
  assert.equal(result.sourceUpdatedAt, "2026-07-26T09:00:00Z");
  assert.equal(
    result.sourceContentRevision,
    crypto
      .createHash("sha256")
      .update(JSON.stringify({ version: 1, title, body }))
      .digest("hex"),
  );
});

test("adaptive Codex timeout preserves the default for small non-media PRs", () => {
  assert.equal(
    adaptiveCodexTimeoutMsForTest({
      changed_files: 4,
      additions: 120,
      deletions: 30,
      body: "Small cleanup without proof assets.",
    }),
    600_000,
  );
});

test("adaptive Codex timeout scales for large PRs", () => {
  assert.equal(
    adaptiveCodexTimeoutMsForTest({
      changed_files: 71,
      additions: 4176,
      deletions: 0,
      body: [
        "Proof:",
        "https://uploads.example.invalid/proof-a.mov",
        "https://uploads.example.invalid/proof-b.mp4.",
      ].join("\n"),
    }),
    1_268_800,
  );
});

test("adaptive Codex timeout stays capped separately from media preprocessing", () => {
  assert.equal(
    adaptiveCodexTimeoutMsForTest({
      changed_files: 1000,
      additions: 50_000,
      deletions: 10_000,
      body: [
        "https://uploads.example.invalid/one.mov",
        "https://uploads.example.invalid/two.mp4",
        "https://uploads.example.invalid/three.webm",
        "https://uploads.example.invalid/four.mkv",
        "https://uploads.example.invalid/five.avi",
      ].join("\n"),
    }),
    1_500_000,
  );
});

test("pull request webhooks dispatch adaptive Codex timeout payload", async () => {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.CLAWSWEEPER_APP_ID;
  const previousClientId = process.env.CLAWSWEEPER_APP_CLIENT_ID;
  const previousPrivateKey = process.env.CLAWSWEEPER_APP_PRIVATE_KEY;
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  let dispatchedBody: Record<string, unknown> | undefined;
  process.env.CLAWSWEEPER_APP_ID = "12345";
  delete process.env.CLAWSWEEPER_APP_CLIENT_ID;
  process.env.CLAWSWEEPER_APP_PRIVATE_KEY = privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    const path = `${url.pathname}${url.search}`;
    if (path === "/repos/openclaw/clawsweeper/installation" && method === "GET") {
      return jsonResponse({ id: 999 });
    }
    if (path === "/app/installations/999/access_tokens" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({
        token: body.permissions?.metadata === "read" ? "metadata-token" : "dispatch-token",
      });
    }
    if (path === "/repos/openclaw/openclaw" && method === "GET") {
      return jsonResponse({
        full_name: "openclaw/openclaw",
        private: false,
        visibility: "public",
      });
    }
    if (path === "/repos/openclaw/clawsweeper/dispatches" && method === "POST") {
      dispatchedBody = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({});
    }
    throw new Error(`unexpected fetch ${method} ${path}`);
  }) as typeof fetch;

  try {
    const result = await handleGitHubWebhook({
      event: "pull_request",
      payload: {
        action: "edited",
        repository: {
          full_name: "openclaw/openclaw",
          default_branch: "main",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        pull_request: {
          number: 91093,
          head: { sha: "b".repeat(40) },
          base: { sha: "c".repeat(40) },
          draft: false,
          title: "Add direct fallback semantic ingress coverage",
          changed_files: 71,
          additions: 4176,
          deletions: 0,
          body: [
            "Proof:",
            "https://uploads.example.invalid/proof-a.mov",
            "https://uploads.example.invalid/proof-b.mp4",
          ].join("\n"),
          updated_at: "2026-07-26T09:00:00Z",
        },
        installation: { id: 123 },
      },
    });

    assert.deepEqual(result, {
      statusCode: 202,
      body: { ok: true, dispatched: "clawsweeper_item" },
    });
    assert.equal(dispatchedBody?.event_type, "clawsweeper_item");
    const clientPayload = dispatchedBody?.client_payload as Record<string, unknown>;
    const queueClaim = clientPayload.queue_claim as Record<string, unknown>;
    assert.ok(Object.keys(clientPayload).length <= 10, JSON.stringify(clientPayload));
    assert.equal(queueClaim.codex_timeout_ms, 1_268_800);
    assert.equal(queueClaim.media_proof_timeout_ms, 240_000);
    assert.equal(clientPayload.source_head_sha, undefined);
    assert.equal(queueClaim.source_head_sha, "b".repeat(40));
    assert.equal(queueClaim.source_base_sha, "c".repeat(40));
    assert.equal(queueClaim.source_is_draft, false);
    assert.equal(
      queueClaim.source_content_revision,
      crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            version: 1,
            title: "Add direct fallback semantic ingress coverage",
            body: [
              "Proof:",
              "https://uploads.example.invalid/proof-a.mov",
              "https://uploads.example.invalid/proof-b.mp4",
            ].join("\n"),
          }),
        )
        .digest("hex"),
    );
    assert.equal(queueClaim.source_updated_at, "2026-07-26T09:00:00Z");
    assert.equal(queueClaim.installation_id, 123);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("CLAWSWEEPER_APP_ID", previousAppId);
    restoreEnv("CLAWSWEEPER_APP_CLIENT_ID", previousClientId);
    restoreEnv("CLAWSWEEPER_APP_PRIVATE_KEY", previousPrivateKey);
  }
});

test("webhook preserves valid repository default branch for item dispatch", () => {
  const result = classifyItemWebhook({
    event: "issues",
    payload: {
      action: "opened",
      repository: {
        full_name: "openclaw/fs-safe",
        default_branch: "trunk",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 597 },
      installation: { id: 123 },
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.targetBranch, "trunk");
});

test("webhook falls back to main for invalid repository default branch", () => {
  const result = classifyItemWebhook({
    event: "issues",
    payload: {
      action: "opened",
      repository: {
        full_name: "openclaw/fs-safe",
        default_branch: "bad branch",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 597 },
      installation: { id: 123 },
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.targetBranch, "main");
});

test("webhook rejects private target repositories and accepts generic public repositories", () => {
  const privateResult = classifyItemWebhook({
    event: "issues",
    payload: {
      action: "opened",
      repository: {
        full_name: "steipete/private-tool",
        private: true,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 1 },
      installation: { id: 456 },
    },
  });
  assert.deepEqual(privateResult, { accepted: false, reason: "repository not eligible" });

  const publicResult = classifyItemWebhook({
    event: "issues",
    payload: {
      action: "opened",
      repository: {
        full_name: "openclaw/example-tool",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 1 },
      installation: { id: 456 },
    },
  });
  assert.equal(publicResult.accepted, true);
});

test("webhook requeues unlocked and close-guard removal events", () => {
  const closeGuardLabels = [
    "security",
    "beta-blocker",
    "release-blocker",
    "maintainer",
    "clawsweeper:human-review",
    "clawsweeper:manual-only",
    "clawsweeper:automerge",
    "clawsweeper:autofix",
  ];
  const cases = [
    { event: "issues", action: "unlocked" },
    { event: "pull_request", action: "unlocked" },
    ...closeGuardLabels.flatMap((name) => [
      { event: "issues", action: "unlabeled", label: { name } },
      { event: "pull_request", action: "unlabeled", label: { name } },
    ]),
  ];
  for (const [index, { event, action, label }] of cases.entries()) {
    const itemNumber = 76990 + index;
    const result = classifyItemWebhook({
      event,
      payload: {
        action,
        repository: {
          full_name: "openclaw/fs-safe",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        ...(event === "issues"
          ? { issue: { number: itemNumber } }
          : { pull_request: { number: itemNumber } }),
        ...(label ? { label } : {}),
        installation: { id: 123 },
      },
    });

    assert.equal(result.accepted, true);
    assert.equal(result.sourceAction, action);
    assert.equal(result.supersedesInProgress, true);
  }
});

test("webhook rejects label additions and unrelated removals from exact-review intake", () => {
  for (const [event, payload] of [
    [
      "pull_request",
      {
        action: "labeled",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        pull_request: { number: 76992 },
        installation: { id: 123 },
        sender: { login: "openclaw-clawsweeper[bot]" },
      },
    ],
    [
      "issues",
      {
        action: "unlabeled",
        repository: {
          full_name: "openclaw/fs-safe",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 597 },
        label: { name: "clawsweeper:queueable-fix" },
        installation: { id: 123 },
        sender: { login: "steipete" },
      },
    ],
  ] as const) {
    assert.deepEqual(classifyItemWebhook({ event, payload }), {
      accepted: false,
      reason: "unsupported action",
    });
  }
});

test("fast ack comment carries source comment marker", () => {
  const body = renderFastAckComment(456);

  assert.match(body, /clawsweeper-command-ack:456/);
  assert.match(body, /ClawSweeper picked this up/);
});

test("concurrent duplicate command webhooks converge on one fast ack comment", async () => {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.CLAWSWEEPER_APP_ID;
  const previousClientId = process.env.CLAWSWEEPER_APP_CLIENT_ID;
  const previousPrivateKey = process.env.CLAWSWEEPER_APP_PRIVATE_KEY;
  const previousSettleDelays = process.env.CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS;
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const comments: Array<{ id: number; body: string; created_at: string; user: { login: string } }> =
    [];
  let nextCommentId = 9001;
  let fastAckPosts = 0;
  let reactions = 0;
  let dispatches = 0;
  const dispatchBodies: Array<Record<string, unknown>> = [];
  process.env.CLAWSWEEPER_APP_ID = "12345";
  delete process.env.CLAWSWEEPER_APP_CLIENT_ID;
  process.env.CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS = "0";
  process.env.CLAWSWEEPER_APP_PRIVATE_KEY = privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    const path = `${url.pathname}${url.search}`;
    if (path === "/repos/openclaw/clawsweeper/installation" && method === "GET") {
      return jsonResponse({ id: 999 });
    }
    if (path === "/app/installations/999/access_tokens" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({
        token: body.permissions?.metadata === "read" ? "metadata-token" : "dispatch-token",
      });
    }
    if (path === "/repos/openclaw/openclaw" && method === "GET") {
      return jsonResponse({
        full_name: "openclaw/openclaw",
        private: false,
        visibility: "public",
      });
    }
    if (path === "/app/installations/123/access_tokens" && method === "POST") {
      return jsonResponse({ token: "target-token" });
    }
    if (path.startsWith("/repos/openclaw/openclaw/issues/71898/comments?") && method === "GET") {
      return jsonResponse([...comments]);
    }
    if (path === "/repos/openclaw/openclaw/issues/71898/comments" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      fastAckPosts += 1;
      const comment = {
        id: nextCommentId++,
        body: String(body.body ?? ""),
        created_at: `2026-05-28T13:00:0${fastAckPosts}Z`,
        user: { login: "clawsweeper[bot]" },
      };
      comments.push(comment);
      return jsonResponse(comment);
    }
    if (path === "/repos/openclaw/openclaw/issues/comments/456/reactions" && method === "POST") {
      reactions += 1;
      return jsonResponse({ id: 1 });
    }
    if (path === "/repos/openclaw/clawsweeper/dispatches" && method === "POST") {
      dispatches += 1;
      dispatchBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({});
    }
    if (path.startsWith("/repos/openclaw/openclaw/issues/comments/") && method === "DELETE") {
      const id = Number(path.split("/").pop());
      const index = comments.findIndex((comment) => comment.id === id);
      if (index >= 0) comments.splice(index, 1);
      return jsonResponse({});
    }
    throw new Error(`unexpected fetch ${method} ${path}`);
  }) as typeof fetch;

  try {
    const payload = {
      action: "created",
      repository: { full_name: "openclaw/openclaw" },
      issue: { number: 71898 },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "@clawsweeper re-review",
        updated_at: "2026-07-12T20:00:00Z",
        author_association: "MEMBER",
        user: { login: "user" },
      },
    };
    const [left, right] = await Promise.all([
      handleGitHubWebhook({ event: "issue_comment", payload }),
      handleGitHubWebhook({ event: "issue_comment", payload }),
    ]);

    assert.deepEqual(left, { statusCode: 202, body: { ok: true, status_comment_id: 9001 } });
    assert.deepEqual(right, { statusCode: 202, body: { ok: true, status_comment_id: 9001 } });
    assert.equal(fastAckPosts, 1);
    assert.equal(reactions, 2);
    assert.equal(dispatches, 2);
    assert.deepEqual(
      dispatchBodies.map((body) => body.client_payload),
      Array.from({ length: 2 }, () => ({
        target_repo: "openclaw/openclaw",
        target_branch: "main",
        item_number: 71898,
        comment_id: 456,
        status_comment_id: 9001,
        source_event: "issue_comment",
        source_action: "created",
        comment_event_auth: "github_webhook_v1",
        comment_updated_at: "2026-07-12T20:00:00Z",
        comment_body_sha256: crypto
          .createHash("sha256")
          .update("@clawsweeper re-review")
          .digest("hex"),
      })),
    );
    assert.ok(
      dispatchBodies.every(
        (body) => Object.keys(body.client_payload as Record<string, unknown>).length <= 10,
      ),
    );
    assert.equal(comments.length, 1);
    assert.match(comments[0]?.body ?? "", /clawsweeper-command-ack:456/);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("CLAWSWEEPER_APP_ID", previousAppId);
    restoreEnv("CLAWSWEEPER_APP_CLIENT_ID", previousClientId);
    restoreEnv("CLAWSWEEPER_APP_PRIVATE_KEY", previousPrivateKey);
    restoreEnv("CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS", previousSettleDelays);
  }
});

test("comment webhook settles duplicate fast ack comments after dispatch", async () => {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.CLAWSWEEPER_APP_ID;
  const previousClientId = process.env.CLAWSWEEPER_APP_CLIENT_ID;
  const previousPrivateKey = process.env.CLAWSWEEPER_APP_PRIVATE_KEY;
  const previousSettleDelays = process.env.CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS;
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  let commentLookups = 0;
  let deletedAck = 0;
  let resolveDeleted: (() => void) | undefined;
  const deleted = new Promise<void>((resolve) => {
    resolveDeleted = resolve;
  });
  process.env.CLAWSWEEPER_APP_ID = "12345";
  delete process.env.CLAWSWEEPER_APP_CLIENT_ID;
  process.env.CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS = "0";
  process.env.CLAWSWEEPER_APP_PRIVATE_KEY = privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    const path = `${url.pathname}${url.search}`;
    if (path === "/repos/openclaw/clawsweeper/installation" && method === "GET") {
      return jsonResponse({ id: 999 });
    }
    if (path === "/app/installations/999/access_tokens" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({
        token: body.permissions?.metadata === "read" ? "metadata-token" : "dispatch-token",
      });
    }
    if (path === "/repos/openclaw/openclaw" && method === "GET") {
      return jsonResponse({
        full_name: "openclaw/openclaw",
        private: false,
        visibility: "public",
      });
    }
    if (path === "/app/installations/123/access_tokens" && method === "POST") {
      return jsonResponse({ token: "target-token" });
    }
    if (path.startsWith("/repos/openclaw/openclaw/issues/71898/comments?") && method === "GET") {
      commentLookups += 1;
      if (commentLookups === 1) {
        return jsonResponse([
          {
            id: 9001,
            body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
            created_at: "2026-05-28T13:00:00Z",
            user: { login: "clawsweeper[bot]" },
          },
        ]);
      }
      return jsonResponse([
        {
          id: 9001,
          body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
          created_at: "2026-05-28T13:00:00Z",
          user: { login: "clawsweeper[bot]" },
        },
        {
          id: 9002,
          body: [
            "<!-- clawsweeper-command-status:71898:re_review:abc123 -->",
            "<!-- clawsweeper-command-ack:456 -->",
            "ClawSweeper re-review requested.",
            "<!-- clawsweeper-command-progress:start -->",
            "Re-review progress:",
            "- State: In progress",
            "<!-- clawsweeper-command-progress:end -->",
          ].join("\n"),
          created_at: "2026-05-28T13:00:01Z",
          updated_at: "2026-05-28T13:00:02Z",
          user: { login: "clawsweeper[bot]" },
        },
      ]);
    }
    if (path === "/repos/openclaw/openclaw/issues/comments/456/reactions" && method === "POST") {
      return jsonResponse({ id: 1 });
    }
    if (path === "/repos/openclaw/clawsweeper/dispatches" && method === "POST") {
      return jsonResponse({});
    }
    if (path === "/repos/openclaw/openclaw/issues/comments/9001" && method === "DELETE") {
      deletedAck = 9001;
      resolveDeleted?.();
      return jsonResponse({});
    }
    throw new Error(`unexpected fetch ${method} ${path}`);
  }) as typeof fetch;

  try {
    const result = await handleGitHubWebhook({
      event: "issue_comment",
      payload: {
        action: "created",
        repository: { full_name: "openclaw/openclaw" },
        issue: { number: 71898 },
        installation: { id: 123 },
        comment: {
          id: 456,
          body: "@clawsweeper re-review",
          author_association: "MEMBER",
          user: { login: "user" },
        },
      },
    });

    assert.deepEqual(result, { statusCode: 202, body: { ok: true, status_comment_id: 9001 } });
    await deleted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(commentLookups, 2);
    assert.equal(deletedAck, 9001);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("CLAWSWEEPER_APP_ID", previousAppId);
    restoreEnv("CLAWSWEEPER_APP_CLIENT_ID", previousClientId);
    restoreEnv("CLAWSWEEPER_APP_PRIVATE_KEY", previousPrivateKey);
    restoreEnv("CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS", previousSettleDelays);
  }
});

test("webhook signature verification uses sha256 body hmac", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ ok: true });
  const signature = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;

  assert.doesNotThrow(() => verifyGitHubSignature({ secret, signature, body }));
  assert.throws(
    () => verifyGitHubSignature({ secret, signature: "sha256=bad", body }),
    /invalid GitHub webhook signature/,
  );
});

test("webhook GitHub requests have a deadline through the response body", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousTimeout = AbortSignal.timeout;
  for (const name of [
    "CLAWSWEEPER_APP_ID",
    "CLAWSWEEPER_APP_CLIENT_ID",
    "CLAWSWEEPER_APP_PRIVATE_KEY",
  ]) {
    const previous = process.env[name];
    t.after(() => restoreEnv(name, previous));
  }
  process.env.CLAWSWEEPER_APP_ID = "12345";
  delete process.env.CLAWSWEEPER_APP_CLIENT_ID;
  process.env.CLAWSWEEPER_APP_PRIVATE_KEY = crypto
    .generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString();

  let mode = "success";
  let calls = 0;
  const server = http.createServer((request, response) => {
    calls++;
    if (mode === "headers") return;
    response.writeHead(200, { "content-type": "application/json" });
    if (mode === "body") {
      response.write('{"id":');
      return;
    }
    response.end(
      JSON.stringify(
        request.url?.endsWith("/installation")
          ? { id: 999 }
          : request.url?.endsWith("/access_tokens")
            ? { token: "synthetic-token" }
            : request.url?.endsWith("/repos/openclaw/openclaw")
              ? {
                  full_name: "openclaw/openclaw",
                  private: false,
                  visibility: "public",
                }
              : {},
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    return previousFetch(`http://127.0.0.1:${address.port}${url.pathname}`, init);
  });
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.ok(ms === 15_000 || ms === 20_000);
    return previousTimeout(mode === "success" ? 2_000 : 50);
  });

  for (mode of ["success", "headers", "body"]) {
    await t.test(mode, { timeout: 3_000 }, async () => {
      calls = 0;
      const result = handleGitHubWebhook({
        event: "pull_request",
        payload: {
          action: "opened",
          repository: {
            full_name: "openclaw/openclaw",
            default_branch: "main",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          pull_request: { number: 91095, head: { sha: "e".repeat(40) } },
          installation: { id: 123 },
        },
      });
      if (mode === "success") {
        assert.deepEqual(await result, {
          statusCode: 202,
          body: { ok: true, dispatched: "clawsweeper_item" },
        });
        assert.equal(calls, 5);
      } else {
        assert.deepEqual(await result, {
          statusCode: 503,
          body: { ok: false, error: "target_visibility_unverified", retryable: true },
        });
        assert.equal(calls, 1);
      }
    });
  }
});

function commandWebhookPayload(commandBody: string, targetRepo = "openclaw/openclaw") {
  return {
    action: "created",
    repository: {
      full_name: targetRepo,
      default_branch: "main",
      private: false,
      archived: false,
      fork: false,
      has_issues: true,
    },
    issue: {
      number: 71898,
      state: "open",
      pull_request: {},
      user: { login: "contributor" },
    },
    installation: { id: 123 },
    comment: {
      id: 456,
      body: commandBody,
      author_association: "MEMBER",
      updated_at: "2026-08-27T00:00:00Z",
      user: { login: "maintainer" },
    },
  };
}

function installWebhookAppCredentials() {
  const previousAppId = process.env.CLAWSWEEPER_APP_ID;
  const previousClientId = process.env.CLAWSWEEPER_APP_CLIENT_ID;
  const previousPrivateKey = process.env.CLAWSWEEPER_APP_PRIVATE_KEY;
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.CLAWSWEEPER_APP_ID = "12345";
  delete process.env.CLAWSWEEPER_APP_CLIENT_ID;
  process.env.CLAWSWEEPER_APP_PRIVATE_KEY = privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();
  return () => {
    restoreEnv("CLAWSWEEPER_APP_ID", previousAppId);
    restoreEnv("CLAWSWEEPER_APP_CLIENT_ID", previousClientId);
    restoreEnv("CLAWSWEEPER_APP_PRIVATE_KEY", previousPrivateKey);
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    status: init.status ?? 200,
    headers: init.headers ?? { "content-type": "application/json" },
  });
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
