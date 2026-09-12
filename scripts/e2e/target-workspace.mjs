import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const baseline = resolve(process.argv[2]);
const scratch = mkdtempSync(join(tmpdir(), "target-workspace-proof-"));
const fixture = join(scratch, "fixture");
const results = [];
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value));
try {
  mkdirSync(fixture);
  writeJson(join(fixture, "package.json"), {
    name: "fixture-root",
    private: true,
    packageManager: JSON.parse(readFileSync("package.json", "utf8")).packageManager,
  });
  writeFileSync(
    join(fixture, "pnpm-workspace.yaml"),
    "packages:\n  - 'packages/*'\n  - '!packages/excluded'\n",
  );
  for (const name of ["app", "lib", "excluded"]) {
    const directory = join(fixture, "packages", name);
    mkdirSync(directory, { recursive: true });
    writeJson(join(directory, "package.json"), {
      name: `@fixture/${name}`,
      scripts: { verify: "node verify.mjs" },
    });
    writeFileSync(
      join(directory, "verify.mjs"),
      "import {writeFileSync} from 'node:fs';writeFileSync('selected.txt', '" + name + "');\n",
    );
  }
  const outside = join(scratch, "outside");
  mkdirSync(outside);
  writeJson(join(outside, "package.json"), { name: "@fixture/outside" });
  symlinkSync(outside, join(fixture, "packages", "linked"), "dir");
  execFileSync("pnpm", ["install", "--offline", "--ignore-scripts"], {
    cwd: fixture,
    stdio: "pipe",
  });
  const hidden = join(fixture, "node_modules", "hidden");
  mkdirSync(hidden, { recursive: true });
  writeJson(join(hidden, "package.json"), { name: "@fixture/hidden" });
  const transcript = execFileSync("pnpm", ["--filter", "@fixture/app", "run", "verify"], {
    cwd: fixture,
    encoding: "utf8",
  });
  assert.equal(readFileSync(join(fixture, "packages/app/selected.txt"), "utf8"), "app");

  for (const root of [baseline, process.cwd()]) {
    const api = await import(pathToFileURL(join(root, "dist/repair/target-validation.js")));
    const paths = api.workspacePackagePaths(fixture, ["packages/*", "!packages/excluded"]);
    assert.deepEqual(paths, ["packages/app", "packages/lib"]);
    const manifests = paths.map((relativeDir) => {
      const pkg = JSON.parse(readFileSync(join(fixture, relativeDir, "package.json"), "utf8"));
      return {
        name: pkg.name,
        relativeDir,
        scriptCommands: new Map(Object.entries(pkg.scripts)),
        scripts: new Set(Object.keys(pkg.scripts)),
      };
    });
    const selections = [
      "@fixture/app",
      "./packages/lib",
      "@fixture/*",
      "@fixture/*{packages/app}",
    ].map((selector) => ({
      selector,
      names: api
        .selectWorkspacePackageManifests(manifests, [selector], false)
        .map((item) => item.name),
    }));
    assert.deepEqual(selections[0].names, ["@fixture/app"]);
    assert.deepEqual(selections[1].names, ["@fixture/lib"]);
    assert.deepEqual(selections[2].names, ["@fixture/app", "@fixture/lib"]);
    assert.deepEqual(selections[3].names, ["@fixture/app"]);
    assert.equal(api.selectWorkspacePackageManifests(manifests, ["...@fixture/app"], false), null);
    assert.throws(
      () => api.workspacePackagePaths(fixture, ["packages/*"], { maxDepth: 1 }),
      /depth budget/,
    );
    results.push({ paths, selections });
  }
  assert.deepEqual(results[0], results[1]);
  console.log(
    JSON.stringify(
      {
        base: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: baseline,
          encoding: "utf8",
        }).trim(),
        head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        source_sha256: createHash("sha256")
          .update(readFileSync("src/repair/target-validation.ts"))
          .update(readFileSync("src/repair/target-workspace.ts"))
          .digest("hex"),
        runtime: process.version,
        package_manager: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
        result: results[1],
        pnpm_selected: "@fixture/app",
        pnpm_script_ran: transcript.includes("node verify.mjs"),
        equivalent: true,
        limits:
          "Actual compiled Node validation APIs, on-disk manifests/symlinks and offline pnpm workspace execution. Does not run target installs against external registries or production repair jobs.",
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
