import type { JsonValue, LooseRecord } from "./json-types.js";
import {
  CLAWSWEEPER_CO_AUTHOR,
  CLAWSWEEPER_CO_AUTHOR_TRAILER,
  coAuthorKey,
} from "./co-author-credit.js";
import { runCommand as run } from "./command-runner.js";
import { parsePullRequestUrl } from "./github-ref.js";
import { repoRoot } from "./lib.js";
import { repairGhEnv as ghEnv } from "./process-env.js";
import { uniqueStrings } from "./validation-command-utils.js";

const ghCommandTimeoutMs = Math.max(
  30_000,
  Number(
    process.env.CLAWSWEEPER_GH_COMMAND_TIMEOUT_MS ??
      process.env.CLAWSWEEPER_NETWORK_COMMAND_TIMEOUT_MS ??
      2 * 60 * 1000,
  ),
);

export function fetchPullRequest(repo: string, number: JsonValue): LooseRecord {
  return JSON.parse(
    run("gh", ["api", `repos/${repo}/pulls/${number}`], {
      cwd: repoRoot(),
      env: ghEnv(),
      timeoutMs: ghCommandTimeoutMs,
    }),
  );
}

export function fetchSourcePullRequestView({
  repo,
  number,
  targetDir,
}: {
  repo: string;
  number: JsonValue;
  targetDir: string;
}): LooseRecord {
  return JSON.parse(
    run(
      "gh",
      ["pr", "view", String(number), "--repo", repo, "--json", "author,state,mergedAt,title,url"],
      {
        cwd: targetDir,
        env: ghEnv(),
        timeoutMs: ghCommandTimeoutMs,
      },
    ),
  );
}

export function sourceContributorCredits({
  fixArtifact,
  targetDir,
  repo,
}: {
  fixArtifact: LooseRecord;
  targetDir: string;
  repo: string;
}): LooseRecord[] {
  const byLogin = new Map<string, LooseRecord>();
  for (const source of fixArtifact.source_prs ?? []) {
    const parsed = parsePullRequestUrl(source);
    if (!parsed || parsed.repo !== repo) continue;
    const view = fetchSourcePullRequestView({ repo, number: parsed.number, targetDir });
    const login = String(view.author?.login ?? "").trim();
    if (!login || view.author?.is_bot || isBotLogin(login)) continue;
    const key = login.toLowerCase();
    const existing = byLogin.get(key) ?? {
      login,
      name: safeTrailerName(login, login),
      email: `${login}@users.noreply.github.com`,
      sources: [],
    };
    const user = fetchGitHubUser(login, targetDir);
    if (user) {
      existing.name = safeTrailerName(user.name || user.login || login, login);
      existing.email = `${user.id}+${user.login}@users.noreply.github.com`;
    }
    existing.sources = uniqueStrings([...existing.sources, parsed.url]);
    byLogin.set(key, existing);
  }
  return [...byLogin.values()];
}

export function coAuthorTrailers(contributorCredits: LooseRecord[]): string[] {
  const seen = new Set<string>();
  const trailers: string[] = [];
  for (const credit of contributorCredits) {
    const name = String(credit.name ?? "").trim();
    const email = String(credit.email ?? "").trim();
    if (!name || !email) continue;
    const key = coAuthorKey(name, email);
    if (seen.has(key)) continue;
    seen.add(key);
    trailers.push(`Co-authored-by: ${name} <${email}>`);
  }
  const clawsweeperKey = coAuthorKey(CLAWSWEEPER_CO_AUTHOR.name, CLAWSWEEPER_CO_AUTHOR.email);
  if (!seen.has(clawsweeperKey)) {
    trailers.push(CLAWSWEEPER_CO_AUTHOR_TRAILER);
  }
  return trailers;
}

export function publicContributorCredit(credit: JsonValue): LooseRecord {
  return {
    login: credit.login,
    name: credit.name,
    sources: credit.sources,
    co_authored_by: `Co-authored-by: ${credit.name} <${credit.email}>`,
  };
}

