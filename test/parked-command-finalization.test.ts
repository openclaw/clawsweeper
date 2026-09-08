import {
  assert,
  test,
  createExactReviewAdmissionHarness,
  buildExactReviewQueueRequest,
  jsonResponse,
  ExactReviewQueue,
} from "./dashboard-worker-harness.ts";
import type { ExactReviewQueueState } from "../dashboard/exact-review-queue.ts";

const number = 990001;
const key = `openclaw/gogcli#${number}`;
const marker = `<!-- clawsweeper-command-status:${number}:re_review:synthetic -->`;
const head = "a".repeat(40);
const closed = {
  number,
  node_id: "PR_synthetic",
  state: "closed",
  closed_at: "2026-09-01T00:00:00Z",
  head: { sha: head },
};
async function fixture(
  variant: "marker" | "comment",
  target: () => Response | Promise<Response>,
  options: Parameters<typeof createExactReviewAdmissionHarness>[1] = {},
) {
  const harness = createExactReviewAdmissionHarness(target, options);
  const response = await harness.queue.fetch(
    buildExactReviewQueueRequest(
      "synthetic-parked-command",
      number,
      "legacy_dispatch",
      "pull_request",
      undefined,
      {
        sourceHeadSha: head,
        ...(variant === "marker" ? { commandStatusMarker: marker } : { statusCommentId: 990002 }),
      },
    ),
  );
  assert.equal(response.status, 202);
  const state = (await harness.storage.get("exact-review-queue")) as ExactReviewQueueState;
  const item = state.items[key];
  assert.ok(item);
  item.state = "parked";
  item.parkedReason = "review_retry_exhausted";
  item.parkedRecoveryAttempts = 3;
  item.reviewFailureAttempts = 8;
  item.attempts = 8;
  await harness.storage.put("exact-review-queue", state);
  return harness;
}
async function stateOf(h: Awaited<ReturnType<typeof fixture>>) {
  return (await h.storage.get("exact-review-queue")) as ExactReviewQueueState;
}
async function claimDriver(h: Awaited<ReturnType<typeof fixture>>) {
  await h.queue.alarm();
  let state = await stateOf(h);
  const driver = Object.values(state.items).find((i) => i.terminalFinalization);
  assert.ok(driver);
  assert.equal(state.items[key].state, "parked");
  await h.queue.alarm();
  state = await stateOf(h);
  const dispatched = state.items[driver.key];
  assert.equal(dispatched.state, "dispatching");
  assert.ok(
    h.dispatched.every(
      (d) =>
        (d.client_payload as { source_action?: string }).source_action ===
        "exact_review_command_acknowledgement",
    ),
  );
  const claim = await h.queue.fetch(
    new Request("https://queue/claim", {
      method: "POST",
      body: JSON.stringify({
        item_key: driver.key,
        lease_id: dispatched.leaseId,
        lease_revision: dispatched.leaseRevision,
        run_id: "990003",
        run_attempt: 1,
      }),
    }),
  );
  assert.equal(claim.status, 200, await claim.clone().text());
  const item = (await stateOf(h)).items[driver.key];
  return {
    item_key: item.key,
    lease_id: item.leaseId,
    lease_revision: item.leaseRevision,
    claim_generation: item.claimGeneration,
    run_id: item.claimedRunId,
    run_attempt: item.claimedRunAttempt,
  };
}
for (const variant of ["marker", "comment"] as const) {
  for (const merged of [false, true])
    test(`parked command ${variant} ${merged ? "merged" : "closed"} settles only after fenced acknowledgement skip`, async () => {
      const h = await fixture(variant, () => jsonResponse({ ...closed, merged }));
      try {
        const tuple = await claimDriver(h);
        const address =
          variant === "marker" ? { status_marker: marker } : { status_comment_id: 990002 };
        const response = await h.queue.fetch(
          new Request("https://queue/terminal-finalization/attempt", {
            method: "POST",
            body: JSON.stringify({ ...tuple, ...address }),
          }),
        );
        assert.equal(response.status, 200, await response.clone().text());
        const result = await response.json();
        assert.equal(result.allowed, true);
        assert.equal(result.status_state, "Failed");
        assert.equal(result.terminal_disposition, "target_closed");
        assert.equal((await stateOf(h)).items[key].state, "parked");
        const skip = await h.queue.fetch(
          new Request("https://queue/terminal-finalization/skip", {
            method: "POST",
            body: JSON.stringify({
              ...tuple,
              ...address,
              attempt_id: result.attempt_id,
              reason: variant === "marker" ? "missing_status_comment" : "locked_conversation",
            }),
          }),
        );
        assert.equal(skip.status, 200, await skip.clone().text());
        assert.equal((await skip.json()).completed, true);
        assert.equal((await stateOf(h)).items[key], undefined);
        assert.equal(
          Object.values((await stateOf(h)).items).filter((i) => i.terminalFinalization).length,
          0,
        );
        const stats = await (await h.queue.fetch(new Request("https://queue/stats"))).json();
        assert.equal(stats.lanes.review.completed_total, 0);
        await h.queue.alarm();
        assert.equal(h.dispatched.length, 1);
      } finally {
        h.restore();
      }
    });
}
for (const kind of ["open", "unavailable", "ambiguous", "reopen-between-reads"] as const)
  test(`parked command ${kind} does not restart or terminalize`, async () => {
    let reads = 0;
    const h = await fixture("marker", () => {
      reads++;
      return kind === "unavailable"
        ? jsonResponse({ message: "not found" }, { status: 404 })
        : kind === "ambiguous"
          ? jsonResponse({ state: "closed" })
          : jsonResponse(
              kind === "open" || (kind === "reopen-between-reads" && reads > 1)
                ? { ...closed, state: "open" }
                : closed,
            );
    });
    try {
      await h.queue.alarm();
      const state = await stateOf(h);
      assert.equal(state.items[key].state, "parked");
      assert.equal(state.items[key].parkedRecoveryAttempts, 3);
      assert.equal(Object.keys(state.items).length, 1);
      assert.equal(h.dispatched.length, 0);
    } finally {
      h.restore();
    }
  });
