import { markdownTopLevelSection } from "../../clawsweeper-markdown.js";
import {
  extractClawSweeperCommandLine,
  isClawSweeperReReviewCommandText,
  reviewPromptFromClawSweeperCommandText,
} from "../comment-command-text.js";
import { asJsonObject, type JsonObject, type JsonValue, type LooseRecord } from "../json-types.js";
import { markerAttributes } from "../markers.js";

export const DEFAULT_ALLOWED_REPOSITORY_PERMISSIONS = ["admin", "maintain", "write"];

export function isMaintainerCommandAllowed({
  authorAssociation,
  repositoryPermission = null,
  allowedAssociations,
  allowedRepositoryPermissions = DEFAULT_ALLOWED_REPOSITORY_PERMISSIONS,
}: LooseRecord) {
  const permission = String(repositoryPermission ?? "")
    .trim()
    .toLowerCase();
  const permissionSet = new Set(
    [...allowedRepositoryPermissions]
      .map((value: string) => String(value).trim().toLowerCase())
      .filter(Boolean),
  );
  if (permission) return permissionSet.has(permission);

  const association = String(authorAssociation ?? "")
    .trim()
    .toUpperCase();
  const associationSet = new Set(
    [...allowedAssociations]
      .map((value: string) => String(value).trim().toUpperCase())
      .filter(Boolean),
  );
  return association === "OWNER" && associationSet.has(association);
}

export function isAuthorReadOnlyCommandAllowed({ command, target }: LooseRecord) {
  const intent = String(command?.intent ?? "");
  if (intent !== "re_review") return false;
  const author = normalizedLogin(command?.author);
  const targetAuthor = normalizedLogin(target?.author);
  return Boolean(author && targetAuthor && author === targetAuthor);
}

export function normalizedLogin(value: JsonValue) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function isTrustedStatusCommentAuthor(
  comment: LooseRecord | null | undefined,
  trustedAuthors: ReadonlySet<string>,
): boolean {
  // Missing authors fail closed; do not normalize padded logins into trusted identities.
  const author = String(comment?.user?.login ?? "").toLowerCase();
  return !!author && (author === "clawsweeper" || trustedAuthors.has(author));
}

export function isAllowedMutationActor(login: JsonValue, trustedBots: Iterable<string>) {
  const actor = String(login ?? "")
    .trim()
    .toLowerCase();
  if (!actor) return false;
  for (const trustedBot of trustedBots) {
    if (
      String(trustedBot ?? "")
        .trim()
        .toLowerCase() === actor
    )
      return true;
  }
  return false;
}

export function normalizeGitHubActor(login: JsonValue) {
  // Strip every trailing [bot] suffix: "evil[bot][bot]" must not normalize to
  // "evil[bot]" and collide with a real bot's normalized identity (#574).
  return String(login ?? "")
    .trim()
    .toLowerCase()
    .replace(/(\[bot\])+$/i, "");
}

export function isGitHubAppIntegrationAuthError(message: JsonValue) {
  const text = String(message ?? "").toLowerCase();
  return (
    text.includes("resource not accessible by integration") &&
    (text.includes("http 403") || /"status"\s*:\s*"403"/.test(text) || text.includes("status: 403"))
  );
}

export function parseCommand(body: string) {
  if (isProofNudgeCommentBody(body)) return null;
  const commandLine = extractClawSweeperCommandLine(body);
  if (!commandLine) return null;
  const command = commandFromText(commandLine.trigger, commandLine.commandText);
  if (!commandLine.supportsContinuation) return command;
  const rest = commandLine.rest;
  if (command.intent === "request_proof" && rest) {
    command.proof_command_text += "\n" + rest;
  }
  if (command.intent !== "freeform_assist") {
    if (command.intent === "implement_issue" && rest) {
      return commandFromText(
        commandLine.trigger,
        `${issueImplementationRestPrefix(command)}\n${rest}`,
      );
    }
    if (command.intent === "automerge" && rest) {
      command.automerge_instructions = rest;
      return command;
    }
    if (commandLine.trigger === "mention" && command.command === "status" && rest) {
      return commandFromText(commandLine.trigger, rest);
    }
    return command;
  }
  return commandLine.trigger === "mention" && rest
    ? commandFromText(commandLine.trigger, `${commandLine.commandText}\n${rest}`)
    : command;
}

