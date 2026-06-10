import assert from "node:assert/strict";
import crypto from "node:crypto";
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
    commentId: 456,
    installationId: 123,
    sourceAction: "created",
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
    commentId: 456,
    installationId: 123,
    sourceAction: "created",
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
    commentId: 456,
    installationId: 123,
    sourceAction: "created",
  });
});

test("comment webhook rejects commands from ineligible repositories", () => {
  const result = classifyIssueCommentWebhook({
    event: "issue_comment",
    payload: {
      action: "created",
      repository: {
        full_name: "openclaw/clawsweeper-state",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 1 },
      installation: { id: 123 },
      comment: { body: "/clawsweeper status", author_association: "MEMBER" },
    },
  });

  assert.deepEqual(result, { accepted: false, reason: "repository not eligible" });
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

test("webhook accepts eligible issue events for generic OpenClaw repositories", () => {
  const result = classifyItemWebhook({
    event: "issues",
    payload: {
      action: "opened",
      repository: {
        full_name: "openclaw/gogcli",
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
    targetRepo: "openclaw/gogcli",
    targetBranch: "main",
    itemNumber: 597,
    itemKind: "issue",
    installationId: 123,
    sourceEvent: "issues",
    sourceAction: "opened",
    supersedesInProgress: false,
  });
});

test("webhook accepts eligible pull request events for generic steipete repositories", () => {
  const result = classifyWebhook({
    event: "pull_request",
    payload: {
      action: "synchronize",
      repository: {
        full_name: "steipete/summarize",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      pull_request: { number: 42 },
      installation: { id: 456 },
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    type: "item",
    targetRepo: "steipete/summarize",
    targetBranch: "main",
    itemNumber: 42,
    itemKind: "pull_request",
    installationId: 456,
    sourceEvent: "pull_request",
    sourceAction: "synchronize",
    supersedesInProgress: true,
    codexTimeoutMs: 600_000,
  });
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

test("adaptive Codex timeout scales for large PRs with video proofs", () => {
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
    1_508_800,
  );
});

test("adaptive Codex timeout stays capped within review shard limits", () => {
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
    1_800_000,
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
      return jsonResponse({ token: "dispatch-token" });
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
        action: "synchronize",
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
          changed_files: 71,
          additions: 4176,
          deletions: 0,
          body: [
            "Proof:",
            "https://uploads.example.invalid/proof-a.mov",
            "https://uploads.example.invalid/proof-b.mp4",
          ].join("\n"),
        },
        installation: { id: 123 },
      },
    });

    assert.deepEqual(result, {
      statusCode: 202,
      body: { ok: true, dispatched: "clawsweeper_item" },
    });
    assert.equal(dispatchedBody?.event_type, "clawsweeper_item");
    assert.equal(
      (dispatchedBody?.client_payload as Record<string, unknown>)?.codex_timeout_ms,
      1_508_800,
    );
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
        full_name: "openclaw/gogcli",
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
        full_name: "openclaw/gogcli",
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

test("webhook rejects private and denied target repositories", () => {
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

  const deniedResult = classifyItemWebhook({
    event: "issues",
    payload: {
      action: "opened",
      repository: {
        full_name: "openclaw/clawsweeper-state",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 1 },
      installation: { id: 456 },
    },
  });
  assert.deepEqual(deniedResult, { accepted: false, reason: "repository not eligible" });
});

test("webhook ignores ClawSweeper-owned label mutations", () => {
  const result = classifyItemWebhook({
    event: "pull_request",
    payload: {
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
      label: { name: "status: 🚀 automerge armed" },
      sender: { login: "openclaw-clawsweeper[bot]" },
    },
  });

  assert.deepEqual(result, {
    accepted: false,
    reason: "routine ClawSweeper label mutation",
  });
});

test("webhook preserves human ClawSweeper-owned label mutations", () => {
  const result = classifyItemWebhook({
    event: "issues",
    payload: {
      action: "labeled",
      repository: {
        full_name: "openclaw/gogcli",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
      },
      issue: { number: 597 },
      installation: { id: 123 },
      label: { name: "status: 👀 ready for maintainer look" },
      sender: { login: "steipete" },
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    type: "item",
    targetRepo: "openclaw/gogcli",
    targetBranch: "main",
    itemNumber: 597,
    itemKind: "issue",
    installationId: 123,
    sourceEvent: "issues",
    sourceAction: "labeled",
    supersedesInProgress: false,
  });
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
  let dispatches = 0;
  process.env.CLAWSWEEPER_APP_ID = "12345";
  delete process.env.CLAWSWEEPER_APP_CLIENT_ID;
  process.env.CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS = "0,0,0";
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
      return jsonResponse({ token: "dispatch-token" });
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
      return jsonResponse({ id: 1 });
    }
    if (path === "/repos/openclaw/clawsweeper/dispatches" && method === "POST") {
      dispatches += 1;
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
    assert.equal(dispatches, 2);
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
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  let commentLookups = 0;
  let deletedAck = 0;
  let resolveDeleted: (() => void) | undefined;
  const deleted = new Promise<void>((resolve) => {
    resolveDeleted = resolve;
  });
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
      return jsonResponse({ token: "dispatch-token" });
    }
    if (path === "/app/installations/123/access_tokens" && method === "POST") {
      return jsonResponse({ token: "target-token" });
    }
    if (path.startsWith("/repos/openclaw/openclaw/issues/71898/comments?") && method === "GET") {
      commentLookups += 1;
      if (commentLookups <= 2) {
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
    assert.equal(deletedAck, 9001);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("CLAWSWEEPER_APP_ID", previousAppId);
    restoreEnv("CLAWSWEEPER_APP_CLIENT_ID", previousClientId);
    restoreEnv("CLAWSWEEPER_APP_PRIVATE_KEY", previousPrivateKey);
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

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
