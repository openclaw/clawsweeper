/** GitHub-signed producer identity; correlation IDs alone never authorize account use. */
export const REVIEW_PROOF_PRODUCER_ENDPOINT =
  "https://clawsweeper.openclaw.ai/internal/exact-review/proof/producer";
const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS = ISSUER + "/.well-known/jwks";

type ProducerIdentity = {
  repositoryId: string;
  workflowPath: string;
  workflowSha: string;
  runId: string;
  runAttempt: number;
};
function bytes(value: string) {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (character) =>
    character.charCodeAt(0),
  );
}
function part(value: string): Record<string, unknown> {
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(value)));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid_jwt");
  return parsed;
}
export async function authenticateReviewProofProducerToken(
  token: string,
  options: { fetch?: typeof fetch; now?: number } = {},
): Promise<ProducerIdentity | null> {
  try {
    if (token.length > 16_384) return null;
    const segments = token.split(".");
    if (segments.length !== 3 || segments.some((s) => !/^[A-Za-z0-9_-]+$/.test(s))) return null;
    const header = part(segments[0]!);
    const claims = part(segments[1]!);
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      header.kid.length > 200 ||
      header.crit !== undefined
    )
      return null;
    const now = (options.now ?? Date.now()) / 1000;
    const workflowPath = [
      ".github/workflows/mantis-telegram-bot-e2e-proof.yml",
      ".github/workflows/mantis-web-ui-chat-proof.yml",
    ].find((path) => claims.workflow_ref === `openclaw/openclaw/${path}@refs/heads/main`);
    const workflowRef = claims.workflow_ref;
    if (
      claims.iss !== ISSUER ||
      claims.aud !== REVIEW_PROOF_PRODUCER_ENDPOINT ||
      claims.repository !== "openclaw/openclaw" ||
      typeof claims.repository_id !== "string" ||
      !/^[1-9][0-9]{0,19}$/.test(claims.repository_id) ||
      claims.event_name !== "workflow_dispatch" ||
      claims.ref !== "refs/heads/main" ||
      !workflowPath ||
      typeof claims.sha !== "string" ||
      !/^[0-9a-f]{40}$/.test(claims.sha) ||
      claims.workflow_sha !== claims.sha ||
      typeof claims.run_id !== "string" ||
      !/^[1-9][0-9]{0,19}$/.test(claims.run_id) ||
      claims.run_attempt !== "1" ||
      (claims.job_workflow_ref !== undefined && claims.job_workflow_ref !== workflowRef) ||
      (claims.job_workflow_sha !== undefined && claims.job_workflow_sha !== claims.sha) ||
      typeof claims.exp !== "number" ||
      typeof claims.iat !== "number" ||
      typeof claims.nbf !== "number" ||
      claims.exp <= now ||
      claims.nbf > now + 30 ||
      claims.iat > now + 30 ||
      claims.exp - claims.iat > 600 ||
      claims.iat < now - 600
    )
      return null;
    const response = await (options.fetch ?? fetch)(JWKS, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: "application/json" },
    });
    if (!response.ok || Number(response.headers.get("content-length") || 0) > 65_536) return null;
    const reader = response.body?.getReader();
    if (!reader) return null;
    let length = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > 65_536) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
    const data = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    const keys = JSON.parse(new TextDecoder().decode(data)).keys;
    if (!Array.isArray(keys) || keys.length > 20) return null;
    const matches = keys.filter(
      (key) =>
        key.kid === header.kid &&
        key.kty === "RSA" &&
        (key.alg === undefined || key.alg === "RS256") &&
        (key.use === undefined || key.use === "sig"),
    );
    if (matches.length !== 1) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      matches[0],
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      bytes(segments[2]!),
      new TextEncoder().encode(segments[0] + "." + segments[1]),
    );
    return verified
      ? {
          repositoryId: claims.repository_id,
          workflowPath,
          workflowSha: claims.sha,
          runId: claims.run_id,
          runAttempt: 1,
        }
      : null;
  } catch {
    return null;
  }
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
