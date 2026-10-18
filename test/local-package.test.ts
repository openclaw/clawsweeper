import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { collectLocalModules, stageLocalPackage } from "../scripts/stage-local-package.mjs";

function fixture(t: test.TestContext, source: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "local-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(source)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), contents);
  }
  return root;
}

test("local graph follows static, re-export and escaped literal dynamic imports", async (t) => {
  const root = fixture(t, {
    "dist/main.js": `import "node:fs"; export * from "./one.js"; export { value } from "./two.js";
      await import("./thr\\u0065e.js"); console.log(import.meta.url);`,
    "dist/one.js": 'import "fs";',
    "dist/two.js": "export const value = 1;",
    "dist/three.js": 'import "@scope/runtime/subpath";',
  });
  const result = await collectLocalModules(root, ["dist/main.js"]);
  assert.deepEqual([...result.files.keys()].sort(), [
    "dist/main.js",
    "dist/one.js",
    "dist/three.js",
    "dist/two.js",
  ]);
  assert.deepEqual([...result.packages], ["@scope/runtime"]);
});

for (const [name, source] of Object.entries({
  computed: "await import(name);",
  glob: "await import(`./${name}.js`);",
  phase: 'import source item from "./one.js";',
  invalid: 'import "unterminated',
  outside: 'import "../outside.js";',
  missing: 'import "./missing.js";',
  url: 'import "https://example.com/runtime.js";',
  hosted: 'import "./clawsweeper-runtime.js";',
})) {
  test(`local graph refuses ${name} before staging`, async (t) => {
    const root = fixture(t, {
      "dist/main.js": source,
      "outside.js": "",
      "dist/clawsweeper-runtime.js": "",
    });
    await assert.rejects(collectLocalModules(root, ["dist/main.js"]));
  });
}

test("local graph refuses symlink files and symlink directories", async (t) => {
  const root = fixture(t, { "dist/main.js": 'import "./linked.js";', "outside.js": "" });
  symlinkSync(join(root, "outside.js"), join(root, "dist/linked.js"));
  await assert.rejects(collectLocalModules(root, ["dist/main.js"]), /without symlinks/);
  symlinkSync(join(root, "dist"), join(root, "alias"), "dir");
  await assert.rejects(collectLocalModules(root, ["alias/main.js"]), /without symlinks/);
});

test("staging rejects undeclared runtime dependencies without creating output", async (t) => {
  const root = fixture(t, {
    "package.json": '{"name":"@example/local","version":"1.0.0"}',
    "dist/clawsweeper-local.js": 'import "undeclared-runtime";',
    "dist/codex-process-worker.js": "",
    "dist/openclaw-process-worker.js": "",
    "dist/git-acquisition-worker.js": "",
    "scripts/setup-review-tools.mjs": "",
  });
  const destination = join(root, "stage");
  await assert.rejects(stageLocalPackage(destination, root), /not declared for production/);
  assert.equal(existsSync(destination), false);
});

test("staging validates assets before output and never replaces an existing destination", async (t) => {
  const files = Object.fromEntries(
    [
      "dist/clawsweeper-local.js",
      "dist/codex-process-worker.js",
      "dist/openclaw-process-worker.js",
      "dist/git-acquisition-worker.js",
      "scripts/setup-review-tools.mjs",
      "prompts/review-item.md",
      "prompts/review-item-issue.md",
      "prompts/review-item-pr.md",
      "prompts/review-close-reasons.md",
      "schema/clawsweeper-decision.schema.json",
      "config/automation-limits.json",
      "config/target-repositories.json",
      "LICENSE",
    ].map((name) => [name, ""]),
  );
  const root = fixture(t, {
    ...files,
    "package.json": '{"name":"@example/local","version":"1.0.0"}',
  });
  const destination = join(root, "stage");
  await assert.rejects(stageLocalPackage(destination, root), /ENOENT/);
  assert.equal(existsSync(destination), false);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/local-package.md"), "README");
  mkdirSync(destination);
  writeFileSync(join(destination, "sentinel"), "preserved");
  await assert.rejects(stageLocalPackage(destination, root), /EEXIST/);
  assert.equal(readFileSync(join(destination, "sentinel"), "utf8"), "preserved");
});
