import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import {
  commandAckMarkerFromBody,
  commandStatusMarkerFromBody,
  planCommandAckConvergence,
  selectCommandAckKeeper,
} from "../../../../dist/repair/command-ack-convergence.js";

const root = process.cwd();
const baseRef = process.env.PROOF_BASE_REF || "origin/main";
const sources = {
  update: extract(
    "src/repair/update-command-status.ts",
    "function commandAckMarkerFromBody(",
    "\nexport function mergeCommandProgressSection(",
  ),
  core: extract(
    "src/repair/comment-router-core.ts",
    "export function commandStatusMarkerFromBody(",
    "\nexport function commandResponseMarker(",
  ),
  router: extract(
    "src/repair/comment-router.ts",
    "function commandAckMarkerFromBody(",
    "\nfunction automergeTimelineEvents(",
  ),
};
const oldUpdate = compile(sources.update, [
  "commandAckMarkerFromBody",
  "commandStatusMarkerFromBody",
  "selectCommandAckKeeper",
]);
const oldCore = compile(sources.core, [
  "commandStatusMarkerFromBody",
  "planCommandAckConvergence",
  "selectCommandAckKeeper",
]);
const oldRouter = compile(sources.router, ["commandAckMarkerFromBody"]);

const requestedStatus = "<!-- clawsweeper-command-status:81564:re_review:new -->";
const otherStatus = "<!-- clawsweeper-command-status:81564:re_review:old -->";
const comments = [
  {
    id: 101,
    created_at: "2026-05-29T10:00:00Z",
    updated_at: "2026-05-29T10:01:00Z",
    body: `${otherStatus}\n<!-- clawsweeper-command-ack:456 -->`,
  },
  {
    id: 102,
    created_at: "2026-05-29T10:02:00Z",
    updated_at: "2026-05-29T10:02:00Z",
    body: "<!-- clawsweeper-command-ack:456 -->",
  },
  {
    id: 103,
    created_at: "2026-05-29T10:03:00Z",
    updated_at: "2026-05-29T10:05:00Z",
    body: `${requestedStatus}\n<!--   clawsweeper-command-ack:456   -->`,
  },
  {
    id: 104,
    created_at: "2026-05-29T10:04:00Z",
    updated_at: "2026-05-29T10:04:00Z",
    body: "<!-- clawsweeper-command-ack:456 -->",
  },
];
const bareTie = [
  { id: 12, created_at: "2026-05-29T10:00:00Z", body: "bare" },
  { id: 11, created_at: "2026-05-29T10:00:00Z", body: "bare" },
  { id: 13, created_at: "2026-05-29T10:01:00Z", body: "bare" },
];
const markerInputs = [
  "<!-- clawsweeper-command-ack:456 -->",
  "prefix <!--   clawsweeper-command-ack:456   --> suffix",
  "<!-- clawsweeper-command-ack:not-a-number -->",
  null,
];
const statusInputs = [requestedStatus, `prefix ${otherStatus} suffix`, "status-free", null];

const current = {
  ackMarkers: markerInputs.map(commandAckMarkerFromBody),
  statusMarkers: statusInputs.map(commandStatusMarkerFromBody),
  plan: simplifyPlan(planCommandAckConvergence(comments, requestedStatus)),
  statusKeeper: selectCommandAckKeeper(comments.filter((comment) => !comment.body.includes("old")))
    ?.id,
  bareKeeper: selectCommandAckKeeper(bareTie)?.id,
};
const old = {
  updateAckMarkers: markerInputs.map(oldUpdate.commandAckMarkerFromBody),
  routerAckMarkers: markerInputs.map(oldRouter.commandAckMarkerFromBody),
  updateStatusMarkers: statusInputs.map(oldUpdate.commandStatusMarkerFromBody),
  coreStatusMarkers: statusInputs.map(oldCore.commandStatusMarkerFromBody),
  corePlan: simplifyPlan(oldCore.planCommandAckConvergence(comments, requestedStatus)),
  updateStatusKeeper: oldUpdate.selectCommandAckKeeper(
    comments.filter((comment) => !comment.body.includes("old")),
  )?.id,
  coreStatusKeeper: oldCore.selectCommandAckKeeper(
    comments.filter((comment) => !comment.body.includes("old")),
  )?.id,
  updateBareKeeper: oldUpdate.selectCommandAckKeeper(bareTie)?.id,
  coreBareKeeper: oldCore.selectCommandAckKeeper(bareTie)?.id,
};

assert.deepEqual(old.updateAckMarkers, current.ackMarkers);
assert.deepEqual(old.routerAckMarkers, current.ackMarkers);
assert.deepEqual(old.updateStatusMarkers, current.statusMarkers);
assert.deepEqual(old.coreStatusMarkers, current.statusMarkers);
assert.deepEqual(old.corePlan, current.plan);
assert.equal(old.updateStatusKeeper, current.statusKeeper);
assert.equal(old.coreStatusKeeper, current.statusKeeper);
assert.equal(old.updateBareKeeper, current.bareKeeper);
assert.equal(old.coreBareKeeper, current.bareKeeper);

const artifact = {
  base_ref: baseRef,
  base_sha: execFileSync("git", ["rev-parse", baseRef], { encoding: "utf8" }).trim(),
  extractions: Object.entries(sources).map(([name, source]) => ({
    name,
    sha256: createHash("sha256").update(source).digest("hex"),
  })),
  representative_inputs: { markerInputs, statusInputs, comments, bareTie },
  old,
  current,
  identical: true,
};

const outputPath = path.join(
  root,
  "docs/proof/repair-duplication-merges/merge-4/artifacts/equivalence.json",
);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify(artifact, null, 2));

function gitShow(file) {
  return execFileSync("git", ["show", `${baseRef}:${file}`], { encoding: "utf8" });
}

function extract(file, start, end) {
  const source = gitShow(file);
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert(startIndex >= 0 && endIndex > startIndex, `could not extract ${start}`);
  return source.slice(startIndex, endIndex);
}

function compile(source, names) {
  const javascript = source
    .replaceAll("export ", "")
    .replace(/\): \{ keep: LooseRecord \| null; prunable: LooseRecord\[\] \} \{/g, ") {")
    .replace(/: JsonValue/g, "")
    .replace(/: LooseRecord\[\]/g, "")
    .replace(/: LooseRecord/g, "")
    .replace(/: string/g, "");
  const assignments = names.map((name) => `exports.${name} = ${name};`).join("\n");
  const context = {
    exports: {},
    PROGRESS_START: "<!-- clawsweeper-command-progress:start -->",
  };
  vm.runInNewContext(`${javascript}\n${assignments}`, context);
  return context.exports;
}

function simplifyPlan(plan) {
  return {
    keep: plan.keep?.id ?? null,
    prunable: Array.from(plan.prunable, (comment) => comment.id),
  };
}
