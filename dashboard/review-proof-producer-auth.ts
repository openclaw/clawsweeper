import { verifiedGithubActionsOidcClaims } from "./github-actions-oidc.ts";

/** GitHub-signed producer identity; correlation IDs alone never authorize account use. */
export const REVIEW_PROOF_PRODUCER_ENDPOINT =
  "https://clawsweeper.openclaw.ai/internal/exact-review/proof/producer";

type ProducerIdentity = {
  repositoryId: string;
  workflowPath: string;
  workflowSha: string;
  runId: string;
  runAttempt: number;
};
const PRODUCER_WORKFLOW_PATHS = [
  ".github/workflows/mantis-telegram-bot-e2e-proof.yml",
  ".github/workflows/mantis-web-ui-chat-proof.yml",
];
function producerWorkflowPath(claims: Record<string, unknown>) {
  return PRODUCER_WORKFLOW_PATHS.find(
    (path) => claims.workflow_ref === `openclaw/openclaw/${path}@refs/heads/main`,
  );
}
export async function authenticateReviewProofProducerToken(
  token: string,
  options: { fetch?: typeof fetch; now?: number } = {},
): Promise<ProducerIdentity | null> {
  const claims = await verifiedGithubActionsOidcClaims(
    token,
    REVIEW_PROOF_PRODUCER_ENDPOINT,
    (claims) =>
      claims.repository === "openclaw/openclaw" &&
      typeof claims.repository_id === "string" &&
      /^[1-9][0-9]{0,19}$/.test(claims.repository_id) &&
      claims.event_name === "workflow_dispatch" &&
      claims.ref === "refs/heads/main" &&
      producerWorkflowPath(claims) !== undefined &&
      typeof claims.sha === "string" &&
      /^[0-9a-f]{40}$/.test(claims.sha) &&
      claims.workflow_sha === claims.sha &&
      typeof claims.run_id === "string" &&
      /^[1-9][0-9]{0,19}$/.test(claims.run_id) &&
      claims.run_attempt === "1" &&
      (claims.job_workflow_ref === undefined || claims.job_workflow_ref === claims.workflow_ref) &&
      (claims.job_workflow_sha === undefined || claims.job_workflow_sha === claims.sha),
    options,
  );
  const workflowPath = claims ? producerWorkflowPath(claims) : undefined;
  return claims && workflowPath
    ? {
        repositoryId: String(claims.repository_id),
        workflowPath,
        workflowSha: String(claims.sha),
        runId: String(claims.run_id),
        runAttempt: 1,
      }
    : null;
}

export function reviewProofProducerMatches(
  actual: ProducerIdentity,
  expected: ProducerIdentity,
): boolean {
  return (
    actual.repositoryId === expected.repositoryId &&
    actual.workflowPath === expected.workflowPath &&
    actual.workflowSha === expected.workflowSha &&
    actual.runId === expected.runId &&
    actual.runAttempt === expected.runAttempt
  );
}

export async function verifyReviewProofProducerToken(
  token: string,
  expected: ProducerIdentity,
  options: { fetch?: typeof fetch; now?: number } = {},
): Promise<boolean> {
  const actual = await authenticateReviewProofProducerToken(token, options);
  return actual !== null && reviewProofProducerMatches(actual, expected);
}
