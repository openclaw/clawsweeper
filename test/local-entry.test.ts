import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../dist/clawsweeper-local.js", import.meta.url));
const composition = new URL("../dist/clawsweeper-local-composition.js", import.meta.url).href;
const importGuard = new URL("./local-entry-import-guard.mjs", import.meta.url);

function withImportGuard(run: (preload: string, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "local-entry-"));
  const preload = join(root, "guard.mjs");
  writeFileSync(preload, readFileSync(importGuard, "utf8"));
  try {
    run(preload, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("local help and version exit before loading review composition", () => {
  withImportGuard((preload, root) => {
    writeFileSync(
      preload,
      readFileSync(preload, "utf8") +
        `
registerHooks({ resolve(specifier, context, nextResolve) {
  if (/clawsweeper-local-composition|codex-process|agent-runner/.test(specifier)) {
    throw new Error("Review engine loaded for help/version");
  }
  return nextResolve(specifier, context);
} });
`,
    );
    for (const flag of ["--help", "--version"]) {
      const result = spawnSync(process.execPath, ["--import", preload, cli, flag], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, flag === "--help" ? /Local ClawSweeper/ : /^\d+\.\d+\.\d+/);
    }
  });
});

test("local composition imports without hosted factories or repair command runner", () => {
  withImportGuard((preload) => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        preload,
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(composition)}); console.log("local composition loaded");`,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /local composition loaded/);
  });
});

test("invalid local command and unavailable diagnostics fail before composition", () => {
  withImportGuard((preload) => {
    writeFileSync(
      preload,
      readFileSync(preload, "utf8") +
        `
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.includes("clawsweeper-local-composition")) throw new Error("Unexpected composition load");
  return nextResolve(specifier, context);
} });
`,
    );
    for (const args of [["apply-decisions"], ["--diagnostics"]]) {
      const result = spawnSync(process.execPath, ["--import", preload, cli, ...args], {
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Use --help for usage/);
      assert.doesNotMatch(result.stderr, /Unexpected composition load|Hosted module/);
    }
  });
});
