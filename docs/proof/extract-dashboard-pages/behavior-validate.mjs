#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const [baseUrl, outputPath] = process.argv.slice(2);
assert(baseUrl && outputPath, "usage: behavior-validate.mjs <base-url> <output-path>");

const cases = [
  { route: "/", title: "<title>🦞 ClawSweeper Live</title>", marker: "/api/status" },
  { route: "/triage", title: "<title>ClawSweeper Triage</title>", marker: "/api/triage" },
  {
    route: "/pr-proof-triage",
    title: "<title>ClawSweeper PR Proof Triage</title>",
    marker: "/api/pr-proof-triage",
  },
];

const checks = [];
const hashes = new Set();
for (const item of cases) {
  const first = await fetch(new URL(item.route, baseUrl), { cache: "no-store" });
  const firstBody = await first.text();
  const second = await fetch(new URL(item.route, baseUrl), { cache: "no-store" });
  const secondBody = await second.text();
  assert.equal(first.status, 200, `${item.route} did not return 200`);
  assert.equal(first.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert(firstBody.includes(item.title), `${item.route} omitted its expected title`);
  assert(firstBody.includes(item.marker), `${item.route} omitted ${item.marker}`);
  assert.equal(second.status, 200, `${item.route} repeat did not return 200`);
  assert.equal(secondBody, firstBody, `${item.route} changed across repeat fetches`);
  const sha256 = createHash("sha256").update(firstBody).digest("hex");
  hashes.add(sha256);
  checks.push({
    contract_clause: `User task ${checks.length + 1}`,
    status: "pass",
    severity: null,
    evidence: `${item.route} returned stable HTTP 200 HTML (${Buffer.byteLength(firstBody)} bytes, sha256 ${sha256}).`,
    reproduction_steps: [`GET ${item.route}`, `GET ${item.route} again`, "Compare response bytes"],
    confidence: 1,
  });
}
assert.equal(hashes.size, cases.length, "expected three distinct rendered pages");

const missing = await fetch(new URL("/__extract-dashboard-pages-missing__", baseUrl));
assert.equal(missing.status, 404, "unknown route did not return 404");

const report = {
  overall_behavior: "satisfies_contract",
  overall_confidence: 1,
  target: { type: "web app", access: baseUrl },
  checks,
  anti_cheat_probes: [
    { probe: "Repeated every page fetch", result: "All repeated bodies were byte-identical" },
    { probe: "Compared route hashes", result: "All three rendered page hashes were distinct" },
    { probe: "Fetched an unknown route", result: "Worker returned HTTP 404" },
  ],
  blockers: [],
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log("behavior_validation=satisfies_contract");
