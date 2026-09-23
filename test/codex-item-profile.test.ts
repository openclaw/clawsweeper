import assert from "node:assert/strict";
import test from "node:test";
import { canonicalItemAuthorAssociations, codexItemProfile } from "../dist/codex-item-profile.js";

test("maintainer-authored items use high reasoning and fast service", () => {
  for (const association of ["OWNER", "member", "COLLABORATOR"]) {
    assert.deepEqual(codexItemProfile(association), {
      reasoningEffort: "high",
      serviceTier: "fast",
    });
  }
});

test("other items preserve the ordinary Sol profile", () => {
  for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE", "", undefined]) {
    assert.deepEqual(codexItemProfile(association), { reasoningEffort: "medium", serviceTier: "" });
  }
});

test("repair routing follows the canonical item rather than linked context", () => {
  const plan = {
    items: [
      { ref: "#10", author_association: "CONTRIBUTOR" },
      { ref: "#11", author_association: "MEMBER" },
    ],
  };
  assert.deepEqual(
    canonicalItemAuthorAssociations({ canonical: ["#11"], candidates: ["#10"] }, plan),
    ["MEMBER"],
  );
  assert.deepEqual(canonicalItemAuthorAssociations({ candidates: ["#10"] }, plan), ["CONTRIBUTOR"]);
  assert.deepEqual(canonicalItemAuthorAssociations({ canonical: ["#12"] }, plan), []);
  assert.deepEqual(
    canonicalItemAuthorAssociations({ canonical: ["#12"], candidates: ["#11"] }, plan),
    [],
  );
});

test("repair routing promotes a cluster when any canonical item is maintainer-authored", () => {
  const associations = canonicalItemAuthorAssociations(
    { canonical: ["#10", "#11"] },
    {
      items: [
        { ref: "#10", author_association: "CONTRIBUTOR" },
        { ref: "#11", author_association: "OWNER" },
      ],
    },
  );
  assert.deepEqual(associations, ["CONTRIBUTOR", "OWNER"]);
  assert.deepEqual(codexItemProfile(associations), {
    reasoningEffort: "high",
    serviceTier: "fast",
  });
});

test("repair routing normalizes accepted numeric canonical refs", () => {
  for (const ref of ["11", "0011", "#0011"]) {
    const associations = canonicalItemAuthorAssociations(
      { canonical: [ref] },
      { items: [{ ref: "#11", author_association: "MEMBER" }] },
    );
    assert.deepEqual(associations, ["MEMBER"]);
    assert.deepEqual(codexItemProfile(associations), {
      reasoningEffort: "high",
      serviceTier: "fast",
    });
  }
});
