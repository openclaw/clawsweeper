import assert from "node:assert/strict";
import test from "node:test";
import {
  hasQueueReviewLeaseIdentity,
  queueReviewLeaseIdentityFromReport,
  queueReviewLeaseIdentityFromMarker,
  queueReviewLeaseMarkerAttributes,
} from "../dist/review-lease-identity.js";
import { exactEventReviewLeaseDisposition } from "../dist/clawsweeper-record-metadata.js";
import {
  durableReviewCausalIdentityFromBody,
  issueReviewCommentState,
  newerDurableReviewTupleVerified,
  staleReviewCommentSyncReason,
} from "../dist/clawsweeper-review-comment-state.js";
import { generationReadKey, LiveReadGeneration } from "../dist/live-read-generation.js";
import { repositoryProfileFor, withTargetProfile } from "../dist/repository-profiles.js";
import { reviewVersionMarkerFromReport } from "../dist/clawsweeper-review-comment-automation.js";

const number = 123;
const head = "a".repeat(40);
const source = "b".repeat(64);
const identity = {
  kind: "queue" as const,
  itemKey: "openclaw/openclaw#123",
  leaseRevision: 2,
  claimGeneration: 3,
  runId: "123456789012345678901234567890",
  runAttempt: 1,
};
const queueFields = [
  `review_queue_item_key: ${identity.itemKey}`,
  `review_queue_lease_revision: ${identity.leaseRevision}`,
  `review_queue_claim_generation: ${identity.claimGeneration}`,
  `review_queue_run_id: ${identity.runId}`,
  `review_queue_run_attempt: ${identity.runAttempt}`,
].join("\n");

function report(fields = queueFields, kind = "pull_request"): string {
  return [
    "---",
    `type: ${kind}`,
    `pull_head_sha: ${head}`,
    `item_source_revision: ${source}`,
    "reviewed_at: 2026-10-12T01:00:00Z",
    "review_lease_owner: fixture",
    fields,
    "---",
    "Review",
  ].join("\n");
}

function body(attributes: string, kind = "pull_request"): string {
  return [
    "Codex review: durable fixture.",
    ...(kind === "pull_request"
      ? [`<!-- clawsweeper-review-state:ready item=${number} sha=${head} v=1 -->`]
      : []),
    `<!-- clawsweeper-review-version item=${number} reviewed_at=2026-10-11T01:00:00Z sha=${kind === "pull_request" ? head : "na"} source_revision=${source} lease_owner=fixture ${attributes} -->`,
    `<!-- clawsweeper-review item=${number} -->`,
  ].join("\n\n");
}

const queueAttributes = `lease_kind=queue queue_item_key=${identity.itemKey} queue_lease_revision=2 queue_claim_generation=3 queue_run_id=${identity.runId} queue_run_attempt=1 v=2`;

function comment(attributes = queueAttributes, kind = "pull_request") {
  return {
    id: 900,
    user: { login: "clawsweeper[bot]" },
    body: body(attributes, kind),
    updated_at: "2026-10-13T01:00:00Z",
  };
}

function commentWithoutState(attributes = queueAttributes, versionOnly = false) {
  const existing = comment(attributes);
  return {
    ...existing,
    body: existing.body
      .split("\n\n")
      .filter(
        (line) =>
          !line.startsWith("<!-- clawsweeper-review-state:") &&
          (!versionOnly || line.startsWith("<!--")),
      )
      .join("\n\n"),
  };
}

test("queue reports parse strictly and pass exact revision validation", () => {
  assert.deepEqual(queueReviewLeaseIdentityFromReport(report()), identity);
  assert.equal(hasQueueReviewLeaseIdentity(report()), true);
  assert.deepEqual(exactEventReviewLeaseDisposition(report(), head), { status: "current" });
  assert.equal(exactEventReviewLeaseDisposition(report(), "c".repeat(40)).status, "source_drift");
  assert.equal(exactEventReviewLeaseDisposition(report(), "").status, "source_drift");
});

