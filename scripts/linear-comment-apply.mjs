#!/usr/bin/env node

/**
 * Single-item Linear review-comment planning runner.
 *
 * This is the proposal half of the ClawSweeper Linear review flow, scoped to ONE issue by
 * its human identifier (e.g. "PAR-244"). It runs the real review pipeline end-to-end and
 * reuses the existing planner + authority gate — it never reimplements comment body or
 * marker logic:
 *
 *   fetchIssueByIdentifier (read)  -> mapWorkspaceItem -> classifyRecord
 *     -> renderReviewCommentBody/planReviewCommentUpsert (comment.ts)
 *     -> reviewCommentMutationRequest -> authorizeMutation (authority.ts)
 *     -> secret-free planning receipt (comment mutations remain disabled)
 *
 * Auth identities remain modeled separately for reviewed ownership receipts:
 *   READ  — personal API key (raw header), from LINEAR_API_KEY/LINEAR_TOKEN or the macOS
 *           Keychain item "openclaw-linear-api-key". Used to fetch the issue + comments.
 *   ACTOR — the stable application actor ID expected to own a managed comment. It remains
 *           bound into plans and approvals, but no OAuth credential is read or token minted.
 *
 * Gating — proposal-only for every invocation:
 *   - Default mode is DRY-RUN: prints the planned comment body and whether it would create
 *     or update, and writes NOTHING. No OAuth token is minted in dry-run.
 *   - Comment creation and updates are planning-only until durable cross-process action
 *     settlement exists. Even --apply + OPENCLAW_NOTIFY_LINEAR=1 cannot execute them.
 *   - Authorization receipts remain useful reviewed evidence for a future settled lane.
 *
 * Secret hygiene: no token, client id, or client secret is ever logged.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  authorizeMutation,
  buildMutationReceipt,
  classifyRecord,
  createLinearTransport,
  evaluateReviewPolicy,
  LinearItemSource,
  mapWorkspaceItem,
  parseLinearIdentifier,
  planReviewCommentUpsert,
  renderAnalyzerSections,
  resolveGates,
  reviewCommentMutationRequest,
} from "../dist/linear/index.js";

const DEFAULT_STALE_DAYS = 60;

// Read-key Keychain coordinates (personal API key, raw header) — mirrors linear-snapshot.mjs.
export const READ_KEYCHAIN_SERVICE = "openclaw-linear-api-key";
// Reserved OAuth app coordinates for a future durably settled write path.
export const APP_CLIENT_ID_SERVICE = "openclaw-linear-clawsweeper-client-id";
export const APP_CLIENT_SECRET_SERVICE = "openclaw-linear-clawsweeper-secret";
export const DEFAULT_KEYCHAIN_ACCOUNT = "partnerai-config";

// Apply-intent opt-in retained for planning receipts; comment writes remain disabled.
export const NOTIFY_ENV = "OPENCLAW_NOTIFY_LINEAR";

export function parseArgs(argv) {
  const options = {
    identifier: "",
    apply: false,
    json: false,
    nowIso: undefined,
    staleDays: DEFAULT_STALE_DAYS,
    requiredLabels: [],
    exclusionLabels: [],
    protectedLabels: [],
    approvedPlanHash: "",
    approvedSnapshotHash: "",
    dryRunReceipt: "",
    keychainAccount: DEFAULT_KEYCHAIN_ACCOUNT,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--identifier":
      case "--issue":
        options.identifier = requireValue(argv, ++index, arg);
        break;
      case "--apply":
        options.apply = true;
        break;
      case "--dry-run":
        options.apply = false;
        break;
      case "--json":
        options.json = true;
        break;
      case "--now":
        options.nowIso = requireValue(argv, ++index, arg);
        break;
      case "--stale-days":
        options.staleDays = positiveInt(requireValue(argv, ++index, arg), "--stale-days");
        break;
      case "--required-label":
        options.requiredLabels.push(requireValue(argv, ++index, arg));
        break;
      case "--exclusion-label":
        options.exclusionLabels.push(requireValue(argv, ++index, arg));
        break;
      case "--protected-label":
        options.protectedLabels.push(requireValue(argv, ++index, arg));
        break;
      case "--approved-plan-hash":
        options.approvedPlanHash = requireHashValue(argv, ++index, arg);
        break;
      case "--approved-snapshot-hash":
        options.approvedSnapshotHash = requireHashValue(argv, ++index, arg);
        break;
      case "--dry-run-receipt":
        options.dryRunReceipt = requireValue(argv, ++index, arg);
        break;
      case "--keychain-account":
        options.keychainAccount = requireValue(argv, ++index, arg);
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!options.help && options.identifier === "") {
    throw new Error("--identifier <KEY> is required (e.g. --identifier PAR-244)");
  }

  return options;
}

function parseDryRunReceipt(raw, path) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `failed to parse --dry-run-receipt ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`--dry-run-receipt ${path} must contain a JSON object`);
  }
  return parsed;
}

function hashFromReceipt(receipt, key) {
  const direct = receipt[key];
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim().toLowerCase();
  const nested = receipt.receipt;
  if (typeof nested === "object" && nested !== null) {
    const value = nested[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim().toLowerCase();
  }
  return "";
}

function validateHash(hash, label) {
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error(`${label} must be a 64-character sha256 hex hash`);
  }
}

function authorIdFromReceipt(receipt) {
  const nested = receipt?.receipt;
  const value =
    typeof receipt?.expectedAuthorId === "string"
      ? receipt.expectedAuthorId
      : typeof nested === "object" && nested !== null && typeof nested.expectedAuthorId === "string"
        ? nested.expectedAuthorId
        : "";
  return value.trim();
}

function canonicalIdentifier(identifier) {
  const parsed = parseLinearIdentifier(identifier);
  return `${parsed.teamKey}-${parsed.number}`;
}

export function resolveApproval(options, deps = {}) {
  const readFile = deps.readFileSync ?? readFileSync;
  const hasReceipt = (options.dryRunReceipt ?? "") !== "";
  const hasDirect =
    (options.approvedPlanHash ?? "") !== "" || (options.approvedSnapshotHash ?? "") !== "";

  if (hasReceipt && hasDirect) {
    throw new Error(
      "use either --dry-run-receipt or direct --approved-plan-hash/--approved-snapshot-hash, not both",
    );
  }

  if (hasReceipt) {
    const receipt = parseDryRunReceipt(
      readFile(options.dryRunReceipt, "utf8"),
      options.dryRunReceipt,
    );
    if (
      typeof receipt.identifier === "string" &&
      typeof options.identifier === "string" &&
      canonicalIdentifier(receipt.identifier) !== canonicalIdentifier(options.identifier)
    ) {
      throw new Error(
        `--dry-run-receipt identifier ${receipt.identifier} does not match requested ${options.identifier}`,
      );
    }
    const approvedPlanHash = hashFromReceipt(receipt, "planHash");
    const approvedSnapshotHash = hashFromReceipt(receipt, "snapshotHash");
    const approvedAuthorId = authorIdFromReceipt(receipt);
    const nowIso = typeof receipt.nowIso === "string" ? receipt.nowIso.trim() : "";
    if (approvedPlanHash === "" || approvedSnapshotHash === "") {
      throw new Error("--dry-run-receipt must include planHash and snapshotHash");
    }
    validateHash(approvedPlanHash, "--dry-run-receipt planHash");
    validateHash(approvedSnapshotHash, "--dry-run-receipt snapshotHash");
    return {
      approvedPlanHash,
      approvedSnapshotHash,
      ...(approvedAuthorId !== "" ? { approvedAuthorId } : {}),
      ...(nowIso !== "" ? { nowIso } : {}),
      source: "dry-run-receipt",
    };
  }

  if (hasDirect) {
    if ((options.approvedPlanHash ?? "") === "" || (options.approvedSnapshotHash ?? "") === "") {
      throw new Error(
        "live approval requires both --approved-plan-hash and --approved-snapshot-hash",
      );
    }
    return {
      approvedPlanHash: options.approvedPlanHash,
      approvedSnapshotHash: options.approvedSnapshotHash,
      source: "direct-hashes",
    };
  }

  return null;
}

// Reads a generic password from the macOS Keychain without a shell. Returns "" on any miss.
function defaultKeychainLookup(service, account) {
  try {
    return execFileSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

/** Resolves the READ token (personal key, raw header): env first, else Keychain. */
export function resolveReadToken(options = {}) {
  const env = options.env ?? process.env;
  const account = options.account ?? DEFAULT_KEYCHAIN_ACCOUNT;
  const runKeychain = options.runKeychain ?? defaultKeychainLookup;

  const envToken = env["LINEAR_API_KEY"] ?? env["LINEAR_TOKEN"];
  if (envToken && envToken.trim() !== "") return envToken.trim();

  const keychainToken = runKeychain(READ_KEYCHAIN_SERVICE, account);
  if (keychainToken && keychainToken.trim() !== "") return keychainToken.trim();

  throw new Error(
    `No Linear read token found. Set LINEAR_API_KEY or LINEAR_TOKEN, or store a generic ` +
      `password in the macOS Keychain (service "${READ_KEYCHAIN_SERVICE}", account "${account}").`,
  );
}