export function parseTrustedAutomation(
  comment: LooseRecord,
  { trustedAuthors = new Set() }: LooseRecord = {},
) {
  const author = String(comment?.user?.login ?? "").toLowerCase();
  if (!trustedAuthors.has(author)) return null;

  const body = String(comment?.body ?? "");
  if (canonicalReviewStartStatusMarker(body)) return null;
  if (isProofNudgeCommentBody(body)) return null;
  const verdict = clawsweeperMarker(body, "verdict");
  const actionMarker = clawsweeperMarker(body, "action");
  const securityMarker = clawsweeperMarker(body, "security");
  if (actionMarker?.action === "close-required" || verdict?.action === "close") {
    const marker = actionMarker ?? verdict;
    if (marker) {
      return trustedCommand("autoclose", {
        author,
        reason: `structured ClawSweeper close marker: ${marker.action}${markerReasonSuffix(marker.attrs)}`,
        marker,
      });
    }
  }
  if (verdict?.action === "human-review") {
    return trustedCommand("clawsweeper_needs_human", {
      author,
      reason: trustedHumanReviewReason(body, verdict),
      marker: verdict,
    });
  }
  if (verdict?.action === "needs-human" && securityMarker?.action === "security-sensitive") {
    return trustedCommand("clawsweeper_needs_human", {
      author,
      reason: trustedHumanReviewReason(body, verdict),
      marker: verdict,
    });
  }
  if (verdict?.action === "needs-human" && Number(verdict.attrs.findings) > 0) {
    return trustedCommand("clawsweeper_auto_repair", {
      author,
      reason: `structured ClawSweeper needs-human verdict with repairable review findings${markerReasonSuffix(verdict.attrs)}`,
      marker: verdict,
    });
  }
  if (verdict?.action === "needs-human") {
    return trustedCommand("clawsweeper_needs_human", {
      author,
      reason: trustedHumanReviewReason(body, verdict),
      marker: verdict,
    });
  }
  if (
    actionMarker &&
    ["fix-required", "repair-required", "address-review", "fix-ci"].includes(actionMarker.action)
  ) {
    return trustedCommand("clawsweeper_auto_repair", {
      author,
      reason: `structured ClawSweeper marker: ${actionMarker.action}${markerReasonSuffix(actionMarker.attrs)}`,
      marker: actionMarker,
    });
  }
  if (
    verdict &&
    [
      "needs-changes",
      "changes-requested",
      "needs-repair",
      "fix-required",
      "repair-required",
    ].includes(verdict.action)
  ) {
    return trustedCommand("clawsweeper_auto_repair", {
      author,
      reason: `structured ClawSweeper verdict: ${verdict.action}${markerReasonSuffix(verdict.attrs)}`,
      marker: verdict,
    });
  }
  if (verdict && ["pass", "approved", "no-changes"].includes(verdict.action)) {
    const liveVerification = markerLiveVerificationState(verdict);
    if (liveVerification === "failed" || liveVerification === "malformed") {
      return trustedCommand("clawsweeper_needs_human", {
        author,
        reason: `attached live verification is ${liveVerification}`,
        marker: verdict,
      });
    }
    if (liveVerification === "unknown") return null;
    return trustedCommand("clawsweeper_auto_merge", {
      author,
      reason: `structured ClawSweeper verdict: ${verdict.action}${markerReasonSuffix(verdict.attrs)}`,
      marker: verdict,
    });
  }
  return null;
}

const REVIEW_START_LEASE_MAX_MS = 2 * 60 * 60 * 1000;
const REVIEW_START_LEASE_CLOCK_SKEW_MS = 5 * 60 * 1000;

function canonicalReviewStartStatusMarker(body: string) {
  const identity = String(body ?? "").match(
    /<!--\s*clawsweeper-(?:review(?:-lease)?|command-review-lease)\s+item=(\d+)\s*-->\s*$/i,
  );
  const itemNumber = Number(identity?.[1]);
  if (!identity || !Number.isInteger(itemNumber) || itemNumber <= 0) return null;
  const prefix = body.slice(0, identity.index).trimEnd();
  const markerStart = prefix.lastIndexOf("<!--");
  if (markerStart < 0) return null;
  const markerBody = prefix.slice(markerStart);
  if (!/^<!--\s*clawsweeper-review-status:started\b[^>]*-->$/i.test(markerBody)) return null;
  const marker = clawsweeperMarker(markerBody, "review-status");
  if (marker?.action !== "started" || Number(marker.attrs.item) !== itemNumber) return null;
  return { itemNumber, marker };
}

function hasDedicatedReviewStartLeaseMarker(body: string, itemNumber: number): boolean {
  return [
    `<!-- clawsweeper-review-lease item=${itemNumber} -->`,
    `<!-- clawsweeper-command-review-lease item=${itemNumber} -->`,
  ].some((marker) => body.includes(marker));
}

