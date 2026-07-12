import type { JsonValue, LooseRecord } from "./json-types.js";

type GithubJsonReader = (args: string[]) => JsonValue;

export function serverStrictBaseBindingBlock({
  repo,
  baseBranch,
  configuredAppSlug,
  authenticatedAppId,
  appSlug,
  installationId,
  policyAppId,
  policyAppSlug,
  policyInstallationId,
  policyReadJson,
}: {
  repo: string;
  baseBranch: string;
  configuredAppSlug: unknown;
  authenticatedAppId: unknown;
  appSlug: unknown;
  installationId: unknown;
  policyAppId: unknown;
  policyAppSlug: unknown;
  policyInstallationId: unknown;
  policyReadJson?: GithubJsonReader | undefined;
}): string {
  if (!baseBranch) {
    return "automerge disabled: pull request base branch is unavailable for strict binding";
  }

  const configuredSlug = normalizedAppSlug(configuredAppSlug);
  const mutationIdentity = actionInstallationIdentity(authenticatedAppId, appSlug, installationId);
  if (!configuredSlug || !mutationIdentity || mutationIdentity.appSlug !== configuredSlug) {
    return "automerge disabled: merge credential is not a verifiable GitHub App installation";
  }
  if (!policyReadJson) {
    return "automerge disabled: ruleset verifier credential is unavailable";
  }
  const verifierIdentity = actionInstallationIdentity(
    policyAppId,
    policyAppSlug,
    policyInstallationId,
  );
  if (
    !verifierIdentity ||
    verifierIdentity.appId !== mutationIdentity.appId ||
    verifierIdentity.appSlug !== configuredSlug ||
    verifierIdentity.installationId !== mutationIdentity.installationId
  ) {
    return "automerge disabled: ruleset verifier credential is not the configured GitHub App installation";
  }

  let rulesUnavailable = false;
  let bypassedStrictRule = false;
  try {
    const rules = policyReadJson([
      "api",
      `repos/${repo}/rules/branches/${encodeURIComponent(baseBranch)}`,
    ]);
    if (!Array.isArray(rules)) {
      rulesUnavailable = true;
    } else {
      for (const rule of rules) {
        if (!isStrictStatusCheckRule(rule)) continue;
        const ruleset = fetchRuleset(rule, repo, policyReadJson);
        if (!ruleset) {
          rulesUnavailable = true;
          continue;
        }
        const bypassesApp = rulesetBypassesApp(ruleset, mutationIdentity.appId);
        if (bypassesApp === null) {
          rulesUnavailable = true;
          continue;
        }
        if (bypassesApp) {
          bypassedStrictRule = true;
          continue;
        }
        return "";
      }
    }
  } catch {
    rulesUnavailable = true;
  }

  try {
    const protection = policyReadJson([
      "api",
      `repos/${repo}/branches/${encodeURIComponent(baseBranch)}/protection`,
    ]);
    if (hasStrictClassicProtection(protection)) return "";
  } catch {
    rulesUnavailable = true;
  }

  if (bypassedStrictRule) {
    return "automerge disabled: merge credential bypasses the strict base-binding ruleset";
  }
  return rulesUnavailable
    ? "automerge disabled: unable to verify server-enforced strict base binding"
    : `automerge disabled: ${baseBranch} lacks server-enforced strict base binding`;
}

function actionInstallationIdentity(
  appId: unknown,
  appSlug: unknown,
  installationId: unknown,
): { appId: number; appSlug: string; installationId: number } | null {
  const normalizedAppId = Number(appId);
  const normalizedSlug = normalizedAppSlug(appSlug);
  const normalizedInstallationId = Number(installationId);
  if (
    !Number.isSafeInteger(normalizedAppId) ||
    normalizedAppId <= 0 ||
    !normalizedSlug ||
    !Number.isSafeInteger(normalizedInstallationId) ||
    normalizedInstallationId <= 0
  ) {
    return null;
  }
  return {
    appId: normalizedAppId,
    appSlug: normalizedSlug,
    installationId: normalizedInstallationId,
  };
}

function normalizedAppSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const appSlug = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*$/.test(appSlug) ? appSlug : null;
}

function isStrictStatusCheckRule(rule: JsonValue): boolean {
  const candidate = rule as LooseRecord;
  const parameters = candidate?.parameters;
  return (
    candidate?.type === "required_status_checks" &&
    parameters?.strict_required_status_checks_policy === true &&
    Array.isArray(parameters.required_status_checks) &&
    parameters.required_status_checks.length > 0
  );
}

function fetchRuleset(
  rule: JsonValue,
  repo: string,
  readJson: GithubJsonReader,
): LooseRecord | null {
  const candidate = rule as LooseRecord;
  const id = Number(candidate?.ruleset_id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const source = String(candidate.ruleset_source ?? repo);
  const sourceType = String(candidate.ruleset_source_type ?? "Repository");
  if (sourceType !== "Repository") return null;
  const endpoint = `repos/${source}/rulesets/${id}`;
  try {
    const ruleset = readJson(["api", endpoint]);
    return ruleset && typeof ruleset === "object" && !Array.isArray(ruleset)
      ? (ruleset as LooseRecord)
      : null;
  } catch {
    return null;
  }
}

function rulesetBypassesApp(ruleset: LooseRecord, appId: number): boolean | null {
  if (!Array.isArray(ruleset.bypass_actors)) return null;
  return ruleset.bypass_actors.some((actor: JsonValue) => {
    const candidate = actor as LooseRecord;
    return (
      candidate?.actor_type === "Integration" &&
      Number(candidate.actor_id) === appId &&
      candidate.bypass_mode !== "never"
    );
  });
}

function hasStrictClassicProtection(protection: JsonValue): boolean {
  const required = (protection as LooseRecord)?.required_status_checks;
  if (required?.strict !== true) return false;
  return (
    (Array.isArray(required.checks) && required.checks.length > 0) ||
    (Array.isArray(required.contexts) && required.contexts.length > 0)
  );
}