test("parked command target reopening before acknowledgement cancels only its driver", async () => {
  let open = false;
  const h = await fixture("marker", () =>
    jsonResponse({ ...closed, state: open ? "open" : "closed" }),
  );
  try {
    const tuple = await claimDriver(h);
    open = true;
    const res = await h.queue.fetch(
      new Request("https://queue/terminal-finalization/attempt", {
        method: "POST",
        body: JSON.stringify({ ...tuple, status_marker: marker }),
      }),
    );
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, "parked_command_target_changed");
    const state = await stateOf(h);
    assert.equal(state.items[key].state, "parked");
    assert.equal(state.items[tuple.item_key], undefined);
  } finally {
    h.restore();
  }
});
test("parked command takeover during target observation cannot authorize an old receipt", async () => {
  let takeover = false;
  let h: Awaited<ReturnType<typeof fixture>>;
  h = await fixture("marker", async () => {
    if (takeover) {
      const state = await stateOf(h);
      state.items[key].revision += 1;
      await h.storage.put("exact-review-queue", state);
    }
    return jsonResponse(closed);
  });
  try {
    const tuple = await claimDriver(h);
    takeover = true;
    const res = await h.queue.fetch(
      new Request("https://queue/terminal-finalization/attempt", {
        method: "POST",
        body: JSON.stringify({ ...tuple, status_marker: marker }),
      }),
    );
    assert.equal(res.status, 409);
    assert.equal((await stateOf(h)).items[key].state, "parked");
  } finally {
    h.restore();
  }
});
test("parked command repeated alarms retain one durable finalizer", async () => {
  const h = await fixture("comment", () => jsonResponse(closed));
  try {
    await h.queue.alarm();
    const before = await stateOf(h);
    const driver = Object.values(before.items).find((i) => i.terminalFinalization);
    assert.ok(driver);
    await h.queue.alarm();
    assert.equal(
      Object.values((await stateOf(h)).items).filter((i) => i.terminalFinalization).length,
      1,
    );
    assert.equal((await stateOf(h)).items[key].attempts, 8);
    const restored = new ExactReviewQueue({ storage: h.storage }, {});
    const stat = await (
      await restored.fetch(
        new Request("https://queue/item-status?target_repo=openclaw%2Fgogcli&item_number=990001"),
      )
    ).json();
    assert.ok(stat.items.some((i) => i.state === "parked"));
  } finally {
    h.restore();
  }
});