/** Resolves the ClawSweeper OAuth app client_id/secret from the Keychain. Never logged. */
export function resolveAppCredentials(options = {}) {
  const account = options.account ?? DEFAULT_KEYCHAIN_ACCOUNT;
  const runKeychain = options.runKeychain ?? defaultKeychainLookup;

  const clientId = runKeychain(APP_CLIENT_ID_SERVICE, account).trim();
  const clientSecret = runKeychain(APP_CLIENT_SECRET_SERVICE, account).trim();
  if (clientId === "" || clientSecret === "") {
    throw new Error(
      `ClawSweeper OAuth app credentials not found in the macOS Keychain ` +
        `(services "${APP_CLIENT_ID_SERVICE}" / "${APP_CLIENT_SECRET_SERVICE}", account "${account}").`,
    );
  }
  return { clientId, clientSecret };
}

/**
 * Renders the deterministic, offline review CONTENT (without the marker — the planner adds
 * it). The narrative is derived purely from the classification + record so re-runs that see
 * the same issue produce a byte-identical body (stable planHash for operator approval).
 *
 * Next-step rendering, exactly ONE source (no redundancy):
 *   - With analysis: optional `review` ({ decision, closeLeaning }) appends the documented
 *     analyzer sections (**Summary**, What I checked:, Reproducibility, **Next step**,
 *     Remaining risk:) THROUGH the pure renderAnalyzerSections (analyzer.ts) — the analyzer's
 *     issue-specific **Next step** is authoritative, so the generic policy line is NOT also
 *     emitted. The body is gated on the CACHED deterministic Decision, so a re-plan of an
 *     unchanged Decision yields a byte-identical body and comment.planHashFor noops.
 *   - Without analysis (or empty analyzer output): the deterministic policy "Suggested next
 *     step" line is emitted instead — the standard non-analysis review comment.
 */
