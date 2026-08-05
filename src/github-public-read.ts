export function isPublicOpenClawReadOnlyRequest(ghArgs: readonly string[]): boolean {
  if (ghArgs[0] !== "api") return false;
  const endpoint = ghArgs[1] ?? "";
  const endpointPath = endpoint.split("?", 1)[0] ?? "";
  if (!/^repos\/openclaw\/openclaw\/(?:issues|pulls)(?:\/|$)/.test(endpointPath)) {
    return false;
  }
  if (
    endpointPath.includes("\\") ||
    endpointPath.split("/").some((segment) => segment === "." || segment === "..") ||
    /%(?:2e|2f|5c)/i.test(endpointPath)
  ) {
    return false;
  }

  for (let index = 2; index < ghArgs.length; index += 1) {
    const flag = ghArgs[index];
    if (flag === "--paginate" || flag === "--slurp") continue;
    if ((flag === "--jq" || flag === "-q") && index + 1 < ghArgs.length) {
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}

export function exactPublicationPublicReadToken(
  ghArgs: readonly string[],
  targetRepo: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (
    env.EXACT_EVENT_PUBLICATION !== "true" ||
    targetRepo !== "openclaw/openclaw" ||
    (env.GH_HOST && env.GH_HOST.toLowerCase() !== "github.com") ||
    !isPublicOpenClawReadOnlyRequest(ghArgs)
  ) {
    return null;
  }
  return env.REPO_TOKEN?.trim() || null;
}