test("parked command receipt failure retains work and verified acknowledgement retires only its producer", async () => {
  const h = await fixture("marker", () => jsonResponse(closed));
  try {
    const tuple = await claimDriver(h);
    const address = { status_marker: marker };
    const begun = await (
      await h.queue.fetch(
        new Request("https://queue/terminal-finalization/attempt", {
          method: "POST",
          body: JSON.stringify({ ...tuple, ...address }),
        }),
      )
    ).json();
    assert.equal(begun.allowed, true);
    const identity = { canonical_target_key: key, fence_key: key, revision: 1 };
    const failed = await h.queue.fetch(
      new Request("https://queue/lifecycle/command-ack/failed", {
        method: "POST",
        body: JSON.stringify({ ...identity, ...address, attempt_id: begun.attempt_id }),
      }),
    );
    assert.equal(failed.status, 200, await failed.clone().text());
    assert.equal((await stateOf(h)).items[key].state, "parked");
    const second = await (
      await h.queue.fetch(
        new Request("https://queue/terminal-finalization/attempt", {
          method: "POST",
          body: JSON.stringify({ ...tuple, ...address }),
        }),
      )
    ).json();
    assert.equal(second.allowed, true);
    const receipt = {
      ...identity,
      ...address,
      command_comment_id: 990010,
      completion_comment_id: 990011,
      completed_at: new Date().toISOString(),
      completion_outcome: "failure",
      observed_at: Date.now(),
    };
    const observed = await h.queue.fetch(
      new Request("https://queue/lifecycle/command-ack/observed", {
        method: "POST",
        body: JSON.stringify(receipt),
      }),
    );
    assert.equal(observed.status, 200, await observed.clone().text());
    assert.equal((await observed.json()).accepted, true);
    assert.equal((await stateOf(h)).items[key], undefined);
    const repeated = await h.queue.fetch(
      new Request("https://queue/lifecycle/command-ack/observed", {
        method: "POST",
        body: JSON.stringify(receipt),
      }),
    );
    assert.equal(repeated.status, 200);
    assert.equal(h.dispatched.length, 1);
  } finally {
    h.restore();
  }
});

test("parked command re-fences a takeover after the initial acknowledgement authorization", async () => {
  const h = await fixture("marker", () => jsonResponse(closed));
  try {
    const tuple = await claimDriver(h);
    const first = await (
      await h.queue.fetch(
        new Request("https://queue/terminal-finalization/attempt", {
          method: "POST",
          body: JSON.stringify({ ...tuple, status_marker: marker }),
        }),
      )
    ).json();
    assert.equal(first.allowed, true);
    const state = await stateOf(h);
    state.items[key].revision += 1;
    await h.storage.put("exact-review-queue", state);
    const verify = await h.queue.fetch(
      new Request("https://queue/terminal-finalization/attempt", {
        method: "POST",
        body: JSON.stringify({
          ...tuple,
          status_marker: marker,
          attempt_id: first.attempt_id,
          verify_only: true,
        }),
      }),
    );
    assert.equal(verify.status, 409);
    assert.equal((await verify.json()).error, "parked_command_superseded");
    assert.equal((await stateOf(h)).items[key].revision, 2);
  } finally {
    h.restore();
  }
});

