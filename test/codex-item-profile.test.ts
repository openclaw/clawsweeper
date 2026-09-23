import assert from "node:assert/strict";
import test from "node:test";
import { canonicalItemAuthorAssociation, codexItemProfile } from "../dist/codex-item-profile.js";

test("maintainer-authored items use high reasoning and fast service", () => {
  for (const association of ["OWNER", "member", "COLLABORATOR"]) {
    assert.deepEqual(
      codexItemProfile(association, { reasoningEffort: "medium", serviceTier: "" }),
      { reasoningEffort: "high", serviceTier: "fast" },
    );
  }
});

test("other items preserve the ordinary Sol profile", () => {
  for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE", "", undefined]) {
    assert.deepEqual(
      codexItemProfile(association, { reasoningEffort: "medium", serviceTier: "" }),
      { reasoningEffort: "medium", serviceTier: "" },
    );
  }
});

test("repair routing follows the canonical item rather than linked context", () => {
  const plan = {
    items: [
      { ref: "#10", author_association: "CONTRIBUTOR" },
      { ref: "#11", author_association: "MEMBER" },
    ],
  };
  assert.equal(
    canonicalItemAuthorAssociation({ canonical: ["#11"], candidates: ["#10"] }, plan),
    "MEMBER",
  );
  assert.equal(canonicalItemAuthorAssociation({ candidates: ["#10"] }, plan), "CONTRIBUTOR");
  assert.equal(canonicalItemAuthorAssociation({ canonical: ["#12"] }, plan), undefined);
  assert.equal(
    canonicalItemAuthorAssociation({ canonical: ["#12"], candidates: ["#11"] }, plan),
    undefined,
  );
});
