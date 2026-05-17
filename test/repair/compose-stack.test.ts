import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  detectComposeFile,
  setupComposeStack,
  teardownComposeStack,
} from "../../dist/repair/compose-stack.js";

function makeCheckout(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-compose-"));
}

test("detectComposeFile returns null when no docker-compose.test.yml exists", () => {
  const checkout = makeCheckout();
  try {
    assert.equal(detectComposeFile(checkout), null);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test("detectComposeFile returns absolute path when the file exists at the checkout root", () => {
  const checkout = makeCheckout();
  try {
    const composeFile = path.join(checkout, "docker-compose.test.yml");
    fs.writeFileSync(composeFile, "services: {}\n", "utf8");
    const detected = detectComposeFile(checkout);
    assert.equal(detected, composeFile);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test("detectComposeFile ignores nested compose files (root-level only)", () => {
  const checkout = makeCheckout();
  try {
    const nestedDir = path.join(checkout, "apps", "service");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, "docker-compose.test.yml"), "services: {}\n", "utf8");
    assert.equal(detectComposeFile(checkout), null);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test("setupComposeStack returns null without shelling out when no compose file exists", () => {
  // This is the legacy path: repos without a declared test stack go through
  // the lane unchanged. Verified indirectly — if setup tried to invoke docker
  // it would either succeed (no-op against nonexistent file) or fail; we
  // assert the null short-circuit instead.
  const checkout = makeCheckout();
  try {
    assert.equal(setupComposeStack(checkout), null);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test("teardownComposeStack is a no-op when given null context", () => {
  // Must not throw, must not crash. The verify-reproduction finally block
  // relies on this when the lane never set up a stack (legacy repos).
  assert.doesNotThrow(() => teardownComposeStack(null));
});