for (const interference of ["none", "reason", "deadline", "revision"] as const) {
  test(`parked command status-write release preserves ${interference} successor interference`, async () => {
    let opened = false;
    const nextHead = "b".repeat(40);
    const h = await fixture("marker", () =>
      jsonResponse(opened ? { ...closed, state: "open", head: { sha: nextHead } } : closed),
    );
    try {
      const tuple = await claimDriver(h);
      const begin = await (
        await h.queue.fetch(
          new Request("https://queue/terminal-finalization/attempt", {
            method: "POST",
            body: JSON.stringify({ ...tuple, status_marker: marker }),
          }),
        )
      ).json();
      const body = { ...tuple, status_marker: marker, attempt_id: begin.attempt_id };
      const verified = await h.queue.fetch(
        new Request("https://queue/terminal-finalization/attempt", {
          method: "POST",
          body: JSON.stringify({ ...body, verify_only: true }),
        }),
      );
      assert.equal(verified.status, 200);
      assert.equal((await verified.json()).write_fenced, true);
      let state = await stateOf(h);
      opened = true;
      state.items[key].revision += 1;
      state.items[key].decision.sourceHeadSha = nextHead;
      state.items[key].state = "pending";
      state.items[key].nextAttemptAt = Date.now() - 1;
      await h.storage.put("exact-review-queue", state);
      await h.queue.alarm();
      state = await stateOf(h);
      assert.equal(state.items[key].state, "pending");
      assert.equal(state.items[key].backoffReason, "coordination_retry");
      assert.equal(h.dispatched.length, 1);
      const beforeRelease = await stateOf(h);
      if (interference === "reason") beforeRelease.items[key].backoffReason = "throttle_retry";
      if (interference === "deadline") beforeRelease.items[key].nextAttemptAt += 30_000;
      if (interference === "revision") beforeRelease.items[key].revision += 1;
      if (interference !== "none") await h.storage.put("exact-review-queue", beforeRelease);
      const release = await h.queue.fetch(
        new Request("https://queue/terminal-finalization/attempt", {
          method: "POST",
          body: JSON.stringify({ ...body, release_status_write: true }),
        }),
      );
      assert.equal(release.status, 200);
      assert.equal((await release.json()).released, true);
      state = await stateOf(h);
      if (interference !== "none") {
        assert.equal(state.items[key].nextAttemptAt, beforeRelease.items[key].nextAttemptAt);
        assert.equal(state.items[key].backoffReason, beforeRelease.items[key].backoffReason);
        return;
      }
      assert.ok(state.items[key].nextAttemptAt <= Date.now());
      assert.equal(state.items[key].backoffReason, undefined);
      await h.queue.alarm();
      assert.equal((await stateOf(h)).items[key].state, "dispatching");
      assert.equal(h.dispatched.length, 2);
    } finally {
      h.restore();
    }
  });
}

test("parked command cancellation invalidates the durable closure plan before a source webhook", async () => {
  let open = false;
  const nextHead = "b".repeat(40);
  const h = await fixture("marker", () =>
    jsonResponse(open ? { ...closed, state: "open", head: { sha: nextHead } } : closed),
  );
  try {
    const tuple = await claimDriver(h);
    const initial = await h.queue.fetch(
      new Request("https://queue/terminal-finalization/attempt", {
        method: "POST",
        body: JSON.stringify({ ...tuple, status_marker: marker }),
      }),
    );
    assert.equal(initial.status, 200);
    const begun = await initial.json();
    assert.equal(begun.allowed, true);
    open = true;
    const cancelled = await h.queue.fetch(
      new Request("https://queue/terminal-finalization/attempt", {
        method: "POST",
        body: JSON.stringify({
          ...tuple,
          status_marker: marker,
          attempt_id: begun.attempt_id,
          verify_only: true,
        }),
      }),
    );
    assert.equal(cancelled.status, 409);
    assert.equal((await cancelled.json()).error, "parked_command_target_changed");
    assert.equal((await stateOf(h)).items[key].state, "parked");
    const inventory = await (
      await h.queue.fetch(new Request("https://queue/lifecycle-bay?public_repo=openclaw%2Fgogcli"))
    ).json();
    const cancelledCard = inventory.durable_lifecycle_bay.sample.cards.find(
      (card) => card.target.number === number && card.revision === tuple.lease_revision,
    );
    assert.ok(cancelledCard);
    assert.equal(cancelledCard.state, "failed");
    assert.equal(cancelledCard.lane, "terminal_attention");
    const event = await h.queue.fetch(
      buildExactReviewQueueRequest(
        "synthetic-after-reopen",
        number,
        "synchronize",
        "pull_request",
        undefined,
        {
          sourceHeadSha: nextHead,
          sourceHeadVerified: true,
          sourceUpdatedAt: new Date().toISOString(),
        },
      ),
    );
    assert.equal(event.status, 202, await event.clone().text());
    const state = await stateOf(h);
    assert.ok(
      state.items[key].revision > Number(tuple.lease_revision),
      JSON.stringify({ response: await event.clone().json(), item: state.items[key] }),
    );
    assert.equal(
      Object.values(state.items).filter(
        (item) => item.terminalFinalization?.disposition === "target_closed",
      ).length,
      0,
    );
    const oldReceipt = await h.queue.fetch(
      new Request("https://queue/lifecycle/command-ack/observed", {
        method: "POST",
        body: JSON.stringify({
          canonical_target_key: key,
          fence_key: key,
          revision: tuple.lease_revision,
          status_marker: marker,
          command_comment_id: 990010,
          completion_comment_id: 990011,
          observed_at: Date.now(),
        }),
      }),
    );
    assert.equal(oldReceipt.status, 200);
    assert.equal((await oldReceipt.json()).accepted, false);
  } finally {
    h.restore();
  }
});

