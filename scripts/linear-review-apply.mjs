#!/usr/bin/env node

/**
 * Scoped Linear review-comment runner (dry-run by default).
 *
 * This is the BULK generalization of linear-comment-apply.mjs: it runs the identical
 * per-item review pipeline over a SCOPE — an explicit set of identifiers, a list/ledger
 * file, a Linear project, or a whole team — instead of one hard-coded identifier. Single
 * item is just scope-of-one; nothing about the per-item review changes.
 *
 *   resolveScope (read-only)  ->  for each identifier:
 *     buildItemPlan (fetch -> map -> classify -> plan -> authorize)   [from linear-comment-apply]
 *       -> resolveWriteDecision -> [--apply only] applyPlan -> readBackComment
 *
 * It is the natural vehicle for a "closeout sweep": point it at a project (or a Command
 * Central ledger) and it posts ClawSweeper's standard review comment on each still-open,
 * eligible issue and SKIPS the ones already Done / protected / excluded. It never closes an
 * issue — closing remains the evidence-gated `close` capability in authority.ts, fired only
 * by a separate, explicitly-opted-in path. This runner only ever opens the comment gate.
 *
 * Gating is identical to the single-item path and just as conservative:
 *   - DRY-RUN by default: plans every item, writes nothing, mints no token. The --json
 *     output doubles as the operator-approval artifact (it carries independent comment and
 *     label plan/snapshot hashes plus nowIso per item) that can be fed straight back via
 *     --approvals for a live apply.
 *   - A live write requires BOTH --apply AND OPENCLAW_NOTIFY_LINEAR=1, AND per-item
 *     authorization: each item is only written if its approved planHash/snapshotHash
 *     (from --approvals) still match the live snapshot (drift gate) and the issue is
 *     eligible and the plan is not a noop. Un-approved or drifted items stay dry — one
 *     stale issue can never be force-written.
 *   - The Bearer write token is minted ONCE for the whole batch and shared (lazy: only if
 *     at least one item will actually be written).
 *
 * Secret hygiene: no token, client id, or client secret is ever logged.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  authorizeMutation,
  buildMutationReceipt,
  classifyRecord,
  chooseScope,
  createLinearTransport,
  evaluateReviewPolicy,
  extractIdentifiers,
  isProtectedActionLabel,
  ISSUE_LABEL_CREATE_MUTATION,
  ISSUE_LABELS_QUERY,
  ISSUE_SET_LABELS_MUTATION,
  LinearItemSource,
  mapWorkspaceItem,
  matchIdentifier,
  mintLinearAppToken,
  nextReviewLabels,
  resolveGates,
  resolveScope,
} from "../dist/linear/index.js";

import {
  applyPlan,
  assertReadBackConfirmed,
  buildItemPlan,
  DEFAULT_KEYCHAIN_ACCOUNT,
  NOTIFY_ENV,
  readBackComment,
  revalidateCommentWrite,
  resolveAppCredentials,
  resolveReadToken,
  resolveWriteDecision,
  resolveWriteMode,
} from "./linear-comment-apply.mjs";

const DEFAULT_STALE_DAYS = 60;
const DEFAULT_CONCURRENCY = 4; // parallel READS for dry-run planning; writes stay serialized

export function parseArgs(argv) {
  const options = {
    identifiers: [],
    fromFile: "",
    listField: "",
    project: "",
    team: "",
    apply: false,
    applyLabels: false,
    json: false,
    approvals: "",
    limit: 0,
    rateMs: 0,
    concurrency: DEFAULT_CONCURRENCY,
    nowIso: undefined,
    staleDays: DEFAULT_STALE_DAYS,
    requiredLabels: [],
    exclusionLabels: [],
    protectedLabels: [],
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
        options.identifiers.push(requireValue(argv, ++index, arg));
        break;
      case "--identifiers":
        for (const part of requireValue(argv, ++index, arg).split(",")) {
          if (part.trim() !== "") options.identifiers.push(part.trim());
        }
        break;
      case "--from-file":
        options.fromFile = requireValue(argv, ++index, arg);
        break;
      case "--list-field":
        options.listField = requireValue(argv, ++index, arg);
        break;
      case "--project":
        options.project = requireValue(argv, ++index, arg);
        break;
      case "--team":
        options.team = requireValue(argv, ++index, arg);
        break;
      case "--apply":
        options.apply = true;
        break;
      case "--apply-labels":
        options.applyLabels = true;
        break;
      case "--dry-run":
        options.apply = false;
        options.applyLabels = false;
        break;
      case "--json":
        options.json = true;
        break;
      case "--approvals":
        options.approvals = requireValue(argv, ++index, arg);
        break;
      case "--limit":
        options.limit = positiveInt(requireValue(argv, ++index, arg), "--limit");
        break;
      case "--rate-ms":
        options.rateMs = nonNegativeInt(requireValue(argv, ++index, arg), "--rate-ms");
        break;
      case "--concurrency":
        options.concurrency = positiveInt(requireValue(argv, ++index, arg), "--concurrency");
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
  return options;
}

/**
 * Builds the ScopeSpec from CLI options, reading the --from-file ledger when given.
 * Exactly one scope source is permitted (chooseScope enforces this). A --from-file is
 * treated as an identifiers scope after extraction.
 */
