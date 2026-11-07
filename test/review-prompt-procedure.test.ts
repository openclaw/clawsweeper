import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  reviewDecisionSchemaText,
  reviewPromptForTest,
  reviewPromptTemplates,
  reviewPromptTelemetryForTest,
} from "../dist/clawsweeper.js";
import { reviewPolicyHash } from "../dist/clawsweeper-review-policy-hash.js";
import { renderReviewSections, reviewPromptSections } from "../dist/review-prompt-sections.js";
import { git, item } from "./helpers.ts";

const shared = readFileSync("prompts/review-item.md", "utf8");
const sharedSections = shared.split(/\{\{\w+\}\}/).filter((section) => section.trim());
const issue = readFileSync("prompts/review-issue.md", "utf8").trimEnd();
const pr = readFileSync("prompts/review-pr.md", "utf8").trimEnd();

test("production PR prompt leads with the engineering contract before canonical policy", () => {
  const target = item({ kind: "pull_request" });
  const prompt = reviewPromptForTest(target, {}, git);
  assert.ok(prompt.startsWith(`${pr}${sharedSections[0]}`));
  const stages = [
    "## Ground rules",
    "## Pull request review",
    "## Repository Policy",
    "## Repository State",
    "## PR Introduction Evidence",
    "## GitHub Context",
  ];
  let previous = -1;
  for (const stage of stages) {
    const at = prompt.indexOf("\n" + stage + "\n");
    assert.ok(at > previous, `${stage} follows the previous stage`);
    previous = at;
  }
  assert.ok(!prompt.includes(issue));
  assert.ok(
    prompt.includes(
      renderReviewSections(
        reviewPromptTemplates().pull_request,
        reviewPromptSections(target, {}),
      ).trim(),
    ),
  );
  assert.equal(
    reviewPromptTelemetryForTest(target, {}, git).staticPromptChars,
    prompt.indexOf("\n## Repository State\n"),
  );
});

test("production issue triage retains its original procedure and all shared rules", () => {
  const target = item({ kind: "issue" });
  const prompt = reviewPromptForTest(target, {}, git);
  assert.ok(prompt.startsWith(`${issue}${sharedSections[0]}`));
  assert.ok(!prompt.includes(pr));
  assert.doesNotMatch(prompt, /## PR Introduction Evidence/);
  assert.ok(
    prompt.includes(
      renderReviewSections(reviewPromptTemplates().issue, reviewPromptSections(target, {})).trim(),
    ),
  );
  assert.equal(
    reviewPromptTelemetryForTest(target, {}, git).staticPromptChars,
    prompt.indexOf("\n## Repository State\n"),
  );
});

for (const kind of ["issue", "pull_request"] as const) {
  test(`${kind} composition retains shared guards and runtime inputs exactly once`, () => {
    const context = { issue: { body: "source-context-sentinel" } };
    const target = item({ kind });
    const prompt = reviewPromptForTest(target, context, git, "maintainer-sentinel");
    for (const section of sharedSections) assert.equal(prompt.split(section).length, 2);
    const sections = reviewPromptSections(target, context);
    const kindRules = renderReviewSections(reviewPromptTemplates()[kind], sections).trim();
    assert.equal(prompt.split(kindRules).length, 2);
    const otherKind = kind === "issue" ? "pull_request" : "issue";
    const otherRules = renderReviewSections(reviewPromptTemplates()[otherKind], sections).trim();
    assert.ok(!prompt.includes(otherRules));
    assert.doesNotMatch(prompt, /\{\{\w+\}\}/);
    assert.doesNotMatch(prompt, /<!-- \/?review-section/);
    for (const sentinel of ["source-context-sentinel", "maintainer-sentinel"])
      assert.equal(prompt.split(sentinel).length, 2, sentinel);
  });
}

test("engineering opening retains conditional PR policy in the assembled prompt", () => {
  const template = reviewPromptTemplates().pull_request;
  for (const authorAssociation of ["NONE", "MEMBER"]) {
    for (const followUp of [false, true]) {
      const target = item({ kind: "pull_request", authorAssociation });
      const context = followUp ? { previousClawSweeperReview: { summary: "Prior review" } } : {};
      const sections = reviewPromptSections(target, context);
      const prompt = reviewPromptForTest(target, context, git);
      assert.ok(prompt.startsWith(pr));
      assert.ok(prompt.includes(renderReviewSections(template, sections).trim()));
      for (const match of template.matchAll(
        /<!-- review-section: (\w+) -->\n([\s\S]*?)<!-- \/review-section -->/g,
      )) {
        const section = match[1] as keyof typeof sections;
        assert.equal(prompt.includes(match[2]!.trim()), sections[section], section);
      }
      assert.doesNotMatch(prompt, /\{\{\w+\}\}|<!-- \/?review-section/);
    }
  }
});

test("review policy hash includes both opening assets", () => {
  const procedures = {
    issue: readFileSync("prompts/review-issue.md", "utf8"),
    pull_request: readFileSync("prompts/review-pr.md", "utf8"),
  };
  const sources = {
    reviewPromptTemplates,
    reviewDecisionSchemaText,
    reviewProcedureTemplate: (kind: "issue" | "pull_request") => procedures[kind],
  };
  const baseline = reviewPolicyHash({}, sources);
  for (const kind of ["issue", "pull_request"] as const) {
    const original = procedures[kind];
    procedures[kind] += "\nChanged opening.\n";
    assert.notEqual(reviewPolicyHash({}, sources), baseline, kind);
    procedures[kind] = original;
    assert.equal(reviewPolicyHash({}, sources), baseline);
  }
});

test("review policy hash retains canonical conditional templates and schema", () => {
  const templates = { ...reviewPromptTemplates() };
  const schema = reviewDecisionSchemaText();
  assert.equal(schema, readFileSync("schema/clawsweeper-decision.schema.json", "utf8"));
  const sources = {
    reviewPromptTemplates: () => templates,
    reviewDecisionSchemaText: () => schema,
    reviewProcedureTemplate: (kind: "issue" | "pull_request") => (kind === "issue" ? issue : pr),
  };
  const baseline = reviewPolicyHash({}, sources);
  for (const key of ["core", "issue", "pull_request", "closeReasons"] as const) {
    const original = templates[key];
    templates[key] += "\nChanged canonical policy.\n";
    assert.notEqual(reviewPolicyHash({}, sources), baseline, key);
    templates[key] = original;
    assert.equal(reviewPolicyHash({}, sources), baseline);
  }
  assert.notEqual(
    reviewPolicyHash({}, { ...sources, reviewDecisionSchemaText: () => schema + "\n" }),
    baseline,
  );
});
