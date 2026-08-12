import type {
  GitHubEgressMethod,
  GitHubEgressOperation,
  GitHubEgressRouteTemplate,
} from "./github-egress-telemetry-contract.js";

export type GitHubEgressCommandDescriptor = {
  operation: GitHubEgressOperation;
  method: GitHubEgressMethod;
  routeTemplate: GitHubEgressRouteTemplate;
  wireSafe: boolean;
};

export function githubEgressCommandDescriptor(
  args: readonly string[],
): GitHubEgressCommandDescriptor {
  const command = args[0] === "--repo" ? args[2] : args[0];
  if (command === "run" && args.includes("download")) {
    return {
      operation: "artifact_download",
      method: "GET",
      routeTemplate: "actions_run_artifacts",
      // GH_DEBUG can render the redirected archive body. Retain invocation
      // accounting but do not expose that binary path to the debug parser.
      wireSafe: false,
    };
  }
  if (command === "workflow" && args.includes("run")) {
    return {
      operation: "workflow_dispatch",
      method: "POST",
      routeTemplate: "actions_workflow_dispatch",
      wireSafe: true,
    };
  }
  const apiIndex = args.indexOf("api");
  if (apiIndex < 0) return unknownDescriptor();
  const endpoint = apiEndpoint(args, apiIndex);
  const method = apiMethod(args, apiIndex);
  const routeTemplate = githubEgressRouteTemplate(endpoint);
  return {
    operation: githubEgressOperation(routeTemplate),
    method,
    routeTemplate,
    wireSafe: routeTemplate !== "unknown",
  };
}

export function githubEgressRouteTemplate(value: string): GitHubEgressRouteTemplate {
  let path = value.trim();
  try {
    path = new URL(path, "https://api.github.invalid").pathname;
  } catch {
    return "unknown";
  }
  path = path.replace(/^\/api\/v3/i, "");
  if (path === "/rate_limit" || path === "rate_limit") return "rate_limit";
  if (path === "/graphql" || path === "graphql") return "graphql";
  if (path === "/user" || path === "user") return "authenticated_user";
  if (path === "/search/issues" || path === "search/issues") return "search_issues";
  if (/^\/repos\/[^/]+\/[^/]+\/?$/.test(path)) return "repository_metadata";
  if (/^\/repos\/[^/]+\/[^/]+\/issues\/?$/.test(path)) return "issues_collection";
  if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/?$/.test(path)) return "issue_metadata";
  if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/?$/.test(path)) return "pull_metadata";
  if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments\/?$/.test(path)) {
    return "issue_comments";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/issues\/comments\/\d+\/?$/.test(path)) {
    return "issue_comment";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews\/?$/.test(path)) {
    return "pull_reviews";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments\/?$/.test(path)) {
    return "pull_comments";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/files\/?$/.test(path)) {
    return "pull_files";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/commits\/?$/.test(path)) {
    return "pull_commits";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/timeline\/?$/.test(path)) {
    return "issue_timeline";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/labels(?:\/[^/]+)?\/?$/.test(path)) {
    return "issue_labels";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/reactions\/?$/.test(path)) {
    return "issue_reactions";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/reactions\/\d+\/?$/.test(path)) {
    return "issue_reactions";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/labels(?:\/[^/]+)?\/?$/.test(path)) {
    return "repository_labels";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/collaborators\/[^/]+\/permission\/?$/.test(path)) {
    return "collaborator_permission";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/contents(?:\/.*)?$/.test(path)) {
    return "repository_contents";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/commits\/?$/.test(path)) return "commits_collection";
  if (/^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/check-runs\/?$/.test(path)) {
    return "commit_check_runs";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/status\/?$/.test(path)) {
    return "commit_status";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/pulls\/?$/.test(path)) {
    return "commit_pulls";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/?$/.test(path)) {
    return "commit_metadata";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/?$/.test(path)) return "actions_runs";
  if (/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/\d+\/artifacts\/?$/.test(path)) {
    return "actions_run_artifacts";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/actions\/artifacts\/\d+\/(?:zip|tar)\/?$/.test(path)) {
    return "actions_artifact_archive";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/[^/]+\/dispatches\/?$/.test(path)) {
    return "actions_workflow_dispatch";
  }
  return "unknown";
}

function apiEndpoint(args: readonly string[], apiIndex: number): string {
  for (let index = apiIndex + 1; index < args.length; index += 1) {
    const value = args[index] || "";
    if (!value.startsWith("-")) return value;
    if (
      [
        "-X",
        "--method",
        "-H",
        "--header",
        "-f",
        "--raw-field",
        "-F",
        "--field",
        "-q",
        "--jq",
        "--hostname",
        "--input",
        "-t",
        "--template",
      ].includes(value)
    ) {
      index += 1;
    }
  }
  return "";
}

function apiMethod(args: readonly string[], apiIndex: number): GitHubEgressMethod {
  for (let index = apiIndex + 1; index < args.length; index += 1) {
    const value = args[index];
    if (value === "-X" || value === "--method") {
      const method = String(args[index + 1] || "").toUpperCase();
      return githubEgressMethod(method);
    }
  }
  return args
    .slice(apiIndex + 1)
    .some((value) => ["-f", "--raw-field", "-F", "--field"].includes(value))
    ? "POST"
    : "GET";
}

function githubEgressMethod(value: string): GitHubEgressMethod {
  return ["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD"].includes(value)
    ? (value as GitHubEgressMethod)
    : "UNKNOWN";
}

export function githubEgressOperation(route: GitHubEgressRouteTemplate): GitHubEgressOperation {
  if (route === "rate_limit") return "rate_status";
  if (
    route === "actions_run_artifacts" ||
    route === "actions_artifact_archive" ||
    route === "external_artifact_blob"
  )
    return "artifact_download";
  if (route === "actions_workflow_dispatch") return "workflow_dispatch";
  if (route === "graphql") return "graphql";
  if (
    route === "issue_metadata" ||
    route === "pull_metadata" ||
    route === "repository_metadata" ||
    route === "issues_collection" ||
    route === "issue_timeline" ||
    route === "pull_files" ||
    route === "pull_commits" ||
    route === "commits_collection" ||
    route === "commit_metadata" ||
    route === "commit_pulls" ||
    route === "actions_runs" ||
    route === "search_issues"
  )
    return "item_metadata";
  if (route === "issue_comments" || route === "issue_comment" || route === "pull_comments") {
    return "comments";
  }
  if (route === "pull_reviews") return "reviews";
  if (route === "issue_labels" || route === "repository_labels") return "labels";
  if (route === "issue_reactions") return "reactions";
  if (route === "commit_status" || route === "commit_check_runs") return "checks";
  if (route === "repository_contents") return "contents";
  if (route === "collaborator_permission" || route === "authenticated_user") {
    return "authorization";
  }
  return "other";
}

function unknownDescriptor(): GitHubEgressCommandDescriptor {
  return { operation: "other", method: "UNKNOWN", routeTemplate: "unknown", wireSafe: false };
}