export function buildScopeSpec(options, deps = {}) {
  const readFile = deps.readFileSync ?? readFileSync;
  let identifiers = [...options.identifiers];

  if ((options.fromFile ?? "") !== "") {
    let parsed;
    try {
      parsed = JSON.parse(readFile(options.fromFile, "utf8"));
    } catch (error) {
      throw new Error(
        `failed to read --from-file ${options.fromFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const extractOptions = options.listField !== "" ? { listField: options.listField } : {};
    const fromFile = extractIdentifiers(parsed, extractOptions);
    if (fromFile.length === 0) {
      throw new Error(
        `--from-file ${options.fromFile} yielded no Linear identifiers` +
          (options.listField !== "" ? ` under list field "${options.listField}"` : ""),
      );
    }
    identifiers = identifiers.concat(fromFile);
  }

  return chooseScope({
    identifiers,
    project: options.project,
    team: options.team,
  });
}

function validateHash(hash, label) {
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error(`${label} must be a 64-character sha256 hex hash`);
  }
}

/**
 * Loads a per-item approvals map (identifier -> approved fingerprints) from a reviewed
 * dry-run. Accepts this runner's own --json output (an object with `items`) or a bare
 * array of per-item summaries / receipts. Comment and label approvals are independent;
 * each complete plan/snapshot pair is carried through with nowIso so the live plan
 * recomputes identically.
 */
export function loadApprovals(raw) {
  const list = Array.isArray(raw) ? raw : (raw?.items ?? raw?.results ?? raw?.entries ?? []);
  const map = new Map();
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = matchIdentifier(entry.identifier ?? entry.key ?? "");
    if (id === null) continue;
    const planHash = pickHash(entry, "planHash", "receipt");
    const snapshotHash = pickHash(entry, "snapshotHash", "receipt");
    const labelPlanHash = pickHash(entry, "labelPlanHash", "labelReceipt", "planHash");
    const labelSnapshotHash = pickHash(entry, "labelSnapshotHash", "labelReceipt", "snapshotHash");
    const commentApproved = planHash !== "" && snapshotHash !== "";
    const labelApproved = labelPlanHash !== "" && labelSnapshotHash !== "";
    if (!commentApproved && !labelApproved) continue;
    if (commentApproved) {
      validateHash(planHash, `approvals planHash for ${id}`);
      validateHash(snapshotHash, `approvals snapshotHash for ${id}`);
    }
    if (labelApproved) {
      validateHash(labelPlanHash, `approvals labelPlanHash for ${id}`);
      validateHash(labelSnapshotHash, `approvals labelSnapshotHash for ${id}`);
    }
    const nowIso = typeof entry.nowIso === "string" ? entry.nowIso.trim() : "";
    map.set(id, {
      ...(commentApproved
        ? { approvedPlanHash: planHash, approvedSnapshotHash: snapshotHash }
        : {}),
      ...(labelApproved
        ? {
            approvedLabelPlanHash: labelPlanHash,
            approvedLabelSnapshotHash: labelSnapshotHash,
          }
        : {}),
      ...(nowIso !== "" ? { nowIso } : {}),
      source: "approvals-file",
    });
  }
  return map;
}

function pickHash(entry, key, receiptKey, nestedKey = key) {
  const direct = entry[key];
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim().toLowerCase();
  const receipt = entry[receiptKey];
  if (typeof receipt === "object" && receipt !== null) {
    const value = receipt[nestedKey];
    if (typeof value === "string" && value.trim() !== "") return value.trim().toLowerCase();
  }
  return "";
}

/** Mints ONE short-lived Bearer transport for the whole batch. Token is never logged. */
async function mintWriteTransport(appCreds, deps = {}) {
  const minted = await mintLinearAppToken({
    clientId: appCreds.clientId,
    clientSecret: appCreds.clientSecret,
    scope: "read,write",
    ...(deps.mintEndpoint ? { endpoint: deps.mintEndpoint } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  return createLinearTransport({
    token: minted.accessToken,
    auth: "bearer",
    ...(deps.graphqlEndpoint ? { endpoint: deps.graphqlEndpoint } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
}

/**
 * Whether a LIVE label write is permitted. A label write needs BOTH the explicit
 * --apply-labels flag AND the OPENCLAW_NOTIFY_LINEAR=1 environment opt-in (the same env opt-in
 * the comment write reuses via resolveWriteMode). Either alone keeps the run dry. Returns
 * { live, reason }. Pure.
 */
export function resolveLabelWriteMode(options, env = process.env) {
  if (!options.applyLabels) {
    return { live: false, reason: "label dry-run (default; pass --apply-labels to write labels)" };
  }
  const notify = (env[NOTIFY_ENV] ?? "").trim();
  if (notify !== "1" && notify.toLowerCase() !== "true") {
    return {
      live: false,
      reason: `--apply-labels given but ${NOTIFY_ENV} is not set to 1 — staying label dry-run`,
    };
  }
  return {
    live: true,
    reason: `live label mode enabled by --apply-labels + ${NOTIFY_ENV}; per-item approval still required`,
  };
}

export function assertCompatibleWriteModes(mode, labelMode) {
  if (mode.live && labelMode.live) {
    throw new Error(
      "comment and label mutations require separate reviewed runs because either write changes the Linear snapshot",
    );
  }
}

export function resolveReportMode(mode, labelMode) {
  return labelMode.live ? labelMode : mode;
}

/**
 * Computes the governed label change for one item from the policy decision. Pure and offline.
 *   existing  — the issue's current label NAMES (record.labels)
 *   removals  — stale engine-owned routing labels that nextReviewLabels removes
 *   additions — proposed labels not already present (case-insensitive), denylist-asserted
 *   proposed  — existing minus stale routing labels plus the wanted labels
 *   noop      — true when there is nothing to add or remove
 * Only engine-owned REVIEW_ROUTING_LABELS may be removed; action/proof/mantis/protected/project
 * labels are preserved by nextReviewLabels. Protected action/proof/mantis/P0 labels are never
 * added (the policy already denylist-filters proposedLabels — this asserts that invariant).
 */
export function planLabelChange(record, decision) {
  const existing = [...(record.labels ?? [])];
  const existingLower = new Map(existing.map((label) => [label.toLowerCase(), label]));
  const wanted = [];
  for (const label of decision.proposedLabels ?? []) {
    if (isProtectedActionLabel(label)) {
      throw new Error(`refusing to apply protected action label "${label}" — policy denylist`);
    }
    wanted.push(existingLower.get(label.toLowerCase()) ?? label);
  }
  const proposed = nextReviewLabels(existing, wanted);
  const proposedLower = new Set(proposed.map((label) => label.toLowerCase()));
  const additions = proposed.filter((label) => !existingLower.has(label.toLowerCase()));
  const removals = existing.filter((label) => !proposedLower.has(label.toLowerCase()));
  return {
    existing,
    removals,
    additions,
    proposed,
    noop: additions.length === 0 && removals.length === 0,
  };
}

/**
 * Resolves wanted label NAMES to label ids, creating any that do not exist. Deterministic
 * given its inputs + a stub createLabel. Lookup order per name (case-insensitive):
 *   1. issueLabelsOnIssue — ids already attached to the issue (no extra read)
 *   2. workspaceLabels    — every workspace label (paginated read result)
 *   3. createLabel(name)  — mint a missing label (live only) and record it as created
 * Returns { ids, createdNames }. The caller passes the PROPOSED set so ids cover existing ∪
 * additions. Never logs secrets; createLabel is the only side-effecting input.
 */
export async function resolveLabelIds(wantedNames, opts) {
  const onIssue = opts.issueLabelsOnIssue ?? [];
  const workspace = opts.workspaceLabels ?? [];
  const findIn = (list, name) =>
    list.find((l) => (l.name ?? "").toLowerCase() === name.toLowerCase());
  const ids = [];
  const createdNames = [];
  for (const name of wantedNames) {
    const hit = findIn(onIssue, name) ?? findIn(workspace, name);
    if (hit) {
      ids.push(hit.id);
      continue;
    }
    const created = await opts.createLabel(name);
    ids.push(created.id);
    createdNames.push(created.name ?? name);
  }
  return { ids, createdNames };
}

/** Reads EVERY workspace label (id + name) via the paginated ISSUE_LABELS_QUERY. */
async function fetchWorkspaceLabels(transport) {
  const all = [];
  let after = null;
  for (;;) {
    const data = await transport(ISSUE_LABELS_QUERY, after ? { after } : {});
    const page = data?.issueLabels;
    for (const node of page?.nodes ?? []) all.push({ id: node.id, name: node.name });
    if (!page?.pageInfo?.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return all;
}

/** Canonical, deterministic plan hash for a label write: sorted proposed names + issue id. */
function labelPlanHash(proposed, issueId) {
  const canonical = JSON.stringify({ issueId, proposed: [...proposed].sort() });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Authorizes one additive label write through authority.authorizeMutation (kind "label-add",
 * labelWrite gate opened). The current plan and live snapshot must match the independent
 * label fingerprints loaded from a reviewed dry-run artifact. Without that approval pair,
 * authorization stays denied while still emitting a feedable receipt.
 * Returns { authorization, receipt, request, planHash }. Pure (no network).
 */
export function authorizeLabelChange(record, change, approval = null) {
  const planHash = labelPlanHash(change.proposed, record.id);
  const request = {
    kind: "label-add",
    key: record.key,
    snapshotHash: approval?.approvedLabelSnapshotHash ?? record.snapshotHash,
    planHash,
    labelChange: {
      existing: change.existing,
      removals: change.removals,
      additions: change.additions,
      proposed: change.proposed,
    },
  };
  const gates = resolveGates({ labelWrite: true });
  const drift = {
    liveSnapshotHash: record.snapshotHash,
    approvedPlanHash: approval?.approvedLabelPlanHash ?? "",
  };
  return {
    authorization: authorizeMutation(request, gates, drift),
    receipt: buildMutationReceipt(request, gates, drift),
    request,
    planHash,
  };
}

/**
 * Performs the gated live label write for one item. Resolves the PROPOSED set to ids
 * (creating any missing label via the shared Bearer transport), then writes the union via
 * ISSUE_SET_LABELS_MUTATION. Returns { labelAction, labelsApplied, labelsCreated }. The
 * caller has already confirmed the gate is open, the change is not a noop, and authorization
 * allowed. `issueLabelsOnIssue` is the issue's current { id, name } labels (from the hydrated
 * read). Reuses the ONE minted Bearer transport — never mints its own.
 */
export async function applyLabelChange(record, change, transport, deps = {}) {
  const assertNoLabelDrift = async () => {
    if (!deps.readBackIssue) return;
    const current = await deps.readBackIssue();
    const currentNames = (current?.issue?.labels ?? [])
      .map((label) => (label.name ?? "").trim().toLowerCase())
      .sort();
    const plannedNames = change.existing.map((label) => label.trim().toLowerCase()).sort();
    if (
      currentNames.length !== plannedNames.length ||
      currentNames.some((label, index) => label !== plannedNames[index])
    ) {
      throw new Error(`label drift before update for ${record.identifier}`);
    }
  };
  await assertNoLabelDrift();
  const fetchLabels = deps.fetchWorkspaceLabels ?? fetchWorkspaceLabels;
  const workspaceLabels = await fetchLabels(transport);
  const issueLabelsOnIssue = deps.issueLabelsOnIssue ?? [];
  const created = [];
  const createLabel = async (name) => {
    const data = await transport(ISSUE_LABEL_CREATE_MUTATION, { name });
    const label = data?.issueLabelCreate?.issueLabel;
    if (!label?.id) throw new Error(`label create failed for "${name}"`);
    created.push(label.name ?? name);
    return { id: label.id, name: label.name ?? name };
  };
  const { ids } = await resolveLabelIds(change.proposed, {
    issueLabelsOnIssue,
    workspaceLabels,
    createLabel,
  });
  await assertNoLabelDrift();
  const update = await transport(ISSUE_SET_LABELS_MUTATION, { id: record.id, labelIds: ids });
  if (update?.issueUpdate?.success !== true) {
    throw new Error(`label update failed for ${record.identifier}`);
  }
  if (deps.readBackIssue) {
    const hydrated = await deps.readBackIssue();
    const actual = new Set(
      (hydrated?.issue?.labels ?? []).map((label) => (label.name ?? "").trim().toLowerCase()),
    );
    const expected = new Set(change.proposed.map((label) => label.trim().toLowerCase()));
    if (actual.size !== expected.size || [...expected].some((label) => !actual.has(label))) {
      throw new Error(`label update read-back failed for ${record.identifier}`);
    }
  }
  return {
    labelAction: created.length > 0 ? "create" : "add",
    labelsApplied: change.additions,
    labelsCreated: created,
  };
}

/**
 * Per-item secret-free summary; planHash/snapshotHash/nowIso make it re-feedable as
 * approvals. Two distinct signals, deliberately not conflated:
 *   - `actionable` — intrinsic to the item: it is eligible for review AND the plan is not a
 *     noop, so there is a real comment to post. This is the closeout picture a dry-run shows.
 *   - `authorized` — the approval handshake: the plan/snapshot fingerprints matched an
 *     operator approval (from --approvals). Empty in a plain dry-run.
 *   - `wouldWrite` — a LIVE run actually writes iff actionable AND authorized.
 */
/**
 * Bulk read-back for a planned comment. The expected application actor id is part of the
 * PLANNED result, not an ambient value: reading it off `result` here keeps the bulk lane from
 * confirming a comment that some other actor happens to own. Never call `readBackComment`
 * directly from the bulk path — dropping the 4th argument silently degrades the identity half
 * of the confirmation.
 */
export async function readBackPlannedComment(source, identifier, result) {
  return await readBackComment(
    source,
    identifier,
    result.plan,
    String(result.expectedAuthorId ?? "").trim(),
  );
}

export function summarizeItem(result, decision) {
  const actionable = result.classification.eligible && result.plan.action !== "noop";
  // A live write is only reachable when ClawSweeper can prove comment ownership. Without a
  // configured application actor id the apply path cannot distinguish its own marker comment
  // from a foreign one, so a run that advertises `wouldWrite` here would be promising a write
  // the apply lane must refuse. Report it as not-writable rather than letting the dry-run
  // preview disagree with live behavior.
  const hasAppActor = String(result.expectedAuthorId ?? "").trim() !== "";
  // Project-agnostic review policy: the routing label + next step ClawSweeper PROPOSES for
  // this item. Read-only here (reporting); applying labels is the inert future path.
  const policy = evaluateReviewPolicy(result.classification, result.record);
  return {
    identifier: result.record.identifier,
    disposition: result.classification.disposition,
    eligible: result.classification.eligible,
    action: result.plan.action,
    actionable,
    authorized: result.authorization.allowed,
    wouldWrite: actionable && result.authorization.allowed && hasAppActor,
    routingLabel: policy.routingLabel,
    proposedLabels: policy.proposedLabels,
    suggestedNextStep: policy.suggestedNextStep,
    writeDecision: decision.reason,
    planHash: result.plan.planHash,
    snapshotHash: result.record.snapshotHash,
    nowIso: result.nowIso,
    receipt: result.receipt,
  };
}

/**
 * Aggregates per-item results into the run report. `byDisposition` and the intent/outcome
 * counters make the closeout picture legible at a glance: how many eligible items would get
 * a comment vs how many are skipped because they're already Done / protected / excluded.
 */
export function aggregate(items, resolution, mode) {
  const byDisposition = {};
  const byRoutingLabel = {};
  const byLabelAction = {};
  let eligible = 0;
  let actionable = 0;
  let authorized = 0;
  let wouldWrite = 0;
  let applied = 0;
  let labelsApplied = 0;
  let errors = 0;
  for (const item of items) {
    if (item.error) {
      errors += 1;
      continue;
    }
    byDisposition[item.disposition] = (byDisposition[item.disposition] ?? 0) + 1;
    const routing = item.routingLabel ?? "(none)";
    byRoutingLabel[routing] = (byRoutingLabel[routing] ?? 0) + 1;
    const labelAction = item.labelAction ?? "noop";
    byLabelAction[labelAction] = (byLabelAction[labelAction] ?? 0) + 1;
    if (item.eligible) eligible += 1;
    if (item.actionable) actionable += 1;
    if (item.authorized) authorized += 1;
    if (item.wouldWrite) wouldWrite += 1;
    if (item.applied) applied += 1;
    if (labelAction === "create" || labelAction === "add") labelsApplied += 1;
  }
  return {
    scope: {
      kind: resolution.kind,
      ...(resolution.matchedTeam ? { team: resolution.matchedTeam } : {}),
      ...(resolution.matchedProjects ? { projects: resolution.matchedProjects } : {}),
      resolvedCount: resolution.identifiers.length,
    },
    mode: mode.live ? "apply" : "dry-run",
    modeReason: mode.reason,
    counts: {
      total: items.length,
      eligible,
      actionable,
      authorized,
      wouldWrite,
      applied,
      labelsApplied,
      errors,
      byDisposition,
      byRoutingLabel,
      byLabelAction,
    },
    items,
  };
}

/** A report containing any planning error is a failed run, even when other items succeeded. */
export function reportExitCode(report) {
  return report.counts.errors > 0 ? 1 : 0;
}

// Runs `worker` over `inputs` with at most `limit` in flight; preserves input order.
async function mapPool(inputs, limit, worker) {
  const results = Array.from({ length: inputs.length });
  let next = 0;
  async function run() {
    while (next < inputs.length) {
      const current = next;
      next += 1;
      results[current] = await worker(inputs[current], current);
    }
  }
  const runners = [];
  for (let i = 0; i < Math.min(limit, inputs.length); i += 1) runners.push(run());
  await Promise.all(runners);
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function itemOptionsFor(identifier, options, approval) {
  return {
    identifier,
    nowIso: approval?.nowIso ?? options.nowIso,
    staleDays: options.staleDays,
    requiredLabels: options.requiredLabels,
    exclusionLabels: options.exclusionLabels,
    protectedLabels: options.protectedLabels,
    approval: approval ?? null,
  };
}

function printHuman(report) {
  const out = [];
  const s = report.scope;
  const scopeDesc =
    s.kind === "team"
      ? `team ${s.team}`
      : s.kind === "project"
        ? `project(s) ${(s.projects ?? []).map((p) => `${p.name} [${p.teamKey}]`).join(", ")}`
        : `${s.resolvedCount} identifier(s)`;
  out.push(`Scope:        ${s.kind} — ${scopeDesc}`);
  out.push(`Resolved:     ${s.resolvedCount} issue(s)`);
  out.push(`Mode:         ${report.mode} — ${report.modeReason}`);
  out.push("");
  out.push("Dispositions:");
  for (const [disp, n] of Object.entries(report.counts.byDisposition).sort()) {
    out.push(`  ${disp.padEnd(16)} ${n}`);
  }
  out.push("");
  out.push("Proposed routing labels:");
  for (const [label, n] of Object.entries(report.counts.byRoutingLabel ?? {}).sort()) {
    out.push(`  ${label.padEnd(34)} ${n}`);
  }
  out.push("");
  out.push(`Eligible:     ${report.counts.eligible}`);
  out.push(`Actionable:   ${report.counts.actionable}  (eligible + a real comment to post)`);
  out.push(`Authorized:   ${report.counts.authorized}  (approved via --approvals)`);
  out.push(`Would write:  ${report.counts.wouldWrite}  (actionable AND authorized)`);
  if (report.mode === "apply") out.push(`Applied:      ${report.counts.applied}`);
  out.push("");
  out.push("Label actions:");
  for (const [action, n] of Object.entries(report.counts.byLabelAction ?? {}).sort()) {
    out.push(`  ${action.padEnd(10)} ${n}`);
  }
  out.push(`Labels applied: ${report.counts.labelsApplied ?? 0}  (create + add)`);
  if (report.counts.errors > 0) out.push(`Errors:       ${report.counts.errors}`);
  if (report.mode === "dry-run" && report.counts.actionable > 0 && report.counts.authorized === 0) {
    out.push("");
    out.push(
      "Note: re-feed this run's --json as --approvals (with --apply + " +
        `${NOTIFY_ENV}=1) to authorize the ${report.counts.actionable} actionable item(s).`,
    );
  }
  out.push("");
  out.push("Per item:");
  for (const item of report.items) {
    if (item.error) {
      out.push(`  ✗ ${item.identifier.padEnd(10)} ERROR: ${item.error}`);
      continue;
    }
    const mark = item.applied ? "✓" : item.actionable ? "→" : "·";
    const label = item.routingLabel ? ` label=${item.routingLabel}` : "";
    const labelAct =
      item.labelAction && item.labelAction !== "noop" ? ` labelAction=${item.labelAction}` : "";
    out.push(
      `  ${mark} ${item.identifier.padEnd(10)} ${item.disposition.padEnd(16)} action=${item.action}${label}${labelAct}` +
        (item.applied ? " (applied)" : ""),
    );
  }
  return out.join("\n");
}

/**
 * Plans (and, when fully gated, applies) the additive label change for one item. Always
 * records the plan on the summary (labelAction/labelChange/labelAuthorized) so a dry-run
 * shows exactly what a live run would do. A live label write requires ALL of:
 *   - labelMode.live    (--apply-labels + OPENCLAW_NOTIFY_LINEAR=1)
 *   - eligible          (never label closed / protected / excluded items)
 *   - not a noop        (there is at least one additive label)
 *   - authorization     (authority.authorizeMutation allowed — additive union, no drop)
 * Additive only; never drops a label; protected action labels are denylist-asserted upstream.
 */
export async function applyLabelStep(entry, summary, labelMode, ensureWriteTransport, deps = {}) {
  try {
    let hydrated = entry.result.hydrated;
    let record = entry.result.record;
    let classification = entry.result.classification;

    // A replace-all labelIds mutation must be planned from an immediate live read. This
    // preserves unrelated labels added after the batch planning phase and makes snapshot or
    // plan drift deny the write against the separately reviewed label approval.
    if (labelMode.live) {
      hydrated = await deps.source.fetchIssueByIdentifier(entry.identifier);
      if (hydrated === null) {
        throw new Error(`no Linear issue found for identifier "${entry.identifier}"`);
      }
      record = mapWorkspaceItem(hydrated);
      classification = classifyRecord(record, {
        nowIso: entry.result.nowIso,
        staleDays: deps.options.staleDays,
        requiredLabels: deps.options.requiredLabels,
        exclusionLabels: deps.options.exclusionLabels,
        protectedLabels: deps.options.protectedLabels,
      });
    }

    const decision = evaluateReviewPolicy(classification, record);
    const change = planLabelChange(record, decision);
    const { authorization, receipt } = authorizeLabelChange(record, change, deps.approval ?? null);

    summary.labelChange = {
      existing: change.existing,
      additions: change.additions,
      removals: change.removals,
      proposed: change.proposed,
    };
    summary.labelAuthorized = authorization.allowed;
    summary.labelPlanHash = receipt.planHash;
    summary.labelSnapshotHash = receipt.snapshotHash;
    summary.labelReceipt = receipt;

    const eligible = classification.eligible;
    const wouldWriteLabels = eligible && !change.noop && authorization.allowed;
    summary.labelWouldWrite = wouldWriteLabels;

    if (change.noop) {
      summary.labelAction = "noop";
      summary.labelsApplied = [];
      summary.labelsCreated = [];
      return;
    }
    if (!labelMode.live || !wouldWriteLabels) {
      // Dry-run, ineligible, or unauthorized — record the plan, write nothing.
      summary.labelAction = "noop";
      summary.labelsApplied = [];
      summary.labelsCreated = [];
      summary.labelWriteSkipped = !labelMode.live
        ? labelMode.reason
        : !eligible
          ? "skipped: item not eligible for review"
          : "skipped: label-add not authorized";
      return;
    }

    const transport = await ensureWriteTransport();
    const result = await applyLabelChange(record, change, transport, {
      issueLabelsOnIssue: hydrated.issue.labels ?? [],
      readBackIssue: () => deps.source.fetchIssueByIdentifier(entry.identifier),
    });
    summary.labelAction = result.labelAction;
    summary.labelsApplied = result.labelsApplied;
    summary.labelsCreated = result.labelsCreated;
  } catch (error) {
    summary.labelAction = "noop";
    summary.labelsApplied = [];
    summary.labelsCreated = [];
    summary.labelApplyError = error instanceof Error ? error.message : String(error);
  }
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
  const labelMode = resolveLabelWriteMode(options);
  try {
    assertCompatibleWriteModes(mode, labelMode);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  let source;
  let resolution;
  let approvals = new Map();
  try {
    const readToken = resolveReadToken({ account: options.keychainAccount });
    source = new LinearItemSource(createLinearTransport({ token: readToken }));
    const spec = buildScopeSpec(options);
    resolution = await resolveScope(source, spec);
    if (options.approvals !== "") {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(options.approvals, "utf8"));
      } catch (error) {
        throw new Error(
          `failed to read --approvals ${options.approvals}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      approvals = loadApprovals(parsed);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  let identifiers = resolution.identifiers;
  if (options.limit > 0) identifiers = identifiers.slice(0, options.limit);

  // Phase 1: plan every item (read-only), bounded-concurrency.
  const planned = await mapPool(identifiers, options.concurrency, async (identifier) => {
    try {
      const result = await buildItemPlan(
        source,
        itemOptionsFor(identifier, options, approvals.get(identifier)),
      );
      const decision = resolveWriteDecision(result, mode);
      return { identifier, result, decision, summary: summarizeItem(result, decision) };
    } catch (error) {
      return { identifier, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Phase 2: live writes, SERIALIZED + rate-limited, sharing ONE minted Bearer token across
  // both the comment write and the label write (mint lazily, only when something will write).
  let writeTransport = null;
  let appCreds = null;
  const ensureWriteTransport = async () => {
    if (writeTransport === null) {
      appCreds = resolveAppCredentials({ account: options.keychainAccount });
      writeTransport = await mintWriteTransport(appCreds);
    }
    return writeTransport;
  };

  const items = [];
  for (const entry of planned) {
    if (entry.error) {
      items.push({ identifier: entry.identifier, error: entry.error });
      continue;
    }
    const summary = entry.summary;
    let didWrite = false;

    if (entry.decision.write) {
      didWrite = true;
      try {
        const revalidated = await revalidateCommentWrite(
          source,
          itemOptionsFor(entry.identifier, options, approvals.get(entry.identifier)),
          mode,
        );
        entry.result = revalidated.result;
        entry.decision = revalidated.decision;
        Object.assign(summary, summarizeItem(entry.result, entry.decision));
        await ensureWriteTransport();
        summary.applyResult = await applyPlan(entry.result.plan, appCreds, {
          transport: writeTransport,
        });
        summary.readback = await readBackPlannedComment(source, entry.identifier, entry.result);
        assertReadBackConfirmed(summary.readback);
        summary.applied = true;
      } catch (error) {
        summary.applied = false;
        summary.applyError = error instanceof Error ? error.message : String(error);
        // Honesty: if the comment mutation itself succeeded but read-back failed, a comment
        // WAS posted — applied=false must not read as "nothing was written". Flag it so the
        // report distinguishes a failed write from an unconfirmed-but-landed one.
        summary.writtenUnconfirmed = summary.applyResult !== undefined && !summary.applyResult.noop;
        process.exitCode = 1;
      }
    } else {
      summary.applied = false;
    }

    // Label write — independent of the comment write, same triple gate (--apply-labels +
    // OPENCLAW_NOTIFY_LINEAR=1 + authority allowed) + eligible + not a noop. Additive only.
    await applyLabelStep(entry, summary, labelMode, ensureWriteTransport, {
      source,
      options,
      approval: approvals.get(entry.identifier) ?? null,
    });
    if (summary.labelApplyError) process.exitCode = 1;

    if (didWrite || summary.labelAction === "create" || summary.labelAction === "add") {
      if (options.rateMs > 0) await sleep(options.rateMs);
    }
    items.push(summary);
  }

  const report = aggregate(items, resolution, resolveReportMode(mode, labelMode));
  if (reportExitCode(report) !== 0) process.exitCode = 1;
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(printHuman(report));
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

function nonNegativeInt(value, flag) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return Number(value);
}

function usage() {
  return `Usage: node scripts/linear-review-apply.mjs <scope> [options]

Runs ClawSweeper's review pipeline over a SCOPE of Linear issues. Dry-run by default
(plans + reports, writes nothing). The same per-item pipeline as the single-item path —
this only generalizes WHICH issues. It posts the standard review comment; it never closes.

Scope (provide exactly one):
  --identifier <KEY>         A Linear identifier, e.g. PAR-244 (repeatable)
  --identifiers a,b,c        Comma-separated identifiers
  --from-file <path>         JSON list/ledger; pulls each record's identifier
  --list-field <key>         Container key in --from-file to read (e.g. order, linear_done)
  --project <name|id>        Every issue in a Linear project (name is case-insensitive)
  --team <KEY>               Every issue in a team

Review options:
  --now <iso>                ISO 8601 "now" for staleness (default: current time)
  --stale-days <n>           Staleness threshold in days (default: ${DEFAULT_STALE_DAYS})
  --required-label <label>   Require one of these labels (repeatable)
  --exclusion-label <label>  Skip items with this label (repeatable)
  --protected-label <label>  Mark items with this label protected (repeatable)
  --limit <n>                Cap to the first n resolved issues
  --concurrency <n>          Parallel READS while planning (default: ${DEFAULT_CONCURRENCY})

Apply options (live write — review-only unless ALL hold):
  --apply                    Opt in to LIVE comment writes (also needs ${NOTIFY_ENV}=1)
  --apply-labels             Opt in to LIVE additive label writes (also needs ${NOTIFY_ENV}=1);
                             applies the policy's ONE proposed routing label, additive only
                             (never drops a label), creating a missing clawsweeper:* label
  --approvals <path>         Per-item comment + label hashes from a reviewed dry-run (--json)
  --rate-ms <n>              Delay between live writes in ms (default: 0)
  --json                     Emit the JSON run report (feedable as --approvals)
  --keychain-account <a>     Keychain account for credentials (default: ${DEFAULT_KEYCHAIN_ACCOUNT})
  --help, -h                 Show this help

Examples:
  # Read-only closeout review of a project (writes nothing):
  node scripts/linear-review-apply.mjs --project "Command Central" --json

  # Review the Command Central ledger's tracked items (the .order list):
  node scripts/linear-review-apply.mjs --from-file research/cc-work-ledger.json --json

  # Live apply over a reviewed-and-approved dry-run (both gates required):
  ${NOTIFY_ENV}=1 node scripts/linear-review-apply.mjs --team PAR --apply \\
    --approvals ./par-dry-run.json --rate-ms 400`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