for (const variant of ["marker", "comment"] as const) {
  for (const transition of ["before_reads", "after_reads"] as const) {
    test(
      "parked command " +
        variant +
        " preserves obligation when repository admission turns terminal " +
        transition,
      async () => {
        let admissionChanged = false;
        let reads = 0;
        const h = await fixture(
          variant,
          () => {
            reads += 1;
            return jsonResponse(closed);
          },
          {
            hostedPublicTargetProbe: async () =>
              admissionChanged && (transition === "before_reads" || reads >= 2)
                ? "terminal"
                : "public",
          },
        );
        try {
          admissionChanged = true;
          await h.queue.alarm();
          const state = await stateOf(h);
          assert.equal(state.items[key]?.state, "parked");
          assert.equal(state.items[key].attempts, 8);
          assert.equal(state.items[key].parkedRecoveryAttempts, 3);
          assert.ok(state.items[key].parkedTerminalCheckedAt);
          assert.equal(
            Object.values(state.items).filter((item) => item.terminalFinalization).length,
            0,
          );
          assert.equal(h.dispatched.length, 0);
          assert.equal(reads, transition === "before_reads" ? 0 : 2);
        } finally {
          h.restore();
        }
      },
    );
  }
}

test("parked command driver survives temporary non-hosted admission and resumes fenced", async () => {
  let nonHosted = false;
  const h = await fixture("marker", () => jsonResponse(closed), {
    hostedPublicTargetProbe: async () => (nonHosted ? "terminal" : "public"),
  });
  try {
    await h.queue.alarm();
    let state = await stateOf(h);
    const driver = Object.values(state.items).find((item) => item.terminalFinalization);
    assert.ok(driver);
    nonHosted = true;
    await h.queue.alarm();
    state = await stateOf(h);
    assert.equal(state.items[key].state, "parked");
    assert.equal(state.items[driver.key]?.state, "pending");
    assert.deepEqual(
      state.items[driver.key].terminalFinalization?.parkedCommand,
      driver.terminalFinalization?.parkedCommand,
    );
    assert.ok(state.items[driver.key].nextAttemptAt > Date.now());
    assert.equal(h.dispatched.length, 0);
    nonHosted = false;
    state.items[driver.key].nextAttemptAt = Date.now() - 1;
    await h.storage.put("exact-review-queue", state);
    await h.queue.alarm();
    state = await stateOf(h);
    assert.equal(state.items[driver.key].state, "dispatching");
    assert.equal(h.dispatched.length, 1);
    assert.ok(state.items[driver.key].terminalFinalization?.parkedCommand);
  } finally {
    h.restore();
  }
});

