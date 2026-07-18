#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const outputPath = optionValue("--output-last-message");
const schemaPath = optionValue("--output-schema");
const prompt = fs.readFileSync(0, "utf8");

if (!outputPath) fail("fake Codex requires --output-last-message");

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
if (schemaPath && path.basename(schemaPath) === "codex-review.schema.json") {
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify({
      status: "clean",
      summary: "The deterministic E2E repair is clean.",
      findings: [],
      findings_addressed: true,
      evidence: ["Hermetic Codex simulator reviewed the repaired checkout."],
    })}\n`,
  );
} else {
  const fixturePath = fixtureEditPath();
  if (!fs.existsSync(fixturePath)) {
    fail(`fake Codex target is missing: ${fixturePath}`);
  }
  const before = fs.readFileSync(fixturePath, "utf8");
  if (before.includes("broken")) {
    fs.writeFileSync(fixturePath, before.replace("broken", "fixed"));
  } else if (!before.includes("ClawSweeper automerge E2E repair marker")) {
    fs.writeFileSync(
      fixturePath,
      `${before.trimEnd()}\n\n// ClawSweeper automerge E2E repair marker.\n`,
    );
  }
  fs.writeFileSync(
    outputPath,
    [
      "Repaired the deterministic fixture through the production Codex entrypoint.",
      `Prompt bytes: ${Buffer.byteLength(prompt)}`,
      "",
    ].join("\n"),
  );
}

process.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } })}\n`);

function optionValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

function fixtureEditPath() {
  const openClawShapedFixture = path.join(
    process.cwd(),
    "packages",
    "fixture-core",
    "src",
    "repair-target.txt",
  );
  if (fs.existsSync(openClawShapedFixture)) return openClawShapedFixture;
  const minimalFixture = path.join(process.cwd(), "src", "repair-target.txt");
  if (fs.existsSync(minimalFixture)) return minimalFixture;
  const ciRegressionFixture = path.join(process.cwd(), "src", "hooks", "gmail-watcher.ts");
  if (fs.existsSync(ciRegressionFixture)) return ciRegressionFixture;
  return minimalFixture;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
