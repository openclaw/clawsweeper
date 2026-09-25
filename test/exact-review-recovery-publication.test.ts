import {
  assert,
  test,
  ExactReviewQueue,
  MemoryDurableStorage,
  buildExactReviewQueueRequest,
  exactReviewPublicationOverrides,
  exactReviewQueueAdmittedItems,
  exactReviewQueueNextWakeAt,
} from "./dashboard-worker-harness.ts";
import { exactReviewQueueBayProjection } from "../dashboard/exact-review-read-model.ts";

for (const publicationRepo of ["openclaw/gogcli", "OpenClaw/GogCli"]) {
  test(`failed shard recovery waits for ${publicationRepo} publication`, async () => {
    const storage = new MemoryDurableStorage();
    const queue = new ExactReviewQueue({ storage }, {});
    const publication = exactReviewPublicationOverrides(710, "7100", "opened", 2, publicationRepo);
    const response = await queue.fetch(
      buildExactReviewQueueRequest(
        "completed-review-publication",
        710,
        "exact_review_artifact_publish",
        "issue",
        publicationRepo,
        publication,
      ),
    );
    assert.equal(response.status, 202);
    const before = await storage.get("exact-review-queue");

    const recovery = await queue.fetch(
      buildExactReviewQueueRequest("late-shard-recovery", 710, "failed_review_shard_recovery"),
    );
    assert.equal(recovery.status, 202);
    const after = await storage.get("exact-review-queue");
    const reviewKey = "openclaw/gogcli#710";
    const publicationKey = `${publicationRepo}#710@publish:7100:1`;
    assert.equal(after.items[reviewKey].decision.sourceAction, "failed_review_shard_recovery");
    assert.deepEqual(after.items[publicationKey], before.items[publicationKey]);
    const now = Date.now();
    after.items[reviewKey].nextAttemptAt = now;
    after.items[publicationKey].nextAttemptAt = now + 30_000;
    assert.deepEqual(exactReviewQueueAdmittedItems(after, now, 8, 8, 8), []);
    assert.equal(exactReviewQueueNextWakeAt(after, now), now + 30_000);
    assert.equal(
      exactReviewQueueBayProjection(Object.values(after.items)).items[0]?.stage,
      "publishing",
    );

    // Publication settlement must leave the one-shot recovery eligible: its
    // missing source tuple cannot prove that the earlier review covered it.
    delete after.items[publicationKey];
    assert.deepEqual(
      exactReviewQueueAdmittedItems(after, now, 8, 8, 8).map((item) => item.key),
      [reviewKey],
    );
    assert.equal(
      exactReviewQueueBayProjection(Object.values(after.items)).items[0]?.stage,
      "repairing",
    );
  });
}

for (const action of [
  "synchronize",
  "edited",
  "manual_explicit_review",
  "source_drift_requeue",
  "artifact_retention_recovery",
]) {
  test(`${action} can request a review while an earlier publication waits`, async () => {
    const storage = new MemoryDurableStorage();
    const queue = new ExactReviewQueue(
      { storage },
      { EXACT_REVIEW_MANUAL_PUBLICATION_ENABLED: "1" },
    );
    assert.equal(
      (
        await queue.fetch(
          buildExactReviewQueueRequest(
            "previous-publication",
            710,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(710, "7100", "opened", 2),
          ),
        )
      ).status,
      202,
    );
    const response = await queue.fetch(
      buildExactReviewQueueRequest(
        `new-${action}`,
        710,
        action,
        "issue",
        "openclaw/gogcli",
        action === "manual_explicit_review" ? { publicationPolicy: "record_comment_only" } : {},
      ),
    );
    assert.equal(response.status, 202);
    const state = await storage.get("exact-review-queue");
    assert.equal(state.items["openclaw/gogcli#710"].decision.sourceAction, action);
    assert.ok(state.items["openclaw/gogcli#710@publish:7100:1"]);
    const now = Date.now();
    state.items["openclaw/gogcli#710"].nextAttemptAt = now;
    assert.ok(
      exactReviewQueueAdmittedItems(state, now, 8, 8, 8).some(
        (item) => item.key === "openclaw/gogcli#710",
      ),
    );
  });
}
