import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import {
  errorFingerprint,
  errorFingerprintDigest,
  failureFingerprint,
} from "../../../../dist/repair/error-fingerprint.js";

const root = process.cwd();
const baseRef = process.env.PROOF_BASE_REF || "origin/main";
const extractions = [
  {
    file: "src/repair/exact-review-batch-cli.ts",
    functionName: "failureFingerprint",
    end: "\n\nfunction env(",
  },
  {
    file: "src/repair/publish-event-result.ts",
    functionName: "errorFingerprint",
    end: "\n\nfunction validateTargetRepo(",
  },
].map((entry) => {
  const source = gitShow(entry.file);
  const extracted = extractBetween(source, `function ${entry.functionName}(`, entry.end);
  return { ...entry, extracted, outputs: evaluateOld(extracted, entry.functionName) };
});

const inputs = [
  {
    kind: "Error",
    text: "Error:boom",
    digest: errorFingerprintDigest(new Error("boom")),
    failure: failureFingerprint(new Error("boom")),
    event: errorFingerprint(new Error("boom")),
  },
  {
    kind: "string",
    text: "plain failure",
    digest: errorFingerprintDigest("plain failure"),
    failure: failureFingerprint("plain failure"),
    event: errorFingerprint("plain failure"),
  },
];

assert.deepEqual(
  extractions[0].outputs,
  inputs.map((input) => input.failure),
);
assert.deepEqual(
  extractions[1].outputs,
  inputs.map((input) => input.event),
);
for (const input of inputs) {
  assert.equal(input.failure, input.digest);
  assert.equal(input.event, `sha256:${input.digest}`);
}

const artifact = {
  base_ref: baseRef,
  base_sha: execFileSync("git", ["rev-parse", baseRef], { encoding: "utf8" }).trim(),
  extractions: extractions.map(({ file, functionName, extracted }) => ({
    file,
    function: functionName,
    sha256: createHash("sha256").update(extracted).digest("hex"),
  })),
  inputs,
  identical: true,
};

const outputPath = path.join(
  root,
  "docs/proof/repair-duplication-merges/merge-3/artifacts/equivalence.json",
);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify(artifact, null, 2));

function gitShow(file) {
  return execFileSync("git", ["show", `${baseRef}:${file}`], { encoding: "utf8" });
}

function extractBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert(startIndex >= 0 && endIndex > startIndex, `could not extract ${start}`);
  return source.slice(startIndex, endIndex);
}

function evaluateOld(source, functionName) {
  const javascript = source.replaceAll("error: unknown", "error").replaceAll("): string", ")");
  const context = { exports: {}, createHash };
  vm.runInNewContext(
    `${javascript}\nexports.outputs = [${functionName}(new Error("boom")), ${functionName}("plain failure")];`,
    context,
  );
  return Array.from(context.exports.outputs);
}
