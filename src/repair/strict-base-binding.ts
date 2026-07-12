import type { JsonValue, LooseRecord } from "./json-types.js";

type GithubJsonReader = (args: string[]) => JsonValue;

export function serverStrictBaseBindingBlock({
  repo,
  baseBranch,
  readJson,
}: {
  repo: string;
  baseBranch: string;
  readJson: GithubJsonReader;
}): string {
  if (!baseBranch) {
    return "automerge disabled: pull request base branch is unavailable for strict binding";
  }

  const appId = authenticatedInstallationAppId(readJson);
  if (!appId) {
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
        if (rulesetBypassesApp(ruleset, appId)) {
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

function authenticatedInstallationAppId(readJson: GithubJsonReader): number | null {
  try {
    const installation = readJson(["api", "installation"]);
    const appId = Number((installation as LooseRecord)?.app_id);
    return Number.isSafeInteger(appId) && appId > 0 ? appId : null;
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

function rulesetBypassesApp(ruleset: LooseRecord, appId: number): boolean {
  return Array.isArray(ruleset.bypass_actors)
    ? ruleset.bypass_actors.some((actor: JsonValue) => {
        const candidate = actor as LooseRecord;
        return (
          candidate?.actor_type === "Integration" &&
          Number(candidate.actor_id) === appId &&
          candidate.bypass_mode !== "never"
        );
      })
    : false;
}

function hasStrictClassicProtection(protection: JsonValue): boolean {
  const required = (protection as LooseRecord)?.required_status_checks;
  if (required?.strict !== true) return false;
  return (
    (Array.isArray(required.checks) && required.checks.length > 0) ||
    (Array.isArray(required.contexts) && required.contexts.length > 0)
  );
}
