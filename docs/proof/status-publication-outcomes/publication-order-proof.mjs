import assert from "node:assert/strict";

export async function provePublicationOrder(origin, revision) {
  const call = async (pathname, body) => {
    const response = await fetch(
      origin + pathname,
      body
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : undefined,
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const control = (body) => call("/__proof/publication-order", body);
  const older = Date.now() - 2_000;
  const newer = older + 1_000;
  await control({ action: "reset" });
  await control({ action: "write", at: older, count: 17, held: true });
  await control({ action: "write", at: newer, count: 18 });
  const before = await call("/__proof/observations");
  assert.equal(before.snapshot_writes, 2);
  assert.equal(before.snapshot_settled, 1, "a held old arrival must not block the newer write");
  assert.equal(before.stored_status.active_codex_jobs, 18);
  await call("/__proof/release", {});
  let after;
  const deadline = Date.now() + 5_000;
  do {
    after = await call("/__proof/observations");
    if (after.snapshot_settled === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(after.snapshot_settled, 2);
  const expected = revision === "candidate" ? 18 : 17;
  assert.equal(after.stored_status.active_codex_jobs, expected);
  assert.equal(
    after.stored_status.generated_at,
    new Date(revision === "candidate" ? newer : older).toISOString(),
  );
  await control({ action: "edge", at: older, count: 17 });
  const fresh = await call("/api/status");
  assert.equal(fresh.fleet.active_codex_jobs, expected);
  await control({ action: "ttl", ttl: 0 });
  const stale = await call("/api/status");
  assert.equal(stale.fleet.active_codex_jobs, expected);
  if (revision === "candidate") {
    assert.equal(stale.freshness.state, "stale");
    assert.equal(stale.generated_at, new Date(newer).toISOString());
    assert.equal((await control({ action: "write", at: newer, count: 7 })).disposition, "retained");
    assert.equal(
      (await control({ action: "write", at: older, count: 7, scope: "another" })).disposition,
      "accepted",
    );
    const tied = await call("/__proof/observations");
    assert.equal(tied.stored_status.active_codex_jobs, 18);
    assert.equal(tied.stored_status.generated_at, new Date(newer).toISOString());
  }
  return {
    revision,
    before,
    after,
    fresh: { count: fresh.fleet.active_codex_jobs, generated_at: fresh.generated_at },
    stale: {
      count: stale.fleet.active_codex_jobs,
      generated_at: stale.generated_at,
      state: stale.freshness.state,
    },
    delayed_arrival_fenced: revision === "candidate",
    poisoned_edge_bypassed: revision === "candidate",
  };
}
