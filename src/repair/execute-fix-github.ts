import type { JsonValue, LooseRecord } from "./json-types.js";
import { CLAWSWEEPER_CO_AUTHOR, coAuthorKey } from "./co-author-credit.js";
import { runCommand as run } from "./command-runner.js";
import { issueNumberFromRef, parsePullRequestUrl, sameRepoSlug } from "./github-ref.js";
import { repoRoot } from "./lib.js";
import { repairGhEnv as ghEnv } from "./process-env.js";
import { uniqueStrings } from "./validation-command-utils.js";
import { closingReferencesFromMarkdown } from "./external-messages.js";

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

export function sourceClosingReferences({
  fixArtifact,
  targetDir,
  repo,
}: {
  fixArtifact: LooseRecord;
  targetDir: string;
  repo: string;
}): string[] {
  const references: string[] = [];
  for (const source of fixArtifact.source_prs ?? []) {
    const parsed = parsePullRequestUrl(source);
    if (!parsed || !sameRepoSlug(parsed.repo, repo)) continue;
    const view = JSON.parse(
      run("gh", ["pr", "view", String(parsed.number), "--repo", repo, "--json", "body"], {
        cwd: targetDir,
        env: ghEnv(),
        timeoutMs: ghCommandTimeoutMs,
      }),
    );
    references.push(...closingReferencesFromMarkdown(view.body));
  }
  return uniqueStrings(references);
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
    if (!parsed || !sameRepoSlug(parsed.repo, repo)) continue;
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
  const clawsweeperKey = coAuthorKey(CLAWSWEEPER_CO_AUTHOR.name, CLAWSWEEPER_CO_AUTHOR.email);
  for (const credit of contributorCredits) {
    const name = String(credit.name ?? "").trim();
    const email = String(credit.email ?? "").trim();
    if (!name || !email) continue;
    const key = coAuthorKey(name, email);
    if (key === clawsweeperKey || seen.has(key)) continue;
    seen.add(key);
    trailers.push(`Co-authored-by: ${name} <${email}>`);
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

// The replacement PR takes the place of the first same-repo source PR. Another source PR
// is closed with it only when its close_superseded action names no other fix or canonical
// PR (the worker keeps candidate_fix null until the replacement exists). A close bound
// to another PR stays with the guarded applicator.
export function supersededReplacementSources({
  fixArtifact,
  actions,
  repo,
}: {
  fixArtifact: LooseRecord;
  actions: LooseRecord[];
  repo: string;
}): JsonValue[] {
  const supersededNumbers = new Set(
    actions
      .filter(
        (action) =>
          action?.action === "close_superseded" &&
          !action.candidate_fix &&
          !action.fixed_by &&
          !action.fix_candidate &&
          !action.canonical &&
          !action.duplicate_of,
      )
      .map((action) => issueNumberFromRef(action.target, repo))
      .filter((number) => number > 0),
  );
  const sameRepoSources = (fixArtifact.source_prs ?? []).filter((source: JsonValue) =>
    sameRepoSlug(parsePullRequestUrl(source)?.repo, repo),
  );
  return sameRepoSources.filter(
    (source: JsonValue, index: number) =>
      index === 0 || supersededNumbers.has(parsePullRequestUrl(source)?.number ?? 0),
  );
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
