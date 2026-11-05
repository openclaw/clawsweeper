import assert from "node:assert/strict";
import test from "node:test";
import {
  fleetCoverageSelections,
  fleetCoverageResponse,
} from "../fixtures/fleet-coverage-query.ts";
import { publicDashboardInputs } from "../../dashboard-site/scripts/coverage.ts";
import { coverageCliFixture } from "../fixtures/review-coverage-cli.ts";

const query = (fields: string) =>
  'query FleetCoverage { r0:repository(owner:"openclaw",name:"core"){' +
  fields +
  '} r1:repository(owner:"openclaw",name:"zero"){' +
  fields +
  "} }";
test("count provider returns only selected root fields for every alias", () => {
  const old = query("issues(states:OPEN){totalCount} pullRequests(states:OPEN){totalCount}");
  const now = query("id issues(states:OPEN){totalCount} pullRequests(states:OPEN){totalCount}");
  const lookup = (_owner: string, name: string) => ({
    id: "selected-" + name,
    issues: name === "zero" ? 0 : 3,
    pulls: 0,
  });
  assert.deepEqual(Object.keys(fleetCoverageResponse(old, lookup).data.r0), [
    "issues",
    "pullRequests",
  ]);
  assert.equal("id" in fleetCoverageResponse(old, lookup).data.r1, false);
  const response = fleetCoverageResponse(now, lookup);
  assert.equal(response.data.r0.id, "selected-core");
  assert.equal(response.data.r1.id, "selected-zero");
  assert.deepEqual(response.data.r1.issues, { totalCount: 0 });
  assert.equal(fleetCoverageSelections(now).length, 2);
  assert.throws(
    () =>
      fleetCoverageSelections(
        query("issues(states:OPEN){id totalCount} pullRequests(states:OPEN){totalCount}"),
      ),
    /selection/,
  );
});

for (const mode of ["coverage", "normal-review", "hot-intake", "audit"])
  test(mode + " selects the repository identity used by signed census/start", async () => {
    const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }]);
    try {
      await f.run(mode);
      assert.ok(f.countExchanges.length);
      for (const x of f.countExchanges) {
        assert.ok(
          x.selections.every((s) => s.fields.includes("id")),
          JSON.stringify(x),
        );
        const response = x.response as {
          data: Record<string, { id: string; issues: unknown; pullRequests: unknown }>;
        };
        for (const value of Object.values(response.data)) {
          assert.deepEqual(Object.keys(value).sort(), ["id", "issues", "pullRequests"]);
          assert.ok(value.id);
        }
      }
      const start = f.calls.find((c) => c.path.endsWith("/census/start"));
      assert.ok(start, "actual signed start must be reached");
      const body = start.body as { repositories: { id: string }[] };
      assert.equal(
        body.repositories[0]!.id,
        (f.countExchanges[0]!.response as { data: { r0: { id: string } } }).data.r0.id,
      );
      assert.equal(f.inventory()!.repositories.length, 1);
      assert.equal(
        f.inventory()!.repositories[0]!.complete,
        true,
        "selected count identity must agree with actual inventory provider identity",
      );
    } finally {
      f.close();
    }
  });

test("empty fleet and selected zero-open repository do not fabricate counts or identities", async () => {
  const empty = await coverageCliFixture([]);
  try {
    await empty.run("coverage");
    assert.equal(empty.countExchanges.length, 0);
  } finally {
    empty.close();
  }
  const zero = await coverageCliFixture([{ name: "zero", issues: 0, pulls: 0 }]);
  try {
    await zero.run("coverage");
    assert.equal(
      (
        zero.countExchanges[0]!.response as {
          data: { r0: { id: string; issues: { totalCount: number } } };
        }
      ).data.r0.issues.totalCount,
      0,
    );
    assert.ok(zero.calls.some((c) => c.path.endsWith("/census/start")));
  } finally {
    zero.close();
  }
});

for (const bad of [undefined, null, 0, ""])
  test("requested missing/null/malformed identity fails closed: " + String(bad), async () => {
    const f = await coverageCliFixture([{ name: "core", issues: 1, pulls: 0 }]);
    try {
      f.setRepositoryId("core", bad);
      await assert.rejects(f.run("coverage"), /identity\/counts unavailable/);
      assert.ok(!f.calls.some((c) => c.path.endsWith("/census/start")));
    } finally {
      f.close();
    }
  });
test("private/unavailable count repository cannot reuse a previous identity", async () => {
  const f = await coverageCliFixture([{ name: "core", issues: 1, pulls: 0 }]);
  try {
    await f.run("coverage");
    f.advance(20 * 60_000);
    f.hideCountRepository("core");
    const before = f.calls.length;
    await assert.rejects(f.run("coverage"), /openclaw\/core counts must be an object/);
    assert.ok(!f.calls.slice(before).some((c) => c.path.endsWith("/census/start")));
  } finally {
    f.close();
  }
});

for (const [name, reply] of [
  ["private", { private: true, visibility: "private" }],
  ["renamed", { full_name: "openclaw/renamed" }],
  ["unavailable", null],
] as const)
  test(
    "current " + name + " metadata cannot expose previously completed source identities",
    async () => {
      const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }]);
      try {
        await f.run("coverage");
        assert.equal(f.inventory()!.repositories[0]!.complete, true);
        f.setMetadataReply("openclaw/core", reply);
        const candidates = await f.read();
        const build = await publicDashboardInputs(f.authority.cache, candidates, (path: string) =>
          globalThis.fetch(new URL(path, "https://api.github.com/")),
        );
        assert.ok(!JSON.stringify(build).includes("openclaw/core"));
      } finally {
        f.close();
      }
    },
  );
