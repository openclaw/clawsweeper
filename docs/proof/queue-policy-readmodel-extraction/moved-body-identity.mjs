#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const proofDir = path.join(repoRoot, "docs/proof/queue-policy-readmodel-extraction");
const outputPath = process.env.QUEUE_EXTRACTION_IDENTITY_OUTPUT
  ? path.resolve(process.env.QUEUE_EXTRACTION_IDENTITY_OUTPUT)
  : path.join(proofDir, "moved-body-identity.json");
const mergeBase = (await commandText("git", ["merge-base", "HEAD", "origin/main"])).trim();
const baseText = await commandText("git", ["show", `${mergeBase}:dashboard/exact-review-queue.ts`]);
const candidateFiles = [
  "dashboard/exact-review-decision.ts",
  "dashboard/exact-review-read-model.ts",
  "dashboard/exact-review-queue-shared.ts",
];
const candidateTexts = new Map(
  await Promise.all(
    candidateFiles.map(async (file) => [file, await readFile(path.join(repoRoot, file), "utf8")]),
  ),
);

const functionNames = [
  "exactReviewDecisionFrom",
  "exactReviewDecisionWithoutSourceAuthority",
  "exactReviewBranchAuthorityDecisionFrom",
  "exactReviewBranchAuthorityReservationKey",
  "exactReviewBranchAuthorityReservationFrom",
  "exactReviewSourceAuthorityReservationKey",
  "exactReviewSourceAuthorityReservationFrom",
  "exactReviewIngressFrom",
  "exactReviewIngressCanPromoteFallback",
  "exactReviewBaseDecisionFrom",
  "exactReviewEditedSemanticInput",
  "exactReviewPublicationRevision",
  "exactReviewPublicationLineage",
  "exactReviewPublicationLineageKey",
  "exactReviewPublicationProducerIsNewer",
  "compareDecimalIdentifiers",
  "exactReviewPublicationFrom",
  "exactReviewDirectLifecycleReceiptFrom",
  "mergePendingExactReviewDecision",
  "exactReviewDecisionAtLiveHead",
  "exactReviewQueueHasStaleLiveHead",
  "exactReviewDecisionCanSupersedeReview",
  "exactReviewSourceAuthorityWatermark",
  "advanceExactReviewSourceAuthorityWatermark",
  "exactReviewItemKey",
  "isExactReviewQueueTargetEnabled",
  "isImmediateExactReviewDecision",
  "isLowPriorityExactReviewDecision",
  "exactReviewQueueIsPublication",
  "exactReviewQueueIsBatchablePublication",
  "exactReviewQueueHasCommandContext",
  "exactReviewQueueCommandStatusAddress",
  "exactReviewTerminalFinalizationSharesCommandStatus",
  "exactReviewQueueLane",
  "exactReviewQueueBayStage",
  "exactReviewQueueBayStagePriority",
  "exactReviewQueueBayPriorityKeys",
  "exactReviewQueueBayProjection",
  "exactReviewQueueActiveReviewCount",
  "exactReviewQueueActivePublicationCount",
  "exactReviewPrioritizePublicationItems",
  "exactReviewQueueAdmittedItems",
  "sumFor",
  "percentileFor",
  "exactReviewQueueStats",
  "exactReviewQueueLaneStats",
  "exactReviewQueueBackoffReason",
  "exactReviewQueueReasonCounts",
  "exactReviewQueueNextWakeAt",
  "exactReviewQueueCapacity",
  "exactReviewDispatchFailureDetailJson",
  "exactReviewEffectiveLeaseExpiresAt",
  "exactReviewParkedRecoveryDelayMs",
  "exactReviewParkedRecoveryAt",
  "exactReviewParkedRecoveryAttempts",
  "exactReviewParkedOperatorEligible",
  "exactReviewParkedTerminalCheckAt",
  "exactReviewParkedTerminalGlobalCheckAt",
  "exactReviewShedSinceReset",
  "exactReviewGithubCredentialCircuits",
  "exactReviewGithubTargetAppCircuitRetryAt",
  "exactReviewScheduledLane",
  "objectValue",
  "numberFrom",
];

const baseBodies = functionBodies("dashboard/exact-review-queue.ts", baseText);
const candidateBodies = new Map();
for (const [file, text] of candidateTexts) {
  for (const [name, body] of functionBodies(file, text)) {
    assert.ok(!candidateBodies.has(name), `candidate function duplicated: ${name}`);
    candidateBodies.set(name, { file, body });
  }
}

const functions = functionNames.map((name) => {
  const before = baseBodies.get(name);
  const candidate = candidateBodies.get(name);
  assert.ok(before, `merge-base function missing: ${name}`);
  assert.ok(candidate, `candidate function missing: ${name}`);
  assert.equal(candidate.body, before, `function body changed: ${name}`);
  return {
    name,
    candidate_file: candidate.file,
    bytes: Buffer.byteLength(before),
    sha256: sha256(before),
    byte_identical: true,
  };
});
const result = {
  schema: "queue-policy-readmodel-body-identity/v1",
  merge_base: mergeBase,
  compared_functions: functions.length,
  all_byte_identical: true,
  functions,
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function functionBodies(file, text) {
  const bodies = new Map();
  const declaration = /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g;
  for (const match of text.matchAll(declaration)) {
    const name = match[1];
    const searchStart = Number(match.index) + match[0].length;
    for (let open = text.indexOf("{", searchStart); open >= 0; open = text.indexOf("{", open + 1)) {
      const close = matchingBrace(text, open);
      if (close < 0) break;
      const tail = text.slice(close + 1).trimStart();
      if (
        tail === "" ||
        /^(?:export\s+)?(?:async\s+)?function\s|^(?:export\s+)?(?:type|const|class)\s/.test(tail)
      ) {
        bodies.set(name, text.slice(open, close + 1));
        break;
      }
    }
  }
  return bodies;
}

function matchingBrace(text, open) {
  let depth = 0;
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "\`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function commandText(executable, args) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    execFile(executable, args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
