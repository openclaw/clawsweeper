import { pathToFileURL } from "node:url";
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
  prClassificationRequest,
  PR_CLASSIFICATION_MODEL,
  PR_CLASSIFICATION_POLICY,
  type PrClassificationApiOptions,
  type PrClassificationResult,
} from "./pr-classification.js";
import { ghJson } from "./repair/github-cli.js";
import { repoRoot } from "./repair/paths.js";

export interface PrClassificationWorkflowOptions {
  repository: string;
  number: number;
  apiKey: string;
  model?: string;
  root?: string;
  readSnapshot?: () => IntakeSnapshot;
  gh?: LabelGh;
  infer?: (options: PrClassificationApiOptions) => Promise<PrClassificationResult>;
}

export async function runPrClassificationWorkflow(
  options: PrClassificationWorkflowOptions,
): Promise<{ outcome: string; labels: string[] }> {
  const model = options.model?.trim() || PR_CLASSIFICATION_MODEL;
  if (!options.apiKey.trim() || model === "off") return { outcome: "disabled", labels: [] };
  return withGitHubRun(async () => {
    const root = options.root ?? repoRoot();
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
    if (snapshot.state !== "open" || snapshot.locked) return { outcome: "not_open", labels: [] };
    // Fill a missing priority, never replace a human or completed review's classification.
    if (
      snapshot.labels.some((name) =>
        PRIORITY_LABELS.some((label) => label.name.toLowerCase() === name.toLowerCase()),
      )
    )
      return { outcome: "already_classified", labels: [] };
    const request = prClassificationRequest(snapshot);
    const identity = JSON.stringify({ ...snapshot, labels: [...snapshot.labels].sort() });
    const assertCurrent = () => {
      const live = read();
      if (JSON.stringify({ ...live, labels: [...live.labels].sort() }) !== identity)
        throw new Error("PR changed during classification; no labels published");
    };
    const context = {
      phase: ACTION_EVENT_TYPES.workflowAttempt,
      operation: "pr-classification",
      operationIdentity: {
        item: options.repository + "#" + options.number,
        digest: request.digest,
      },
      component: "pr-classification",
      subject: {
        repository: options.repository,
        kind: "pull_request" as const,
        number: options.number,
        sourceRevision: request.digest,
      },
      privacy: {
        classification: "internal" as const,
        redactionVersion: PR_CLASSIFICATION_POLICY,
        fieldsDropped: ["title", "body", "prompt", "response"],
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
          status,
          retryable: false,
          mutation: false,
          identity: { slot, digest: request.digest },
          phaseSeq: ++sequence,
          attributes: { work_kind: "pr-classification", ...attributes },
        })
      )
        throw new Error("PR classification requires durable action receipts");
    };
    const result = await (options.infer ?? classifyPullRequest)({
      packet: snapshot,
      cwd: root,
      apiKey: options.apiKey,
      model,
      recordAttempt: () => {
        assertCurrent();
        record("started", "inference-intent", { model });
      },
    });
    record(result.outcome === "classified" ? "classified" : "skipped", "inference-result", {
      completion_reason: result.outcome,
      ...(result.usage
        ? { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens }
        : {}),
    });
    const classification =
      result.outcome === "classified" ? parsePrClassification(result.classification) : null;
    if (!classification || classification.priority === "unclear")
      return { outcome: result.outcome === "classified" ? "unclear" : result.outcome, labels: [] };
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
      ghObservedMutationCommand: (mutation: Parameters<LabelGh["ghObservedMutationCommand"]>[0]) =>
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
            slot: "label-intent",
            phaseSeq: ++sequence,
            idempotencyIdentity,
          });
          if (!attempt.eventId) throw new Error("PR classification mutation receipt unavailable");
          try {
            const output = operation();
            finishWorkflowMutationAttempt(root, attempt, "accepted", {
              ...context,
              slot: "label-result",
              phaseSeq: ++sequence,
            });
            return output;
          } catch (error) {
            finishWorkflowMutationAttempt(
              root,
              attempt,
              knownNoMutation?.(error) ? "rejected" : "unknown",
              { ...context, slot: "label-result", phaseSeq: ++sequence },
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
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prClassificationWorkflowMain().catch(() => {
    console.error(
      "PR classification did not finish; review admission is unchanged. Check this run before retrying.",
    );
    process.exitCode = 1;
  });
}
