import { createDecisionParser } from "../clawsweeper-decision-parser.js";
import { reviewSectionValue } from "../clawsweeper-record-metadata.js";
import {
  LIVE_PROOF_RECORDING_MARKER,
  LIVE_VERIFICATION_MARKER,
  REVIEW_SECTIONS,
} from "../clawsweeper-policy.js";
import type { LiveProofPlan } from "../clawsweeper-types.js";
import { frontMatterValue } from "../report-front-matter.js";
import { readReviewRecord } from "../review-record.js";
import {
  parseAttachedLiveVerification,
  renderLiveVerificationCommentBlock,
  type AttachedLiveVerification,
} from "./verification.js";

const LIVE_PROOF_SECTION_HEADING = REVIEW_SECTIONS.liveProof;
const LIVE_PROOF_OWNED_HEADINGS = new Set(
  Object.values(REVIEW_SECTIONS).map((heading) => heading.toLowerCase()),
);
const parseRecordedLiveProofPlan = createDecisionParser({
  neutralizeOwnedSectionSpoofing: neutralizeLiveProofText,
  sanitizeArchitectureDiagram: (value) => value,
}).parseLiveProofPlan;

export function reportLiveProofPlan(markdown: string): LiveProofPlan {
  // The plan is host-authored, but a corrupt review record must never authorize execution.
  readReviewRecord(markdown);
  const section = reportSectionValue(markdown, LIVE_PROOF_SECTION_HEADING);
  const status = reportSectionLineValue(section, "Status");
  const surface = reportSectionLineValue(section, "Surface");
  const terminalCompletion =
    reportSectionLineValue(section, "Terminal completion") ??
    (status !== "recommended" || surface !== "terminal" ? "not_applicable" : undefined);
  try {
    return parseRecordedLiveProofPlan(
      {
        status,
        surface,
        terminalCompletion,
        reason: reportSectionLineValue(section, "Reason"),
        payoff: {
          kind: reportSectionLineValue(section, "Payoff"),
          justification: reportSectionLineValue(section, "Payoff justification"),
        },
        entry: reportSectionLineValue(section, "Entry") ?? "",
        steps: reportLiveProofSteps(section),
      },
      "report.liveProofPlan",
    );
  } catch {
    return {
      status: "not_applicable",
      surface: "none",
      terminalCompletion: "not_applicable",
      invalid: true,
      reason:
        "The live-proof plan is missing or invalid; regenerate the review report before execution.",
      payoff: {
        kind: "static_text",
        justification: "Invalid report plans are non-runnable and fail closed.",
      },
      entry: "",
      steps: [],
    };
  }
}

function reportSectionValue(markdown: string, heading: string): string {
  // Preserve marker whitespace and never separate a final CRLF pair.
  const match = markdown.match(
    new RegExp(`(?:^|\\n)## ${heading}\\n\\n([\\s\\S]*?)(?=\\r?\\n## |$)`),
  );
  return match?.[1] ?? "";
}

function reportSectionLineValue(section: string, label: string): string | undefined {
  const prefix = `${label}:`;
  for (const line of section.trim().split("\n")) {
    if (!line.startsWith(prefix)) continue;
    const value = line.slice(prefix.length).trim();
    return value || undefined;
  }
  return undefined;
}

function reportLiveProofSteps(section: string): unknown[] {
  const lines = section.split(/\r?\n/);
  // Match raw attachment lines exactly, as the verification parser does.
  const attachmentStart = lines.findIndex(
    (line) => line === LIVE_VERIFICATION_MARKER || line === LIVE_PROOF_RECORDING_MARKER,
  );
  const planLines = (attachmentStart < 0 ? lines : lines.slice(0, attachmentStart)).map((line) =>
    line.trim(),
  );
  const start = planLines.indexOf("Steps:");
  if (start < 0 || planLines.lastIndexOf("Steps:") !== start) {
    throw new Error("live-proof report requires exactly one Steps payload");
  }
  const payload = planLines.slice(start + 1).filter(Boolean);
  // legacy-empty-list-v1: already-produced reports used a solitary "- none".
  if (payload.length === 1 && (payload[0] === "[]" || payload[0] === "- none")) return [];
  if (!payload.length) throw new Error("live-proof report is missing its Steps payload");
  return payload.map((line) => {
    if (!line.startsWith("- ")) throw new Error("live-proof report step must be a JSON list item");
    return JSON.parse(line.slice(2)) as unknown;
  });
}