export function supersededReplacementSources({
  fixArtifact,
  repo,
}: {
  fixArtifact: LooseRecord;
  repo: string;
}): JsonValue[] {
  if (
    Array.isArray(fixArtifact.supersede_source_prs) &&
    fixArtifact.supersede_source_prs.length > 0
  ) {
    return fixArtifact.supersede_source_prs.filter(
      (source: JsonValue) => parsePullRequestUrl(source)?.repo === repo,
    );
  }

  const blockerText = (fixArtifact.branch_update_blockers ?? []).join("\n");
  const directUneditableSources = (fixArtifact.source_prs ?? []).filter((source: JsonValue) => {
    const parsed = parsePullRequestUrl(source);
    if (!parsed || parsed.repo !== repo) return false;
    const sourcePattern = new RegExp(`(?:#|pull/)${parsed.number}(?!\\d)[\\s\\S]{0,220}`, "i");
    const sourceBlocker = blockerText.match(sourcePattern)?.[0] ?? "";
    return /maintainer_can_modify\s*=\s*false|uneditable|cannot safely update|branch is unsafe|mergeability unknown/i.test(
      sourceBlocker,
    );
  });
  return directUneditableSources.length > 0
    ? directUneditableSources
    : (fixArtifact.source_prs ?? []).slice(0, 1);
}

export function prepareReviewThreadsForMerge({
  repo,
  number,
  targetDir,
  resolveThreads,
}: {
  repo: string;
  number: JsonValue;
  targetDir: string;
  resolveThreads: boolean;
}): LooseRecord {
  const before = fetchReviewThreads(repo, number);
  if (before.hasNextPage)
    return { status: "blocked", reason: "too many review threads to prove resolved" };
  const unresolved = before.threads.filter((thread: JsonValue) => !thread.isResolved);
  if (unresolved.length === 0) return { status: "resolved", unresolved_before: 0, resolved: 0 };
  if (!resolveThreads) {
    return {
      status: "blocked",
      reason: "unresolved review threads remain and CLAWSWEEPER_RESOLVE_REVIEW_THREADS=0",
      unresolved_before: unresolved.length,
      examples: unresolved.slice(0, 3).map((thread: JsonValue) => thread.url ?? thread.id),
    };
  }
  for (const thread of unresolved) {
    resolveReviewThread(thread.id, targetDir);
  }
  const after = fetchReviewThreads(repo, number);
  const remaining = after.threads.filter((thread: JsonValue) => !thread.isResolved);
  if (remaining.length > 0) {
    return {
      status: "blocked",
      reason: "some review threads remained unresolved after resolution attempt",
      unresolved_before: unresolved.length,
      unresolved_after: remaining.length,
      examples: remaining.slice(0, 3).map((thread: JsonValue) => thread.url ?? thread.id),
    };
  }
  return { status: "resolved", unresolved_before: unresolved.length, resolved: unresolved.length };
}

function fetchGitHubUser(login: JsonValue, targetDir: string): LooseRecord | null {
  try {
    const user = JSON.parse(
      run("gh", ["api", `users/${login}`], {
        cwd: targetDir,
        env: ghEnv(),
        timeoutMs: ghCommandTimeoutMs,
      }),
    );
    if (!user?.id || !user?.login) return null;
    return user;
  } catch {
    return null;
  }
}

function safeTrailerName(value: JsonValue, fallback: JsonValue = "Contributor"): JsonValue {
  const name = String(value ?? "")
    .replace(/[<>\r\n]/g, "")
    .trim();
  return name || fallback;
}

function isBotLogin(login: JsonValue): boolean {
  return /\[bot\]$|bot$/i.test(String(login ?? ""));
}

function fetchReviewThreads(repo: string, number: JsonValue): LooseRecord {
  const [owner, name] = repo.split("/");
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              id
              isResolved
              path
              line
              comments(first: 1) {
                nodes {
                  url
                  author { login }
                  body
                }
              }
            }
          }
        }
      }
    }
  `;
  const data = JSON.parse(
    run(
      "gh",
      [
        "api",
        "graphql",
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${number}`,
        "-f",
        `query=${query}`,
      ],
      { cwd: repoRoot(), env: ghEnv(), timeoutMs: ghCommandTimeoutMs },
    ),
  );
  const threads = data?.data?.repository?.pullRequest?.reviewThreads;
  return {
    hasNextPage: Boolean(threads?.pageInfo?.hasNextPage),
    threads: (threads?.nodes ?? []).map((thread: JsonValue) => ({
      id: thread.id,
      isResolved: Boolean(thread.isResolved),
      path: thread.path,
      line: thread.line,
      url: thread.comments?.nodes?.[0]?.url ?? null,
      author: thread.comments?.nodes?.[0]?.author?.login ?? null,
      body: thread.comments?.nodes?.[0]?.body ?? "",
    })),
  };
}

function resolveReviewThread(threadId: JsonValue, cwd: string): void {
  const mutation = `
    mutation($threadId: ID!) {
      resolveReviewThread(input: {threadId: $threadId}) {
        thread { id isResolved }
      }
    }
  `;
  run("gh", ["api", "graphql", "-f", `threadId=${threadId}`, "-f", `query=${mutation}`], {
    cwd,
    env: ghEnv(),
  });
}
