import fs from "node:fs";
import path from "node:path";

import type { JsonValue, LooseRecord } from "./json-types.js";
import {
  REVIEW_REPRODUCIBLE_BUG_TRIGGER_SOURCE,
  REVIEW_VIABLE_ISSUE_TRIGGER_SOURCE,
  REVIEW_VISION_FIT_TRIGGER_SOURCE,
} from "./comment-router-core.js";
import { validateRepairContractShape } from "./repair-contract.js";
import { GITHUB_PR_TITLE_MAX_LENGTH } from "./pr-title.js";
import { slug } from "./text-utils.js";

const REPAIR_STRATEGIES = new Set([
  "repair_contributor_branch",
  "replace_uneditable_branch",
  "new_fix_pr",
]);
export const HUMAN_REVIEW_LABEL = "clawsweeper:human-review";
export const MANUAL_ONLY_LABEL = "clawsweeper:manual-only";
const REVIEWED_ISSUE_TRIGGER_SOURCES = new Set([
  REVIEW_REPRODUCIBLE_BUG_TRIGGER_SOURCE,
  REVIEW_VIABLE_ISSUE_TRIGGER_SOURCE,
  REVIEW_VISION_FIT_TRIGGER_SOURCE,
]);

export function repairPauseLabel(labels: Iterable<JsonValue> | null | undefined): string | null {
  for (const label of labels ?? []) {
    const name = String(label?.name ?? label ?? "")
      .trim()
      .toLowerCase();
    if (name === HUMAN_REVIEW_LABEL || name === MANUAL_ONLY_LABEL) return name;
  }
  return null;
}

export function validateFixArtifact(fixArtifact: LooseRecord): LooseRecord {
  if (!fixArtifact || typeof fixArtifact !== "object") {
    throw new Error("fix execution requires fix_artifact");
  }
  for (const key of ["summary", "pr_title", "pr_body"]) {
    if (typeof fixArtifact[key] !== "string" || !fixArtifact[key].trim()) {
      throw new Error(`fix_artifact.${key} is required`);
    }
  }
  if (String(fixArtifact.pr_title).length > GITHUB_PR_TITLE_MAX_LENGTH) {
    throw new Error(
      `fix_artifact.pr_title must be ${GITHUB_PR_TITLE_MAX_LENGTH} characters or fewer`,
    );
  }
  for (const key of [
    "affected_surfaces",
    "likely_files",
    "linked_refs",
    "validation_commands",
    "credit_notes",
  ]) {
    if (!Array.isArray(fixArtifact[key]) || fixArtifact[key].length === 0) {
      throw new Error(`fix_artifact.${key} must be a non-empty list`);
    }
  }
  if (typeof fixArtifact.changelog_required !== "boolean") {
    throw new Error("fix_artifact.changelog_required must be boolean");
  }
  const contractErrors = validateRepairContractShape(fixArtifact);
  if (contractErrors.length > 0) throw new Error(contractErrors.join("; "));
  if (!REPAIR_STRATEGIES.has(fixArtifact.repair_strategy)) {
    throw new Error("fix_artifact.repair_strategy is not executable");
  }
  if (
    fixArtifact.repair_strategy !== "new_fix_pr" &&
    (!Array.isArray(fixArtifact.source_prs) || fixArtifact.source_prs.length === 0)
  ) {
    throw new Error("repair/replacement fix_artifact must list source_prs");
  }
  return fixArtifact;
}

