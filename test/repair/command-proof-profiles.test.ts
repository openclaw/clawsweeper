import assert from "node:assert/strict";
import test from "node:test";
import { proofFixture } from "../helpers/command-proof-fixtures.ts";
import {
  COMMAND_PROOF_PROFILES,
  COMMAND_PROOF_SCENARIO,
  TELEGRAM_PROOF_SCENARIO,
  TELEGRAM_QA_SCENARIO,
  commandProofProfile,
  commandProofProducerFromEnv,
  commandProofProducersFromEnv,
  parseCommandProofClaim,
} from "../../src/command-proof-contract.ts";

const pins = (scenario: keyof typeof COMMAND_PROOF_PROFILES) => {
  const profile = COMMAND_PROOF_PROFILES[scenario];
  return {
    [profile.configPrefix + "_WORKFLOW_PATH"]: profile.workflowPath,
    [profile.configPrefix + "_WORKFLOW_REF"]: scenario + "-reviewed",
    [profile.configPrefix + "_WORKFLOW_SHA"]: "b".repeat(40),
    [profile.configPrefix + "_HARNESS_SHA"]: "b".repeat(40),
  };
};

test("paired proof fixtures preserve the actual candidate identity", () => {
  const head = "1234567890abcdef1234567890abcdef12345678";
  for (const scenario of Object.keys(COMMAND_PROOF_PROFILES)) {
    const fixture = proofFixture(
      undefined,
      scenario as keyof typeof COMMAND_PROOF_PROFILES,
      "pass",
      head,
    );
    assert.equal(fixture.claim.headSha, head);
    assert.equal(fixture.receipt.candidate_sha, head);
    assert.equal(fixture.live.pull.head.sha, head);
    assert.ok(fixture.live.comment.body.endsWith(head));
  }
});

test("proof profiles bind distinct workflows, trusted jobs and observation contracts", () => {
  assert.deepEqual(Object.keys(COMMAND_PROOF_PROFILES), [
    COMMAND_PROOF_SCENARIO,
    TELEGRAM_PROOF_SCENARIO,
    TELEGRAM_QA_SCENARIO,
  ]);
  assert.equal(commandProofProfile("__proto__"), null);
  assert.equal(commandProofProfile("telegram"), null);
  assert.equal(commandProofProfile("telegram-bot-e2e-proof-extra"), null);
  assert.equal(commandProofProfile(undefined), null);
  const web = COMMAND_PROOF_PROFILES[COMMAND_PROOF_SCENARIO];
  const telegram = COMMAND_PROOF_PROFILES[TELEGRAM_PROOF_SCENARIO];
  assert.equal(web.workflowPath, ".github/workflows/mantis-web-ui-chat-proof.yml");
  assert.equal(web.configPrefix, "CLAWSWEEPER_PROOF");
  assert.equal(web.observerJob, "Run request-bound web chat proof");
  assert.equal(web.evidenceArtifactPrefix, "mantis-request-web-ui");
  assert.deepEqual(web.observations, [
    ["chat-send", "chat-send.json"],
    ["final-reply", "final-reply.json"],
    ["final-screenshot", "final-reply.png"],
  ]);
  assert.equal(telegram.workflowPath, ".github/workflows/mantis-telegram-bot-e2e-proof.yml");
  assert.equal(telegram.configPrefix, "CLAWSWEEPER_TELEGRAM_PROOF");
  assert.equal(telegram.observerJob, "Run request-bound Telegram bot proof");
  assert.equal(telegram.evidenceArtifactPrefix, "mantis-request-telegram");
  assert.deepEqual(telegram.observations, [
    ["telegram-send", "telegram-send.json"],
    ["provider-request", "provider-request.json"],
    ["telegram-reply", "telegram-reply.json"],
  ]);
  assert.match(web.scopeNotice, /mocked Gateway ONLY/);
  assert.ok(telegram.scopeNotice.includes("TelegramTestServer/TDLib"));
  assert.match(telegram.scopeNotice, /external mock provider ONLY/);
  assert.match(telegram.scopeNotice, /not live Telegram/);
});