export function renderReviewContent(record, classification, review = null) {
  const lines = [];
  lines.push(`## ClawSweeper review — ${record.identifier}`);
  lines.push("");
  lines.push(`- Disposition: \`${classification.disposition}\``);
  lines.push(`- Priority: \`${record.triagePriority}\``);
  lines.push(`- Category: \`${record.itemCategory}\``);
  lines.push(`- State: \`${record.state}\``);
  lines.push("");
  lines.push("Reasons:");
  for (const reason of classification.reasons) {
    lines.push(`- ${reason}`);
  }

  // Exactly one next-step source. When a cached Decision is supplied, the analyzer's
  // issue-specific sections (incl. **Next step**) are authoritative; otherwise fall back to
  // the deterministic policy suggested-next-step. Both are pure/deterministic so planHash
  // stays byte-stable on re-plan.
  let renderedAnalyzerSections = false;
  if (review && review.decision) {
    const sections = renderAnalyzerSections(review.decision, review.closeLeaning);
    if (sections.trim() !== "") {
      lines.push("");
      lines.push(sections);
      renderedAnalyzerSections = true;
    }
  }
  if (!renderedAnalyzerSections) {
    const policy = evaluateReviewPolicy(classification, record);
    lines.push("");
    lines.push(`Suggested next step: ${policy.suggestedNextStep}`);
  }

  lines.push("");
  lines.push(
    "_This is an automated, review-only triage note. ClawSweeper proposes; it never closes._",
  );
  return lines.join("\n");
}

