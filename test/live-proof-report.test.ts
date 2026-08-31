import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseDecision,
  renderLiveProofReportSectionForTest,
  reportLiveProofPlan,
} from "../dist/clawsweeper.js";
import {
  LIVE_PROOF_RECORDING_MARKER,
  LIVE_VERIFICATION_MARKER,
} from "../dist/clawsweeper-policy.js";
import type { LiveProofPlan } from "../dist/clawsweeper-types.js";
import {
  executeReviewLiveProofs,
  inspectReviewLiveProofs,
} from "../dist/live-proof/review-artifacts.js";
import {
  buildLiveVerificationResult,
  encodeLiveVerificationReportPayload,
  parseAttachedLiveVerification,
} from "../dist/live-proof/verification.js";
import { repositoryProfileFor } from "../dist/repository-profiles.js";
import { closeDecision, reportFrontMatter } from "./helpers.ts";

const HEAD = "a".repeat(40);
const EMPTY_INSPECTION = {
  candidates: [],
  recordMedia: false,
  requiresBrowser: false,
  requiresTerminal: false,
};

function noExecutionPlan(status: "declined_suspicious" | "not_applicable"): LiveProofPlan {
  return {
    status,
    surface: "none",
    terminalCompletion: "not_applicable",
    reason: "This synthetic plan must not execute.",
    payoff: { kind: "static_text", justification: "No execution or recording is needed." },
    entry: "",
    steps: [],
  };
}

function renderedReport(plan: LiveProofPlan, suffix = ""): string {
  const decision = parseDecision(closeDecision({ liveProofPlan: plan }));
  assert.deepEqual(decision.liveProofPlan, plan);
  return `${reportFrontMatter({ repository: "openclaw/clawsweeper", type: "pull_request", number: 42, pull_head_sha: HEAD })}\n## Live Proof\n\n${renderLiveProofReportSectionForTest(decision)}${suffix}\n\n## Work Candidate\n\nCandidate: none\n`;
}

