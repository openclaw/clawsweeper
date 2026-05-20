import type { JsonValue, LooseRecord } from "./json-types.js";
import { randomInt } from "node:crypto";
import { repairCodexReasoningEffort } from "./process-env.js";

const EVIDENCE_LIMIT = 5;
const COMMENT_PARAGRAPH_LIMIT = 520;

function listOrNone(items: JsonValue[]) {
  return items?.length ? items.join("; ") : "none";
}

function code(value: JsonValue) {
  const text = String(value ?? "");
  const longestBacktickRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestBacktickRun + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}

function codeList(items: JsonValue[]) {
  return items?.length ? items.map(code).join("; ") : "none";
}

const CLOSING_REFERENCE_PATTERN =
  /\b(?<verb>close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?<targets>(?:https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+|#\d+)(?:\s*,\s*(?:https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+|#\d+))*)/gi;

export function closingReferencesFromMarkdown(body: JsonValue) {
  const seen = new Set<string>();
  const references: string[] = [];
  for (const match of String(body ?? "").matchAll(CLOSING_REFERENCE_PATTERN)) {
    const verb = String(match.groups?.verb ?? "").trim();
    const targets = String(match.groups?.targets ?? "")
      .split(/\s*,\s*/)
      .map((target) => target.trim())
      .filter(Boolean);
    for (const target of targets) {
      const reference = `${verb} ${target}`.replace(/\s+/g, " ").trim();
      const key = reference.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      references.push(reference);
    }
  }
  return references;
}

function visibleSelfReference(value: JsonValue, target: JsonValue) {
  const text = String(value ?? "");
  const number = String(target ?? "").replace(/^#/, "");
  if (!number) return text;
  const githubPr = new RegExp(
    `https://github\\.com/[^/\\s]+/[^/\\s]+/pull/${number}\\b(?:#issuecomment-\\d+)?`,
    "gi",
  );
  const githubIssue = new RegExp(
    `https://github\\.com/[^/\\s]+/[^/\\s]+/issues/${number}\\b(?:#issuecomment-\\d+)?`,
    "gi",
  );
  return text
    .replace(githubPr, "this PR")
    .replace(githubIssue, "this item")
    .replace(new RegExp(`\\bPR\\s+#${number}\\b`, "gi"), "this PR")
    .replace(new RegExp(`\\bPR\\s+${number}\\b`, "gi"), "this PR")
    .replace(new RegExp(`#${number}\\b`, "g"), "this PR");
}

function issueRef(value: JsonValue) {
  return value ? `#${value}` : "";
}

function pick(items: LooseRecord[]) {
  return items[randomInt(items.length)];
}

function variant(items: LooseRecord[], context: LooseRecord = {}) {
  const item = pick(items);
  return typeof item === "function" ? item(context) : item;
}

function evidenceLines(evidence: JsonValue) {
  return (Array.isArray(evidence) ? evidence : [])
    .slice(0, EVIDENCE_LIMIT)
    .map(
      (item: JsonValue) =>
        `- ${typeof item === "string" ? item : (item.detail ?? JSON.stringify(item))}`,
    );
}

function codexStyleComment({
  marker,
  badge,
  headline,
  body,
  metadata = [],
  footer,
  provenance,
}: {
  marker?: JsonValue;
  badge: "DONE" | "INFO" | "SKIP" | "P2" | "P3";
  headline: string;
  body: string;
  metadata?: JsonValue[];
  footer?: JsonValue;
  provenance?: LooseRecord;
}) {
  const lines = [
    marker,
    `${renderBadge(badge)} **${headline}**`,
    "",
    compactParagraph(body, COMMENT_PARAGRAPH_LIMIT),
    ...metadataLines(metadata),
    footer ? ["", footer] : [],
    provenance ? ["", fishNotes(provenance)] : [],
  ].flat();
  return lines.filter((line) => line !== null && line !== undefined).join("\n");
}

function renderBadge(badge: "DONE" | "INFO" | "SKIP" | "P2" | "P3") {
  const symbols: Record<typeof badge, string> = {
    DONE: "✅",
    INFO: "ℹ️",
    SKIP: "⏭️",
    P2: "💡",
    P3: "💡",
  };
  return `${symbols[badge]} **${badge}**`;
}

function metadataLines(metadata: JsonValue[]) {
  const lines = metadata.filter(Boolean).map((line) => String(line));
  return lines.length ? ["", ...lines] : [];
}

const reopenLines = [
  "If this still reproduces by a different route, reply here and we can fish it back out.",
  "If this still splashes on current main through a different path, reply here and we can reopen or split it back out.",
  "If there is a separate reproduction path hiding under this, reply here and ClawSweeper can pull it back into the light.",
  "If this is still real on current main by a different route, reply here and we can reopen the trail.",
  "If this closeout misses a distinct bug path, reply here and we can separate it cleanly.",
  "If the canonical path does not cover your case, reply here and we can fish the thread back out.",
];

function fishNotes(provenance: LooseRecord) {
  const model = provenance?.model ?? process.env.CLAWSWEEPER_MODEL ?? "gpt-5.5";
  const reasoning = repairCodexReasoningEffort(provenance?.reasoning);
  const reviewedSha = provenance?.reviewedSha ?? provenance?.reviewed_sha;
  const reviewed = reviewedSha ? `; reviewed against ${String(reviewedSha).slice(0, 12)}` : "";
  return `_ClawSweeper 🐠 · model ${model}, reasoning ${reasoning}${reviewed}._`;
}

export function externalMessageProvenance({ model, reasoning, reviewedSha }: LooseRecord = {}) {
  return {
    model: model ?? process.env.CLAWSWEEPER_MODEL ?? "gpt-5.5",
    reasoning: repairCodexReasoningEffort(reasoning),
    reviewedSha,
  };
}

function contributorCreditLines(contributorCredits: JsonValue) {
  if (!Array.isArray(contributorCredits) || contributorCredits.length === 0) return [];
  const lines = contributorCredits
    .map((credit: JsonValue) => {
      const login = String(credit?.login ?? "")
        .replace(/^@/, "")
        .trim();
      const trailer =
        String(credit?.co_authored_by ?? "").trim() ||
        (credit?.name && credit?.email ? `Co-authored-by: ${credit.name} <${credit.email}>` : "");
      if (!trailer) return null;
      return `- ${login ? `@${login}: ` : ""}${trailer}`;
    })
    .filter(Boolean);
  return lines.length > 0 ? ["Co-author credit kept:", ...lines] : [];
}

export function repairContributorBranchComment({ validationCommands, provenance }: LooseRecord) {
  return codexStyleComment({
    badge: "DONE",
    headline: "Repair pushed to the source branch",
    body: "ClawSweeper pushed a narrow repair to the source branch, so the original PR remains the canonical review path and contributor credit stays with the original history.",
    metadata: [`_Validation: ${codeList(validationCommands)}_`],
    provenance,
  });
}

export function automergeRepairOutcomeComment({
  marker,
  result,
  report,
  target,
  provenance,
}: LooseRecord) {
  const metadata = [
    `_Executor outcome: ${compactForComment(report?.reason ?? "no executable fix action", 260)}._`,
  ];
  const summary = compactForComment(visibleSelfReference(result?.summary, target), 900);
  if (summary) metadata.push(`_Worker summary: ${summary}_`);
  const actionLines = automergeOutcomeActionLines(result?.actions, target);
  if (actionLines.length > 0) {
    metadata.push("Worker actions:", ...actionLines);
  }
  return codexStyleComment({
    marker,
    badge: "SKIP",
    headline: "No branch changes were pushed",
    body: "ClawSweeper checked this PR but did not find a safe narrow repair to push. No branch update, rebase, replacement PR, merge, or fresh ClawSweeper re-review was started on this pass.",
    metadata,
    provenance,
  });
}

export function issueImplementationResultStatusComment({
  existingBody,
  prUrl,
  branch,
  runUrl,
  completedAt,
}: LooseRecord) {
  const marker = "<!-- clawsweeper-issue-implementation-result -->";
  const lines = [
    marker,
    "Result: implementation PR opened.",
    "",
    `- PR: ${prUrl}`,
    branch ? `- Branch: \`${branch}\`` : null,
    runUrl ? `- Worker: ${runUrl}` : null,
    completedAt ? `- Updated: ${completedAt}` : null,
  ].filter(Boolean);
  const nextSection = lines.join("\n");
  const body = String(existingBody ?? "").trimEnd();
  const existingSection = new RegExp(`\\n\\n${escapeRegExp(marker)}[\\s\\S]*$`);
  if (existingSection.test(body)) return body.replace(existingSection, `\n\n${nextSection}`);
  return `${body}\n\n${nextSection}`;
}

export function replacementSourceLinkComment({
  replacementPrUrl,
  provenance,
  contributorCredits,
}: LooseRecord) {
  return codexStyleComment({
    badge: "INFO",
    headline: "Replacement PR opened from a writable branch",
    body: "ClawSweeper could not update the source PR branch directly because GitHub did not grant sufficient push rights to the bot, so it opened a narrow replacement PR from a writable branch. The source PR stays open for comparison, and contributor credit is preserved in the replacement notes.",
    metadata: [
      `Replacement PR: ${replacementPrUrl}`,
      "Source PR status: left open for maintainer and contributor comparison.",
      ...contributorCreditLines(contributorCredits),
    ],
    provenance,
  });
}

function automergeOutcomeActionLines(actions: LooseRecord[], targetPr: JsonValue) {
  if (!Array.isArray(actions)) return [];
  return actions.slice(0, 6).map((action: JsonValue) => {
    const name = compactForComment(action?.action ?? "unknown", 80);
    const target = compactForComment(
      visibleSelfReference(action?.target ?? "unknown", targetPr),
      80,
    );
    const status = compactForComment(action?.status ?? "unknown", 80);
    const reason = compactForComment(visibleSelfReference(action?.reason, targetPr), 220);
    return `- \`${name}\` on \`${target}\`: ${status}${reason ? ` - ${reason}` : ""}`;
  });
}

function compactForComment(value: JsonValue, max: JsonValue) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function compactParagraph(value: JsonValue, max: number) {
  return compactForComment(value, max);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function replacementSourceCloseComment({
  replacementPrUrl,
  provenance,
  contributorCredits,
}: LooseRecord) {
  return codexStyleComment({
    badge: "DONE",
    headline: "Source PR closed after opening credited replacement",
    body: "ClawSweeper could not update the source PR branch directly because GitHub did not grant sufficient push rights to the bot. This run explicitly closes the superseded source PR after opening a credited replacement PR, so review continues in one place.",
    metadata: [
      `Replacement PR: ${replacementPrUrl}`,
      "Why close: this run explicitly closes the superseded source PR after the credited replacement PR is open, so review continues in one place.",
      ...contributorCreditLines(contributorCredits),
    ],
    provenance,
  });
}

export function replacementPrBody({
  fixArtifact,
  fallbackReason,
  clusterId,
  provenance,
  contributorCredits,
  maintainerAttribution = null,
  sourceClosingReferences = [],
}: LooseRecord) {
  const lines = [
    fixArtifact.pr_body.trim(),
    "",
    `${renderBadge("INFO")} **Replacement PR opened from a writable branch**`,
    "",
    "ClawSweeper could not update the source PR branch directly, so it opened this writable replacement PR while preserving the original context and credit.",
    "",
    `- Cluster: ${code(clusterId)}`,
    `- Source PRs: ${(fixArtifact.source_prs ?? []).join(", ") || "none"}`,
    `- Credit: ${listOrNone(fixArtifact.credit_notes)}`,
    `- Validation: ${codeList(fixArtifact.validation_commands)}`,
    "- Replacement reason: ClawSweeper could not update the source PR branch directly, so it opened a writable replacement PR instead.",
  ];
  const maintainer = automergeMaintainerAttribution(maintainerAttribution);
  if (maintainer) {
    lines.push(`- Automerge requested by: @${maintainer.login}`);
    lines.push(
      `<!-- clawsweeper-automerge-requested-by login="${escapeHtmlAttribute(
        maintainer.login,
      )}" id="${escapeHtmlAttribute(maintainer.id)}" -->`,
    );
  }
  if (fallbackReason) lines.push(`- Repair fallback: ${fallbackReason}`);
  const closingReferences = uniqueLines(sourceClosingReferences);
  if (closingReferences.length > 0) {
    lines.push(
      "",
      "Inherited issue-closing references from the source PR:",
      ...closingReferences.map((reference) => `${reference}`),
    );
  }
  const creditLines = contributorCreditLines(contributorCredits);
  if (creditLines.length > 0) lines.push("", ...creditLines);
  lines.push("", fishNotes(provenance));
  return `${lines.join("\n")}\n`;
}

function uniqueLines(values: JsonValue[]) {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const value of Array.isArray(values) ? values : []) {
    const line = String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return lines;
}

function automergeMaintainerAttribution(value: LooseRecord): LooseRecord | null {
  const login = String(value?.author ?? value?.login ?? value?.requested_by ?? "").trim();
  if (!login || login.includes("[bot]")) return null;
  return {
    login,
    id: String(value?.author_id ?? value?.id ?? value?.requested_by_id ?? "").trim(),
  };
}

function escapeHtmlAttribute(value: JsonValue) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function defaultCloseComment({
  action,
  classification,
  clusterId,
  target,
  title,
  canonical,
  candidateFix,
  reason,
  provenance,
}: LooseRecord) {
  let badge: "DONE" | "INFO" | "SKIP" | "P2" | "P3" = "DONE";
  let headline = `Close ${issueRef(target)} after cluster review`;
  let body = `ClawSweeper reviewed the cluster and is closing ${issueRef(target)}. `;
  if (classification === "duplicate" && canonical) {
    badge = "P3";
    headline = `Close duplicate in favor of ${issueRef(canonical)}`;
    body += `${issueRef(target)} overlaps ${issueRef(canonical)}, so keeping one canonical thread keeps fixes, validation, and follow-up in one place.`;
  } else if (classification === "superseded" && canonical) {
    badge = "P3";
    headline = `Close superseded thread in favor of ${issueRef(canonical)}`;
    body += `${issueRef(canonical)} is now the current canonical thread, so closing this one keeps validation and context from drifting.`;
  } else if (classification === "superseded" && candidateFix) {
    badge = "P3";
    headline = `Close superseded thread after ${issueRef(candidateFix)} landed`;
    body += `${issueRef(candidateFix)} landed for this path, so closing the older overlap keeps follow-up attached to the shipped fix.`;
  } else if (classification === "fixed_by_candidate" && candidateFix) {
    badge = "P3";
    headline = `Close thread covered by candidate fix ${issueRef(candidateFix)}`;
    body += `${issueRef(candidateFix)} is carrying this fix path now, so follow-up should stay attached to that review lane.`;
  } else if (classification === "low_signal") {
    badge = "SKIP";
    headline = "Close low-signal PR cleanup candidate";
    body +=
      "This PR does not currently present a reviewable OpenClaw fix with maintainer signal, current validation, or a focused product path. Reopen from a clean branch with a scoped summary, linked issue or rationale, and validation if this still needs attention.";
  } else {
    body += String(reason ?? "");
  }

  const metadata = [`Cluster: ${code(clusterId)}`, `Reviewed item: ${issueRef(target)} - ${title}`];
  const renderedEvidence = evidenceLines(action.evidence);
  if (renderedEvidence.length) metadata.push("Evidence:", ...renderedEvidence);
  return codexStyleComment({
    badge,
    headline,
    body,
    metadata,
    footer: variant(reopenLines),
    provenance,
  });
}

export function postMergeCloseoutComment({ actionName, fixUrl, provenance }: LooseRecord) {
  const relation = actionName === "close_superseded" ? "superseded by" : "covered by";
  return codexStyleComment({
    badge: "DONE",
    headline: "Close thread after canonical fix landed",
    body: `This thread is ${relation} ${fixUrl}, which has landed as the canonical ClawSweeper fix path for this cluster. Closing now keeps follow-up attached to the code that shipped; reply here if a separate reproduction remains.`,
    provenance,
  });
}

export function sampleExternalMessages() {
  const provenance = externalMessageProvenance({
    model: "gpt-5.5",
    reasoning: "high",
    reviewedSha: "ba0f2e948fc0cafe1234567890abcdef12345678",
  });
  const baseAction = {
    evidence: [
      "The same reproduction is tracked on the canonical thread.",
      { detail: "The replacement PR carries the current validation path." },
    ],
  };
  return [
    {
      title: "Contributor Branch Repair",
      body: repairContributorBranchComment({
        sourcePrUrl: "https://github.com/openclaw/openclaw/pull/12345",
        validationCommands: ["pnpm test:serial src/example.test.ts", "pnpm check:changed"],
        provenance,
      }),
    },
    {
      title: "Replacement PR Link",
      body: replacementSourceLinkComment({
        replacementPrUrl: "https://github.com/openclaw/openclaw/pull/67890",
        sourcePrUrl: "https://github.com/openclaw/openclaw/pull/12345",
        contributorCredits: [
          {
            login: "contributor",
            co_authored_by:
              "Co-authored-by: Contributor <123+contributor@users.noreply.github.com>",
          },
        ],
        provenance,
      }),
    },
    {
      title: "Replacement PR Close",
      body: replacementSourceCloseComment({
        replacementPrUrl: "https://github.com/openclaw/openclaw/pull/67890",
        sourcePrUrl: "https://github.com/openclaw/openclaw/pull/12345",
        contributorCredits: [
          {
            login: "contributor",
            co_authored_by:
              "Co-authored-by: Contributor <123+contributor@users.noreply.github.com>",
          },
        ],
        provenance,
      }),
    },
    {
      title: "Replacement PR Body",
      body: replacementPrBody({
        clusterId: "ghcrawl-123456-agentic-merge",
        fixArtifact: {
          pr_body:
            "Fixes the focused provider auth regression.\n\nValidation: `pnpm check:changed`",
          source_prs: ["https://github.com/openclaw/openclaw/pull/12345"],
          credit_notes: ["Thanks @contributor for the original report and branch."],
          validation_commands: ["pnpm check:changed"],
        },
        fallbackReason: "source branch was not safely writable",
        contributorCredits: [
          {
            login: "contributor",
            co_authored_by:
              "Co-authored-by: Contributor <123+contributor@users.noreply.github.com>",
          },
        ],
        provenance,
      }),
    },
    {
      title: "Duplicate Closeout",
      body: defaultCloseComment({
        action: baseAction,
        classification: "duplicate",
        clusterId: "ghcrawl-123456-agentic-merge",
        target: 54321,
        title: "Duplicate provider auth bug",
        canonical: 12345,
        reason: "duplicate of the canonical thread",
        provenance,
      }),
    },
    {
      title: "Low-Signal Closeout",
      body: defaultCloseComment({
        action: { evidence: ["No current validation or focused OpenClaw change was present."] },
        classification: "low_signal",
        clusterId: "low-signal-pr-sweep-20260427T0530-01",
        target: 55555,
        title: "Unscoped cleanup draft",
        reason: "low-signal PR cleanup",
        provenance,
      }),
    },
    {
      title: "Post-Merge Closeout",
      body: postMergeCloseoutComment({
        actionName: "close_fixed_by_candidate",
        fixUrl: "https://github.com/openclaw/openclaw/pull/67890",
        provenance,
      }),
    },
  ];
}
