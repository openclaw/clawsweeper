import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assertCommandProofSubject,
  commandProofBinding,
} from "../dist/command-proof-assessment.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const head = "a".repeat(40);
const binding = commandProofBinding(
  `<!-- command-proof-assessment-v1 head=${head} body=${sha256("claim")} base=${sha256("main")} base_sha=${"b".repeat(40)} request=${"c".repeat(64)} scenario=telegram-bot-e2e-proof -->\n`,
)!;

test("candidate evidence remains applicable when only the review base advances", () => {
  assert.doesNotThrow(() =>
    assertCommandProofSubject(binding, head, "claim", "main", "d".repeat(40)),
  );
  assert.throws(
    () => assertCommandProofSubject(binding, "e".repeat(40), "claim", "main", "d".repeat(40)),
    /subject changed/,
  );
});
