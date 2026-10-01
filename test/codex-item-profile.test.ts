import assert from "node:assert/strict";
import test from "node:test";
import { canonicalItemCodexProfile, codexItemProfile } from "../dist/codex-item-profile.js";

const FAST = { reasoningEffort: "medium", serviceTier: "fast" };
const STANDARD = { reasoningEffort: "medium", serviceTier: "" };

test("maintainer-authored items use medium reasoning and priority service", () => {
  for (const association of ["OWNER", "member", "COLLABORATOR"]) {
    assert.deepEqual(codexItemProfile(association), FAST);
  }
});

test("authors with write access use priority service whatever their association", () => {
  for (const permission of ["write", "maintain", "ADMIN", " write "]) {
    assert.deepEqual(codexItemProfile("CONTRIBUTOR", permission), FAST);
    assert.deepEqual(codexItemProfile(["NONE"], [null, permission]), FAST);
  }
});

test("other items preserve the ordinary Sol profile", () => {
  for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE", "", undefined]) {
    assert.deepEqual(codexItemProfile(association), STANDARD);
    for (const permission of ["read", "triage", "none", "", null, undefined]) {
      assert.deepEqual(codexItemProfile(association, permission), STANDARD);
    }
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
    canonicalItemCodexProfile({ canonical: ["#11"], candidates: ["#10"] }, plan),
    FAST,
  );
  assert.deepEqual(canonicalItemCodexProfile({ candidates: ["#10"] }, plan), STANDARD);
  assert.deepEqual(canonicalItemCodexProfile({ canonical: ["#12"] }, plan), STANDARD);
  assert.deepEqual(
    canonicalItemCodexProfile({ canonical: ["#12"], candidates: ["#11"] }, plan),
    STANDARD,
  );
});

test("repair routing promotes a cluster when any canonical item is maintainer-authored", () => {
  const plan = {
    items: [
      { ref: "#10", author_association: "CONTRIBUTOR" },
      { ref: "#11", author_association: "OWNER" },
    ],
  };
  assert.deepEqual(canonicalItemCodexProfile({ canonical: ["#10", "#11"] }, plan), FAST);
});

test("repair routing uses the canonical author's recorded write access", () => {
  const plan = {
    items: [
      { ref: "#10", author_association: "CONTRIBUTOR", author_repository_permission: "read" },
      { ref: "#11", author_association: "CONTRIBUTOR", author_repository_permission: "write" },
    ],
  };
  assert.deepEqual(canonicalItemCodexProfile({ canonical: ["#11"] }, plan), FAST);
  assert.deepEqual(canonicalItemCodexProfile({ canonical: ["#10"] }, plan), STANDARD);
  // Linked context never lends its author's access to the canonical item.
  assert.deepEqual(
    canonicalItemCodexProfile({ canonical: ["#10"], candidates: ["#11"] }, plan),
    STANDARD,
  );
});

test("repair routing normalizes accepted numeric canonical refs", () => {
  for (const ref of ["11", "0011", "#0011"]) {
    assert.deepEqual(
      canonicalItemCodexProfile(
        { canonical: [ref] },
        { items: [{ ref: "#11", author_association: "MEMBER" }] },
      ),
      FAST,
    );
  }
});
