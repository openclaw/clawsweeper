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

test("production PR prompt leads with the engineering contract before canonical policy", () => {
  const target = item({ kind: "pull_request" });
  const prompt = reviewPromptForTest(target, {}, git);
  assert.ok(prompt.startsWith(`${pr}${sharedSections[0]}`));
  const stages = [
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
  assert.ok(!prompt.includes(issue));
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
  assert.ok(!prompt.includes(pr));
  assert.doesNotMatch(prompt, /## PR Introduction Evidence/);
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
    const otherKind = kind === "issue" ? "pull_request" : "issue";
    assert.ok(!prompt.includes(reviewPromptTemplates()[otherKind].trim()));
    assert.doesNotMatch(prompt, /\{\{\w+\}\}/);
    for (const guard of ["source-context-sentinel", "maintainer-sentinel"])
      assert.equal(prompt.split(guard).length, 2, guard);
  });
}
