// Keep known review-job credentials explicit even when the heuristic below
// would also catch them. This list documents the secrets the workflow owns;
// the suffix and provider rules cover credentials added by tools or runners.
const EXACT_CREDENTIAL_NAMES = new Set([
  "CLAWSWEEPER_OPENCLAW_OPENAI_KEY",
  "CLAWSWEEPER_WEBHOOK_SECRET",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
]);

export function isLiveProofCredentialEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    EXACT_CREDENTIAL_NAMES.has(upper) ||
    upper.startsWith("AWS_") ||
    upper.includes("R2") ||
    upper.endsWith("_KEY") ||
    upper.endsWith("_PASSWORD") ||
    upper.endsWith("_SECRET") ||
    upper.endsWith("_TOKEN")
  );
}

export function sanitizedLiveProofEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => !isLiveProofCredentialEnvironmentName(name)),
  );
}

export function assertLiveProofEnvironmentSanitized(env: NodeJS.ProcessEnv): void {
  const names = Object.keys(env).filter(isLiveProofCredentialEnvironmentName).sort();
  if (names.length) {
    throw new Error(`live-proof environment still exposes credentials: ${names.join(", ")}`);
  }
}
