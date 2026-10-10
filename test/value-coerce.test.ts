import assert from "node:assert/strict";
import test from "node:test";

import { asRecord, login } from "../dist/value-coerce.js";

test("asRecord keeps plain objects and turns arrays and scalars into an empty record", () => {
  const record = { login: "octocat" };
  assert.equal(asRecord(record), record);
  for (const value of [[{ login: "octocat" }], null, undefined, "octocat", 1]) {
    assert.deepEqual(asRecord(value), {});
  }
  assert.deepEqual(Object.keys(asRecord(["a", "b"])), []);
});

test("login reads only a string login field", () => {
  assert.equal(login({ login: "octocat" }), "octocat");
  assert.equal(login({ login: 1 }), undefined);
  assert.equal(login([{ login: "octocat" }]), undefined);
  assert.equal(login(null), undefined);
});
