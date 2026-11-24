import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { PrClassificationError } from "./pr-classification-error.js";
import {
  recordWorkflowPhaseEvent,
  startWorkflowMutationAttempt,
  finishWorkflowMutationAttempt,
} from "./action-ledger-runtime.js";
import {
  ACTION_EVENT_TYPES,
  type ActionEventAttributes,
  type ActionEventStatus,
} from "./action-ledger.js";
import { createLabelMutationOperations, type LabelGh } from "./clawsweeper-label-mutations.js";
import {
  ghObservedMutationCommand,
  withMutationReceiptRunner,
} from "./clawsweeper-github-execution.js";
import { withGitHubRun } from "./clawsweeper-github-runtime.js";
import { IMPACT_LABEL_NAMES, PRIORITY_LABELS } from "./clawsweeper-policy.js";
import { readIntakeSnapshot, type IntakeSnapshot } from "./intake-triage-workflow.js";
import {
  classifyPullRequest,
  parsePrClassification,
  PR_CLASSIFICATION_INPUT_BYTES,
  prClassificationRequest,
  PR_CLASSIFICATION_MODEL,
  PR_CLASSIFICATION_POLICY,
  type PrClassificationApiOptions,
  type PrClassificationResult,
} from "./pr-classification.js";
import {
  readPrClassificationSource,
  type PrClassificationSource,
} from "./pr-classification-source.js";
import { ghJson } from "./repair/github-cli.js";
import { repoRoot } from "./repair/paths.js";

export interface PrClassificationWorkflowOptions {
  repository: string;
  number: number;
  apiKey: string;
  model?: string;
  root?: string;
  readSnapshot?: () => IntakeSnapshot;
  readSource?: (maxDiffBytes: number) => PrClassificationSource;
  gh?: LabelGh;
  infer?: (options: PrClassificationApiOptions) => Promise<PrClassificationResult>;
  waitBeforeRetry?: () => Promise<void>;
}

export async function runPrClassificationWorkflow(
  options: PrClassificationWorkflowOptions,
): Promise<{ outcome: string; labels: string[] }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { retryable, ...result } = await runPrClassificationAttempt(options, attempt);
      if (attempt === 2 || !retryable) return result;
    } catch (error) {
      if (attempt === 2 || !(error instanceof PrClassificationError) || !error.retryable)
        throw error;
    }
    console.warn("PR classification retrying once with a fresh snapshot; attempt=2");
    await (options.waitBeforeRetry ?? (() => setTimeout(2_000)))();
  }
}