test("Bay canonical queue card remains exhausted while its acknowledgement driver is pending", async () => {
  const h = await fixture("marker", () => jsonResponse(closed));
  try {
    await h.queue.alarm();
    const state = await stateOf(h);
    const driver = Object.values(state.items).find((item) => item.terminalFinalization);
    assert.ok(driver);
    assert.ok(driver.updatedAt >= state.items[key].updatedAt);
    const stats = await (await h.queue.fetch(new Request("https://queue/stats"))).json();
    const card = stats.bay_projection.items.find((item) => item.item_key === key);
    assert.equal(card.stage, "repairing");
    assert.equal(card.queue_disposition, "parked_exhausted");
    assert.equal(stats.bay_projection.total, 1);
  } finally {
    h.restore();
  }
});

test("parked command receipt-time non-hosted admission defers rather than discards its driver", async () => {
  let nonHosted = false;
  const h = await fixture("marker", () => jsonResponse(closed), {
    hostedPublicTargetProbe: async () => (nonHosted ? "terminal" : "public"),
  });
  try {
    const tuple = await claimDriver(h);
    const begun = await h.queue.fetch(
      new Request("https://queue/terminal-finalization/attempt", {
        method: "POST",
        body: JSON.stringify({ ...tuple, status_marker: marker }),
      }),
    );
    assert.equal(begun.status, 200);
    const original = (await stateOf(h)).items[tuple.item_key].terminalFinalization;
    nonHosted = true;
    const response = await h.queue.fetch(
      new Request("https://queue/lifecycle/command-ack/observed", {
        method: "POST",
        body: JSON.stringify({
          canonical_target_key: key,
          fence_key: key,
          revision: tuple.lease_revision,
          status_marker: marker,
          command_comment_id: 990010,
          completion_comment_id: 990011,
          observed_at: Date.now(),
        }),
      }),
    );
    assert.equal(response.ok, false);
    const state = await stateOf(h);
    assert.equal(state.items[key].state, "parked");
    assert.equal(state.items[tuple.item_key]?.state, "pending");
    assert.deepEqual(state.items[tuple.item_key].terminalFinalization, original);
    assert.equal(state.items[tuple.item_key].leaseId, undefined);
    assert.ok(state.items[tuple.item_key].nextAttemptAt > Date.now());
  } finally {
    h.restore();
  }
});

test("parked command rechecks hosted admission before a claimed status write", async () => {
  let nonHosted = false;
  const h = await fixture("marker", () => jsonResponse(closed), {
    hostedPublicTargetProbe: async () => (nonHosted ? "terminal" : "public"),
  });
  try {
    const tuple = await claimDriver(h);
    nonHosted = true;
    const response = await h.queue.fetch(
      new Request("https://queue/terminal-finalization/attempt", {
        method: "POST",
        body: JSON.stringify({ ...tuple, status_marker: marker }),
      }),
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "lease_not_active");
    const state = await stateOf(h);
    assert.equal(state.items[key].state, "parked");
    assert.equal(state.items[tuple.item_key]?.state, "pending");
    assert.ok(state.items[tuple.item_key].terminalFinalization?.parkedCommand);
  } finally {
    h.restore();
  }
});

