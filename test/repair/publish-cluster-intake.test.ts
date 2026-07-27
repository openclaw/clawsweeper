import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { clusterIntakeIntent } from "../../dist/repair/cluster-intake-state.js";
import { publishClusterIntake } from "../../dist/repair/publish-cluster-intake.js";

test("cluster intake publication exposes a repeated durable delivery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-publish-"));
  const intentPath = path.join(root, "intent.json");
  fs.writeFileSync(
    intentPath,
    JSON.stringify({
      schema: "clawsweeper-cluster-intake-intent-v1",
      target_repo: "openclaw/openclaw",
      repo_slug: "openclaw-openclaw",
      store_sha256: "a".repeat(64),
      store_exported_at: "2026-07-26T12:00:00.000Z",
      manifest_path: "artifacts/gitcrawl-clusters.json",
      run_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
      accepted_at: "2026-07-26T12:01:00.000Z",
      runner: "codex",
      execution_runner: "ubuntu-latest",
      model: "internal",
      selector_summary: { evaluated: 1, rejected: 1, reason_counts: { stale: 1 } },
      jobs: [],
    }),
  );
  let requests = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    requests += 1;
    const body = JSON.parse(String(init?.body)) as {
      delivery_id: string;
      records: Array<{ payload: unknown }>;
    };
    assert.equal(body.delivery_id, `cluster-intake:openclaw-openclaw:${"a".repeat(64)}`);
    const accepted = clusterIntakeIntent(body.records[0].payload);
    assert.deepEqual(accepted.jobs, []);
    return Response.json(requests === 1 ? { ok: true, appended: 1 } : { ok: true, deduped: true }, {
      status: 202,
    });
  }) as typeof fetch;

  try {
    const options = {
      env: {
        QUEUE_URL: "https://queue.test",
        CLAWSWEEPER_WEBHOOK_SECRET: "publish-cluster-test-secret",
      },
      fetchImpl,
    };
    assert.deepEqual(await publishClusterIntake(intentPath, options), { deduped: false });
    assert.deepEqual(await publishClusterIntake(intentPath, options), { deduped: true });
    assert.equal(requests, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
