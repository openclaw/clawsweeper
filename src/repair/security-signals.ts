import MarkdownIt from "markdown-it/browser";
import type { Decision, SecurityReview } from "../clawsweeper-types.js";

const markdown = new MarkdownIt("commonmark", { html: true });
const PAYLOAD_SUMMARY =
  "Concealed shell payload in the item or discussion requires human security moderation; do not execute it.";

/** Inspect rendered HTML comments only, never visible fenced/inline code examples. */
export function hiddenPayloadSecurityReview(
  body: unknown,
  comments: readonly unknown[] = [],
): SecurityReview | undefined {
  for (const source of [
    body,
    ...comments.map((comment) =>
      comment && typeof comment === "object" && "body" in comment ? comment.body : undefined,
    ),
  ]) {
    if (typeof source !== "string" || !source.includes("<!--")) continue;
    // GitHub bodies are bounded; also cap local overrides before Markdown parsing.
    const tokens = markdown.parse(source.slice(0, 131_072), {});
    const html = tokens
      .flatMap((token) => [token, ...(token.children ?? [])])
      .filter((token) => token.type === "html_block" || token.type === "html_inline");
    for (const token of html) {
      for (const match of token.content.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) {
        const hidden = match[0];
        // Deliberately coarse: shell grammar is not modeled. People rarely write their own
        // hidden comments and no org template mentions network tools in one, so any network
        // tool there is moderation-worthy. A false positive only keeps the item open for a
        // human; workflows never execute this text. Tool-free loaders are out of scope.
        const network = /\b(?:curl|wget|nc|ncat|netcat)\b|\/dev\/(?:tcp|udp)\//i.test(hidden);
        const environment = /\b(?:env|printenv)\b|\/proc\/(?:self|\d+)\/environ/i.test(hidden);
        const encodedEnvironment = environment && /\bbase64\b/i.test(hidden);
        if (!network && !encodedEnvironment) continue;
        return {
          status: "needs_attention",
          summary: PAYLOAD_SUMMARY,
          concerns: [
            {
              title: "Moderate concealed shell payload",
              body: PAYLOAD_SUMMARY,
              severity: "high",
              confidenceScore: 0.99,
              file: null,
              line: null,
            },
          ],
        };
      }
    }
  }
  return undefined;
}

export function applyHiddenPayloadSecurityReview(
  decision: Decision,
  signal: SecurityReview | undefined,
): Decision {
  if (!signal) return decision;
  const priority = decision.triagePriority === "P0" ? "P0" : "P1";
  // Review records allow at most three impact labels; security takes precedence.
  const impactLabels = [
    "impact:security" as const,
    ...decision.impactLabels.filter((label) => label !== "impact:security"),
  ].slice(0, 3);
  const droppedImpactLabels = new Set<string>(
    decision.impactLabels.filter((label) => !impactLabels.includes(label)),
  );
  return {
    ...decision,
    decision: "keep_open",
    closeReason: "none",
    closeComment: "",
    workCandidate: "manual_review",
    autoImplementationCandidate: "none",
    workPrompt: "",
    workReason: PAYLOAD_SUMMARY,
    summary: `${PAYLOAD_SUMMARY} ${decision.summary}`,
    triagePriority: priority,
    impactLabels,
    labelJustifications: [
      ...decision.labelJustifications.filter(
        (entry) =>
          !/^P[0-3]$/.test(entry.label) &&
          entry.label !== "impact:security" &&
          !droppedImpactLabels.has(entry.label),
      ),
      { label: priority, reason: PAYLOAD_SUMMARY },
      { label: "impact:security", reason: PAYLOAD_SUMMARY },
    ],
    securityReview: {
      ...signal,
      concerns: [...signal.concerns, ...decision.securityReview.concerns],
    },
  };
}

const SECURITY_LABELS = new Set([
  "security",
  "security-sensitive",
  "security sensitive",
  "type: security",
  "type:security",
  "kind: security",
  "kind:security",
]);

export function isSecurityLabel(value: string): boolean {
  return SECURITY_LABELS.has(normalizeToken(value));
}

function normalizeToken(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
