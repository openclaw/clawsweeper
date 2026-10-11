import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveResultTargets } from "../../dist/repair/resolve-result-targets.js";

function artifactsWithResults(repos: readonly string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-result-targets-"));
  for (const [index, repo] of repos.entries()) {
    const runDir = path.join(root, `run-${index}`, `cluster-${index}`);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "result.json"),
      `${JSON.stringify({ repo, cluster_id: index })}\n`,
    );
  }
  return root;
}

test("result targets resolve to the validated non-default repository from worker artifacts", () => {
  const resolved = resolveResultTargets({
    artifactsDir: artifactsWithResults(["openclaw", "openclaw"].map((o) => `${o}/gitcrawl`)),
    allowedOwner: "openclaw",
    fallbackRepo: "openclaw/openclaw",
  });
  assert.deepEqual(resolved, { owner: "openclaw", repositories: ["gitcrawl"] });
});

test("result targets dedupe and sort multiple allowed repositories", () => {
  const resolved = resolveResultTargets({
    artifactsDir: artifactsWithResults(["openclaw/zebra", "openclaw/alpha", "openclaw/zebra"]),
    allowedOwner: "openclaw",
    fallbackRepo: "openclaw/openclaw",
  });
  assert.deepEqual(resolved.repositories, ["alpha", "zebra"]);
});

test("result targets fall back to the configured default when artifacts carry no result", () => {
  const resolved = resolveResultTargets({
    artifactsDir: artifactsWithResults([]),
    allowedOwner: "openclaw",
    fallbackRepo: "openclaw/openclaw",
  });
  assert.deepEqual(resolved, { owner: "openclaw", repositories: ["openclaw"] });
});

test("result targets honor the production owner-list contract", () => {
  // CLAWSWEEPER_ALLOWED_OWNER is a comma/whitespace-separated list (issue
  // #604); production sets "openclaw,steipete".
  const resolved = resolveResultTargets({
    artifactsDir: artifactsWithResults(["steipete/vibetunnel"]),
    allowedOwner: "openclaw,steipete",
    fallbackRepo: "openclaw/openclaw",
  });
  assert.deepEqual(resolved, { owner: "steipete", repositories: ["vibetunnel"] });
  const fallback = resolveResultTargets({
    artifactsDir: artifactsWithResults([]),
    allowedOwner: "openclaw, steipete",
    fallbackRepo: "openclaw/openclaw",
  });
  assert.deepEqual(fallback, { owner: "openclaw", repositories: ["openclaw"] });
  assert.throws(
    () =>
      resolveResultTargets({
        artifactsDir: artifactsWithResults(["evil/openclaw"]),
        allowedOwner: "openclaw,steipete",
        fallbackRepo: "openclaw/openclaw",
      }),
    /outside openclaw,steipete/,
  );
});

test("result targets fail closed when results span multiple owners", () => {
  assert.throws(
    () =>
      resolveResultTargets({
        artifactsDir: artifactsWithResults(["openclaw/openclaw", "steipete/vibetunnel"]),
        allowedOwner: "openclaw,steipete",
        fallbackRepo: "openclaw/openclaw",
      }),
    /span multiple owners/,
  );
});

test("result targets fail closed on a repository outside the allowed owner", () => {
  assert.throws(
    () =>
      resolveResultTargets({
        artifactsDir: artifactsWithResults(["evil/openclaw"]),
        allowedOwner: "openclaw",
        fallbackRepo: "openclaw/openclaw",
      }),
    /outside openclaw/,
  );
});

test("result targets fail closed on malformed repository identities", () => {
  assert.throws(
    () =>
      resolveResultTargets({
        artifactsDir: artifactsWithResults(["unknown/unknown/extra"]),
        allowedOwner: "openclaw",
        fallbackRepo: "openclaw/openclaw",
      }),
    /invalid target repository/,
  );
  assert.throws(
    () =>
      resolveResultTargets({
        artifactsDir: artifactsWithResults([]),
        allowedOwner: "openclaw",
        fallbackRepo: "elsewhere/openclaw",
      }),
    /must be owned by openclaw/,
  );
});