/**
 * Records whether the operator supplied both historical apply-intent gates. This does not
 * authorize a comment mutation; resolveWriteDecision rejects every non-noop comment action.
 */
export function resolveWriteMode(options, env = process.env) {
  if (!options.apply) {
    return { live: false, reason: "dry-run (default; pass --apply to write)" };
  }
  const notify = (env[NOTIFY_ENV] ?? "").trim();
  if (notify !== "1" && notify.toLowerCase() !== "true") {
    return {
      live: false,
      reason: `--apply given but ${NOTIFY_ENV} is not set to 1 — staying dry-run`,
    };
  }
  return { live: true, reason: "apply intent supplied by --apply + " + NOTIFY_ENV };
}

/**
 * Builds the full plan for one item: fetch (hydrated with comments) -> map -> classify ->
 * plan comment upsert -> mutation request -> authorization (comment gate opened).
 * Pure of side effects beyond the read fetch; performs NO write.
 */
export async function buildItemPlan(source, options) {
  const nowIso = options.nowIso || new Date().toISOString();

  const hydrated = await source.fetchIssueByIdentifier(options.identifier);
  if (hydrated === null) {
    throw new Error(`no Linear issue found for identifier "${options.identifier}"`);
  }

  const record = mapWorkspaceItem(hydrated);
  const classification = classifyRecord(record, {
    nowIso,
    staleDays: options.staleDays ?? DEFAULT_STALE_DAYS,
    requiredLabels: options.requiredLabels ?? [],
    exclusionLabels: options.exclusionLabels ?? [],
    protectedLabels: options.protectedLabels ?? [],
  });
  const policy = evaluateReviewPolicy(classification, record);

  const content = renderReviewContent(record, classification);
  const configuredAuthorId = String(
    options.expectedAuthorId ?? process.env.LINEAR_APP_ACTOR_ID ?? "",
  ).trim();
  const approvedAuthorId = String(options.approval?.approvedAuthorId ?? "").trim();
  if (
    configuredAuthorId !== "" &&
    approvedAuthorId !== "" &&
    configuredAuthorId !== approvedAuthorId
  ) {
    throw new Error(
      `configured Linear application actor ${configuredAuthorId} does not match reviewed actor ${approvedAuthorId}`,
    );
  }
  const expectedAuthorId = approvedAuthorId || configuredAuthorId;
  const plan = planReviewCommentUpsert({
    issueId: record.id,
    key: record.key,
    content,
    existingComments: hydrated.comments,
    expectedAuthorId,
  });

  const request = reviewCommentMutationRequest(plan, record.snapshotHash);

  // Open ONLY the comment gate. Live drift fingerprint: the same read pass produced both
  // the snapshot and the comment list. A live apply must still provide independently
  // approved hashes (direct flags or a saved dry-run receipt); missing or stale approvals
  // keep authorization denied. The approved snapshot is treated as the plan-time snapshot,
  // while record.snapshotHash is the current live read-back fingerprint.
  const gates = resolveGates({ comment: true });
  const approval = options.approval ?? null;
  const authorizationRequest = {
    ...request,
    snapshotHash: approval?.approvedSnapshotHash ?? request.snapshotHash,
  };
  const drift = {
    liveSnapshotHash: record.snapshotHash,
    approvedPlanHash: approval?.approvedPlanHash ?? "",
  };
  const authorization = authorizeMutation(authorizationRequest, gates, drift);
  const receipt = {
    ...buildMutationReceipt(authorizationRequest, gates, drift),
    expectedAuthorId,
  };

  return {
    record,
    classification,
    policy,
    plan,
    request,
    authorization,
    receipt,
    hydrated,
    approval,
    nowIso,
    expectedAuthorId,
  };
}

