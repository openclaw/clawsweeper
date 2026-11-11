import assert from "node:assert/strict";
import test from "node:test";
import { censusFixture } from "./fixtures/review-coverage-census.ts";
import { censusPage } from "../src/review-coverage-census.ts";
import {
  runReviewCoverageCensus,
  censusQuery,
  censusQueryPages,
  prepareCensusObservation,
} from "../dist/repair/review-coverage-census.js";

function prepared(f, attempt = "clock-test") {
  const reply = f.store.prepare({ version: 2, attempt }, f.time);
  return { attempt, observationWindow: reply.observationWindow };
}
async function start(f, observation) {
  return f.store.start(
    {
      version: 2,
      ...observation,
      observedAt: observation.observationWindow.startedAt,
      repositories: f
        .population()
        .map((r) => ({ ...r, countsAt: observation.observationWindow.startedAt })),
    },
    f.time,
  );
}
function assigned(f, observation) {
  const work = f.store.next({ version: 2, attempt: observation.attempt }, f.time).work;
  return censusQueryPages(
    f.query(censusQuery(work)),
    work,
    new Date(f.time - 60_000).toISOString(),
  );
}
function accept(f, observation, pages, requestId = "clock-page") {
  return f.store.accept({ version: 2, attempt: observation.attempt, requestId, pages }, f.time);
}

test("independent producer clock cannot reject prepared fresh queries through both witnesses", async () => {
  for (const offset of [-120_000, -250, 250, 120_000]) {
    const f = censusFixture([{ name: "clock", issues: 3, pulls: 1 }]);
    const observation = prepared(f);
    f.restart(50); // metadata source read follows preparation on the server timeline
    const result = await runReviewCoverageCensus({
      observation,
      repositories: f.population(),
      control: f.control,
      now: () => f.time + offset,
      query: (text) => {
        f.restart(50);
        return f.query(text);
      },
    });
    assert.equal(result.failed, 0);
    assert.ok(f.states()[0].state.complete);
    assert.ok(Date.parse(f.states()[0].state.complete.end) <= f.time);
  }
});

test("windows are stored authority, not caller timestamps; malformed/future/replay/CAS stay closed", async () => {
  const f = censusFixture([{ name: "clock", issues: 1, pulls: 0 }]);
  const observation = prepared(f);
  await start(f, observation);
  const pages = assigned(f, observation);
  assert.equal(pages[0].observedAt, null);
  for (const transform of [
    (p) => {
      p.observationWindow.id = "forged";
    },
    (p) => {
      p.observationWindow.startedAt = new Date(f.time + 1).toISOString();
    },
    (p) => {
      p.observationWindow.startedAt = new Date(f.time - 1).toISOString();
    },
    (p) => {
      delete p.observationWindow;
      p.observedAt = new Date(f.time).toISOString();
    },
    (p) => {
      p.revisionNumber++;
    },
    (p) => {
      p.pass++;
    },
    (p) => {
      p.generation = "old-generation";
    },
    (p) => {
      p.cursor = "old-cursor";
    },
    (p) => {
      p.items[0].updated_at = new Date(f.time + 1).toISOString();
    },
    (p) => {
      p.items[0].reopened_at = new Date(f.time + 1).toISOString();
    },
  ]) {
    const changed = structuredClone(pages);
    transform(changed[0]);
    await assert.rejects(accept(f, observation, changed));
  }
  assert.throws(
    () => censusPage({ ...pages[0], observedAt: new Date(f.time).toISOString() }),
    /invalid census observation clock/,
  );
  const receipt = await accept(f, observation, pages);
  assert.equal(receipt.accepted, true);
  assert.equal((await accept(f, observation, pages)).replayed, true);
  await assert.rejects(accept(f, observation, pages, "different-replay"));
});

test("metadata preparation precedes source read and rejects tamper, downgrade, old lease/assignment", async () => {
  const f = censusFixture([{ name: "clock", issues: 1, pulls: 0 }]);
  const first = prepared(f);
  await start(f, first);
  const oldPages = assigned(f, first);
  await assert.rejects(
    f.store.start(
      {
        version: 2,
        attempt: first.attempt,
        repositories: f.population(),
        observedAt: new Date(f.time).toISOString(),
      },
      f.time,
    ),
    /invalid census observation time/,
  );
  await assert.rejects(
    start(f, { ...first, observationWindow: { ...first.observationWindow, id: "forged" } }),
    /invalid census observation time/,
  );
  f.restart();
  const next = prepared(f, "next-epoch");
  await start(f, next);
  await assert.rejects(accept(f, first, oldPages), /lease conflict/);
  await assert.rejects(accept(f, next, oldPages), /observation window conflict/);
  const pages = assigned(f, next);
  assert.notDeepEqual(pages[0].observationWindow, oldPages[0].observationWindow);
  await accept(f, next, pages);
});

test("only explicit old-Worker 404 negotiates legacy, never lease/auth/checkpoint errors", async () => {
  for (const status of [404, 401, 409, 500]) {
    const call = prepareCensusObservation({
      baseUrl: "https://synthetic.invalid",
      secret: "synthetic",
      fetchImpl: async () => Response.json({ error: "coverage_checkpoint_rejected" }, { status }),
    });
    if (status === 404) assert.equal(await call, null);
    else await assert.rejects(call);
  }
});

test("persisted legacy v2 partial checkpoints cannot downgrade a newly negotiated lease", async () => {
  const f = censusFixture([{ name: "clock", issues: 101, pulls: 1 }]);
  const attempt = "deployed-legacy";
  await f.store.start(
    {
      version: 2,
      attempt,
      repositories: f.population(),
      observedAt: new Date(f.time).toISOString(),
    },
    f.time,
  );
  const first = f.store.next({ version: 2, attempt }, f.time).work;
  const firstPages = censusQueryPages(
    f.query(censusQuery(first)),
    first,
    new Date(f.time).toISOString(),
  );
  await f.store.accept(
    { version: 2, attempt, requestId: "legacy-page", pages: firstPages },
    f.time,
  );
  const inFlight = f.store.next({ version: 2, attempt }, f.time).work;
  const oldPages = censusQueryPages(
    f.query(censusQuery(inFlight)),
    inFlight,
    new Date(f.time).toISOString(),
  );
  assert.equal(f.states()[0].state.active.connections.issue.cursor, "c100");
  const generation = f.states()[0].state.active.id;
  f.restart();
  const observation = prepared(f, "upgraded-producer");
  await start(f, observation);
  assert.equal(f.states()[0].state.active.id, generation);
  assert.equal(f.states()[0].state.active.connections.issue.cursor, "c100");
  await assert.rejects(
    accept(f, observation, oldPages, "cross-mode-page"),
    /observation window conflict/,
  );
  const result = await runReviewCoverageCensus({
    observation,
    repositories: f.population(),
    control: f.control,
    query: f.query,
    now: () => f.time - 500,
  });
  assert.equal(result.failed, 0);
  assert.ok(f.states()[0].state.complete);
  assert.equal(f.states()[0].state.complete.issues, 101);
  assert.equal(f.states()[0].state.complete.pulls, 1);
});
