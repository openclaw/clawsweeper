import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tsc = join("node_modules", "typescript", "bin", "tsc");
const packageScripts = (
  JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

test("main and repair builds preserve their action-ledger CLI contracts", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-build-contract-"));
  const mainOutput = join(root, "main");
  const repairOutput = join(root, "repair");

  execFileSync(process.execPath, [tsc, "-p", "tsconfig.json", "--outDir", mainOutput]);
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.repair.json", "--outDir", repairOutput]);

  assert.ok(existsSync(join(mainOutput, "clawsweeper.js")));
  assert.ok(existsSync(join(mainOutput, "repair", "action-event-importer.js")));
  assert.ok(!existsSync(join(mainOutput, "repair", "publish-action-events.js")));
  assert.equal(
    packageScripts["publish-action-events"],
    "node dist/clawsweeper.js publish-action-events",
  );

  assert.ok(!existsSync(join(repairOutput, "clawsweeper.js")));
  assert.ok(existsSync(join(repairOutput, "repair", "publish-action-events.js")));
  assert.ok(existsSync(join(repairOutput, "repair", "publish-action-event-paths.js")));
  assert.equal(
    packageScripts["repair:publish-action-events"],
    "node dist/repair/publish-action-events.js",
  );
});
