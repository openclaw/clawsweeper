import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findFilesByBasenameSync } from "../../dist/repair/glob-files.js";

test("glob file discovery preserves recursive readdir ordering and symlink traversal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-glob-files-"));
  try {
    const nested = path.join(root, "nested");
    fs.mkdirSync(path.join(nested, "deeper"), { recursive: true });
    fs.writeFileSync(path.join(root, "result.json"), "root");
    fs.writeFileSync(path.join(nested, "result.json"), "nested");
    fs.writeFileSync(path.join(nested, "deeper", "result.json"), "deeper");
    fs.mkdirSync(path.join(root, "linked-file"));
    fs.symlinkSync(path.join(root, "result.json"), path.join(root, "linked-file", "result.json"));
    fs.symlinkSync(nested, path.join(root, "linked-directory"));
    fs.mkdirSync(path.join(root, ".hidden", ".deeper"), { recursive: true });
    fs.writeFileSync(path.join(root, ".hidden", "result.json"), "hidden");
    fs.writeFileSync(path.join(root, ".hidden", ".deeper", "result.json"), "deeper hidden");

    assert.deepEqual(
      findFilesByBasenameSync(root, "result.json").map((file) => path.relative(root, file)),
      [
        "result.json",
        ".hidden/result.json",
        "linked-directory/result.json",
        "linked-file/result.json",
        "nested/result.json",
        ".hidden/.deeper/result.json",
        "linked-directory/deeper/result.json",
        "nested/deeper/result.json",
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
