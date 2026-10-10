#!/usr/bin/env node
import * as fs from "node:fs";
import { MAX_MEDIA_PROOF_TIMEOUT_MS } from "../media-proof-budget.ts";

const decision = JSON.parse(process.env.CLAIM_DECISION || "{}") as {
  targetRepo: string;
  itemNumber: number;
  codexTimeoutMs: number;
  sourceAction: string;
  publicationPolicy: string;
  mediaProofTimeoutMs: number;
  commandStatusMarker: string;
  statusCommentId: number;
};
const targetRepo = String(decision.targetRepo || "");
const itemNumber = Number(decision.itemNumber);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo)) process.exit(1);
if (!Number.isInteger(itemNumber) || itemNumber < 1) process.exit(1);

// The review-start lease permits at most two hours, including its ten-minute
// cushion. The job keeps the rest of its timeout for target checkout/setup and
// artifact/publication finalizers after this cap and the review reserve: the
// largest media proof allowance plus three minutes.
const maxExactReviewCodexTimeoutMs = 2_700_000;
const configuredValue = Number(process.env.CONFIGURED_CODEX_TIMEOUT_MS);
const configuredTimeout =
  Number.isInteger(configuredValue) && configuredValue > 0
    ? Math.min(maxExactReviewCodexTimeoutMs, configuredValue)
    : 1_200_000;
const adaptiveValue = Number(decision.codexTimeoutMs);
const adaptiveTimeout =
  Number.isInteger(adaptiveValue) && adaptiveValue > 0
    ? Math.min(1_800_000, Math.max(600_000, adaptiveValue))
    : 0;
const requestedTimeout =
  decision.sourceAction === "manual_explicit_review" &&
  decision.publicationPolicy === "record_comment_only" &&
  Number.isInteger(adaptiveValue) &&
  adaptiveValue > 0
    ? adaptiveValue
    : Math.max(configuredTimeout, adaptiveTimeout);
// Manual review options can carry any media allowance; preparation never needs more.
const mediaValue = Number(decision.mediaProofTimeoutMs);
const mediaTimeout =
  Number.isInteger(mediaValue) && mediaValue > 0
    ? Math.min(MAX_MEDIA_PROOF_TIMEOUT_MS, mediaValue)
    : 0;
const [owner, name] = targetRepo.split("/");
const targetSlug = targetRepo
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9_.-]+/g, "-");
const checkoutDir = targetRepo === process.env.GITHUB_REPOSITORY ? `${name}-target` : name;
const hasCommandContext = Boolean(decision.commandStatusMarker || decision.statusCommentId);
const targetEnabled = targetRepo !== "openclaw/clawhub" || process.env.CLAWHUB_ENABLED === "1";
const output = {
  target_repo: targetRepo,
  target_repo_owner: owner,
  target_repo_name: name,
  target_slug: targetSlug,
  target_checkout_dir: checkoutDir,
  item_number: itemNumber,
  codex_timeout_ms: Math.min(maxExactReviewCodexTimeoutMs, requestedTimeout),
  media_proof_timeout_ms: mediaTimeout,
  media_preprocessing_reserve_seconds: Math.ceil(MAX_MEDIA_PROOF_TIMEOUT_MS / 1000),
  has_command_context: hasCommandContext,
  target_enabled: targetEnabled,
};
fs.appendFileSync(
  process.env.GITHUB_OUTPUT!,
  `${Object.entries(output)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`,
);