function withSteps(report: string, payload: string): string {
  return report.replace(/Steps:\n\n[\s\S]*?(?=\n\n## Work Candidate)/, `Steps:\n\n${payload}`);
}

function reportBoundaryVariants(report: string): [string, string][] {
  const [prefix, body] = report.split("## Live Proof\n\n");
  const section = body!.split("\n\n## Work Candidate")[0]!;
  return ["\n", "\r\n"].flatMap((newline) => {
    // Keep the existing LF heading grammar; vary the body and attachment line endings.
    const raw = `${prefix}## Live Proof\n\n${section.replaceAll("\n", newline)}`;
    return Object.entries({
      eof: "",
      "final-newline": newline,
      "next-section": `${newline}## Work Candidate${newline}${newline}Candidate: none${newline}`,
    }).map(([ending, suffix]) => [`${JSON.stringify(newline)} ${ending}`, raw + suffix]);
  });
}

function attachedVerificationStatus(report: string, plan: LiveProofPlan) {
  return parseAttachedLiveVerification(
    report.split("## Live Proof\n\n")[1]!,
    {
      repository: "openclaw/clawsweeper",
      number: "42",
      type: "pull_request",
      pullHeadSha: HEAD,
    },
    plan,
  ).status;
}

function reviewFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-report-steps-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const options = {
    recordsDir: root,
    itemNumbers: [42],
    repo: "openclaw/clawsweeper",
    get checkoutPath(): string {
      assert.fail("must not access a target checkout");
    },
    get outputRoot(): string {
      assert.fail("must not access an output directory");
    },
    get entrypoint(): string {
      assert.fail("must not launch a proof child");
    },
  };
  const dependencies = {
    repositoryProfileFor,
    reportLiveProofPlan,
    frontMatterValue: (markdown: string, key: string) =>
      new RegExp(`^${key}:\\s*(.*)$`, "m").exec(markdown)?.[1]?.trim(),
  };
  assert.equal(repositoryProfileFor(options.repo).liveTest?.enabled, true);
  return {
    write: (report: string) => writeFileSync(join(root, "42.md"), report),
    inspect: () => inspectReviewLiveProofs(options, dependencies),
    execute: () => executeReviewLiveProofs(options, dependencies),
    assertRecordsOnly: () => assert.deepEqual(readdirSync(root), ["42.md"]),
  };
}

test("non-executable plans roundtrip through the production renderer and skip review execution", (t) => {
  const fixture = reviewFixture(t);
  for (const status of ["declined_suspicious", "not_applicable"] as const) {
    const plan = noExecutionPlan(status);
    const report = renderedReport(plan);
    assert.match(report, /Steps:\n\n\[\]\n\n## Work Candidate/);
    for (const payload of ["[]", "- none", " \t[] \t\n", "\n \t- none \t\n"]) {
      for (const [boundary, persisted] of reportBoundaryVariants(withSteps(report, payload))) {
        assert.deepEqual(
          reportLiveProofPlan(persisted),
          plan,
          `${status}: ${payload}: ${boundary}`,
        );
        fixture.write(persisted);
        assert.deepEqual(fixture.inspect(), EMPTY_INSPECTION);
        assert.deepEqual(fixture.execute(), EMPTY_INSPECTION);
        fixture.assertRecordsOnly();
      }
    }
  }
});

test("plan labels retain whitespace tolerance without normalizing attachment lines", () => {
  const plan = noExecutionPlan("not_applicable");
  const rendered = renderedReport(plan)
    .replace("Status:", " \tStatus:")
    .replace("Steps:\n", " \tSteps: \t\n");
  for (const [boundary, report] of reportBoundaryVariants(rendered)) {
    assert.deepEqual(reportLiveProofPlan(report), plan, boundary);
  }
});

test("malformed or ambiguous Steps payloads reject before review execution", (t) => {
  const fixture = reviewFixture(t);
  const step = '- {"action":"expect_output","text":"synthetic"}';
  const invalidPayloads = {
    "mixed sentinel and step": `- none\n${step}`,
    "step before sentinel": `${step}\n- none`,
    "duplicate sentinel": "- none\n- none",
    "mixed array and step": `[]\n${step}`,
    "step before array": `${step}\n[]`,
    "duplicate array": "[]\n[]",
    "mixed empty markers": "[]\n- none",
    "reverse mixed markers": "- none\n[]",
    "array and text": "[]\nunknown",
    "sentinel and text": "- none\nunknown",
    "uppercase sentinel": "- None",
    "quoted sentinel": '- "none"',
    "sentinel substring": "- nonetheless",
    "bare sentinel": "none",
    "extra sentinel spacing": "-  none",
    "bullet array": "- []",
    "noncanonical array": "[ ]",
    "unknown text": "unknown",
    "non-JSON row": "- broken",
    "malformed JSON": "- {",
    "wrong step type": "- 17",
    "null step": "- null",
    "unknown action": '- {"action":"unknown"}',
    "missing command": '- {"action":"run"}',
    "multiline command": '- {"action":"run","command":"first\\nsecond"}',
    "empty payload": "",
    "empty bullet": "- ",
    "duplicate Steps label": "[]\nSteps:\n[]",
    "unknown field": "[]\nUnexpected: ignored",
    "step and unknown text": `${step}\nunknown`,
    "unbulleted step": '{"action":"expect_output","text":"synthetic"}',
    "inline verification marker": `[]\ntext ${LIVE_VERIFICATION_MARKER}`,
    "inexact recording marker": `[]\n${LIVE_PROOF_RECORDING_MARKER} text`,
  };
  const plans: LiveProofPlan[] = [
    noExecutionPlan("declined_suspicious"),
    noExecutionPlan("not_applicable"),
    {
      ...noExecutionPlan("not_applicable"),
      status: "recommended",
      surface: "terminal",
      terminalCompletion: "exit_zero",
      entry: "must-never-execute",
      steps: [{ action: "expect_output", text: "synthetic" }],
    },
  ];
  for (const plan of plans) {
    const report = renderedReport(plan);
    const cases = [
      ...Object.entries(invalidPayloads).map(([name, payload]) => [
        name,
        withSteps(report, payload),
      ]),
      ["missing Steps label", withSteps(report, "").replace("Steps:\n\n", "")],
      [
        "attachment without steps",
        withSteps(report, `${LIVE_VERIFICATION_MARKER}\nResult: absent`),
      ],
    ];
    for (const [name, malformed] of cases) {
      assert.equal(reportLiveProofPlan(malformed!).invalid, true, `${plan.status}: ${name}`);
      fixture.write(malformed!);
      assert.throws(fixture.inspect, /live proof plan for 42 is invalid/);
      assert.throws(fixture.execute, /live proof plan for 42 is invalid/);
      fixture.assertRecordsOnly();
    }
  }
});

test("padded attachment markers reject before inspection or execution at raw section boundaries", (t) => {
  const fixture = reviewFixture(t);
  const plans: LiveProofPlan[] = [
    noExecutionPlan("declined_suspicious"),
    noExecutionPlan("not_applicable"),
    {
      ...noExecutionPlan("not_applicable"),
      status: "recommended",
      surface: "terminal",
      terminalCompletion: "exit_zero",
      entry: "must-never-execute",
      steps: [{ action: "expect_output", text: "synthetic" }],
    },
  ];
  for (const plan of plans) {
    for (const marker of [LIVE_VERIFICATION_MARKER, LIVE_PROOF_RECORDING_MARKER]) {
      for (const whitespace of [" ", "\t", "\u00a0"]) {
        for (const padded of [whitespace + marker, marker + whitespace]) {
          for (const trailer of ["", "\nnot-a-step"]) {
            for (const [boundary, malformed] of reportBoundaryVariants(
              renderedReport(plan, `\n\n${padded}${trailer}`),
            )) {
              const context = `${plan.status}: ${JSON.stringify(padded + trailer)}: ${boundary}`;
              assert.equal(attachedVerificationStatus(malformed, plan), "absent", context);
              assert.equal(reportLiveProofPlan(malformed).invalid, true, context);
              fixture.write(malformed);
              assert.throws(fixture.inspect, /live proof plan for 42 is invalid/, context);
              assert.throws(fixture.execute, /live proof plan for 42 is invalid/, context);
              fixture.assertRecordsOnly();
            }
          }
        }
      }
      // A terminal lone CR is not a CRLF line ending and must not become an exact marker.
      const malformed = reportBoundaryVariants(renderedReport(plan, `\n\n${marker}\r`))[0]![1];
      assert.equal(attachedVerificationStatus(malformed, plan), "absent");
      assert.equal(reportLiveProofPlan(malformed).invalid, true);
      fixture.write(malformed);
      assert.throws(fixture.inspect, /live proof plan for 42 is invalid/);
      assert.throws(fixture.execute, /live proof plan for 42 is invalid/);
      fixture.assertRecordsOnly();
    }
  }
});

test("exact raw markers delimit steps while malformed attachment validation stays separate", () => {
  const plan = noExecutionPlan("not_applicable");
  for (const marker of [LIVE_VERIFICATION_MARKER, LIVE_PROOF_RECORDING_MARKER]) {
    for (const trailer of ["", "\nnot-a-step"]) {
      for (const [boundary, report] of reportBoundaryVariants(
        renderedReport(plan, `\n\n${marker}${trailer}`),
      )) {
        assert.deepEqual(reportLiveProofPlan(report), plan, boundary);
        assert.equal(
          attachedVerificationStatus(report, plan),
          marker === LIVE_VERIFICATION_MARKER ? "malformed" : "absent",
          boundary,
        );
      }
    }
  }
});

test("recommended plans still reject both empty report formats", (t) => {
  const fixture = reviewFixture(t);
  for (const surface of ["browser", "terminal"] as const) {
    const plan: LiveProofPlan = {
      ...noExecutionPlan("not_applicable"),
      status: "recommended",
      surface,
      terminalCompletion: surface === "terminal" ? "exit_zero" : "not_applicable",
      entry: surface === "terminal" ? "must-never-execute" : "/synthetic",
      steps: [],
    };
    assert.throws(
      () => parseDecision(closeDecision({ liveProofPlan: plan })),
      /steps must not be empty/,
    );
    const report = renderedReport({
      ...plan,
      steps: [
        surface === "terminal"
          ? { action: "expect_output", text: "synthetic" }
          : { action: "expect_text", text: "synthetic" },
      ],
    });
    for (const payload of ["[]", "- none"]) {
      const malformed = withSteps(report, payload);
      assert.equal(reportLiveProofPlan(malformed).invalid, true);
      fixture.write(malformed);
      assert.throws(fixture.inspect, /live proof plan for 42 is invalid/);
      assert.throws(fixture.execute, /live proof plan for 42 is invalid/);
    }
  }
});

test("nonempty report steps preserve command order and attached verification/recording suffixes", () => {
  const plan: LiveProofPlan = {
    ...noExecutionPlan("not_applicable"),
    status: "recommended",
    surface: "terminal",
    terminalCompletion: "exit_zero",
    entry: "synthetic-command",
    steps: [
      { action: "run", command: "synthetic-command" },
      { action: "expect_output", text: `none [] ${LIVE_VERIFICATION_MARKER}` },
      { action: "run", command: "synthetic-command" },
    ],
  };
  const verification = buildLiveVerificationResult({
    repo: "openclaw/clawsweeper",
    item: 42,
    headSha: HEAD,
    plan,
    driveStatus: "completed",
    stepLog: plan.steps.map((step) => ({
      action: step.action,
      status: "completed",
      detail: "Synthetic outcome.",
      presentAtStart: false,
      satisfied: true,
    })),
    output: "Synthetic output.",
    verifiedAt: "2026-08-27T00:00:00.000Z",
  });
  const verificationBlock = `${LIVE_VERIFICATION_MARKER}\nResult: ${encodeLiveVerificationReportPayload(verification)}`;
  const recordingBlock = `${LIVE_PROOF_RECORDING_MARKER}\n\n[![Live proof recording](https://media.example.test/poster.jpg)](https://media.example.test/proof.mp4)\n\n*Recorded live on the PR head (\`${HEAD.slice(0, 12)}\`), 4s, terminal surface.*`;
  for (const suffix of [
    "",
    `\n\n${verificationBlock}`,
    `\n\n${recordingBlock}`,
    `\n\n${verificationBlock}\n\n${recordingBlock}`,
  ]) {
    const rendered = renderedReport(plan, suffix);
    assert.match(rendered, /Steps:\n\n- \{"action":"run"/);
    for (const [boundary, report] of reportBoundaryVariants(rendered)) {
      assert.deepEqual(reportLiveProofPlan(report), plan, boundary);
      if (suffix.includes(verificationBlock)) {
        assert.equal(attachedVerificationStatus(report, plan), "passed", boundary);
      }
    }
  }
});