export function validateFixSecurityScope({
  job,
  resultPath,
  fixArtifact,
  plannedFixActions,
}: LooseRecord): LooseRecord | null {
  if (job.frontmatter.security_sensitive === true) {
    return {
      reason: "job is marked security_sensitive; route to central security handling",
      evidence: ["job.frontmatter.security_sensitive=true"],
    };
  }

  const clusterPlan = readSiblingJson(resultPath, "cluster-plan.json");
  const securityRefs = new Set(
    (clusterPlan?.security_boundary?.security_sensitive_items ?? [])
      .map(normalizeLocalRef)
      .filter(Boolean),
  );

  for (const action of plannedFixActions) {
    const target = normalizeLocalRef(action.target);
    if (target && securityRefs.has(target)) {
      return {
        reason: `fix action targets security-sensitive ref ${target}`,
        evidence: [`${target} appears in cluster-plan.security_boundary.security_sensitive_items`],
      };
    }
  }

  for (const source of fixArtifact.source_prs ?? []) {
    const sourceRef = normalizeLocalRef(source);
    if (sourceRef && securityRefs.has(sourceRef)) {
      return {
        reason: `fix artifact source PR ${sourceRef} is security-sensitive`,
        evidence: [
          `${sourceRef} appears in cluster-plan.security_boundary.security_sensitive_items`,
        ],
      };
    }
  }

  return null;
}

export function validateAutonomousFixScope({
  job,
  fixArtifact,
  allowBroadFixArtifacts,
  maxAutonomousFixFiles,
  maxAutonomousFixSurfaces,
}: LooseRecord): LooseRecord | null {
  if (allowBroadFixArtifacts || job.frontmatter.allow_broad_fix_artifacts === true) return null;
  if (isTrustedAdoptedBranchRepair({ job, fixArtifact })) return null;
  if (isTrustedIssueImplementation({ job, fixArtifact })) return null;

  const likelyFiles = fixArtifact.likely_files ?? [];
  const affectedSurfaces = fixArtifact.affected_surfaces ?? [];
  const text = [
    fixArtifact.pr_title,
    fixArtifact.summary,
    fixArtifact.pr_body,
    ...affectedSurfaces,
    ...likelyFiles,
  ].join("\n");
  const featureSignal =
    /\bfeat(?:\(|:)|\bfeature\b|add(?:s|ing)?\s+(?:a |an )?(?:new |explicit )?|new config|configuration surface|public .*docs?|schema/i.test(
      text,
    );
  const crossesDocs = likelyFiles.some((file: JsonValue) => String(file).startsWith("docs/"));
  const crossesConfig = likelyFiles.some((file: JsonValue) =>
    /\bconfig\b|schema|labels|help/i.test(String(file)),
  );
  const crossesTests = likelyFiles.some((file: JsonValue) =>
    /\.test\.[cm]?[jt]s$|\.spec\.[cm]?[jt]s$/i.test(String(file)),
  );
  const crossesCore = likelyFiles.some((file: JsonValue) => String(file).startsWith("src/"));
  const crossSurfaceCount = [crossesDocs, crossesConfig, crossesTests, crossesCore].filter(
    Boolean,
  ).length;
  const tooManyFiles = likelyFiles.length > maxAutonomousFixFiles;
  const tooManySurfaces = affectedSurfaces.length > maxAutonomousFixSurfaces;

  if (!featureSignal || (!tooManyFiles && !tooManySurfaces && crossSurfaceCount < 3)) return null;

  return {
    reason:
      "fix artifact is too broad for autonomous execution; split into narrower jobs or explicitly set CLAWSWEEPER_ALLOW_BROAD_FIX_ARTIFACTS=1",
    evidence: [
      `pr_title=${fixArtifact.pr_title}`,
      `likely_files=${likelyFiles.length}/${maxAutonomousFixFiles}`,
      `affected_surfaces=${affectedSurfaces.length}/${maxAutonomousFixSurfaces}`,
      `cross_surface_count=${crossSurfaceCount}`,
      `sample_files=${likelyFiles.slice(0, 8).join(", ")}`,
    ],
  };
}

function isTrustedIssueImplementation({ job, fixArtifact }: LooseRecord): boolean {
  const frontmatter = job.frontmatter ?? {};
  if (frontmatter.source !== "issue_implementation") return false;
  if (fixArtifact.repair_strategy !== "new_fix_pr") return false;
  if (frontmatter.allow_fix_pr !== true) return false;
  if (!Array.isArray(frontmatter.allowed_actions) || !frontmatter.allowed_actions.includes("fix")) {
    return false;
  }
  if (!REVIEWED_ISSUE_TRIGGER_SOURCES.has(frontmatter.trigger_source)) return false;
  const repo = String(frontmatter.repo ?? "")
    .trim()
    .toLowerCase();
  const sourceRepo = String(frontmatter.source_issue_repo ?? "")
    .trim()
    .toLowerCase();
  const sourceNumber = Number(frontmatter.source_issue_number);
  const sourceRevision = String(frontmatter.source_issue_revision_sha256 ?? "").trim();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(sourceRepo) || sourceRepo !== repo) return false;
  if (!Number.isInteger(sourceNumber) || sourceNumber <= 0) return false;
  if (!/^[a-f0-9]{64}$/i.test(sourceRevision)) return false;
  const sourceSlug = sourceRepo.replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return frontmatter.target_branch === `clawsweeper/issue-${sourceSlug}-${sourceNumber}`;
}

