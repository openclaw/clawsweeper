import assert from "node:assert/strict";

export async function provePublicationReasons(origin, revision) {
  const post = async (path, body) => {
    const response = await fetch(`${origin}/__proof/reasons/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    return response.json();
  };
  const read = async () => {
    const response = await fetch(`${origin}/__proof/reasons/events`);
    assert.equal(response.status, 200);
    const result = (await response.json()).recent_durable_publication_events;
    assert.ok(result?.collection.complete);
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-fence|openclaw\/openclaw|error_fingerprint|claim_generation/,
    );
    return result;
  };
  await post("seed", {});
  for (const [number, kind, reason] of [
    [9101, "permanent_failure", "invalid_artifact"],
    [9102, "retryable_failure", "github_transient"],
  ]) {
    const run = String(number * 10);
    const completion = {
      lease_id: `lease-${number}`,
      item_key: `openclaw/openclaw#${number}@publish:${run}:1`,
      lease_revision: 1,
      claim_generation: 1,
      run_id: run,
      run_attempt: 1,
      outcome: "failure",
      completion_kind: kind,
      reason_code: reason,
    };
    await post("complete", completion);
    const before = await read();
    const replay = await fetch(`${origin}/__proof/reasons/complete`, {
      method: "POST",
      body: JSON.stringify(completion),
    });
    assert.ok([200, 409].includes(replay.status));
    assert.deepEqual((await read()).batch.counts, before.batch.counts);
  }
  const claim = await post("publication-batches/claim", {
    claim_id: "reason-proof-batch",
    lease_owner: "reason-proof",
    max_items: 1,
  });
  assert.equal(claim.claimed, true);
  const batch = await post("publication-batches/fetch", {
    batch_id: "reason-proof-batch",
    lease_owner: "reason-proof",
  });
  assert.equal(batch.items.length, 1);
  const item = batch.items[0];
  const completion = {
    batch_id: "reason-proof-batch",
    lease_owner: "reason-proof",
    items: [
      {
        item_key: item.item_key,
        revision: item.revision,
        claim_generation: item.claim_generation,
        terminal_outcome: "permanent_failure",
        reason_code: "tuple_protocol_invalid",
      },
    ],
  };
  await post("publication-batches/complete", completion);
  const view = await read();
  assert.deepEqual(view.batch.counts, { superseded: 0, retryable: 1, permanent: 3 });
  if (revision === "candidate") {
    assert.equal(view.batch.reason_counts.permanent.invalid_artifact, 1);
    assert.equal(view.batch.reason_counts.permanent.tuple_protocol_invalid, 1);
    assert.equal(view.batch.reason_counts.permanent.unrecorded, 1);
    assert.equal(view.batch.reason_counts.permanent.unknown_failure, 0);
    assert.equal(view.batch.reason_counts.retryable.github_transient, 1);
  } else {
    assert.equal(view.batch.reason_counts, undefined);
  }
  await post("publication-batches/complete", completion);
  assert.deepEqual((await read()).batch.counts, view.batch.counts);
  return {
    revision,
    counts: view.batch.counts,
    reasons: view.batch.reason_counts,
    legacy_row_preserved: true,
    replay_deduplicated: true,
  };
}
