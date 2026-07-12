import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  isTerminalMutationState,
  isSuccessfulTerminalMutationState,
  issueImplementationStatusMarker,
  renderIssueImplementationStatusComment,
} from "../../dist/repair/issue-implementation-status.js";

const options = {
  repo: "steipete/example",
  itemNumber: 42,
  state: "Planning",
  detail: "Codex is inspecting the issue and repository.",
  runUrl: "https://github.com/openclaw/clawsweeper/actions/runs/100",
  prUrl: "",
  title: "Add compact export mode",
};

test("issue implementation status creates a stable public progress comment", () => {
  const body = renderIssueImplementationStatusComment("", options);

  assert.match(body, new RegExp(issueImplementationStatusMarker(42)));
  assert.match(body, /automatically building this issue/);
  assert.match(body, /State: Planning/);
  assert.match(body, /clawsweeper:manual-only/);
  assert.match(body, /clawsweeper:human-review/);
});

test("issue implementation status includes a generated pull request", () => {
  const body = renderIssueImplementationStatusComment("", {
    ...options,
    state: "Blocked",
    prUrl: "https://github.com/steipete/example/pull/51",
  });

  assert.match(body, /PR: https:\/\/github\.com\/steipete\/example\/pull\/51/);
});

test("blocked and failed status comments require the terminal mutation guard", () => {
  for (const state of ["Complete", "PR Opened", "Blocked", "Failed"]) {
    assert.equal(isTerminalMutationState(state), true, state);
  }
  for (const state of ["Queued", "Planning", "Building"]) {
    assert.equal(isTerminalMutationState(state), false, state);
  }
  for (const state of ["Complete", "PR Opened"]) {
    assert.equal(isSuccessfulTerminalMutationState(state), true, state);
  }
  for (const state of ["Blocked", "Failed"]) {
    assert.equal(isSuccessfulTerminalMutationState(state), false, state);
  }

  const source = fs.readFileSync("src/repair/issue-implementation-status.ts", "utf8");
  assert.match(source, /publicationReceiptSha256[\s\S]*runVerifiedPublishedPullMutation\(/);
  assert.match(source, /--sealed-source-only[\s\S]*runVerifiedSealedSourceMutation\(/);
  assert.match(
    source,
    /isSuccessfulTerminalMutationState\(state\) \|\| prUrl[\s\S]*requires a verified publication receipt/,
  );
});

test("issue implementation status updates progress without replacing worker results", () => {
  const initial = renderIssueImplementationStatusComment("", options);
  const withResult = `${initial}\n\n## Implementation result\n\nPull request opened.`;
  const updated = renderIssueImplementationStatusComment(withResult, {
    ...options,
    state: "Complete",
    detail: "Implementation workflow completed.",
  });

  assert.doesNotMatch(updated, /Automatic implementation progress:/);
  assert.match(updated, /Automatic implementation completed\./);
  assert.doesNotMatch(updated, /## Implementation result/);
});

test("issue implementation status collapses an opened PR to a concise terminal comment", () => {
  const body = renderIssueImplementationStatusComment("", {
    ...options,
    state: "PR Opened",
    detail: "Checks continue on the pull request.",
    prUrl: "https://github.com/steipete/example/pull/51",
  });

  assert.match(
    body,
    /Implementation PR opened: https:\/\/github\.com\/steipete\/example\/pull\/51/,
  );
  assert.match(body, /Status: Checks continue on the pull request\./);
  assert.doesNotMatch(body, /Automatic implementation progress|Opt out|State:/);
});

test("issue build workflow reports an opened PR without calling pending CI blocked", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");

  assert.match(workflow, /state="PR Opened"/);
  assert.match(workflow, /TRUSTED_PR_URL: \$\{\{ steps\.publish\.outputs\.target_pr_url \}\}/);
  assert.match(
    workflow,
    /POST_FLIGHT_OUTCOME: \$\{\{ steps\.post_flight\.outputs\.report_outcome \}\}/,
  );
  assert.doesNotMatch(workflow, /POST_FLIGHT_OUTCOME: \$\{\{ steps\.post_flight\.outcome \}\}/);
  assert.match(
    workflow,
    /steps\.post_flight\.outputs\.report_outcome == 'success'[\s\S]*completion-reason gates_passed/,
  );
  assert.match(
    workflow,
    /name: Post-flight finalize fix PRs[\s\S]*continue-on-error: true[\s\S]*name: Fail incomplete post-flight result/,
  );
  assert.match(
    workflow,
    /steps\.post_flight\.outcome == 'failure' \|\| steps\.post_flight\.outputs\.report_outcome != 'success'/,
  );
  assert.match(workflow, /The exact independently validated repair was published at/);
  assert.match(
    workflow,
    /status_guard=\([\s\S]*--handoff-root \.clawsweeper-repair\/execution[\s\S]*--validation-receipt-sha256 "\$\{\{ needs\.validate\.outputs\.receipt_sha256 \}\}"/,
  );
  assert.match(
    workflow,
    /if \[ -n "\$PUBLICATION_RECEIPT_SHA256" \]; then[\s\S]*--publication-receipt-sha256 "\$PUBLICATION_RECEIPT_SHA256"[\s\S]*else[\s\S]*TRUSTED_PR_URL=""[\s\S]*--sealed-source-only/,
  );
  assert.match(
    workflow,
    /\[ -n "\$TRUSTED_PR_URL" \] && \[ -n "\$PUBLICATION_RECEIPT_SHA256" \][\s\S]*state="PR Opened"/,
  );
  assert.doesNotMatch(
    workflow,
    /detail="The automatic implementation worker stopped before all post-flight gates passed:/,
  );
});