export const LINEAR_APPLICATION_INFO_QUERY = `
  query ClawSweeperLinearApplicationInfo {
    applicationInfo { id name }
  }
`;

export async function assertLinearApplicationActor(transport, expectedAuthorId) {
  const expected = String(expectedAuthorId ?? "").trim();
  if (expected === "") {
    throw new Error("reviewed Linear application actor id is required before mutation");
  }
  const data = await transport(LINEAR_APPLICATION_INFO_QUERY, {});
  const actorId =
    typeof data?.applicationInfo?.id === "string" ? data.applicationInfo.id.trim() : "";
  if (actorId === "") {
    throw new Error("authenticated Linear application actor could not be verified");
  }
  if (actorId !== expected) {
    throw new Error(
      `authenticated Linear application actor ${actorId} does not match reviewed actor ${expected}`,
    );
  }
  return { id: actorId, name: String(data.applicationInfo.name ?? "") };
}

/** Rejects executable comment plans while preserving the planning contract. */
export async function applyPlan(plan, _appCreds, _deps = {}) {
  if (plan.action === "noop") {
    return { noop: true };
  }
  if (plan.action === "create") {
    throw new Error(
      "live Linear comment creation is disabled until durable cross-process settlement exists",
    );
  }
  if (plan.action === "update") {
    throw new Error(
      "live Linear comment updates are disabled until durable cross-process settlement exists",
    );
  }
  throw new Error(`unsupported live Linear comment action: ${String(plan.action)}`);
}

/**
 * Composes the apply decision. Comment creation and updates always remain planning-only.
 * Before that terminal boundary, the result still records whether:
 *   - apply intent was supplied (--apply + OPENCLAW_NOTIFY_LINEAR=1),
 *   - the item is ELIGIBLE for review (disposition "review"/"stale-candidate") — ClawSweeper
 *     never comments on closed, protected, or excluded issues; there is nothing to review,
 *   - the proposal is authorized (gate open + matching fingerprints),
 *   - the plan actually changes something (action !== "noop").
 * Returns { write, reason }; reason explains any skip for the summary/receipt. Pure.
 */
export function resolveWriteDecision(result, mode) {
  if (!mode.live) return { write: false, reason: mode.reason };
  if (!result.classification.eligible) {
    return {
      write: false,
      reason:
        `skipped: ${result.record.identifier} is not eligible for review ` +
        `(disposition "${result.classification.disposition}") — ClawSweeper does not comment ` +
        `on closed, protected, or excluded issues`,
    };
  }
  if (result.policy?.ruleId === "protected-human-review") {
    return {
      write: false,
      reason: `skipped: ${result.record.identifier} has clawsweeper:human-review — ClawSweeper does not comment on protected items`,
    };
  }
  if (result.expectedAuthorId === "") {
    return { write: false, reason: "LINEAR_APP_ACTOR_ID is required for a live comment write" };
  }
  if (!result.authorization.allowed) {
    return { write: false, reason: "authorization denied — see authorizationReasons" };
  }
  if (result.plan.action === "create") {
    return {
      write: false,
      reason: "live comment creation is disabled until durable cross-process settlement exists",
    };
  }
  if (result.plan.action === "update") {
    return {
      write: false,
      reason: "live comment updates are disabled until durable cross-process settlement exists",
    };
  }
  if (result.plan.action === "noop") {
    return { write: false, reason: "noop: the durable comment already matches — nothing to write" };
  }
  return {
    write: false,
    reason: `unsupported comment action ${String(result.plan.action)} — no comment mutation is executable`,
  };
}

