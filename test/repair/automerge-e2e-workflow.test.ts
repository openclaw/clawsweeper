import assert from "node:assert/strict";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import { readText } from "../helpers.ts";

type Step = { uses?: string; run?: string; with?: Record<string, string> };
type Workflow = {
  permissions?: unknown;
  jobs: Record<string, { if?: string; env?: Record<string, string>; steps?: Step[] }>;
};

// E2E workflows run repository code on shared runners and must never hold write tokens or secrets.
test("E2E workflows are read-only and skip fork pull requests", () => {
  for (const name of ["automerge-e2e.yml", "repair-containment-smoke.yml"]) {
    const document = parseYaml(readText(`.github/workflows/${name}`)) as Workflow;
    assert.deepEqual(document.permissions, { contents: "read" }, name);
    for (const job of Object.values(document.jobs)) {
      assert.match(
        job.if ?? "",
        /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
      );
      const checkout = job.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
      assert.equal(checkout?.with?.["persist-credentials"], false, name);
    }
    assert.doesNotMatch(readText(`.github/workflows/${name}`), /secrets\.|GH_TOKEN|app-token/);
  }
});

// The automerge E2E image must come from repository source, not from a registry or a stale cache.
test("automerge E2E builds its base image from the repository Dockerfile", () => {
  const document = parseYaml(readText(".github/workflows/automerge-e2e.yml")) as Workflow;
  const job = document.jobs["automerge-e2e"]!;
  assert.doesNotMatch(job.env?.AUTOMERGE_E2E_BASE_IMAGE ?? "", /\//);
  const cache = job.steps?.find((step) => step.uses?.startsWith("actions/cache@"));
  assert.match(String(cache?.with?.key), /hashFiles\('test\/e2e\/automerge\/Dockerfile\.base'\)/);
  const runs = (job.steps ?? []).map((step) => step.run ?? "").join("\n");
  assert.match(runs, /docker build \\\n\s+--file test\/e2e\/automerge\/Dockerfile\.base/);
  assert.doesNotMatch(runs, /docker pull/);
});
