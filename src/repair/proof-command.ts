import { createHash } from "node:crypto";

export const PROOF_COMMAND_USAGE =
  "@clawsweeper proof [scenario-id[,scenario-id...]] [40-character-head-sha]";

export interface ProofCommandRequest {
  repository: string;
  pullRequest: number;
  headSha: string;
  scenarioId: string;
  requestId: string;
}

export interface ProofCommandAdmission {
  status: "inconclusive" | "queued";
  reason: string;
  request?: ProofCommandRequest;
}

// Parse admission separately from execution. Only the pinned, durable consumer
// may turn this into an asynchronous request; never freeform assist or override.
export function admitProofCommand(input: {
  commandText: string;
  repository: string;
  pullRequest: number;
  isPullRequest: boolean;
  isOpen: boolean;
  maintainerAuthorized: boolean;
  currentHeadSha: string;
}): ProofCommandAdmission {
  if (!input.maintainerAuthorized) {
    return inconclusive("Proof requests require a human maintainer with repository permission.");
  }
  if (!input.isPullRequest || !input.isOpen) {
    return inconclusive("Proof requests require an open pull request.");
  }
  const match = input.commandText
    .trim()
    .match(
      /^proof(?: ([a-z0-9][a-z0-9-]{0,79}(?:,[a-z0-9][a-z0-9-]{0,79}){0,2}))?(?: ([0-9a-f]{40}))?$/,
    );
  if (!match) {
    return inconclusive("Use " + PROOF_COMMAND_USAGE + "; only supported scenarios are accepted.");
  }
  const scenarioId = match[1] ?? "auto";
  const headSha = match[2] ?? input.currentHeadSha;
  if (!/^[0-9a-f]{40}$/.test(headSha) || headSha !== input.currentHeadSha) {
    return inconclusive(
      "Requested head is not the current PR head. Submit a new exact-head request.",
    );
  }
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(input.repository) ||
    [".", ".."].includes(input.repository.split("/")[1] ?? "") ||
    !Number.isSafeInteger(input.pullRequest) ||
    input.pullRequest <= 0
  ) {
    return inconclusive("The proof target identity could not be verified.");
  }
  const identity = {
    repository: input.repository.toLowerCase(),
    pullRequest: input.pullRequest,
    headSha,
    scenarioId,
  };
  return {
    status: "inconclusive",
    reason:
      "No authenticated, request-bound behavioral-proof producer is connected. Nothing was dispatched. Media, PASS text, and exit status cannot establish proof or readiness.",
    request: {
      ...identity,
      requestId: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    },
  };
}

export function renderProofCommandAdmission(admission: ProofCommandAdmission): string {
  const request = admission.request;
  return [
    admission.status === "queued"
      ? "Behavioral proof: **queued for the selected checks**."
      : "Behavioral proof: **inconclusive**.",
    "",
    admission.reason,
    ...(request
      ? [
          "",
          "Target: https://github.com/" + request.repository + "/pull/" + request.pullRequest,
          "Head: " + request.headSha,
          "Scenario: " + request.scenarioId,
          "Request identity: " + request.requestId,
        ]
      : []),
    "",
    admission.status === "queued"
      ? "No proof, review, security, or CI blocker was cleared. Authenticated observations still require independent proof assessment; no merge or repair is authorized."
      : "No proof, review, security, or CI blocker was cleared. This is not a queued run and will not start automatically later. Existing review and merge gates are unchanged.",
  ].join("\n");
}

function inconclusive(reason: string): ProofCommandAdmission {
  return { status: "inconclusive", reason };
}