export function isTrustedReviewStartStatusComment({
  comment,
  trustedAuthors = new Set<string>(),
}: {
  comment: LooseRecord;
  trustedAuthors?: ReadonlySet<string>;
}) {
  const author = String(comment?.user?.login ?? "")
    .trim()
    .toLowerCase();
  return Boolean(
    author && trustedAuthors.has(author) && canonicalReviewStartStatusMarker(comment.body),
  );
}

export function freshExactHeadReviewStartLease({
  comments,
  itemNumber,
  headSha,
  trustedAuthors = new Set<string>(),
  nowMs = Date.now(),
}: {
  comments: LooseRecord[];
  itemNumber: number;
  headSha: string;
  trustedAuthors?: ReadonlySet<string>;
  nowMs?: number;
}): {
  startedAt: string;
  expiresAt: string;
  owner: string | null;
  commentId: number | null;
} | null {
  const normalizedHead = String(headSha ?? "")
    .trim()
    .toLowerCase();
  if (
    !Number.isInteger(itemNumber) ||
    itemNumber <= 0 ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(normalizedHead)
  ) {
    return null;
  }
  const candidates: Array<{
    startedAt: string;
    expiresAt: string;
    owner: string | null;
    commentId: number | null;
    serverOrder: number;
  }> = [];
  for (const [serverOrder, comment] of comments.entries()) {
    const author = String(comment?.user?.login ?? "")
      .trim()
      .toLowerCase();
    if (!author || !trustedAuthors.has(author)) continue;
    const canonical = canonicalReviewStartStatusMarker(String(comment?.body ?? ""));
    if (!canonical || canonical.itemNumber !== itemNumber) continue;
    const { marker } = canonical;
    if (
      String(marker.attrs.sha ?? "")
        .trim()
        .toLowerCase() !== normalizedHead
    )
      continue;
    if (String(marker.attrs.v ?? "") !== "1") continue;
    const startedAt = String(marker.attrs.started_at ?? "");
    const expiresAt = String(marker.attrs.lease_expires_at ?? "");
    const owner = String(marker.attrs.owner ?? "").trim() || null;
    const rawCommentId = Number(comment?.id);
    const commentId = Number.isInteger(rawCommentId) && rawCommentId > 0 ? rawCommentId : null;
    const startedAtMs = Date.parse(startedAt);
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(expiresAtMs)) continue;
    const durationMs = expiresAtMs - startedAtMs;
    if (durationMs <= 0 || durationMs > REVIEW_START_LEASE_MAX_MS) continue;
    if (startedAtMs > nowMs + REVIEW_START_LEASE_CLOCK_SKEW_MS) continue;
    if (expiresAtMs < nowMs) continue;
    candidates.push({ startedAt, expiresAt, owner, commentId, serverOrder });
  }
  // GitHub comment ids are server-assigned and monotonic. Elect the first server-created lease;
  // client clocks only validate the TTL and never choose the winner. Legacy id-less comments
  // cannot displace a server-identified lease; if every candidate is legacy, preserve API order.
  const selected = candidates.sort((left, right) => {
    if (left.commentId !== null && right.commentId !== null) {
      return left.commentId - right.commentId;
    }
    if (left.commentId !== null) return -1;
    if (right.commentId !== null) return 1;
    return left.serverOrder - right.serverOrder;
  })[0];
  return selected
    ? {
        startedAt: selected.startedAt,
        expiresAt: selected.expiresAt,
        owner: selected.owner,
        commentId: selected.commentId,
      }
    : null;
}

export function expiredReviewStartStatusLeases({
  comments,
  itemNumber,
  trustedAuthors = new Set<string>(),
  nowMs = Date.now(),
}: {
  comments: LooseRecord[];
  itemNumber: number;
  trustedAuthors?: ReadonlySet<string>;
  nowMs?: number;
}): Array<{ commentId: number; expiresAt: string }> {
  if (!Number.isInteger(itemNumber) || itemNumber <= 0) return [];
  const expired: Array<{ commentId: number; expiresAt: string }> = [];
  for (const comment of comments) {
    const author = String(comment?.user?.login ?? "")
      .trim()
      .toLowerCase();
    if (!author || !trustedAuthors.has(author)) continue;
    const body = String(comment?.body ?? "");
    // Only dedicated lease comments are reapable. The durable review comment can
    // carry the same started marker via the legacy combined-lease path, and it
    // must never be deleted here.
    if (!hasDedicatedReviewStartLeaseMarker(body, itemNumber)) continue;
    const canonical = canonicalReviewStartStatusMarker(body);
    if (!canonical || canonical.itemNumber !== itemNumber) continue;
    if (String(canonical.marker.attrs.v ?? "") !== "1") continue;
    const expiresAt = String(canonical.marker.attrs.lease_expires_at ?? "");
    const expiresAtMs = Date.parse(expiresAt);
    // Unparseable expiry never qualifies: deleting is unrecoverable, so only a
    // lease that provably lapsed may be reaped.
    if (!Number.isFinite(expiresAtMs) || expiresAtMs >= nowMs) continue;
    const rawCommentId = Number(comment?.id);
    if (!Number.isInteger(rawCommentId) || rawCommentId <= 0) continue;
    expired.push({ commentId: rawCommentId, expiresAt });
  }
  return expired;
}

