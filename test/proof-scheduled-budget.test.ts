import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("scripts/proof-scheduled-budget.mjs");

test("scheduled budget proof refuses existing output without removing operator files", () => {
  for (const kind of ["directory", "working-directory", "parent", "file", "symlink"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-budget-output-"));
    try {
      const tools = path.join(root, "tools");
      // Let the old CLI reach its output handling without installing a runtime.
      for (const name of ["miniflare", "esbuild"]) {
        const module = path.join(tools, "node_modules", name);
        fs.mkdirSync(module, { recursive: true });
        fs.writeFileSync(path.join(module, "index.js"), "module.exports = {};\n");
      }
      const protectedDir = path.join(root, "protected");
      fs.mkdirSync(protectedDir);
      const marker = path.join(protectedDir, "keep.txt");
      fs.writeFileSync(marker, "operator data\n");
      let output = protectedDir;
      let cwd = root;
      if (kind === "working-directory") {
        cwd = protectedDir;
        output = ".";
      } else if (kind === "parent") {
        cwd = path.join(protectedDir, "child");
        fs.mkdirSync(cwd);
        output = "..";
      } else if (kind === "file") {
        output = marker;
      } else if (kind === "symlink") {
        output = path.join(root, "output-link");
        fs.symlinkSync(protectedDir, output, process.platform === "win32" ? "junction" : "dir");
      }
      const result = spawnSync(process.execPath, [script, "missing-proof-base", tools, output], {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.notEqual(result.status, 0, kind);
      assert.equal(fs.readFileSync(marker, "utf8"), "operator data\n", kind);
      if (kind === "symlink") assert.ok(fs.lstatSync(output).isSymbolicLink());
      assert.match(result.stderr, /EEXIST/, "refuse the output before starting the proof");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
