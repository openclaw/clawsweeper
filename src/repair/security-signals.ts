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
        // Hidden comments rarely mention download tools at all, so a download tool plus any
        // execution signal anywhere in the comment is enough; no URL or pipe shape required.
        // This only surfaces items for moderation; workflows never execute this text.
        const download = /\b(?:curl|wget)\b/i.test(hidden);
        const substitution =
          /(?:[$<]\(|`)\s*(?:\/[\w./-]+\/)?(?:curl|wget|env|printenv|base64)\b/i.test(hidden);
        // Interpreters as a command word, wrapped or pathed: `| sudo -E /bin/bash`, `; sh /tmp/x`.
        const shellExecution =
          /(?:^|[\s|;&(])(?:sudo(?:\s+-\w+(?:\s+[\w-]+)?)*\s+)?(?:\/[\w./-]+\/)?(?:env(?:\s+-\w+)*\s+)?(?:ba|da|z|k)?sh(?=\s|$|[;&|)])/im.test(
            hidden,
          ) || /\bchmod\s+(?:[+ugoa]*x|[0-7]{3,4})\b/i.test(hidden);
        const environment = /\b(?:env|printenv)\b|\/proc\/(?:self|\d+)\/environ/i.test(hidden);
        const encodedEnvironment = environment && /\bbase64\b/i.test(hidden);
        if (!(download && (substitution || shellExecution)) && !encodedEnvironment) continue;
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
    impactLabels: [...new Set([...decision.impactLabels, "impact:security" as const])],
    labelJustifications: [
      ...decision.labelJustifications.filter(
        (entry) => !/^P[0-3]$/.test(entry.label) && entry.label !== "impact:security",
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