test("rendering a queue report preserves its causal identity without a comment ID", () => {
  const markdown = report().replace("type: pull_request", "type: pull_request\nnumber: 123");
  const version = reviewVersionMarkerFromReport(markdown);
  const rendered = [
    `<!-- clawsweeper-review-state:ready item=123 sha=${head} v=1 -->`,
    version,
    "<!-- clawsweeper-review item=123 -->",
  ].join("\n");
  assert.deepEqual(durableReviewCausalIdentityFromBody(rendered, 123)?.leaseIdentity, identity);
  assert.equal(version.includes("lease_comment_id="), false);
  assert.equal(
    reviewVersionMarkerFromReport(
      markdown.replace(`review_queue_run_id: ${identity.runId}`, "review_queue_run_id: invalid"),
    ),
    "",
  );
});

test("malformed, duplicate, missing and mixed queue fields never become tupleless", () => {
  const malformed = [
    "review_queue_item_key:",
    queueFields.replace("#123", "#0"),
    queueFields.replace("openclaw/openclaw#123", "openclaw#123"),
    queueFields.replace("lease_revision: 2", "lease_revision: 0"),
    queueFields.replace("lease_revision: 2", "lease_revision: 2.5"),
    queueFields.replace("lease_revision: 2", "lease_revision: 9007199254740992"),
    queueFields.replace("claim_generation: 3", "claim_generation: -1"),
    queueFields.replace("run_attempt: 1", "run_attempt: 01"),
    queueFields.replace(identity.runId, "0"),
    queueFields.replace(identity.runId, "1".repeat(31)),
    queueFields.replace(identity.runId, "1e3"),
    queueFields.replace(/review_queue_run_attempt: 1/, ""),
    `${queueFields}\nreview_queue_run_attempt: 2`,
    `${queueFields}\nreview_lease_comment_id: 100`,
    `${queueFields}\nreview_lease_comment_id:`,
  ];
  for (const fields of malformed) {
    const markdown = report(fields);
    assert.equal(hasQueueReviewLeaseIdentity(markdown), true, fields);
    assert.equal(queueReviewLeaseIdentityFromReport(markdown), null, fields);
    assert.equal(exactEventReviewLeaseDisposition(markdown, head).status, "invalid", fields);
    assert.notEqual(staleReviewCommentSyncReason(markdown, undefined, number), null, fields);
    assert.equal(newerDurableReviewTupleVerified(markdown, comment(), number), false, fields);
  }
  assert.equal(hasQueueReviewLeaseIdentity("review_queue_run_id: 1"), true);
  assert.equal(queueReviewLeaseIdentityFromReport("review_queue_run_id: 1"), null);
});

test("queue reports require an owner that keeps old readers fail-closed", () => {
  for (const owner of ["", "unknown", "bad owner", "x".repeat(201)]) {
    const markdown = report().replace(
      "review_lease_owner: fixture",
      `review_lease_owner: ${owner}`,
    );
    assert.equal(queueReviewLeaseIdentityFromReport(markdown), null, owner);
    assert.equal(exactEventReviewLeaseDisposition(markdown, head).status, "invalid", owner);
  }
  assert.equal(
    queueReviewLeaseIdentityFromReport(report().replace("review_lease_owner: fixture\n", "")),
    null,
  );
  const attributes = queueReviewLeaseMarkerAttributes(identity);
  assert.equal(attributes, queueAttributes.replace(" v=2", ""));
  assert.deepEqual(
    queueReviewLeaseIdentityFromMarker(`${attributes} lease_owner=github-run-123-attempt-1`),
    identity,
  );
  assert.equal(queueReviewLeaseIdentityFromMarker(`${attributes} lease_owner=unknown`), null);
  assert.equal(queueReviewLeaseIdentityFromMarker(attributes), null);
});

test("v2 markers retain causal identity for PR and issue readers", () => {
  for (const kind of ["pull_request", "issue"]) {
    const parsed = durableReviewCausalIdentityFromBody(body(queueAttributes, kind), number);
    assert.deepEqual(parsed?.leaseIdentity, identity);
    assert.equal(parsed?.leaseOwner, "fixture");
    assert.equal(parsed?.leaseCommentId, null);
    assert.equal(parsed?.headSha, kind === "pull_request" ? head : null);
    assert.equal(parsed?.sourceRevision, source);
    assert.equal(
      staleReviewCommentSyncReason(
        report(queueFields, kind),
        comment(queueAttributes, kind),
        number,
      ),
      null,
    );
  }
});

