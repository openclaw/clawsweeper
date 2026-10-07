import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  reviewPromptForTest,
  reviewPromptTemplates,
  reviewPromptTelemetryForTest,
} from "../dist/clawsweeper.js";
import { git, item } from "./helpers.ts";

const shared = readFileSync("prompts/review-item.md", "utf8");
const sharedSections = shared.split(/\{\{\w+\}\}/).filter((section) => section.trim());
const issue = readFileSync("prompts/review-issue.md", "utf8").trimEnd();
const pr = readFileSync("prompts/review-pr.md", "utf8").trimEnd();

test("production PR prompt leads with the engineering procedure before shared reporting", () => {
  const target = item({ kind: "pull_request" });
  const prompt = reviewPromptForTest(target, {}, git);
  assert.ok(prompt.startsWith(`${pr}${sharedSections[0]}`));
  const stages = [
    "## 1. Understand the before and after system",
    "## 2. Review integrated behavior",
    "## 3. Challenge candidate findings against source",
    "## 4. Synthesize the whole patch",
    "## 5. Assess proof and readiness under shared policy",
    "# Shared review rules and reporting",
    "## Role and evidence",
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
  assert.doesNotMatch(prompt, /an issue or PR must earn its place in the active backlog/);
  assert.ok(pr.includes("behavioral verdict and rationale in `summary`"));
  assert.match(pr, /before\/after account, central source-backed path/);
  assert.match(pr, /alternate-path observations in `evidence`/);
  assert.match(pr, /guard,\nupstream validation, alternate owner/);
  assert.ok(prompt.includes(reviewPromptTemplates().pull_request.trim()));
  assert.equal(
    reviewPromptTelemetryForTest(target, {}, git).staticPromptChars,
    prompt.indexOf("\n## Repository State\n"),
  );
});

test("production issue triage retains its original procedure and all shared rules", () => {
  const target = item({ kind: "issue" });
  const prompt = reviewPromptForTest(target, {}, git);
  assert.ok(prompt.startsWith(`${issue}${sharedSections[0]}`));
  assert.match(prompt, /an issue or PR must earn its place in the active backlog/);
  assert.match(prompt, /For each issue, aim for one useful outcome/);
  assert.doesNotMatch(
    prompt,
    /## 1\. Understand the before and after system|## PR Introduction Evidence/,
  );
  assert.ok(prompt.includes(reviewPromptTemplates().issue.trim()));
  assert.equal(
    reviewPromptTelemetryForTest(target, {}, git).staticPromptChars,
    prompt.indexOf("\n## Repository State\n"),
  );
});

for (const kind of ["issue", "pull_request"] as const) {
  test(`${kind} composition retains shared guards and runtime inputs exactly once`, () => {
    const context = { issue: { body: "source-context-sentinel" } };
    const prompt = reviewPromptForTest(item({ kind }), context, git, "maintainer-sentinel");
    for (const section of sharedSections) assert.equal(prompt.split(section).length, 2);
    assert.equal(prompt.split(reviewPromptTemplates()[kind].trim()).length, 2);
    assert.doesNotMatch(prompt, /\{\{\w+\}\}/);
    const findingRule = "Every finding must identify an actual introduced trigger";
    assert.equal(prompt.split(findingRule).length, kind === "pull_request" ? 2 : 1);
    for (const guard of [
      "This is a read-only review.",
      "mandatory TruffleHog admission",
      "Return JSON only, matching the output schema.",
      "source-context-sentinel",
      "maintainer-sentinel",
    ])
      assert.equal(prompt.split(guard).length, 2, guard);
  });
}
