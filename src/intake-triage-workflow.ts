import { appendFileSync } from "node:fs";
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
import { ghJson } from "./repair/github-cli.js";
import { repoRoot } from "./repair/paths.js";
import { exactReviewQueueAuthorityFence } from "./repair/update-command-status.js";
import {
  intakeRequest,
  intakeLabels,
  parseIntakeAnswers,
  INTAKE_POLICY,
  INTAKE_DEFAULT_MODEL,
  type IntakePacket,
  type IntakeResult,
} from "./intake-triage-contract.js";
import { runResponsesIntake, type IntakeApiOptions } from "./intake-triage-api.js";
import { runDecisionsIntake } from "./intake-triage-decisions.js";
import { isRecord } from "./value-coerce.js";

export interface IntakeSnapshot extends IntakePacket {
  state: string;
  locked: boolean;
  updatedAt: string;
  labels: string[];
  headSha: string;
}
export interface IntakeWorkflowOptions {
  repository: string;
  number: number;
  kind: IntakePacket["kind"];
  apiKey: string;
  backend: "responses" | "decisions";
  model?: string;
  root?: string;
  readSnapshot?: () => IntakeSnapshot;
  fence?: (phase: "status" | "review") => boolean;
  gh?: LabelGh;
  infer?: (options: IntakeApiOptions) => Promise<IntakeResult>;
  admissionUnchanged?: (value: boolean) => void;
}
class IntakeGuardError extends Error {
  constructor() {
    super("Intake source or queue ownership changed");
    this.name = "IntakeGuardError";
  }
}

export function readIntakeSnapshot(
  repository: string,
  number: number,
  kind: IntakePacket["kind"],
): IntakeSnapshot {
  // Use one metadata response for PR text, labels, timestamp and head. Mixing
  // issues and pulls responses can construct a snapshot GitHub never held.
  const item: unknown = ghJson(
    ["api", `repos/${repository}/${kind === "pull_request" ? "pulls" : "issues"}/${number}`],
    { timeoutMs: 10_000 },
  );
  if (
    !isRecord(item) ||
    item.number !== number ||
    typeof item.title !== "string" ||
    !(item.body === null || typeof item.body === "string") ||
    typeof item.updated_at !== "string" ||
    typeof item.state !== "string" ||
    typeof item.locked !== "boolean" ||
    !Array.isArray(item.labels) ||
    (kind === "issue" && Boolean(item.pull_request))
  )
    throw new Error("Invalid intake item metadata");
  const labels = item.labels.map((label) => {
    if (!isRecord(label) || typeof label.name !== "string")
      throw new Error("Invalid intake label metadata");
    return label.name;
  });
  let headSha = "";
  if (kind === "pull_request") {
    if (
      !isRecord(item.head) ||
      typeof item.head.sha !== "string" ||
      !/^[0-9a-f]{40}$/.test(item.head.sha)
    )
      throw new Error("Invalid intake pull request head");
    headSha = item.head.sha;
  }
  return {
    repository,
    number,
    kind,
    title: item.title,
    body: item.body ?? "",
    state: item.state,
    locked: item.locked,
    updatedAt: item.updated_at,
    labels,
    headSha,
  };
}
function snapshotIdentity(snapshot: IntakeSnapshot): string {
  return JSON.stringify({ ...snapshot, labels: [...snapshot.labels].sort() });
}