test("queue generations order by revision then claim, ignoring timestamps", () => {
  for (const attributes of [
    queueAttributes.replace("claim_generation=3", "claim_generation=4"),
    queueAttributes
      .replace("lease_revision=2", "lease_revision=3")
      .replace("claim_generation=3", "claim_generation=1"),
  ]) {
    assert.match(staleReviewCommentSyncReason(report(), comment(attributes), number)!, /newer/);
    assert.equal(newerDurableReviewTupleVerified(report(), comment(attributes), number), true);
  }
  for (const attributes of [
    queueAttributes,
    queueAttributes.replace("claim_generation=3", "claim_generation=2"),
    queueAttributes
      .replace("lease_revision=2", "lease_revision=1")
      .replace("claim_generation=3", "claim_generation=9"),
  ]) {
    assert.equal(staleReviewCommentSyncReason(report(), comment(attributes), number), null);
    assert.equal(newerDurableReviewTupleVerified(report(), comment(attributes), number), false);
  }
});

test("manual and oversized-style v2 versions compare without granting PR readiness", () => {
  for (const versionOnly of [false, true]) {
    const existing = commentWithoutState(queueAttributes, versionOnly);
    assert.equal(durableReviewCausalIdentityFromBody(existing.body, number), null);
    assert.equal(staleReviewCommentSyncReason(report(), existing, number), null);
    assert.equal(newerDurableReviewTupleVerified(report(), existing, number), false);

    const newer = commentWithoutState(
      queueAttributes.replace("claim_generation=3", "claim_generation=4"),
      versionOnly,
    );
    assert.equal(durableReviewCausalIdentityFromBody(newer.body, number), null);
    assert.match(staleReviewCommentSyncReason(report(), newer, number)!, /newer/);
    assert.equal(newerDurableReviewTupleVerified(report(), newer, number), true);
    assert.equal(
      newerDurableReviewTupleVerified(
        report().replace(`pull_head_sha: ${head}`, `pull_head_sha: ${"c".repeat(40)}`),
        newer,
        number,
      ),
      false,
    );
  }
});

test("state-independent queue versions still reject malformed and conflicting identities", () => {
  for (const attributes of [
    queueAttributes.replace(identity.itemKey, "other/repo#123"),
    queueAttributes.replace(identity.runId, "999"),
    queueAttributes.replace("queue_run_attempt=1", ""),
    `${queueAttributes} lease_comment_id=100`,
    `${queueAttributes} queue_run_attempt=1`,
  ]) {
    const existing = commentWithoutState(attributes);
    assert.notEqual(staleReviewCommentSyncReason(report(), existing, number), null);
    assert.equal(newerDurableReviewTupleVerified(report(), existing, number), false);
  }
  const existing = commentWithoutState();
  for (const body of [
    existing.body.replace(`sha=${head}`, "sha=invalid"),
    existing.body.replace(
      `<!-- clawsweeper-review item=${number} -->`,
      `<!-- clawsweeper-review-state:ready item=${number} sha=${"c".repeat(40)} v=1 -->\n\n<!-- clawsweeper-review item=${number} -->`,
    ),
    existing.body.replace(/(<!-- clawsweeper-review-version[^>]*-->)/, "$1\n\n$1"),
  ]) {
    const malformed = { ...existing, body };
    assert.notEqual(staleReviewCommentSyncReason(report(), malformed, number), null);
    assert.equal(newerDurableReviewTupleVerified(report(), malformed, number), false);
  }
});