export function supersededReviewStartStatusLeases({
  comments,
  itemNumber,
  headSha,
  authoritativeHeadSha,
  trustedAuthors = new Set<string>(),
}: {
  comments: LooseRecord[];
  itemNumber: number;
  headSha: string;
  authoritativeHeadSha: string;
  trustedAuthors?: ReadonlySet<string>;
}): Array<{ commentId: number; headSha: string }> {
  const normalizedHead = String(headSha ?? "")
    .trim()
    .toLowerCase();
  const normalizedAuthoritativeHead = String(authoritativeHeadSha ?? "")
    .trim()
    .toLowerCase();
  if (
    !Number.isInteger(itemNumber) ||
    itemNumber <= 0 ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(normalizedHead) ||
    normalizedAuthoritativeHead !== normalizedHead
  ) {
    return [];
  }
  const superseded: Array<{ commentId: number; headSha: string }> = [];
  for (const comment of comments) {
    const author = String(comment?.user?.login ?? "")
      .trim()
      .toLowerCase();
    if (!author || !trustedAuthors.has(author)) continue;
    const body = String(comment?.body ?? "");
    if (!hasDedicatedReviewStartLeaseMarker(body, itemNumber)) continue;
    const canonical = canonicalReviewStartStatusMarker(body);
    if (!canonical || canonical.itemNumber !== itemNumber) continue;
    if (String(canonical.marker.attrs.v ?? "") !== "1") continue;
    const reviewedHead = String(canonical.marker.attrs.sha ?? "")
      .trim()
      .toLowerCase();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(reviewedHead) || reviewedHead === normalizedHead) {
      continue;
    }
    const rawCommentId = Number(comment?.id);
    if (!Number.isInteger(rawCommentId) || rawCommentId <= 0) continue;
    superseded.push({ commentId: rawCommentId, headSha: reviewedHead });
  }
  return superseded;
}

export function trustedAutomationPredatesReviewStartLease({
  command,
  currentHeadSha,
  lease,
}: {
  command: LooseRecord;
  currentHeadSha: string;
  lease: {
    startedAt: string;
    expiresAt: string;
    owner: string | null;
    commentId: number | null;
  } | null;
}): boolean {
  if (!lease || command.trusted_bot !== true || command.automation_source !== "clawsweeper") {
    return false;
  }
  const expectedHeadSha = String(command.expected_head_sha ?? "")
    .trim()
    .toLowerCase();
  const normalizedCurrentHeadSha = String(currentHeadSha ?? "")
    .trim()
    .toLowerCase();
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(normalizedCurrentHeadSha) ||
    expectedHeadSha !== normalizedCurrentHeadSha
  ) {
    return true;
  }
  const commandOwner = String(command.review_lease_owner ?? "").trim();
  const commandCommentId = Number(command.review_lease_comment_id);
  if (!lease.owner || commandOwner !== lease.owner) return true;
  if (lease.commentId !== null) {
    return !Number.isInteger(commandCommentId) || commandCommentId !== lease.commentId;
  }
  // Legacy owner-only and ownerless leases cannot be safely superseded using client clocks.
  return true;
}

