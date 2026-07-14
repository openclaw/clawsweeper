import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTrustedSandboxRoot } from "../../dist/repair/contained-command-sandbox.js";

test("sandbox root selection continues after an unwritable candidate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-sandbox-candidates-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const writable = path.join(root, "writable");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  fs.mkdirSync(writable);
  let attempts = 0;
  try {
    const sandboxRoot = createTrustedSandboxRoot([writable], {
      candidates: [first, second],
      makeTemporaryDirectory: (prefix) => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("candidate is read-only"), { code: "EROFS" });
        }
        return fs.mkdtempSync(prefix);
      },
    });

    assert.equal(attempts, 2);
    assert.equal(path.dirname(sandboxRoot), fs.realpathSync(second));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sandbox root selection surfaces unexpected candidate errors", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-sandbox-error-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const writable = path.join(root, "writable");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  fs.mkdirSync(writable);
  const failure = Object.assign(new Error("unexpected I/O failure"), { code: "EIO" });
  let attempts = 0;
  try {
    assert.throws(
      () =>
        createTrustedSandboxRoot([writable], {
          candidates: [first, second],
          makeTemporaryDirectory: () => {
            attempts += 1;
            throw failure;
          },
        }),
      (error) => error === failure,
    );
    assert.equal(attempts, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