test("queue identity conflicts and malformed markers fail closed without timestamp fallback", () => {
  const invalidAttributes = [
    queueAttributes.replace(identity.itemKey, "other/repo#123"),
    queueAttributes.replace(identity.itemKey, "openclaw/openclaw#124"),
    queueAttributes.replace(identity.runId, "999"),
    queueAttributes.replace("run_attempt=1", "run_attempt=2"),
    queueAttributes.replace("claim_generation=3", "claim_generation=0"),
    queueAttributes.replace("queue_run_attempt=1", ""),
    `${queueAttributes} queue_run_attempt=1`,
    `${queueAttributes} lease_comment_id=100`,
    `${queueAttributes} lease_comment_id=`,
    queueAttributes.replace("v=2", "v=1"),
    "lease_comment_id=100 v=1",
  ];
  for (const attributes of invalidAttributes) {
    assert.notEqual(
      staleReviewCommentSyncReason(report(), comment(attributes), number),
      null,
      attributes,
    );
    assert.equal(
      newerDurableReviewTupleVerified(report(), comment(attributes), number),
      false,
      attributes,
    );
  }
  assert.notEqual(
    staleReviewCommentSyncReason(report("review_lease_comment_id: 100"), comment(), number),
    null,
  );
  assert.equal(
    newerDurableReviewTupleVerified(report("review_lease_comment_id: 100"), comment(), number),
    false,
  );
  assert.equal(
    durableReviewCausalIdentityFromBody(body(`${queueAttributes} lease_comment_id=100`), number),
    null,
  );
  assert.equal(
    durableReviewCausalIdentityFromBody(body(`${queueAttributes} queue_run_attempt=1`), number),
    null,
  );
});

test("a malformed v2 marker never falls back to an older valid v1 marker", () => {
  const malformed = body("lease_comment_id=100 v=1").replace(
    `<!-- clawsweeper-review item=${number} -->`,
    `<!-- clawsweeper-review-version item=${number} reviewed_at=invalid ${queueAttributes} -->\n<!-- clawsweeper-review item=${number} -->`,
  );
  assert.equal(durableReviewCausalIdentityFromBody(malformed, number), null);
  const existing = { ...comment(), body: malformed };
  assert.notEqual(staleReviewCommentSyncReason(report(), existing, number), null);
  assert.equal(newerDurableReviewTupleVerified(report(), existing, number), false);
});

test("legacy tupleless and v1 reports keep their existing behavior", () => {
  const tupleless = `---\npull_head_sha: ${head}\ntype: pull_request\n---\n`;
  assert.equal(hasQueueReviewLeaseIdentity(tupleless), false);
  assert.deepEqual(exactEventReviewLeaseDisposition(tupleless, head), {
    status: "legacy_tupleless",
    reason: "local report has no durable lease identity",
  });
  const legacy = report("review_lease_comment_id: 100");
  assert.deepEqual(exactEventReviewLeaseDisposition(legacy, head), { status: "current" });
  const parsed = durableReviewCausalIdentityFromBody(body("lease_comment_id=100 v=1"), number);
  assert.equal(parsed?.leaseCommentId, 100);
  assert.deepEqual(parsed?.leaseIdentity, { kind: "comment", owner: "fixture", commentId: 100 });
  assert.equal(
    staleReviewCommentSyncReason(legacy, comment("lease_comment_id=100 v=1"), number),
    null,
  );
  assert.match(
    staleReviewCommentSyncReason(legacy, comment("lease_comment_id=101 v=1"), number)!,
    /newer/,
  );
  assert.equal(
    newerDurableReviewTupleVerified(legacy, comment("lease_comment_id=101 v=1"), number),
    true,
  );
});

