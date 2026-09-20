import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runText } from "../../dist/command.js";
import { mockGhBinEnv, withMockGh } from "../../test/helpers.ts";

const root = mkdtempSync(join(tmpdir(), "clawsweeper-fixture-coverage-"));
const coverage = join(root, "coverage");
const gh = join(root, "gh.cjs");
const originalCoverage = process.env.NODE_V8_COVERAGE;
const args = ["api", "space value", "a&b", 'quote"value', "tail\\"];
const fixture = `process.stdout.write(JSON.stringify({
  args: process.argv.slice(2), coverage: process.env.NODE_V8_COVERAGE ?? null
}));\n`;

try {
  mkdirSync(coverage);
  writeFileSync(gh, fixture);
  process.env.NODE_V8_COVERAGE = coverage;
  const expected = { args, coverage: process.platform === "win32" ? coverage : null };
  assert.deepEqual(JSON.parse(runText("gh", args, { env: mockGhBinEnv(gh) })), expected);
  withMockGh(root, fixture, () => {
    assert.deepEqual(JSON.parse(runText("gh", args)), expected);
  });
  assert.equal(process.env.NODE_V8_COVERAGE, coverage);
  const fixtureProfiles = readdirSync(coverage).length;
  if (process.platform !== "win32") assert.equal(fixtureProfiles, 0);

  const moduleUrl = new URL("../../dist/value-coerce.js", import.meta.url).href;
  assert.equal(
    runText(process.execPath, [
      "--input-type=module",
      "-e",
      `import { isRecord } from ${JSON.stringify(moduleUrl)}; console.log(isRecord({}));`,
    ]),
    "true",
  );
  const profiles = readdirSync(coverage).map((file) =>
    JSON.parse(readFileSync(join(coverage, file), "utf8")),
  );
  assert.ok(profiles.some(({ result }) => result.some(({ url }) => url === moduleUrl)));

  let interrupted = 0;
  const attempts = process.argv.includes("--stress") ? 100 : 0;
  if (attempts && process.platform !== "win32") {
    writeFileSync(
      gh,
      `${Array.from({ length: 5_000 }, (_, i) => `function fixture${i}() { return ${i}; }`).join("\n")}\nsetTimeout(() => {}, 200);\n`,
    );
    for (let i = 0; i < attempts; i++) {
      try {
        runText("gh", [], { env: mockGhBinEnv(gh), timeoutMs: 65 + (i % 80) });
      } catch (error) {
        assert.equal(error.code, "ETIMEDOUT");
        interrupted++;
      }
    }
    assert.equal(interrupted, attempts);
    assert.equal(readdirSync(coverage).length, profiles.length);
  }
  console.log(
    JSON.stringify({
      runtime: process.version,
      platform: process.platform,
      fixtureProfiles,
      productionChildCovered: true,
      attempts,
      interrupted,
      result: "passed",
      limits: "Shared GitHub CLI stand-ins on POSIX only; other fixture launchers are unchanged.",
    }),
  );
} finally {
  if (originalCoverage === undefined) delete process.env.NODE_V8_COVERAGE;
  else process.env.NODE_V8_COVERAGE = originalCoverage;
  rmSync(root, { recursive: true, force: true });
}
