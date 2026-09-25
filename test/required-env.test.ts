import assert from "node:assert/strict";
import test from "node:test";
import { requiredEnv, requiredRawEnv } from "../dist/required-env.js";

test("required environment readers preserve trimmed and raw value contracts", () => {
  for (const value of [undefined, "", " \t\n", "value", " padded \t\n", "0"]) {
    const env = { VALUE: value };
    for (const [read, expected] of [
      [requiredEnv, value?.trim()],
      [requiredRawEnv, value],
    ] as const) {
      if (expected) assert.equal(read("VALUE", env), expected);
      else assert.throws(() => read("VALUE", env), { message: "VALUE is required" });
    }
  }
});

test("required environment readers resolve the default environment at call time", () => {
  const name = "CLAWSWEEPER_REQUIRED_ENV_TEST";
  const previous = process.env[name];
  try {
    process.env[name] = " first ";
    assert.equal(requiredEnv(name), "first");
    assert.equal(requiredRawEnv(name), " first ");
    process.env[name] = " second ";
    assert.equal(requiredEnv(name), "second");
    assert.equal(requiredRawEnv(name), " second ");
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});