test("proof producer pins are independently opt-in with no cross-transport fallback", () => {
  assert.deepEqual(commandProofProducersFromEnv({}), {});
  const webPins = pins(COMMAND_PROOF_SCENARIO);
  const telegramPins = pins(TELEGRAM_PROOF_SCENARIO);
  assert.equal(commandProofProducerFromEnv(TELEGRAM_PROOF_SCENARIO, webPins), null);
  assert.equal(commandProofProducerFromEnv(COMMAND_PROOF_SCENARIO, telegramPins), null);
  assert.deepEqual(Object.keys(commandProofProducersFromEnv(webPins)), [COMMAND_PROOF_SCENARIO]);
  assert.deepEqual(Object.keys(commandProofProducersFromEnv(telegramPins)), [
    TELEGRAM_PROOF_SCENARIO,
    TELEGRAM_QA_SCENARIO,
  ]);
  assert.deepEqual(Object.keys(commandProofProducersFromEnv({ ...webPins, ...telegramPins })), [
    COMMAND_PROOF_SCENARIO,
    TELEGRAM_PROOF_SCENARIO,
    TELEGRAM_QA_SCENARIO,
  ]);
  for (const scenario of [COMMAND_PROOF_SCENARIO, TELEGRAM_PROOF_SCENARIO, TELEGRAM_QA_SCENARIO]) {
    const valid = pins(scenario);
    const profile = COMMAND_PROOF_PROFILES[scenario];
    for (const key of Object.keys(valid)) {
      const partial: Record<string, string> = { ...valid };
      delete partial[key];
      assert.equal(commandProofProducerFromEnv(scenario, partial), null, key);
    }
    for (const [suffix, value] of [
      [
        "_WORKFLOW_PATH",
        scenario === COMMAND_PROOF_SCENARIO
          ? COMMAND_PROOF_PROFILES[TELEGRAM_PROOF_SCENARIO].workflowPath
          : COMMAND_PROOF_PROFILES[COMMAND_PROOF_SCENARIO].workflowPath,
      ],
      ["_WORKFLOW_REF", "b".repeat(40)],
      ["_WORKFLOW_REF", "bad ref"],
      ["_WORKFLOW_SHA", "not-a-sha"],
      ["_HARNESS_SHA", "c".repeat(40)],
    ]) {
      assert.equal(
        commandProofProducerFromEnv(scenario, {
          ...valid,
          [profile.configPrefix + suffix!]: value!,
        }),
        null,
      );
    }
  }
});

test("closed proof claims reject scenario and workflow substitution across transports", () => {
  for (const scenario of [COMMAND_PROOF_SCENARIO, TELEGRAM_PROOF_SCENARIO, TELEGRAM_QA_SCENARIO]) {
    const claim = {
      requestId: "d".repeat(64),
      repository: "openclaw/openclaw",
      repositoryId: "123",
      pullRequest: 42,
      headSha: "a".repeat(40),
      baseSha: "c".repeat(40),
      bodySha256: "e".repeat(64),
      targetBranch: "main",
      scenario,
      ...commandProofProducerFromEnv(scenario, pins(scenario))!,
      sourceCommentId: "200",
      sourceCommentUpdatedAt: "2026-09-04T10:00:00Z",
      sourceCommentBodySha256: "f".repeat(64),
    };
    assert.deepEqual(parseCommandProofClaim(claim), claim);
    const other =
      scenario === COMMAND_PROOF_SCENARIO ? TELEGRAM_PROOF_SCENARIO : COMMAND_PROOF_SCENARIO;
    assert.equal(parseCommandProofClaim({ ...claim, scenario: other }), null);
    assert.equal(
      parseCommandProofClaim({
        ...claim,
        workflowPath: COMMAND_PROOF_PROFILES[other].workflowPath,
      }),
      null,
    );
    assert.equal(parseCommandProofClaim({ ...claim, transport: "telegram" }), null);
  }
});
