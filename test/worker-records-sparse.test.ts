import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("record hydration imports from the existing scripts-and-src sparse checkout", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-records-sparse-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  cpSync("src", path.join(root, "src"), { recursive: true });
  for (const script of ["worker-records.ts", "worker-blobs.ts", "hydrate-state.ts"])
    cpSync(path.join("scripts", script), path.join(root, "scripts", script));
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const { hydrateState } = await import('./scripts/hydrate-state.ts'); if (typeof hydrateState !== 'function') process.exit(1);",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});