function isTrustedAdoptedBranchRepair({ job, fixArtifact }: LooseRecord): boolean {
  const frontmatter = job.frontmatter ?? {};
  if (fixArtifact.repair_strategy !== "repair_contributor_branch") return false;
  const trustedSource =
    frontmatter.source === "pr_autofix" ||
    frontmatter.source === "pr_automerge" ||
    isTrustedPrRepairIntake(frontmatter, fixArtifact);
  if (!trustedSource) return false;
  if (frontmatter.allow_fix_pr !== true) return false;
  if (!Array.isArray(frontmatter.allowed_actions) || !frontmatter.allowed_actions.includes("fix")) {
    return false;
  }
  const targetBranch = String(frontmatter.target_branch ?? "");
  if (!targetBranch.startsWith("clawsweeper/")) return false;
  if (!Array.isArray(fixArtifact.source_prs) || fixArtifact.source_prs.length === 0) return false;
  return fixArtifact.source_prs.every((source: JsonValue) => {
    const text = String(source ?? "");
    return (
      /^#?\d+$/.test(text) ||
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/i.test(text)
    );
  });
}

function isTrustedPrRepairIntake(frontmatter: LooseRecord, fixArtifact: LooseRecord): boolean {
  if (frontmatter.source !== "pr-repair-intake" || frontmatter.job_intent !== "pr_repair") {
    return false;
  }
  const repo = String(frontmatter.repo ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo)) return false;
  if (!Array.isArray(fixArtifact.source_prs) || fixArtifact.source_prs.length !== 1) return false;
  const sourcePr = String(fixArtifact.source_prs[0] ?? "").toLowerCase();
  const sourceMatch = sourcePr.match(
    new RegExp(
      `^https://github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/([1-9]\\d*)$`,
    ),
  );
  if (!sourceMatch) return false;
  const sourceRef = `#${sourceMatch[1]}`;
  for (const key of ["canonical", "candidates", "cluster_refs"]) {
    const refs = frontmatter[key];
    if (!Array.isArray(refs) || refs.length !== 1 || refs[0] !== sourceRef) return false;
  }
  const expectedClusterId = slug(`repair-pr-${repo.replace("/", "-")}-${sourceMatch[1]}`);
  return (
    frontmatter.cluster_id === expectedClusterId &&
    frontmatter.target_branch === `clawsweeper/${expectedClusterId}`
  );
}

function readSiblingJson(resultPath: string, name: string): LooseRecord | null {
  const file = path.join(path.dirname(resultPath), name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function normalizeLocalRef(value: JsonValue): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const githubMatch = text.match(/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/(\d+)/i);
  if (githubMatch) return `#${githubMatch[1]}`;
  const hashMatch = text.match(/^#?(\d+)$/);
  if (hashMatch) return `#${hashMatch[1]}`;
  return "";
}
