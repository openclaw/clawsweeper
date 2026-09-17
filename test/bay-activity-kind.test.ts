import assert from "node:assert/strict";
import test from "node:test";
import {
  publicBayActivityKind,
  normalizePublicBayActivityKind,
} from "../dashboard/bay-activity-kind.ts";

test("Bay work identity comes from closed producer classifications, not the visual lane", () => {
  assert.equal(
    publicBayActivityKind({ mode: "exact-review", stage: "repairing", current_step: "Run tests" }),
    "review",
  );
  assert.equal(publicBayActivityKind({ mode: "repair", stage: "setting-up" }), "repair");
  assert.equal(publicBayActivityKind({ mode: "automerge", work_kind: "pr_repair" }), "repair");
  assert.equal(publicBayActivityKind({ work_kind: "repair_cluster" }), "repair");
  for (const mode of ["background-review", "hot-review", "commit-review"]) {
    assert.equal(publicBayActivityKind({ mode }), "review");
  }
  for (const value of [
    null,
    [],
    "repair",
    { stage: "repairing" },
    { name: "repair arbitrary text" },
    { work_kind: "private/repository" },
    { mode: "<script>repair</script>" },
  ]) {
    assert.equal(publicBayActivityKind(value), undefined);
  }
});

test("projected Bay work identity accepts no arbitrary diagnostic text", () => {
  assert.equal(normalizePublicBayActivityKind("review"), "review");
  assert.equal(normalizePublicBayActivityKind("repair"), "repair");
  for (const value of [
    undefined,
    null,
    {},
    ["repair"],
    "__proto__",
    "workflow_failed",
    "private/debug",
  ]) {
    assert.equal(normalizePublicBayActivityKind(value), undefined);
  }
});