/** Recomputes a reviewed proposal and confirms the planning-only boundary still blocks it. */
export async function revalidateCommentWrite(source, itemOptions, mode) {
  const result = await buildItemPlan(source, itemOptions);
  const decision = resolveWriteDecision(result, mode);
  if (!decision.write) {
    const reasons = result.authorization.reasons.join("; ");
    throw new Error(
      `live comment revalidation blocked: ${decision.reason}${reasons ? ` (${reasons})` : ""}`,
    );
  }
  return { result, decision };
}

/**
 * Reads the issue back after a live write and confirms the durable marker comment now
 * reflects the plan (PAR-215 read-back: prove the mutation actually landed, not just that
 * the API echoed success). Returns a secret-free confirmation summary.
 */
export async function readBackComment(source, identifier, plan, expectedAuthorId) {
  const hydrated = await source.fetchIssueByIdentifier(identifier);
  const comments = hydrated?.comments ?? [];
  const matches = comments.filter((c) => (c.body ?? "").includes(plan.marker));
  // Confirm the EXACT comment we wrote, not "exactly one marker comment": the planner
  // deliberately tolerates stale duplicate marker comments (cleaned up separately), so a
  // successful update must still read back as confirmed when duplicates are present. For an
  // update we pin the kept target by id; for a create we find the comment carrying the body.
  const target =
    plan.targetCommentId != null
      ? comments.find((c) => c.id === plan.targetCommentId)
      : matches.find((c) => (c.body ?? "") === plan.body);
  const bodyMatches = (target?.body ?? null) === plan.body;
  const authorMatches = (target?.authorId ?? null) === expectedAuthorId;
  return {
    confirmed: bodyMatches && authorMatches,
    markerCommentCount: matches.length,
    staleDuplicates: Math.max(0, matches.length - 1),
    commentId: target?.id ?? (matches.length > 0 ? matches[0].id : null),
    bodyMatches,
    authorMatches,
  };
}

export function assertReadBackConfirmed(readback) {
  if (readback?.confirmed === true) return;
  const error = readback?.error ? `: ${readback.error}` : "";
  throw new Error(`live apply read-back failed${error}`);
}

export function summarize(result, mode) {
  return {
    identifier: result.record.identifier,
    disposition: result.classification.disposition,
    eligible: result.classification.eligible,
    action: result.plan.action,
    targetCommentId: result.plan.targetCommentId,
    staleDuplicateIds: result.plan.staleDuplicateIds,
    authorized: result.authorization.allowed,
    authorizationReasons: result.authorization.reasons,
    // Comment creation and updates are planning-only until durable shared settlement exists.
    wouldWrite: false,
    planHash: result.plan.planHash,
    snapshotHash: result.record.snapshotHash,
    expectedAuthorId: result.expectedAuthorId,
    receipt: result.receipt, // secret-free MutationReceipt (audit trail)
    approvalSource: result.approval?.source ?? null,
    nowIso: result.nowIso,
    live: mode.live,
    mode: mode.live ? "apply" : "dry-run",
    modeReason: mode.reason,
    body: result.plan.body,
  };
}

