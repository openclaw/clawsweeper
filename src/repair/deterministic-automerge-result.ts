import { automergeChangelogBlockReason } from "./comment-router-core.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import { sanitizeCheckLink, sanitizeEvidenceList } from "./url-safety.js";

export function deterministicAutomergeResult({
  job,
  mode,
  clusterPlan,
}: LooseRecord): LooseRecord | null {
  if (String(job?.frontmatter?.source ?? "") !== "pr_automerge") return null;
  if (!["autonomous", "execute"].includes(String(mode ?? ""))) return null;
  if (job?.frontmatter?.allow_fix_pr !== true) return null;
  if (job?.frontmatter?.allow_merge === true) return null;

  const repo = String(clusterPlan?.repo ?? job?.frontmatter?.repo ?? "");
  const canonical = firstCanonicalPullItem({ job, clusterPlan });
  if (!canonical) return null;
  if (canonical.state !== "open") return null;

  const files = changedFiles(canonical);
  const changelogReason = automergeChangelogBlockReason({
    repo,
    title: canonical.title,
    files,
  });

  const number = Number(canonical.number);
  if (!Number.isInteger(number) || number <= 0) return null;
  const ref = `#${number}`;
  const prUrl = `https://github.com/${repo}/pull/${number}`;
  const title = String(canonical.title ?? `fix: update ${ref}`).trim();
  const repairMode = String(job?.frontmatter?.repair_mode ?? "automerge");
  const summary = [
    `Make PR ${ref} merge-ready for ClawSweeper ${repairMode}.`,
    "Rebase onto latest main, address PR comments and review findings, fix CI/check failures, add required changelog if needed, and validate before returning.",
  ].join(" ");
  const likelyFiles = likelyRepairFiles(files, Boolean(changelogReason));
  const failedChecks = failingCheckEvidence(canonical);
  const evidence = sanitizeEvidenceList(
    [
      `Source PR: ${prUrl}`,
      canonical.pull_request?.head_sha ? `Current head: ${canonical.pull_request.head_sha}` : null,
      ...failedChecks,
      canonical.pull_request?.branch_writable === false
        ? `Branch writable: false (${canonical.pull_request?.branch_write_reason ?? "unknown"})`
        : "Branch writable: true or executor will fall back safely",
      canonical.pull_request?.files_truncated > 0
        ? `Changed files truncated by ${canonical.pull_request.files_truncated}; Codex must inspect live diff before editing`
        : null,
      changelogReason,
    ].filter(Boolean),
  );
  const reason =
    "Maintainer opted this PR into ClawSweeper automerge/autofix repair; run the direct Codex edit loop after live hydration instead of a separate read-only planning pass.";
  const fixArtifact = {
    summary,
    affected_surfaces: affectedSurfaces(files),
    likely_files: likelyFiles,
    linked_refs: [ref],
    validation_commands: ["pnpm check:changed"],
    changelog_required: Boolean(changelogReason),
    credit_notes: [`Source PR: ${prUrl}`],
    pr_title: title,
    pr_body: [
      `Makes ${prUrl} merge-ready for the ClawSweeper ${repairMode} loop.`,
      "",
      "The edit pass should inspect the live PR diff, review comments, and failing checks; rebase if needed; keep the contributor branch credited; and stop only when validation is green or an external blocker is proven.",
      failedChecks.length > 0
        ? `Known failing checks:\n${failedChecks.map((check) => `- ${check}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    source_prs: [prUrl],
    repair_strategy: "repair_contributor_branch",
    allow_no_pr: false,
    branch_update_blockers: [],
  };

  return {
    status: "planned",
    repo,
    cluster_id: String(clusterPlan?.cluster_id ?? job?.frontmatter?.cluster_id ?? ""),
    mode,
    summary,
    actions: [
      {
        target: ref,
        action: "build_fix_artifact",
        status: "planned",
        idempotency_key: `${clusterPlan?.cluster_id ?? "automerge"}:${number}:direct-repair`,
        classification: "canonical",
        target_kind: "pull_request",
        target_updated_at: canonical.updated_at ?? null,
        canonical: ref,
        duplicate_of: null,
        candidate_fix: ref,
        comment: null,
        evidence,
        reason,
      },
    ],
    needs_human: [],
    canonical: ref,
    canonical_issue: null,
    canonical_pr: ref,
    merge_preflight: [],
    fix_artifact: fixArtifact,
  };
}

function changedFiles(item: LooseRecord): string[] {
  return uniqueStrings(
    (item.pull_request?.files ?? [])
      .map((file: JsonValue) => file?.filename ?? file?.path ?? file)
      .map((file: JsonValue) => String(file ?? "").trim())
      .filter(Boolean),
  );
}

function affectedSurfaces(files: string[]): string[] {
  const surfaces = uniqueStrings(files.map(surfaceForFile)).slice(0, 24);
  return surfaces.length > 0 ? surfaces : ["PR changed surface"];
}

function surfaceForFile(file: string): string {
  const parts = file.split("/").filter(Boolean);
  const root = parts[0] ?? "";
  if (parts.length <= 1) return file || "PR changed surface";
  if (["apps", "crates", "extensions", "packages"].includes(root) && parts[1]) {
    return `${root}/${parts[1]}`;
  }
  return root || "PR changed surface";
}

function likelyRepairFiles(files: string[], changelogRequired: boolean): string[] {
  const likely = files.slice(0, 80);
  if (changelogRequired && !likely.includes("CHANGELOG.md")) likely.push("CHANGELOG.md");
  if (likely.length === 0) likely.push("CHANGELOG.md");
  return uniqueStrings(likely);
}

function failingCheckEvidence(item: LooseRecord): string[] {
  return (item.pull_request?.checks ?? [])
    .filter((check: JsonValue) => {
      const state = String(check?.state ?? check?.conclusion ?? check?.status ?? "").toLowerCase();
      const bucket = String(check?.bucket ?? "").toLowerCase();
      return (
        ["failure", "failed", "error", "timed_out", "action_required"].includes(state) ||
        ["fail", "failing", "failed"].includes(bucket)
      );
    })
    .map((check: JsonValue) => {
      const name = String(check?.name ?? "unnamed check").trim();
      const state = String(check?.state ?? check?.conclusion ?? check?.status ?? "unknown").trim();
      const rawLink = String(check?.link ?? check?.html_url ?? "").trim();
      const safeLink = sanitizeCheckLink(rawLink);
      const hint = safeLink ? safeLink : safeCheckHostHint(rawLink);
      return `Failing check: ${name}:${state}${hint ? ` (${hint})` : ""}`;
    })
    .filter(Boolean)
    .slice(0, 12);
}

function safeCheckHostHint(rawLink: string): string {
  if (!rawLink) return "";
  try {
    const url = new URL(rawLink);
    if (url.hostname === "github.com") return "";
    return `external check details on ${url.hostname}`;
  } catch {
    return "";
  }
}

function uniqueStrings(values: JsonValue[]): string[] {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function firstCanonicalPullItem({ job, clusterPlan }: LooseRecord): LooseRecord | null {
  const canonicalNumbers = new Set(
    (job?.frontmatter?.canonical ?? [])
      .map((ref: JsonValue) => Number(String(ref ?? "").replace(/^#/, "")))
      .filter((number: number) => Number.isInteger(number) && number > 0),
  );
  for (const item of clusterPlan?.items ?? []) {
    if (item?.kind !== "pull_request") continue;
    const number = Number(item.number);
    if (canonicalNumbers.size > 0 && !canonicalNumbers.has(number)) continue;
    return item;
  }
  return null;
}