for (const variant of ["marker", "comment"] as const) {
  test(`cancelled ${variant} closure can finalize a later closure without restarting review`, async () => {
    let target = { ...closed };
    const h = await fixture(variant, () => jsonResponse(target));
    const address =
      variant === "marker" ? { status_marker: marker } : { status_comment_id: 990002 };
    try {
      const old = await claimDriver(h);
      const begun = await (
        await h.queue.fetch(
          new Request("https://queue/terminal-finalization/attempt", {
            method: "POST",
            body: JSON.stringify({ ...old, ...address }),
          }),
        )
      ).json();
      target = { ...closed, state: "open" };
      const cancelled = await h.queue.fetch(
        new Request("https://queue/terminal-finalization/attempt", {
          method: "POST",
          body: JSON.stringify({
            ...old,
            ...address,
            verify_only: true,
            attempt_id: begun.attempt_id,
          }),
        }),
      );
      assert.equal(cancelled.status, 409);
      target = { ...closed, closed_at: "2026-09-02T00:00:00Z" };
      const due = await stateOf(h);
      due.items[key].parkedTerminalCheckedAt = 0;
      due.dispatcher = { ...due.dispatcher, parkedTerminalCheckedAt: 0 };
      await h.storage.put("exact-review-queue", due);
      const fresh = await claimDriver(h);
      assert.ok(Number(fresh.lease_revision) > Number(old.lease_revision));
      const retained = (await stateOf(h)).items[key];
      assert.equal(retained.state, "parked");
      assert.equal(retained.attempts, 8);
      assert.equal(retained.parkedRecoveryAttempts, 3);
      const oldReceipt = await h.queue.fetch(
        new Request("https://queue/lifecycle/command-ack/observed", {
          method: "POST",
          body: JSON.stringify({
            canonical_target_key: key,
            fence_key: key,
            revision: old.lease_revision,
            ...address,
            command_comment_id: 990010,
            completion_comment_id: 990011,
            observed_at: Date.now(),
          }),
        }),
      );
      assert.equal(oldReceipt.status, 200);
      assert.equal((await oldReceipt.json()).accepted, false);
      const allowed = await (
        await h.queue.fetch(
          new Request("https://queue/terminal-finalization/attempt", {
            method: "POST",
            body: JSON.stringify({ ...fresh, ...address }),
          }),
        )
      ).json();
      assert.equal(allowed.allowed, true);
      const settled = await h.queue.fetch(
        new Request("https://queue/terminal-finalization/skip", {
          method: "POST",
          body: JSON.stringify({
            ...fresh,
            ...address,
            attempt_id: allowed.attempt_id,
            reason: "missing_status_comment",
          }),
        }),
      );
      assert.equal(settled.status, 200);
      assert.equal((await stateOf(h)).items[key], undefined);
      assert.equal(h.dispatched.length, 2);
    } finally {
      h.restore();
    }
  });
}

for (const interference of ["none", "reason", "deadline", "revision"] as const) {
  test(`failed parked writer retry releases only its ${interference} successor deferral`, async () => {
    let open = false;
    const h = await fixture("marker", () =>
      jsonResponse(open ? { ...closed, state: "open", head: { sha: "b".repeat(40) } } : closed),
    );
    try {
      const tuple = await claimDriver(h);
      const first = await h.queue.fetch(
        new Request("https://queue/terminal-finalization/attempt", {
          method: "POST",
          body: JSON.stringify({ ...tuple, status_marker: marker }),
        }),
      );
      assert.equal(first.status, 200);
      open = true;
      const successor = await stateOf(h);
      successor.items[key].revision += 1;
      successor.items[key].decision.sourceHeadSha = "b".repeat(40);
      successor.items[key].state = "pending";
      successor.items[key].nextAttemptAt = Date.now() - 1;
      await h.storage.put("exact-review-queue", successor);
      await h.queue.alarm();
      const before = await stateOf(h);
      assert.equal(before.items[key].backoffReason, "coordination_retry");
      if (interference === "reason") before.items[key].backoffReason = "throttle_retry";
      if (interference === "deadline") before.items[key].nextAttemptAt += 30_000;
      if (interference === "revision") before.items[key].revision += 1;
      if (interference !== "none") await h.storage.put("exact-review-queue", before);
      const retry = await h.queue.fetch(
        new Request("https://queue/terminal-finalization/retry", {
          method: "POST",
          body: JSON.stringify(tuple),
        }),
      );
      assert.equal(retry.status, 200);
      assert.equal((await retry.json()).requeued, true);
      const after = await stateOf(h);
      assert.equal(after.items[tuple.item_key].state, "pending");
      assert.equal(
        after.items[tuple.item_key].terminalFinalization?.parkedCommand?.coordinationDeferral,
        undefined,
      );
      if (interference === "none") {
        assert.equal(after.items[key].backoffReason, undefined);
        assert.ok(after.items[key].nextAttemptAt <= Date.now());
      } else {
        assert.equal(after.items[key].backoffReason, before.items[key].backoffReason);
        assert.equal(after.items[key].nextAttemptAt, before.items[key].nextAttemptAt);
      }
    } finally {
      h.restore();
    }
  });
}