test("legacy identity transition is explicit and never inferred from comment IDs", () => {
  const legacy = comment("lease_comment_id=9007199254740991 v=1");
  assert.notEqual(staleReviewCommentSyncReason(report(), legacy, number), null);
  assert.equal(
    staleReviewCommentSyncReason(report(), legacy, number, undefined, {
      allowLegacyIdentityTransition: true,
    }),
    null,
  );
  assert.equal(newerDurableReviewTupleVerified(report(), legacy, number), false);
  const versionOnlyLegacy = {
    ...legacy,
    body: legacy.body.replace(
      `<!-- clawsweeper-review-state:ready item=${number} sha=${head} v=1 -->\n\n`,
      "",
    ),
  };
  assert.equal(durableReviewCausalIdentityFromBody(versionOnlyLegacy.body, number), null);
  assert.notEqual(staleReviewCommentSyncReason(report(), versionOnlyLegacy, number), null);
  assert.equal(
    staleReviewCommentSyncReason(report(), versionOnlyLegacy, number, undefined, {
      allowLegacyIdentityTransition: true,
    }),
    null,
  );
  for (const existing of [
    comment("lease_comment_id=invalid v=1"),
    comment(`${queueAttributes} lease_comment_id=100`),
    comment(queueAttributes.replace(identity.itemKey, "other/repo#123")),
  ]) {
    assert.notEqual(
      staleReviewCommentSyncReason(report(), existing, number, undefined, {
        allowLegacyIdentityTransition: true,
      }),
      null,
    );
  }
  const mixedReport = report(`${queueFields}\nreview_lease_comment_id: 100`);
  assert.notEqual(
    staleReviewCommentSyncReason(mixedReport, legacy, number, undefined, {
      allowLegacyIdentityTransition: true,
    }),
    null,
  );
});

test("durable comment selection orders queue generations and rejects ambiguous identities", () => {
  function select(comments: Record<string, unknown>[]) {
    return withTargetProfile(repositoryProfileFor("openclaw/openclaw"), () => {
      const generation = new LiveReadGeneration();
      generation.read(
        generationReadKey("paged", [`repos/openclaw/openclaw/issues/${number}/comments`]),
        () => comments,
      );
      return issueReviewCommentState(number, [], { liveReadGeneration: generation }).reviewComment;
    });
  }
  const older = { ...comment(), id: 901, updated_at: "2026-10-15T00:00:00Z" };
  const newer = {
    ...comment(queueAttributes.replace("claim_generation=3", "claim_generation=4")),
    id: 800,
    updated_at: "2026-10-10T00:00:00Z",
  };
  assert.equal(select([older, newer])?.id, 800);
  assert.equal(select([newer, older])?.id, 800);
  for (const versionOnly of [false, true]) {
    const manual = { ...commentWithoutState(queueAttributes, versionOnly), id: 902 };
    const repeated = { ...manual, id: 903 };
    const newerWithoutState = {
      ...commentWithoutState(
        queueAttributes.replace("claim_generation=3", "claim_generation=4"),
        versionOnly,
      ),
      id: 800,
    };
    assert.equal(select([manual])?.id, 902);
    assert.equal(select([manual, repeated])?.id, 903);
    assert.equal(select([repeated, manual])?.id, 903);
    assert.equal(select([manual, newerWithoutState])?.id, 800);
    assert.equal(select([newerWithoutState, manual])?.id, 800);
    assert.equal(select([older, newerWithoutState])?.id, 800);
    for (const conflict of [
      commentWithoutState(`${queueAttributes} lease_comment_id=100`, versionOnly),
      commentWithoutState(queueAttributes.replace(identity.runId, "999"), versionOnly),
      commentWithoutState("lease_comment_id=100 v=1", versionOnly),
    ]) {
      assert.throws(() => select([manual, conflict]), /ambiguous queue lease identities/);
      assert.throws(() => select([conflict, manual]), /ambiguous queue lease identities/);
    }
  }
  for (const conflict of [
    comment("lease_comment_id=100 v=1"),
    comment(queueAttributes.replace(identity.itemKey, "other/repo#123")),
    comment(queueAttributes.replace(identity.runId, "999")),
    comment(queueAttributes.replace("claim_generation=3", "claim_generation=0")),
  ]) {
    assert.throws(() => select([older, conflict]), /ambiguous queue lease identities/);
    assert.throws(() => select([conflict, older]), /ambiguous queue lease identities/);
  }
  const fallback = {
    id: 100,
    user: { login: "clawsweeper[bot]" },
    body: `Codex review: publication failed closed.\n\n<!-- clawsweeper-review item=${number} -->`,
  };
  assert.equal(select([fallback, newer])?.id, 100);
  assert.equal(select([newer, fallback])?.id, 100);
  assert.equal(
    select([
      comment("lease_comment_id=100 v=1"),
      {
        ...comment("lease_comment_id=101 v=1"),
        id: 950,
      },
    ])?.id,
    950,
  );
});