export function trustedExactHeadReviewCompletionSince({
  comments,
  headSha,
  trustedAuthors = new Set<string>(),
  sinceMs,
}: {
  comments: LooseRecord[];
  headSha: string;
  trustedAuthors?: ReadonlySet<string>;
  sinceMs: number;
}): {
  commentId: number;
  reviewedAt: string | null;
  publishedAt: string | null;
  sourceRevision: string | null;
} | null {
  const normalizedHead = String(headSha ?? "")
    .trim()
    .toLowerCase();
  if (!normalizedHead || !Number.isFinite(sinceMs)) return null;

  let newest: {
    commentId: number;
    observedAtMs: number;
    reviewedAt: string | null;
    publishedAt: string | null;
    sourceRevision: string | null;
  } | null = null;
  for (const comment of comments) {
    const completed = parseTrustedAutomation(comment, { trustedAuthors });
    if (!completed) continue;
    const commentId = Number(comment?.id);
    if (!Number.isInteger(commentId) || commentId <= 0) continue;
    if (
      String(completed.expected_head_sha ?? "")
        .trim()
        .toLowerCase() !== normalizedHead
    )
      continue;

    const body = String(comment?.body ?? "");
    const reviewMarker = [
      clawsweeperMarker(body, "verdict"),
      clawsweeperMarker(body, "action"),
    ].find(
      (marker) =>
        String(marker?.attrs?.sha ?? "")
          .trim()
          .toLowerCase() === normalizedHead,
    );
    const reviewedAt = String(reviewMarker?.attrs?.reviewed_at ?? "").trim() || null;
    const sourceRevision = String(reviewMarker?.attrs?.source_revision ?? "").trim() || null;
    const publishedAt = String(comment?.updated_at ?? comment?.created_at ?? "").trim() || null;
    const observedAtMs = Math.max(
      Number.isFinite(Date.parse(reviewedAt ?? "")) ? Date.parse(reviewedAt ?? "") : 0,
      Number.isFinite(Date.parse(publishedAt ?? "")) ? Date.parse(publishedAt ?? "") : 0,
    );
    if (observedAtMs < sinceMs || observedAtMs <= 0) continue;
    if (!newest || observedAtMs > newest.observedAtMs) {
      newest = { commentId, observedAtMs, reviewedAt, publishedAt, sourceRevision };
    }
  }
  return (
    newest && {
      commentId: newest.commentId,
      reviewedAt: newest.reviewedAt,
      publishedAt: newest.publishedAt,
      sourceRevision: newest.sourceRevision,
    }
  );
}

export function parseRoutedCommentCommand(
  comment: LooseRecord,
  { trustedAuthors = new Set() }: LooseRecord = {},
) {
  if (isAssistPublicationCommentBody(String(comment?.body ?? ""))) return null;
  if (isTrustedReviewStartStatusComment({ comment, trustedAuthors })) return null;
  const trusted = parseTrustedAutomation(comment, { trustedAuthors });
  if (trusted) return trusted;
  return parseCommand(String(comment?.body ?? ""));
}

export function isAssistPublicationCommentBody(body: string) {
  return /<!--\s*clawsweeper-(?:assist:|visual(?:\s|-->))/i.test(String(body ?? ""));
}

export function isProofNudgeCommentBody(body: string) {
  return /<!--\s*clawsweeper-proof-nudge(?:\s|-->)/i.test(String(body ?? ""));
}

function decisionNeededReason(body: string): string {
  const section = markdownTopLevelSection(body, "Decision needed");
  return section ? compactReason(`Maintainer decision needed: ${section}`, 220) : "";
}

function beforeMergeReason(body: string): string {
  const raw = markdownTopLevelSection(body, "Before merge");
  // New-format comments render "None." when no checklist entries remain; that is a
  // no-action sentinel, not a reason a human needs to look. Decision-only reviews
  // still carry their outstanding maintainer question.
  if (!raw) return "";
  if (/^none[.!]?$/i.test(raw.trim())) return decisionNeededReason(body);
  const lines = raw.split(/\r?\n/).map((line) => line.trim());
  const tasks = lines.filter((line) => /^- \[[ xX]\]/.test(line));
  if (tasks.length) {
    // A checklist where every task is checked leaves only a pending decision, if any.
    const unresolved = tasks.find((line) => line.startsWith("- [ ]"));
    return unresolved ? compactReason(unresolved, 220) : decisionNeededReason(body);
  }
  return compactReason(raw, 220);
}

function trustedHumanReviewReason(body: string, verdict: LooseRecord | null) {
  // A present Before merge section is authoritative; only legacy comments without
  // it may fall back to the old follow-up heading.
  const hasBeforeMergeSection = markdownTopLevelSection(body, "Before merge") !== "";
  const details = [
    beforeMergeReason(body),
    hasBeforeMergeSection ? "" : markdownSection(body, "Next step before merge"),
    markdownSection(body, "Security"),
    firstReviewFinding(body),
  ].filter(Boolean);
  const suffix = markerReasonSuffix(verdict?.attrs);
  const fallback = verdict?.action
    ? `structured ClawSweeper verdict: ${verdict.action}${suffix}`
    : "ClawSweeper requested human review";
  if (details.length === 0) return fallback;
  return `${compactReason(details.join("; "), 420)}${suffix}`;
}