function printHuman(summary) {
  const out = [];
  out.push(`Identifier:   ${summary.identifier}`);
  out.push(`Disposition:  ${summary.disposition}`);
  out.push(`Eligible:     ${summary.eligible}`);
  out.push(
    `Action:       ${summary.action}` +
      (summary.targetCommentId ? ` (-> ${summary.targetCommentId})` : ""),
  );
  out.push(`Authorized:   ${summary.authorized}`);
  if (!summary.authorized) {
    for (const r of summary.authorizationReasons) out.push(`  - ${r}`);
  }
  out.push(`Would write:  ${summary.wouldWrite}`);
  out.push(`Mode:         ${summary.mode} — ${summary.modeReason}`);
  if (summary.writeDecision) out.push(`Decision:     ${summary.writeDecision}`);
  if (summary.readback) {
    out.push(
      `Read-back:    confirmed=${summary.readback.confirmed}` +
        (summary.readback.commentId ? ` (${summary.readback.commentId})` : ""),
    );
  }
  out.push("");
  out.push("Planned comment body:");
  out.push("----------------------------------------");
  out.push(summary.body);
  out.push("----------------------------------------");
  return out.join("\n");
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("\n" + usage());
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  const mode = resolveWriteMode(options);

  let readToken;
  try {
    readToken = resolveReadToken({ account: options.keychainAccount });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  let result;
  let source;
  let approval;
  try {
    approval = resolveApproval(options);
    if (approval?.nowIso !== undefined) {
      if (options.nowIso !== undefined && options.nowIso !== approval.nowIso) {
        throw new Error(
          `--now ${options.nowIso} does not match --dry-run-receipt nowIso ${approval.nowIso}`,
        );
      }
      options.nowIso = approval.nowIso;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  try {
    const transport = createLinearTransport({ token: readToken });
    source = new LinearItemSource(transport);
    result = await buildItemPlan(source, { ...options, approval });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const decision = resolveWriteDecision(result, mode);
  const summary = summarize(result, mode);
  summary.writeDecision = decision.reason;
  summary.applied = false;
  if (mode.live) summary.applyBlocked = decision.reason;

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(printHuman(summary));
  }
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function positiveInt(value, flag) {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return Number(value);
}

function requireHashValue(argv, index, flag) {
  const value = requireValue(argv, index, flag).trim();
  validateHash(value, flag);
  return value.toLowerCase();
}

function usage() {
  return `Usage: node scripts/linear-comment-apply.mjs --identifier <KEY> [options]

Single-item Linear review-comment planning runner. Fetches ONE issue by identifier,
runs the real review pipeline (map -> classify -> plan -> authorize), and prints
the planned comment. Comment creation and updates remain disabled until durable
cross-process settlement exists. --apply records operator intent but cannot write.

Options:
  --identifier <KEY>         Linear issue identifier, e.g. PAR-244 (required)
  --apply                    Exercise apply-intent checks without enabling a comment write
  --dry-run                  Force dry-run (default behaviour)
  --json                     Emit a JSON summary instead of human-readable text
  --now <iso>                ISO 8601 timestamp to use as "now" (default: current time)
  --stale-days <n>           Staleness threshold in days (default: ${DEFAULT_STALE_DAYS})
  --approved-plan-hash <h>   Operator-approved plan hash from a reviewed dry-run
  --approved-snapshot-hash <h>
                              Operator-approved snapshot hash from the same dry-run
  --dry-run-receipt <path>   JSON dry-run receipt containing planHash + snapshotHash
  --required-label <label>   Require at least one of these labels (repeatable)
  --exclusion-label <label>  Skip items with this label (repeatable)
  --protected-label <label>  Mark items with this label as protected (repeatable)
  --keychain-account <a>     Keychain account for credentials (default: ${DEFAULT_KEYCHAIN_ACCOUNT})
  --help, -h                 Show this help message

Auth: READ uses the personal key (LINEAR_API_KEY/LINEAR_TOKEN or Keychain service
"${READ_KEYCHAIN_SERVICE}", raw header). Comment plans do not read the reserved OAuth
app credentials or mint a Bearer token.

Examples:
  # Dry-run (default): print the planned comment for PAR-244, write nothing
  node scripts/linear-comment-apply.mjs --identifier PAR-244 --json

  # Apply-intent probe — reports the comment mutation disabled and writes nothing
  ${NOTIFY_ENV}=1 node scripts/linear-comment-apply.mjs --identifier PAR-244 --apply \
    --dry-run-receipt ./par-244-clawsweeper-dry-run.json`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
