import {
  assert,
  createHmac,
  test,
  ExactReviewQueue,
  MemoryDurableStorage,
  MemoryDurableNamespace,
  worker,
} from "./dashboard-worker-harness.ts";

const secret = "test-clawsweeper-webhook-secret";
// The error that each queue route returns for a decision that it cannot read.
const invalidDecisionErrors = {
  enqueue: "invalid_exact_review_item",
  "branch-authority": "invalid_branch_authority_reservation",
  "source-authority": "invalid_source_authority_reservation",
} as const;

// Sends a signed intake request through the Worker to a real queue.
// `hosted` is false when the hosted-target policy excludes every repository.
async function signedIntake(route: string, decision: Record<string, unknown>, hosted = true) {
  const storage = new MemoryDurableStorage();
  const policy = { hostedTargetPredicate: () => hosted };
  const queue = new ExactReviewQueue(
    { storage },
    { ...policy, hostedPublicTargetProbe: async () => "public" },
  );
  const body = JSON.stringify({
    delivery_id: `target-repo-header:${route}`,
    installation_id: 123,
    decision: {
      // Branch authority resolves the branch, so its decision names none.
      ...(route === "branch-authority" ? {} : { targetBranch: "main" }),
      itemNumber: 597,
      itemKind: "pull_request",
      sourceEvent: "pull_request",
      sourceAction: "legacy_dispatch",
      supersedesInProgress: false,
      ...decision,
    },
  });
  const response = await worker.fetch(
    new Request(`https://clawsweeper.openclaw.ai/internal/exact-review/${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body,
    }),
    {
      ...policy,
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    },
  );
  const stored = (await storage.get("exact-review-queue")) as
    | { items: Record<string, unknown> }
    | undefined;
  return {
    status: response.status,
    body: await response.json(),
    items: Object.keys(stored?.items ?? {}),
  };
}

for (const [route, error] of Object.entries(invalidDecisionErrors)) {
  // Before the fix, Headers threw on these values and the Worker failed with 500.
  for (const targetRepo of [
    "openclaw/openclaw\nother/repo",
    "openclaw/openclaw\u0000",
    "openclaw/日本",
  ]) {
    test(`signed ${route} intake rejects ${JSON.stringify(targetRepo)} with the queue error`, async () => {
      assert.deepEqual(await signedIntake(route, { targetRepo }), {
        status: 400,
        body: { error },
        items: [],
      });
    });
  }

  test(`signed ${route} intake keeps the queue error for an empty or missing target repository`, async () => {
    for (const decision of [{ targetRepo: "" }, { targetRepo: undefined }]) {
      assert.deepEqual(await signedIntake(route, decision), {
        status: 400,
        body: { error },
        items: [],
      });
    }
  });
}

// The queue trims the target repository, so a padded slug is accepted as before.
for (const [route, status, body] of [
  [
    "enqueue",
    202,
    { ok: true, queued: true, item_key: "openclaw/openclaw#597", superseded_publications: 0 },
  ],
  ["branch-authority", 202, { ok: true, branch_authority_pending: true }],
  ["source-authority", 200, { ok: true, source_authority_seq: 1 }],
] as const) {
  test(`signed ${route} intake still accepts a space-padded target repository`, async () => {
    const result = await signedIntake(route, { targetRepo: " openclaw/openclaw " });
    assert.deepEqual({ status: result.status, body: result.body }, { status, body });
  });
}

// The header tells the queue that the Worker checked eligibility. A padded slug
// must not get the header without that check.
for (const route of Object.keys(invalidDecisionErrors)) {
  test(`signed ${route} intake checks hosted-target eligibility for a space-padded repository`, async () => {
    const unpadded = await signedIntake(route, { targetRepo: "openclaw/openclaw" }, false);
    assert.equal(unpadded.status >= 400, true);
    assert.deepEqual(unpadded.items, []);
    assert.deepEqual(
      await signedIntake(route, { targetRepo: " openclaw/openclaw " }, false),
      unpadded,
    );
  });
}
