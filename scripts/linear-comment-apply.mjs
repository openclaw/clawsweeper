#!/usr/bin/env node

/**
 * Single-item Linear review-comment apply runner (dry-run by default).
 *
 * This is the WRITE half of the ClawSweeper Linear review flow, scoped to ONE issue by
 * its human identifier (e.g. "PAR-244"). It runs the real review pipeline end-to-end and
 * reuses the existing planner + authority gate — it never reimplements comment body or
 * marker logic:
 *
 *   fetchIssueByIdentifier (read)  -> mapWorkspaceItem -> classifyRecord
 *     -> renderReviewCommentBody/planReviewCommentUpsert (comment.ts)
 *     -> reviewCommentMutationRequest -> authorizeMutation (authority.ts)
 *     -> [--apply only, existing marker only] mint OAuth Bearer token -> commentUpdate
 *
 * Two auth identities, kept strictly separate:
 *   READ  — personal API key (raw header), from LINEAR_API_KEY/LINEAR_TOKEN or the macOS
 *           Keychain item "openclaw-linear-api-key". Used to fetch the issue + comments.
 *   WRITE — the dedicated "ClawSweeper" OAuth app. Client-credentials tokens already
 *           represent the app actor. Its client_id/secret live in the Keychain
 *           ("openclaw-linear-clawsweeper-client-id"
 *           / "openclaw-linear-clawsweeper-secret"). A short-lived Bearer access token is
 *           minted at apply time and used only to update an existing actor-owned comment.
 *
 * Gating — review-only by default, impossible to write without an explicit opt-in:
 *   - Default mode is DRY-RUN: prints the planned comment body and whether it would create
 *     or update, and writes NOTHING. No OAuth token is minted in dry-run.
 *   - New comment creation is planning-only until durable cross-process action settlement
 *     exists. A live update requires BOTH: the explicit --apply flag AND the environment opt-in
 *     OPENCLAW_NOTIFY_LINEAR=1. Either alone keeps the run dry. (Belt and suspenders so a
 *     stray flag in a cron command can never post.)
 *   - Even with both, the write only proceeds if authorizeMutation() returns allowed=true
 *     with the comment gate explicitly opened and independently supplied matching
 *     snapshot/plan fingerprints (--dry-run-receipt or direct approved hash flags).
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
  COMMENT_UPDATE_MUTATION,
  createLinearTransport,
  evaluateReviewPolicy,
  LinearItemSource,
  mapWorkspaceItem,
  mintLinearAppToken,
  parseLinearIdentifier,
  planReviewCommentUpsert,
  renderAnalyzerSections,
  resolveGates,
  reviewCommentMutationRequest,
} from "../dist/linear/index.js";

const DEFAULT_STALE_DAYS = 60;

// Read-key Keychain coordinates (personal API key, raw header) — mirrors linear-snapshot.mjs.
export const READ_KEYCHAIN_SERVICE = "openclaw-linear-api-key";
// OAuth app (ClawSweeper) client_credentials Keychain coordinates (Bearer write path).
export const APP_CLIENT_ID_SERVICE = "openclaw-linear-clawsweeper-client-id";
export const APP_CLIENT_SECRET_SERVICE = "openclaw-linear-clawsweeper-secret";
export const DEFAULT_KEYCHAIN_ACCOUNT = "partnerai-config";

// Environment opt-in required (alongside --apply) before any live write.
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
 * Decides whether a live write is permitted. A write needs BOTH the explicit --apply flag
 * AND the OPENCLAW_NOTIFY_LINEAR=1 environment opt-in. Returns { live, reason }.
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
  return { live: true, reason: "live write authorized by --apply + " + NOTIFY_ENV };
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

/** Applies the authorized plan with a freshly minted Bearer token. Never logs the token. */
export async function applyPlan(plan, appCreds, deps = {}) {
  // Nothing to write — never mint a write token for a noop.
  if (plan.action === "noop") {
    return { noop: true };
  }
  if (plan.action === "create") {
    throw new Error(
      "live Linear comment creation is disabled until durable cross-process settlement exists",
    );
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  // Reuse a caller-supplied transport when present (bulk runs mint ONE Bearer token and
  // share it across items); only mint when we must build our own transport.
  let transport = deps.transport;
  if (transport === undefined) {
    const minted = await mintLinearAppToken({
      clientId: appCreds.clientId,
      clientSecret: appCreds.clientSecret,
      scope: "read,write",
      ...(deps.mintEndpoint ? { endpoint: deps.mintEndpoint } : {}),
      fetchImpl,
    });
    transport = createLinearTransport({
      token: minted.accessToken,
      auth: "bearer",
      ...(deps.graphqlEndpoint ? { endpoint: deps.graphqlEndpoint } : {}),
      ...(deps.fetchImpl ? { fetchImpl } : {}),
    });
  }

  await assertLinearApplicationActor(transport, plan.expectedAuthorId);

  if (plan.action === "update") {
    return transport(COMMENT_UPDATE_MUTATION, { id: plan.targetCommentId, body: plan.body });
  }
  throw new Error(`unsupported live Linear comment action: ${String(plan.action)}`);
}

/**
 * Composes the full live-write decision. An existing managed comment is updated only when ALL hold:
 *   - mode is live (--apply + OPENCLAW_NOTIFY_LINEAR=1),
 *   - the item is ELIGIBLE for review (disposition "review"/"stale-candidate") — ClawSweeper
 *     never comments on closed, protected, or excluded issues; there is nothing to review,
 *   - the mutation is authorized (gate open + matching fingerprints),
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
  if (result.plan.action === "noop") {
    return { write: false, reason: "noop: the durable comment already matches — nothing to write" };
  }
  return { write: true, reason: `live write authorized for ${result.record.identifier}` };
}

/**
 * Re-fetches and reauthorizes a comment immediately before a live mutation.
 * The reviewed plan/snapshot hashes remain the authority; any target or plan
 * drift converts the write into a terminal skip instead of using stale input.
 */
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
    // Mode-independent: would a LIVE run actually update an existing managed comment?
    // Lets a dry-run state exactly what a live run would do.
    wouldWrite:
      result.classification.eligible &&
      result.policy?.ruleId !== "protected-human-review" &&
      result.authorization.allowed &&
      typeof result.expectedAuthorId === "string" &&
      result.expectedAuthorId.trim() !== "" &&
      result.plan.action === "update",
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

  let decision = resolveWriteDecision(result, mode);
  if (decision.write) {
    try {
      ({ result, decision } = await revalidateCommentWrite(source, { ...options, approval }, mode));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
  }

  const summary = summarize(result, mode);
  summary.writeDecision = decision.reason;

  if (decision.write) {
    try {
      const appCreds = resolveAppCredentials({ account: options.keychainAccount });
      const applyResult = await applyPlan(result.plan, appCreds);
      summary.applyAttempted = true;
      summary.applied = false;
      summary.applyResult = applyResult;
      // PAR-215 read-back: re-fetch and confirm the durable marker comment landed.
      try {
        summary.readback = await readBackComment(
          source,
          options.identifier,
          result.plan,
          result.expectedAuthorId,
        );
        assertReadBackConfirmed(summary.readback);
        summary.applied = true;
      } catch (error) {
        summary.readback = {
          confirmed: false,
          error: error instanceof Error ? error.message : String(error),
        };
        console.error(summary.readback.error);
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
  } else {
    summary.applied = false;
    // Surface why a LIVE run skipped (ineligible / denied / noop); the dry-run reason is in writeDecision.
    if (mode.live) summary.applyBlocked = decision.reason;
    if (
      mode.live &&
      result.classification.eligible &&
      result.plan.action !== "noop" &&
      !result.authorization.allowed
    ) {
      process.exitCode = 1;
    }
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(printHuman(summary));
    if (summary.applied && summary.readback?.confirmed === true) {
      console.log("\nApplied: managed comment updated as ClawSweeper and read-back confirmed.");
    }
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

Single-item Linear review-comment apply runner. Fetches ONE issue by identifier,
runs the real review pipeline (map -> classify -> plan -> authorize), and prints
the planned comment by default. Live mode can update an existing actor-owned marker
comment; new comment creation remains disabled until durable cross-process settlement
exists. Live update requires both --apply and ${NOTIFY_ENV}=1.

Options:
  --identifier <KEY>         Linear issue identifier, e.g. PAR-244 (required)
  --apply                    Opt in to a LIVE write (also needs ${NOTIFY_ENV}=1)
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
"${READ_KEYCHAIN_SERVICE}", raw header). WRITE mints a Bearer token from the
ClawSweeper OAuth app credentials in the Keychain (services
"${APP_CLIENT_ID_SERVICE}" / "${APP_CLIENT_SECRET_SERVICE}").

Examples:
  # Dry-run (default): print the planned comment for PAR-244, write nothing
  node scripts/linear-comment-apply.mjs --identifier PAR-244 --json

  # Live update of an existing managed comment — both gates required
  ${NOTIFY_ENV}=1 node scripts/linear-comment-apply.mjs --identifier PAR-244 --apply \
    --dry-run-receipt ./par-244-clawsweeper-dry-run.json`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
