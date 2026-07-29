import assert from "node:assert/strict";
import test from "node:test";

import { runStateRepoSizeCheck } from "../../dist/repair/state-repo-size.js";

const stateToken = "test-token-state";

test("repository size check logs GB and warns only above the configured threshold", async (t) => {
  const logged: string[] = [];
  const warned: string[] = [];
  t.mock.method(console, "log", (...parts: unknown[]) => logged.push(parts.join(" ")));
  t.mock.method(console, "warn", (...parts: unknown[]) => warned.push(parts.join(" ")));
  const result = await runStateRepoSizeCheck({
    env: {
      CLAWSWEEPER_STATE_REPO_TOKEN: stateToken,
      GITHUB_API_URL: "https://api.github.test",
      STATE_REPO_SIZE_WARN_GB: "5",
    },
    fetchImpl: (async () => Response.json({ size: 6 * 1024 * 1024 })) as typeof fetch,
  });

  assert.equal(result.errors, 0);
  assert.equal(result.size?.aboveThreshold, true);
  assert.ok(logged.includes("state-repo size: 6.00GB"));
  assert.ok(warned.includes("::warning::state-repo size: 6.00GB exceeds 5GB threshold"));
});

test("repository size check fails open when its credential is unavailable", async () => {
  assert.deepEqual(await runStateRepoSizeCheck({ env: {} }), {
    size: null,
    errors: 1,
  });
});