export async function runIntakeWorkflow(
  options: IntakeWorkflowOptions,
): Promise<{ outcome: string; labels: string[] }> {
  // Bypass the old admission handoff before any possible item write. The next
  // review must hydrate post-intake labels and timestamps, including uncertain writes.
  const model = options.model?.trim() || INTAKE_DEFAULT_MODEL;
  const disabled = !options.apiKey.trim() || model === "off";
  options.admissionUnchanged?.(disabled);
  if (disabled) return { outcome: "disabled", labels: [] };
  return withGitHubRun(async () => {
    const env = process.env;
    const root = options.root ?? repoRoot();
    if (env.EXACT_REVIEW_ITEM_KEY !== `${options.repository}#${options.number}`)
      throw new IntakeGuardError();
    const read =
      options.readSnapshot ??
      (() => readIntakeSnapshot(options.repository, options.number, options.kind));
    const fence =
      options.fence ?? ((phase) => exactReviewQueueAuthorityFence(env, undefined, phase));
    const snapshot = read();
    if (
      snapshot.repository !== options.repository ||
      snapshot.number !== options.number ||
      snapshot.kind !== options.kind ||
      snapshot.state !== "open" ||
      snapshot.locked ||
      (snapshot.kind === "pull_request" && snapshot.headSha !== env.EXACT_REVIEW_SOURCE_HEAD_SHA)
    )
      throw new IntakeGuardError();
    const request = intakeRequest(snapshot);
    const subject = {
      repository: options.repository,
      kind: snapshot.kind,
      number: options.number,
      sourceRevision: request.digest,
    };
    const operationIdentity = {
      item: env.EXACT_REVIEW_ITEM_KEY,
      lease: env.EXACT_REVIEW_LEASE_ID,
      revision: env.EXACT_REVIEW_LEASE_REVISION,
      generation: env.EXACT_REVIEW_CLAIM_GENERATION,
      digest: request.digest,
    };
    const context = {
      phase: ACTION_EVENT_TYPES.workflowAttempt,
      operation: "intake-triage",
      operationIdentity,
      component: "intake-triage",
      subject,
      privacy: {
        classification: "internal" as const,
        redactionVersion: "intake-v1",
        fieldsDropped: ["title", "body", "prompt", "response"],
      },
    };
    let sequence = 0;
    const record = (
      status: ActionEventStatus,
      slot: string,
      attributes: ActionEventAttributes = {},
    ) => {
      const event = recordWorkflowPhaseEvent(
        root,
        {
          ...context,
          status,
          retryable: false,
          mutation: false,
          identity: { slot, digest: request.digest, backend: options.backend },
          phaseSeq: ++sequence,
          attributes: { work_kind: "intake", ...attributes },
        },
        { env },
      );
      if (!event) throw new Error("Intake requires durable action receipts");
      return event;
    };
    if (!fence("review")) throw new IntakeGuardError();
    const result = await (
      options.infer ?? (options.backend === "decisions" ? runDecisionsIntake : runResponsesIntake)
    )({
      cwd: root,
      request,
      apiKey: options.apiKey,
      model,
      recordAttempt: () => {
        // Scanning can outlive the original lease or submission. Fence the paid
        // request after scanning, immediately before its durable intent and dispatch.
        if (!fence("review") || snapshotIdentity(read()) !== snapshotIdentity(snapshot))
          throw new IntakeGuardError();
        record("started", "inference-intent", { model });
      },
    });
    record(result.outcome === "classified" ? "classified" : "skipped", "inference-result", {
      completion_reason: result.outcome,
      duration_ms: result.durationMs,
      ...(result.usage
        ? { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens }
        : {}),
    });
    if (
      result.policy !== INTAKE_POLICY ||
      result.digest !== request.digest ||
      result.backend !== options.backend
    )
      throw new IntakeGuardError();
    if (result.outcome !== "classified") return { outcome: result.outcome, labels: [] };
    if (!parseIntakeAnswers(result.answers)) throw new IntakeGuardError();
    const wanted = intakeLabels(result);
    let held = false;
    const assertCurrent = () => {
      if (!fence("status")) throw new IntakeGuardError();
      held = true;
      if (snapshotIdentity(read()) !== snapshotIdentity(snapshot)) throw new IntakeGuardError();
    };
    const gh = options.gh ?? {
      readLabelCatalogPages: () =>
        ghJson<unknown>([
          "api",
          `repos/${options.repository}/labels?per_page=100`,
          "--paginate",
          "--slurp",
        ]),
      ghObservedMutationCommand: (mutation: Parameters<LabelGh["ghObservedMutationCommand"]>[0]) =>
        ghObservedMutationCommand({
          ...mutation,
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
    const release = () => {
      mutations.discardIssueLabelMutationBatch(options.number);
      if (held && !fence("review")) throw new IntakeGuardError();
    };
    let publication: { outcome: string; labels: string[] };
    try {
      const published = withMutationReceiptRunner(
        ({ identity, idempotencyIdentity, operation, knownNoMutation }) => {
          // A definition write can separate the model answer from the item mutation.
          // Recheck source and queue authority at every actual dispatch, not just once.
          assertCurrent();
          const attempt = startWorkflowMutationAttempt(root, state, identity, {
            ...context,
            slot: "label-intent",
            phaseSeq: ++sequence,
            idempotencyIdentity,
          });
          if (!attempt.eventId) throw new Error("Intake mutation receipt unavailable");
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
          mutations.syncIntakeLabels({
            number: options.number,
            labels: snapshot.labels,
            wanted,
            dryRun: false,
          });
          return mutations.flushIssueLabelMutationBatch(options.number);
        },
      );
      record("completed", "publication-result", {
        action_count: Number(published.itemMutationPublished),
        completion_reason: published.itemMutationPublished
          ? "preliminary_labels"
          : "no_label_change",
      });
      publication = {
        outcome: published.itemMutationPublished ? "published" : "unchanged",
        labels: wanted,
      };
    } catch (error) {
      try {
        release();
      } catch (releaseError) {
        // A lost release fence must not erase an uncertain write's original error.
        // oxlint-disable-next-line preserve-caught-error -- AggregateError retains both failures.
        throw new AggregateError([error, releaseError], "Intake publication and release failed");
      }
      throw error;
    }
    release();
    return publication;
  });
}

export async function intakeWorkflowMain(): Promise<void> {
  const repository = process.env.TARGET_REPO ?? "";
  const number = Number(process.env.ITEM_NUMBER);
  const backend = process.env.CLAWSWEEPER_INTAKE_BACKEND || "decisions";
  const kind = process.env.EXACT_REVIEW_ITEM_KIND;
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    !["responses", "decisions"].includes(backend) ||
    !["issue", "pull_request"].includes(kind ?? "")
  )
    throw new Error("Invalid intake workflow configuration");
  const result = await runIntakeWorkflow({
    repository,
    number,
    kind: kind as IntakePacket["kind"],
    backend: backend as "responses" | "decisions",
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.CLAWSWEEPER_DECISION_MODEL ?? "",
    admissionUnchanged: (value) => {
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, `admission_unchanged=${value}\n`);
    },
  });
  console.log(JSON.stringify({ intake: result.outcome, labels: result.labels }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  intakeWorkflowMain().catch(() => {
    console.error("Intake unavailable; full source review continues independently.");
    process.exitCode = 1;
  });
}
