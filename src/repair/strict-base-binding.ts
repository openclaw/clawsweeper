import type { JsonValue, LooseRecord } from "./json-types.js";

type GithubJsonReader = (args: string[]) => JsonValue;

export function serverStrictBaseBindingBlock({
  repo,
  baseBranch,
  appId,
  appSlug,
  readJson,
}: {
  repo: string;
  baseBranch: string;
  appId: unknown;
  appSlug: unknown;
  readJson: GithubJsonReader;
}): string {
  if (!baseBranch) {
    return "automerge disabled: pull request base branch is unavailable for strict binding";
  }

  const authenticatedAppId = authenticatedInstallationAppId(appId, appSlug, readJson);
  if (!authenticatedAppId) {
    return "automerge disabled: merge credential is not a verifiable GitHub App installation";
  }

  let rulesUnavailable = false;
  let bypassedStrictRule = false;
  try {
    const rules = readJson([
      "api",
      `repos/${repo}/rules/branches/${encodeURIComponent(baseBranch)}`,
    ]);
    if (!Array.isArray(rules)) {
      rulesUnavailable = true;
    } else {
      for (const rule of rules) {
        if (!isStrictStatusCheckRule(rule)) continue;
        const ruleset = fetchRuleset(rule, repo, readJson);
        if (!ruleset) {
          rulesUnavailable = true;
          continue;
        }
        const bypassesApp = rulesetBypassesApp(ruleset, authenticatedAppId);
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
    const protection = readJson([
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

function authenticatedInstallationAppId(
  appId: unknown,
  appSlug: unknown,
  readJson: GithubJsonReader,
): number | null {
  const configuredAppId = Number(appId);
  if (!Number.isSafeInteger(configuredAppId) || configuredAppId <= 0) return null;
  const authenticatedAppSlug = String(appSlug ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(authenticatedAppSlug)) return null;
  try {
    const installation = readJson(["api", "installation/repositories?per_page=1"]);
    const candidate = installation as LooseRecord;
    if (
      !Number.isSafeInteger(Number(candidate?.total_count)) ||
      !Array.isArray(candidate?.repositories)
    ) {
      return null;
    }
    const app = readJson([
      "api",
      `apps/${encodeURIComponent(authenticatedAppSlug)}`,
    ]) as LooseRecord;
    if (
      Number(app?.id) !== configuredAppId ||
      String(app?.slug ?? "").toLowerCase() !== authenticatedAppSlug.toLowerCase()
    ) {
      return null;
    }
    return configuredAppId;
  } catch {
    return null;
  }
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
  const endpoint =
    sourceType === "Organization"
      ? `orgs/${source}/rulesets/${id}`
      : sourceType === "Enterprise"
        ? `enterprises/${source}/rulesets/${id}`
        : `repos/${source}/rulesets/${id}`;
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
