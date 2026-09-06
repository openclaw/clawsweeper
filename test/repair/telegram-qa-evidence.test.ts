import assert from "node:assert/strict";
import test from "node:test";
import {
  proofFixture,
  replaceProofEvidence,
  replaceReceipt,
} from "../helpers/command-proof-fixtures.ts";
import { readProofZip } from "../../dist/repair/proof-zip.js";
import { verifyCommandProof } from "../../dist/repair/proof-receipt-verification.js";

for (const outcome of ["pass", "fail"] as const) {
  test(`trusted catalog ${outcome} evidence enters full review with explicit emulator limitations`, () => {
    const fixture = proofFixture(undefined, "telegram-markdown-parser-fidelity", outcome);
    fixture.live.pull.base.sha = "f".repeat(40);
    const verified = verifyCommandProof(fixture);
    assert.equal(verified.outcome, outcome);
    if (verified.outcome === "inconclusive") throw new Error(verified.reason);
    assert.match(verified.reviewContext, /normal full review/);
    assert.match(verified.reviewContext, /Crabline/);
    assert.match(verified.reviewContext, /no Telegram Test Server/);
    assert.match(verified.reviewContext, /all-space-code/);
    assert.doesNotMatch(verified.reviewContext, /Only the proof assessment may change/);
    assert.equal(
      verifyCommandProof(
        replaceReceipt(fixture, {
          ...fixture.receipt,
          assertion_outcome: outcome === "pass" ? "fail" : "pass",
        }),
      ).outcome,
      "inconclusive",
    );
  });
}

test("complete failed QA observations retain empty text and absent parse mode", () => {
  const fixture = proofFixture(undefined, "telegram-markdown-parser-fidelity", "fail");
  const files = readProofZip(fixture.evidenceArchive);
  const value = JSON.parse(files.get("qa-observations.json")!.toString());
  value.cases[0].outboundHtml = "";
  value.cases[0].acceptedPayloads = [{ text: "", parseMode: null }];
  files.set("qa-observations.json", Buffer.from(JSON.stringify(value)));
  const verified = verifyCommandProof(replaceProofEvidence(fixture, files));
  assert.equal(verified.outcome, "fail");
  if (verified.outcome === "inconclusive") throw new Error(verified.reason);
  const context = JSON.parse(verified.reviewContext.split("\n").at(-1)!);
  const observation = context.observations.find(
    (item: { id: string }) => item.id === "qa-observations",
  );
  assert.deepEqual(JSON.parse(observation.actual)[0].acceptedPayloads, [
    { text: "", parseMode: null },
  ]);
});

for (const [file, change] of [
  [
    "qa-execution.json",
    (v) => {
      v.transport = "TelegramTestServer";
    },
  ],
  [
    "qa-execution.json",
    (v) => {
      v.candidate_sha = "f".repeat(40);
    },
  ],
  [
    "qa-execution.json",
    (v) => {
      v.request_id = "f".repeat(64);
    },
  ],
  [
    "qa-execution.json",
    (v) => {
      v.harness_sha = "f".repeat(40);
    },
  ],
  [
    "qa-execution.json",
    (v) => {
      v.run_id = "999";
    },
  ],
  [
    "qa-execution.json",
    (v) => {
      v.run_attempt = 2;
    },
  ],
  [
    "qa-execution.json",
    (v) => {
      v.live_service = true;
    },
  ],
  [
    "qa-execution.json",
    (v) => {
      v.candidate_quiescent = false;
    },
  ],
  [
    "qa-execution.json",
    (v) => {
      v.token = "unexpected";
    },
  ],
  [
    "qa-result.json",
    (v) => {
      v.steps = [];
    },
  ],
  [
    "qa-result.json",
    (v) => {
      v.steps[0].status = "skip";
    },
  ],
  [
    "qa-result.json",
    (v) => {
      v.steps[0].status = "fail";
    },
  ],
  [
    "qa-observations.json",
    (v) => {
      v.cases.pop();
    },
  ],
  [
    "qa-observations.json",
    (v) => {
      v.cases[0].case = v.cases[1].case;
    },
  ],
  [
    "qa-observations.json",
    (v) => {
      v.cases[0].acceptedPayloads = [];
    },
  ],
] as Array<[string, (value: any) => void]>) {
  test(`QA evidence rejects ${file}: ${change.toString()}`, () => {
    const fixture = proofFixture(undefined, "telegram-markdown-parser-fidelity");
    const files = readProofZip(fixture.evidenceArchive);
    const value = JSON.parse(files.get(file)!.toString());
    change(value);
    files.set(file, Buffer.from(JSON.stringify(value)));
    assert.equal(verifyCommandProof(replaceProofEvidence(fixture, files)).outcome, "inconclusive");
  });
}
