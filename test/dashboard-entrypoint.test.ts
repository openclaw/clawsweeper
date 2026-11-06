import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the configured dashboard entry exposes only its handler and bound Durable Objects", async () => {
  const config = readFileSync(new URL("../dashboard/wrangler.toml", import.meta.url), "utf8");
  const main = /^main = "([^"]+)"$/m.exec(config)?.[1];
  assert.ok(main, "dashboard configuration must select an entry point");
  const entry = await import(new URL(`../dashboard/${main}`, import.meta.url).href);
  const classes = [...config.matchAll(/^class_name = "([^"]+)"$/gm)].map((match) => match[1]);
  assert.deepEqual(Object.keys(entry).sort(), ["default", ...classes].sort());
  assert.equal(typeof entry.default.fetch, "function");
  assert.equal(typeof entry.default.scheduled, "function");
  for (const name of classes) assert.equal(typeof entry[name], "function");
});