function neutralizeLiveProofText(value: string): string {
  return value
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .split("\n")
    .map((line) => {
      const containerPrefix =
        line.match(/^[ \t]*(?:(?:>|(?:[-*+]|\d+[.)])[ \t])[ \t]*)*/)?.[0] ?? "";
      const content = line.slice(containerPrefix.length).replace(/<(?!br\s*\/?>)/gi, "&lt;");
      const trimmed = content.trim();
      if (/^#{1,6}\s+\S/.test(trimmed)) {
        return `${containerPrefix}${content.replace("#", "\\#")}`;
      }
      if (/^\*\*[^*\n]+\*\*:?\s*$/.test(trimmed)) {
        return `${containerPrefix}${content.replace("**", "\\*\\*")}`;
      }
      if (/^(?:```|~~~)/.test(trimmed)) {
        return `${containerPrefix}${content.replace(/[`~]/, "\\$&")}`;
      }
      if (/^(?:=+|-+)[ \t]*$/.test(trimmed)) {
        return `${containerPrefix}${content.replace(/[=-]/, "\\$&")}`;
      }
      if (
        trimmed.endsWith(":") &&
        LIVE_PROOF_OWNED_HEADINGS.has(trimmed.slice(0, -1).trim().toLowerCase())
      ) {
        return `${containerPrefix}${content.trimEnd().slice(0, -1)}&#58;`;
      }
      return `${containerPrefix}${content}`;
    })
    .join("\n");
}

export function reportLiveProofRecordingBlock(markdown: string): string {
  const section = reviewSectionValue(markdown, "liveProof");
  const verificationBlock = reportLiveVerificationBlock(markdown);
  const markerIndex = section.lastIndexOf(LIVE_PROOF_RECORDING_MARKER);
  if (markerIndex < 0) return verificationBlock;
  const lines = section
    .slice(markerIndex + LIVE_PROOF_RECORDING_MARKER.length)
    .trim()
    .split("\n")
    .map((line) => line.trimEnd());
  if (lines.length !== 3 || lines[1] !== "") return verificationBlock;
  if (
    !/^\[!\[Live proof recording\]\(https:\/\/[^)\s]+\)\]\(https:\/\/[^)\s]+\)$/.test(
      lines[0] ?? "",
    )
  ) {
    return verificationBlock;
  }
  if (
    !/^\*Recorded live on the PR head \(`(?:[0-9a-f]{7,40})`\), (?:0|[1-9][0-9]*)(?:\.[0-9]+)?s, (?:browser|terminal) surface\.\*$/.test(
      lines[2] ?? "",
    )
  ) {
    return verificationBlock;
  }
  return [verificationBlock, lines.join("\n")].filter(Boolean).join("\n\n");
}

export function reportAttachedLiveVerification(markdown: string): AttachedLiveVerification {
  return parseAttachedLiveVerification(
    reviewSectionValue(markdown, "liveProof"),
    {
      repository: frontMatterValue(markdown, "repository"),
      number: frontMatterValue(markdown, "number"),
      type: frontMatterValue(markdown, "type"),
      pullHeadSha: frontMatterValue(markdown, "pull_head_sha"),
    },
    reportLiveProofPlan(markdown),
  );
}

function reportLiveVerificationBlock(markdown: string): string {
  const attached = reportAttachedLiveVerification(markdown);
  return attached.status === "passed" || attached.status === "failed"
    ? renderLiveVerificationCommentBlock(attached.result)
    : "";
}