async function runPrClassificationAttempt(
  options: PrClassificationWorkflowOptions,
  attempt: number,
): Promise<{ outcome: string; labels: string[]; retryable?: boolean }> {
  const model = options.model?.trim() || PR_CLASSIFICATION_MODEL;
  if (!options.apiKey.trim() || model === "off") return { outcome: "disabled", labels: [] };
  return withGitHubRun(async () => {
    const root = options.root ?? repoRoot();
    let digest: string | undefined;
    let mutationAttempted = false;
    const context = {
      phase: ACTION_EVENT_TYPES.workflowAttempt,
      operation: "pr-classification",
      operationIdentity: {
        item: options.repository + "#" + options.number,
        attempt,
      },
      component: "pr-classification",
      subject: {
        repository: options.repository,
        kind: "pull_request" as const,
        number: options.number,
      },
      privacy: {
        classification: "internal" as const,
        redactionVersion: PR_CLASSIFICATION_POLICY,
        fieldsDropped: ["title", "body", "diff", "tool_output", "prompt", "response"],
      },
    };
    let sequence = 0;
    const record = (
      status: ActionEventStatus,
      slot: string,
      attributes: ActionEventAttributes = {},
    ) => {
      if (
        !recordWorkflowPhaseEvent(root, {
          ...context,
          subject: { ...context.subject, ...(digest ? { sourceRevision: digest } : {}) },
          status,
          retryable: false,
          mutation: false,
          identity: { slot, attempt, ...(digest ? { digest } : {}) },
          phaseSeq: ++sequence,
          attributes: { work_kind: "pr-classification", attempt, ...attributes },
        })
      )
        throw new PrClassificationError("receipt-unavailable");
    };
    try {
      record("started", "workflow-start");
      const read =
        options.readSnapshot ??
        (() => readIntakeSnapshot(options.repository, options.number, "pull_request"));
      const snapshot = read();
      if (
        snapshot.repository !== options.repository ||
        snapshot.number !== options.number ||
        snapshot.kind !== "pull_request"
      )
        throw new Error("PR classification target mismatch");
      if (snapshot.state !== "open" || snapshot.locked) {
        record("skipped", "not-open");
        return { outcome: "not_open", labels: [] };
      }
      // Fill a missing priority, never replace a human or completed review's classification.
      if (
        snapshot.labels.some((name) =>
          PRIORITY_LABELS.some((label) => label.name.toLowerCase() === name.toLowerCase()),
        )
      ) {
        record("skipped", "already-classified");
        return { outcome: "already_classified", labels: [] };
      }
      // Truncate the diff, not the job: the diff gets whatever the packet budget leaves.
      const maxDiffBytes = Math.min(
        160_000,
        PR_CLASSIFICATION_INPUT_BYTES -
          Buffer.byteLength(
            JSON.stringify({
              repository: snapshot.repository,
              number: snapshot.number,
              title: snapshot.title,
              body: snapshot.body,
              headSha: snapshot.headSha,
              baseSha: snapshot.headSha,
              diff: "",
            }),
          ),
      );
      const source =
        options.readSource?.(maxDiffBytes) ??
        readPrClassificationSource(
          options.repository,
          options.number,
          snapshot.headSha,
          undefined,
          maxDiffBytes,
        );
      const packet = {
        ...snapshot,
        headSha: source.headSha,
        baseSha: source.baseSha,
        diff: source.diff,
      };
      const request = prClassificationRequest(packet);
      digest = request.digest;
      const identity = JSON.stringify({ ...snapshot, labels: [...snapshot.labels].sort() });
      const assertCurrent = () => {
        source.assertCurrent();
        const live = read();
        if (JSON.stringify({ ...live, labels: [...live.labels].sort() }) !== identity)
          throw new PrClassificationError("snapshot-drift", true);
      };
      let guardFailure: unknown;
      const result = await (options.infer ?? classifyPullRequest)({
        packet,
        readTool: source.readTool,
        cwd: root,
        apiKey: options.apiKey,
        model,
        recordAttempt: () => {
          try {
            assertCurrent();
            record("started", "inference-intent", { model });
          } catch (error) {
            guardFailure = error;
            throw error;
          }
        },
      });
      record(result.outcome === "classified" ? "classified" : "skipped", "inference-result", {
        completion_reason: result.outcome,
        ...(result.diagnostic ? { status_kind: result.diagnostic } : {}),
        ...(result.usage
          ? { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens }
          : {}),
      });
      if (result.outcome !== "classified")
        console.warn(
          "PR classification attempt=" +
            attempt +
            " outcome=" +
            result.outcome +
            " diagnostic=" +
            (result.diagnostic ?? "none"),
        );
      if (guardFailure) throw guardFailure;
      const classification =
        result.outcome === "classified" ? parsePrClassification(result.classification) : null;
      if (!classification || classification.priority === "unclear")
        return {
          outcome: result.outcome === "classified" ? "unclear" : result.outcome,
          labels: [],
          retryable: result.retryable === true,
        };
      const priority = PRIORITY_LABELS.find((label) => label.name === classification.priority)!;
      // Existing impact labels also remain human/review-owned. Never remove labels.
      const impact = snapshot.labels.some((label) => IMPACT_LABEL_NAMES.has(label.toLowerCase()))
        ? []
        : classification.impact;
      const wanted = [priority.name, ...impact];
      const gh = options.gh ?? {
        readLabelCatalogPages: () =>
          ghJson<unknown>([
            "api",
            "repos/" + options.repository + "/labels?per_page=100",
            "--paginate",
            "--slurp",
          ]),
        ghObservedMutationCommand: (
          mutation: Parameters<LabelGh["ghObservedMutationCommand"]>[0],
        ) =>
          ghObservedMutationCommand({
            ...mutation,
            attempts: 1,
            args: [...mutation.args, "--repo", options.repository],
          }),
      };
      const mutations = createLabelMutationOperations(gh);
      const state = {
        index: 0,
        mutationAttemptCount: 0,
        startEventId: null,
        lastEventId: null,
        uncertainMutationObserved: false,
      };
      try {
        const published = withMutationReceiptRunner(
          ({ identity, idempotencyIdentity, operation, knownNoMutation }) => {
            assertCurrent();
            const attempt = startWorkflowMutationAttempt(root, state, identity, {
              ...context,
              subject: { ...context.subject, sourceRevision: request.digest },
              slot: "label-intent",
              phaseSeq: ++sequence,
              idempotencyIdentity,
            });
            if (!attempt.eventId) throw new PrClassificationError("receipt-unavailable");
            try {
              mutationAttempted = true;
              const output = operation();
              finishWorkflowMutationAttempt(root, attempt, "accepted", {
                ...context,
                subject: { ...context.subject, sourceRevision: request.digest },
                slot: "label-result",
                phaseSeq: ++sequence,
              });
              return output;
            } catch (error) {
              finishWorkflowMutationAttempt(
                root,
                attempt,
                knownNoMutation?.(error) ? "rejected" : "unknown",
                {
                  ...context,
                  subject: { ...context.subject, sourceRevision: request.digest },
                  slot: "label-result",
                  phaseSeq: ++sequence,
                },
              );
              throw error;
            }
          },
          () => {
            mutations.beginIssueLabelMutationBatch(options.number);
            mutations.ensurePriorityLabel(priority);
            mutations.addIssueLabel(options.number, priority.name);
            for (const label of impact) {
              mutations.ensureImpactLabel(label);
              mutations.addIssueLabel(options.number, label);
            }
            return mutations.flushIssueLabelMutationBatch(options.number);
          },
        );
        record("completed", "publication-result", {
          action_count: Number(published.itemMutationPublished),
        });
        return {
          outcome: published.itemMutationPublished ? "published" : "unchanged",
          labels: wanted,
        };
      } finally {
        mutations.discardIssueLabelMutationBatch(options.number);
      }
    } catch (error) {
      const diagnostic =
        error instanceof PrClassificationError ? error.diagnostic : "workflow-error";
      record("failed", "workflow-failure", { status_kind: diagnostic });
      if (error instanceof PrClassificationError)
        throw new PrClassificationError(error.diagnostic, error.retryable && !mutationAttempted);
      throw error;
    }
  });
}

export async function prClassificationWorkflowMain(): Promise<void> {
  const repository = process.env.TARGET_REPO ?? "";
  const number = Number(process.env.ITEM_NUMBER);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(number) || number <= 0)
    throw new Error("Invalid PR classification workflow configuration");
  const result = await runPrClassificationWorkflow({
    repository,
    number,
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.CLAWSWEEPER_CLASSIFICATION_MODEL ?? "",
  });
  console.log(JSON.stringify({ classification: result.outcome, labels: result.labels }));
  if (["unavailable", "timeout"].includes(result.outcome)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prClassificationWorkflowMain().catch((error: unknown) => {
    console.error(
      "PR classification failed; diagnostic=" +
        (error instanceof PrClassificationError ? error.diagnostic : "workflow-error") +
        "; review admission is unchanged.",
    );
    process.exitCode = 1;
  });
}
