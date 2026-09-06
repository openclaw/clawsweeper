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
export async function verifyReviewProofProducerToken(
  token: string,
  expected: ProducerIdentity,
  options: { fetch?: typeof fetch; now?: number } = {},
): Promise<boolean> {
  try {
    if (token.length > 16_384) return false;
    const segments = token.split(".");
    if (segments.length !== 3 || segments.some((s) => !/^[A-Za-z0-9_-]+$/.test(s))) return false;
    const header = part(segments[0]!);
    const claims = part(segments[1]!);
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      header.kid.length > 200 ||
      header.crit !== undefined
    )
      return false;
    const now = (options.now ?? Date.now()) / 1000;
    const workflowRef = "openclaw/openclaw/" + expected.workflowPath + "@refs/heads/main";
    if (
      claims.iss !== ISSUER ||
      claims.aud !== REVIEW_PROOF_PRODUCER_ENDPOINT ||
      claims.repository !== "openclaw/openclaw" ||
      claims.repository_id !== expected.repositoryId ||
      claims.event_name !== "workflow_dispatch" ||
      claims.ref !== "refs/heads/main" ||
      claims.sha !== expected.workflowSha ||
      claims.workflow_ref !== workflowRef ||
      claims.workflow_sha !== expected.workflowSha ||
      claims.run_id !== expected.runId ||
      claims.run_attempt !== String(expected.runAttempt) ||
      (claims.job_workflow_ref !== undefined && claims.job_workflow_ref !== workflowRef) ||
      (claims.job_workflow_sha !== undefined && claims.job_workflow_sha !== expected.workflowSha) ||
      typeof claims.exp !== "number" ||
      typeof claims.iat !== "number" ||
      typeof claims.nbf !== "number" ||
      claims.exp <= now ||
      claims.nbf > now + 30 ||
      claims.iat > now + 30 ||
      claims.exp - claims.iat > 600 ||
      claims.iat < now - 600
    )
      return false;
    const response = await (options.fetch ?? fetch)(JWKS, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: "application/json" },
    });
    if (!response.ok || Number(response.headers.get("content-length") || 0) > 65_536) return false;
    const reader = response.body?.getReader();
    if (!reader) return false;
    let length = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > 65_536) {
        await reader.cancel();
        return false;
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
    if (!Array.isArray(keys) || keys.length > 20) return false;
    const matches = keys.filter(
      (key) =>
        key.kid === header.kid &&
        key.kty === "RSA" &&
        (key.alg === undefined || key.alg === "RS256") &&
        (key.use === undefined || key.use === "sig"),
    );
    if (matches.length !== 1) return false;
    const key = await crypto.subtle.importKey(
      "jwk",
      matches[0],
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      bytes(segments[2]!),
      new TextEncoder().encode(segments[0] + "." + segments[1]),
    );
  } catch {
    return false;
  }
}