function markdownSection(body: string, heading: string) {
  return compactReason(markdownTopLevelSection(body, heading), 220);
}

function firstReviewFinding(body: string) {
  const section = markdownSection(body, "Findings") || markdownSection(body, "Review findings");
  const finding = section.match(/(?:^|;\s*|\n)\s*[-*]\s*(.+?)(?:$|;\s*|\n)/)?.[1] ?? "";
  return finding ? compactReason(`Review finding: ${finding}`, 180) : "";
}

function compactReason(value: JsonValue, max = 300) {
  const text = String(value ?? "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .replace(/\bNeeds attention:\s+Needs attention:\s+/i, "Needs attention: ")
    .trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function commandFromText(trigger: JsonValue, value: JsonValue) {
  const rawText = String(value ?? "status").trim();
  const rawCommand = rawText.replace(/\s+/g, " ");
  const rawNormalized = rawCommand.toLowerCase();
  const command = normalizeCommandForIntent(rawNormalized);
  let intent = normalizeIntent(command);
  if (
    trigger === "mention" &&
    intent === "help" &&
    !["", "help", "?", "help.", "help!", "help?"].includes(rawNormalized)
  ) {
    intent = "freeform_assist";
  }
  const parsedCommand =
    intent === "freeform_assist" || intent === "autoclose" || intent === "visualize"
      ? rawNormalized
      : command;
  const parsed: LooseRecord = { trigger, command: parsedCommand, intent };
  if (intent === "autoclose") parsed.autoclose_message = autocloseReasonFromCommand(rawCommand);
  if (intent === "freeform_assist") parsed.freeform_prompt = assistPromptFromCommand(rawCommand);
  if (intent === "request_proof") parsed.proof_command_text = rawText;
  if (intent === "re_review") {
    const prompt = reviewPromptFromClawSweeperCommandText(rawText);
    if (prompt) parsed.freeform_prompt = prompt;
  }
  if (intent === "visualize") parsed.visual_lens = visualLensFromCommand(rawCommand);
  if (intent === "implement_issue") {
    parsed.implementation_prompt = implementationPromptFromCommand(rawText);
    if (isIssueImplementationOverride(rawCommand)) parsed.operator_override = true;
  }
  return parsed;
}

function normalizeCommandForIntent(command: string) {
  if (command === "?" || command.startsWith("autoclose ")) return command;
  return command.replace(/[.!]+$/g, "");
}

export function autocloseReasonFromCommand(command: LooseRecord) {
  const match = String(command ?? "")
    .trim()
    .match(/^autoclose(?:\s+([\s\S]+))?$/i);
  return String(match?.[1] ?? "").trim();
}

function implementationPromptFromCommand(command: LooseRecord) {
  return String(command ?? "")
    .trim()
    .replace(
      /^(?:implement|build(?:\s+override)?|create\s+pr|open\s+pr|fix\s+issue|fix)\b[:\s-]*/i,
      "",
    )
    .trim();
}

function isIssueImplementationOverride(command: string) {
  return /^build\s+override(?:\s|$)/i.test(command.trim());
}

function assistPromptFromCommand(command: LooseRecord) {
  const prompt = String(command ?? "").trim();
  return prompt.replace(/^(?:ask|explain)\b[:\s-]*/i, "").trim() || prompt;
}

export const VISUAL_LENSES = new Set([
  "ux",
  "flow",
  "state",
  "data",
  "proof",
  "risk",
  "maintainer",
]);

function visualLensFromCommand(command: LooseRecord) {
  const lens =
    String(command ?? "")
      .trim()
      .toLowerCase()
      .replace(/^visuali[sz]e\b[:\s-]*/i, "")
      .split(/\s+/)[0] ?? "";
  return VISUAL_LENSES.has(lens) ? lens : "auto";
}

function issueImplementationRestPrefix(command: LooseRecord) {
  return command.command === "fix" ? "fix issue" : command.command;
}

function normalizeIntent(command: LooseRecord) {
  if (!command || command === "status") return "status";
  if (command === "proof" || command.startsWith("proof ")) return "request_proof";
  if (["help", "?"].includes(command)) return "help";
  if (["explain", "why"].includes(command)) return "explain";
  if (
    command === "ask" ||
    command.startsWith("ask ") ||
    command.startsWith("explain ") ||
    command.startsWith("why ")
  ) {
    return "freeform_assist";
  }
  if (
    command === "visualize" ||
    command === "visualise" ||
    command.startsWith("visualize ") ||
    command.startsWith("visualise ")
  ) {
    return "visualize";
  }
  if (["fix ci", "fix-ci", "ci", "repair ci", "repair checks", "fix checks"].includes(command))
    return "fix_ci";
  if (["address review", "address-review", "fix review"].includes(command)) return "address_review";
  if (
    command === "implement" ||
    command.startsWith("implement ") ||
    command === "build" ||
    command.startsWith("build ") ||
    command === "create pr" ||
    command.startsWith("create pr ") ||
    command === "open pr" ||
    command.startsWith("open pr ") ||
    command === "fix" ||
    command === "fix issue" ||
    command.startsWith("fix issue ")
  ) {
    return "implement_issue";
  }
  if (isClawSweeperReReviewCommandText(command)) return "re_review";
  if (["rebase", "update branch", "sync"].includes(command)) return "rebase";
  if (["autofix", "auto fix", "fix when needed", "repair only", "autofix on"].includes(command)) {
    return "autofix";
  }
  if (
    [
      "automerge",
      "auto-merge",
      "auto merge",
      "merge when clean",
      "merge when ready",
      "automerge on",
      "auto-merge on",
      "auto merge on",
    ].includes(command)
  ) {
    return "automerge";
  }
  if (["approve", "approve automerge", "approve merge", "merge"].includes(command)) {
    return "maintainer_approve_automerge";
  }
  if (command === "autoclose" || command.startsWith("autoclose ")) return "autoclose";
  if (["stop", "pause", "human review", "handoff"].includes(command)) return "stop";
  return "help";
}

function trustedCommand(
  intent:
    | "clawsweeper_auto_repair"
    | "clawsweeper_auto_merge"
    | "clawsweeper_needs_human"
    | "autoclose",
  {
    author,
    reason,
    marker = null,
  }: {
    author: string;
    reason: string;
    marker?: { action: string; attrs: Record<string, string> } | null;
  },
) {
  const attrs = marker?.attrs;
  return {
    trigger: "trusted_bot",
    command: intent === "autoclose" ? `autoclose ${reason}` : intent.replaceAll("_", " "),
    intent,
    trusted_bot: true,
    trusted_bot_author: author,
    automation_source: "clawsweeper",
    repair_reason: reason,
    expected_head_sha: attrs?.sha ?? null,
    reviewed_at: attrs?.reviewed_at ?? null,
    review_lease_owner: attrs?.lease_owner ?? null,
    review_lease_comment_id: attrs?.lease_comment_id ?? null,
    expected_source_revision: attrs?.source_revision ?? null,
    finding_id: attrs?.finding ?? null,
    ...(intent === "autoclose"
      ? {
          autoclose_message: reason,
          close_reason: attrs?.reason ?? null,
          close_confidence: attrs?.confidence ?? null,
          close_action_taken: attrs?.action_taken ?? null,
          expected_item_updated_at: attrs?.updated_at ?? null,
        }
      : {
          live_verification: markerLiveVerificationState(marker),
          needs_human_hold: attrs?.hold ?? null,
          review_findings: attrs?.findings ?? null,
        }),
  };
}

export type TrustedLiveVerificationState = "absent" | "passed" | "failed" | "malformed" | "unknown";

function markerLiveVerificationState(marker: unknown): TrustedLiveVerificationState {
  return liveVerificationState(asJsonObject(asJsonObject(marker).attrs).live_verification);
}

function liveVerificationState(value: unknown): TrustedLiveVerificationState {
  if (typeof value !== "string") return "unknown";
  return ["absent", "passed", "failed", "malformed"].includes(value)
    ? (value as Exclude<TrustedLiveVerificationState, "unknown">)
    : "unknown";
}

export interface TrustedExactHeadReview {
  decision: "pass" | "repair" | "human" | "non_landing" | "legacy";
  liveVerification: TrustedLiveVerificationState;
  command: JsonObject | null;
  commentCreatedAt: string | null;
  commentUpdatedAt: string | null;
}

export function latestTrustedExactHeadReview({
  comments,
  headSha,
  trustedAuthors,
}: {
  comments: JsonValue[];
  headSha: string;
  trustedAuthors: ReadonlySet<string>;
}): TrustedExactHeadReview | null {
  let latest: {
    review: TrustedExactHeadReview;
    publishedAt: number;
    commentId: bigint | null;
    tieBreaker: string;
  } | null = null;
  for (const comment of comments) {
    const commentRecord = asJsonObject(comment);
    const commentCreatedAt =
      typeof commentRecord.created_at === "string" ? commentRecord.created_at : null;
    const commentUpdatedAt =
      typeof commentRecord.updated_at === "string" ? commentRecord.updated_at : null;
    const command = asJsonObject(parseTrustedAutomation(comment, { trustedAuthors }));
    let review: TrustedExactHeadReview | null = null;
    if (String(command.expected_head_sha ?? "") === headSha) {
      if (command.intent === "clawsweeper_auto_merge") {
        review = {
          decision: "pass",
          liveVerification: liveVerificationState(command.live_verification),
          command,
          commentCreatedAt,
          commentUpdatedAt,
        };
      } else if (command.intent === "clawsweeper_auto_repair") {
        review = {
          decision: "repair",
          liveVerification: liveVerificationState(command.live_verification),
          command,
          commentCreatedAt,
          commentUpdatedAt,
        };
      } else if (command.intent === "clawsweeper_needs_human") {
        review = {
          decision: "human",
          liveVerification: liveVerificationState(command.live_verification),
          command,
          commentCreatedAt,
          commentUpdatedAt,
        };
      } else if (command.intent) {
        review = {
          decision: "non_landing",
          liveVerification: liveVerificationState(command.live_verification),
          command,
          commentCreatedAt,
          commentUpdatedAt,
        };
      }
    }

    if (!review) {
      const author = String((comment as LooseRecord)?.user?.login ?? "").toLowerCase();
      const verdict = trustedAuthors.has(author)
        ? clawsweeperMarker(String((comment as LooseRecord)?.body ?? ""), "verdict")
        : null;
      if (verdict && String(verdict.attrs.sha ?? "") === headSha) {
        const liveVerification = markerLiveVerificationState(verdict);
        review = {
          decision:
            ["pass", "approved", "no-changes"].includes(verdict.action) &&
            liveVerification === "unknown"
              ? "legacy"
              : "non_landing",
          liveVerification,
          command: null,
          commentCreatedAt,
          commentUpdatedAt,
        };
      }
    }
    if (!review) continue;

    const candidate = {
      review,
      publishedAt: trustedReviewPublicationTime(commentUpdatedAt, commentCreatedAt),
      commentId: trustedReviewCommentId(commentRecord.id),
      tieBreaker: [
        String(commentRecord.user?.login ?? "").toLowerCase(),
        String(commentRecord.body ?? ""),
        commentUpdatedAt ?? "",
        commentCreatedAt ?? "",
      ].join("\0"),
    };
    if (!latest || compareTrustedExactHeadReviewCandidates(candidate, latest) > 0) {
      latest = candidate;
    }
  }
  return latest?.review ?? null;
}

function trustedReviewPublicationTime(updatedAt: string | null, createdAt: string | null) {
  const updatedAtMs = Date.parse(updatedAt ?? "");
  if (Number.isFinite(updatedAtMs)) return updatedAtMs;
  const createdAtMs = Date.parse(createdAt ?? "");
  return Number.isFinite(createdAtMs) ? createdAtMs : 0;
}

function trustedReviewCommentId(value: JsonValue): bigint | null {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

function compareTrustedExactHeadReviewCandidates(
  left: {
    publishedAt: number;
    commentId: bigint | null;
    tieBreaker: string;
  },
  right: {
    publishedAt: number;
    commentId: bigint | null;
    tieBreaker: string;
  },
) {
  if (left.publishedAt !== right.publishedAt) return left.publishedAt - right.publishedAt;
  if (left.commentId !== null && right.commentId !== null && left.commentId !== right.commentId) {
    return left.commentId > right.commentId ? 1 : -1;
  }
  if (left.commentId !== null && right.commentId === null) return 1;
  if (left.commentId === null && right.commentId !== null) return -1;
  return left.tieBreaker.localeCompare(right.tieBreaker);
}

function clawsweeperMarker(body: string, kind: string) {
  const marker = String(body ?? "").match(
    new RegExp(`<!--\\s*clawsweeper-${kind}:\\s*([a-z0-9_-]+)([^>]*)-->`, "i"),
  );
  if (!marker) return null;
  return {
    action: (marker[1] ?? "").toLowerCase(),
    attrs: markerAttributes(marker[2] ?? ""),
  };
}

function markerReasonSuffix(attrs: LooseRecord) {
  const parts: JsonValue[] = [];
  if (attrs?.finding) parts.push(`finding=${attrs.finding}`);
  if (attrs?.sha) parts.push(`sha=${attrs.sha}`);
  return parts.length ? ` (${parts.join(" ")})` : "";
}
