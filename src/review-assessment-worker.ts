import { AgentInputScanError, scanAgentInput } from "./agent-input-scan.js";
import { readFileSync } from "node:fs";
import { createReviewCoreRuntime } from "./clawsweeper-review-core.js";
import { reviewDecisionParser } from "./clawsweeper-decision-parser.js";
import { run, ensureDir } from "./clawsweeper-review-io.js";
import {
  REVIEW_ITEM_PROMPT_PATHS,
  CLAWSWEEPER_DECISION_SCHEMA_PATH,
  PR_CLOSE_COVERAGE_PROOF_PROMPT_PATH,
} from "./clawsweeper-repository-paths.js";
import type { AssessmentJob } from "./multi-model-review.js";
import type { ReviewExecutionReceipt } from "./review-execution-receipt.js";
import { assessmentRecoveryReceipt, CodexReviewError } from "./review-assessment-failure.js";

// Internal, host-created options only. No dispatch, publication, or nested orchestration.
const job = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as AssessmentJob & {
  reviewEnvKeys: string[];
};
job.options.reviewEnv = Object.fromEntries(
  job.reviewEnvKeys
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
const core = createReviewCoreRuntime({
  reviewItemPromptPaths: REVIEW_ITEM_PROMPT_PATHS,
  decisionSchemaPath: CLAWSWEEPER_DECISION_SCHEMA_PATH,
  prCloseCoverageProofPromptPath: PR_CLOSE_COVERAGE_PROOF_PROMPT_PATH,
  run,
  ensureDir,
  untrustedCodexEnv: () => job.options.reviewEnv ?? {},
  defaultRootCauseCluster: reviewDecisionParser.defaultRootCauseCluster,
  parseDecision: reviewDecisionParser.parseDecision,
});
let execution: ReviewExecutionReceipt | undefined;
try {
  if (Date.now() >= job.deadlineAt) throw new AgentInputScanError("deadline");
  const decision = core.runCodex({
    ...job.options,
    timeoutMs: Math.max(1, job.deadlineAt - Date.now()),
    onExecution: (receipt) => {
      execution = receipt;
    },
  });
  // No model-authored Decision crosses into durable advisory evidence without scanning.
  scanAgentInput({
    cwd: job.options.openclawDir,
    source: { kind: "prompt" },
    prompt: JSON.stringify({ decision, ...(execution ? { execution } : {}) }),
    timeoutMs: job.deadlineAt - Date.now(),
  });
  process.stdout.write(JSON.stringify({ decision, ...(execution ? { execution } : {}) }));
} catch (error) {
  const recovery = assessmentRecoveryReceipt(error);
  if (recovery) {
    process.stdout.write(JSON.stringify({ recovery }));
  } else if (error instanceof AgentInputScanError) {
    process.stdout.write(JSON.stringify({ scanRefusal: error.reason }));
  } else {
    // Do not transfer raw diagnostics or provider endpoints to the durable record.
    // Transport completion is not assessment success: no Decision means failed.
    const failure = core.codexReviewFailure(error);
    process.stdout.write(
      JSON.stringify({
        failure: {
          // The legacy helper retries unknown exceptions for single reviews.
          // A new paid batch requires explicitly classified native failure.
          retryable:
            error instanceof CodexReviewError &&
            core.codexReviewFailureRetryable(error) &&
            !failure.decision.codexTerminalFailure &&
            ["timeout", "transport_network", "provider_throttle"].includes(failure.logKind),
          terminal: Boolean(failure.decision.codexTerminalFailure),
          logKind: failure.logKind,
        },
      }),
    );
  }
}
