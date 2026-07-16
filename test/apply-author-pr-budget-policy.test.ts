import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  promotionGhMock,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  withMockGh,
  workPlanCandidateReport,
} from "./helpers.ts";

function budgetCandidateReport(
  options: {
    number?: number;
    authorAssociation?: string;
    labels?: string[];
    rating?: "S" | "A" | "B" | "C" | "D" | "F";
    proof?: "missing" | "mock_only" | "insufficient" | "sufficient" | "override";
    proposed?: boolean;
  } = {},
): string {
  const number = options.number ?? 321;
  const rating = options.rating ?? "D";
  const proof = options.proof ?? "missing";
  const proposed = options.proposed === true;
  return `${workPlanCandidateReport({
    number,
    repository: "openclaw/openclaw",
    type: "pull_request",
    title: "Idle low-signal PR",
    author: "reporter",
    author_association: options.authorAssociation ?? "CONTRIBUTOR",
    labels: JSON.stringify(options.labels ?? []),
    decision: proposed ? "close" : "keep_open",
    close_reason: proposed ? "author_pr_budget_exceeded" : "none",
    confidence: "high",
    action_taken: proposed ? "proposed_close" : "kept_open",
    work_candidate: "none",
    work_status: "none",
    item_snapshot_hash: "reviewed-snapshot",
    item_created_at: "2026-05-01T00:00:00Z",
    item_updated_at: "2026-05-01T00:00:00Z",
    reviewed_at: "2026-05-01T00:00:00Z",
    pull_head_sha: "head-sha",
    pr_rating_overall: rating,
    pr_rating_proof: rating,
    pr_rating_patch: rating,
  })}

## Real Behavior Proof

Status: ${proof}
Evidence kind: ${proof === "sufficient" ? "terminal" : "none"}
Needs contributor action: ${proof === "sufficient" || proof === "override" ? "false" : "true"}
Summary: ${proof === "sufficient" ? "A real live run proves the behavior." : "No adequate live proof was supplied."}

## PR Rating

Overall tier: ${rating}
Proof tier: ${rating}
Patch tier: ${rating}
Summary: The latest review assigned this readiness tier.
Next rank-up steps:
- Add real behavior proof.

## Close Comment

Close this lowest-signal PR under the author budget.
`;
}

interface RunOptions {
  gateEnabled?: boolean;
  openPrCount?: number;
  authorSearchIncomplete?: boolean;
  authorSearchError?: string;
  authorAssociation?: string;
  labels?: string[];
  rating?: "S" | "A" | "B" | "C" | "D" | "F";
  proof?: "missing" | "mock_only" | "insufficient" | "sufficient" | "override";
  comments?: unknown[];
  proposed?: boolean;
  checkActivityAt?: string;
  dryRun?: boolean;
}

function runBudgetApply(options: RunOptions = {}) {
  const root = mkdtempSync(tmpPrefix);
  const original = {
    enabled: process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED,
    budget: process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET,
    cap: process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN,
  };
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const source = budgetCandidateReport(options);
    const reason = options.proposed ? "author_pr_budget_exceeded" : "none";
    const synced = reportWithSyncedReviewComment(source, 321, reason);
    writeFileSync(join(itemsDir, "321.md"), synced.report, "utf8");

    if (options.gateEnabled === false) {
      delete process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED;
    } else {
      process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED = "true";
    }
    process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET = "15";
    process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN = "5";

    const comments = options.comments ?? [
      {
        id: 9321,
        html_url: "https://github.com/openclaw/openclaw/pull/321#issuecomment-9321",
        created_at: "2026-05-01T01:00:00Z",
        updated_at: "2026-05-01T01:00:00Z",
        author_association: "NONE",
        user: { login: "clawsweeper[bot]", type: "Bot" },
        body: synced.comment,
      },
    ];
    withMockGh(
      root,
      promotionGhMock({
        number: 321,
        title: "Idle low-signal PR",
        labels: options.labels ?? [],
        authorAssociation: options.authorAssociation ?? "CONTRIBUTOR",
        openPrCount: options.openPrCount ?? 16,
        authorSearchIncomplete: options.authorSearchIncomplete,
        authorSearchError: options.authorSearchError,
        checkActivityAt: options.checkActivityAt,
        comments,
        comment: synced.comment,
        itemCreatedAt: "2026-05-01T00:00:00Z",
        itemUpdatedAt: "2026-05-01T00:00:00Z",
        headActivityAt: "2026-05-01T01:00:00Z",
        headCommittedAt: "2026-05-01T00:00:00Z",
        mergeable: true,
        mergeableState: "clean",
      }),
      () => {
        runApplyDecisionsForTest({
          targetRepo: "openclaw/openclaw",
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            ...(options.dryRun === false ? [] : ["--dry-run"]),
            "--apply-kind",
            "pull_request",
            "--apply-close-reasons",
            "author_pr_budget_exceeded",
            "--processed-limit",
            "3",
            "--item-number",
            "321",
          ],
        });
      },
    );

    const storedPath = existsSync(join(closedDir, "321.md"))
      ? join(closedDir, "321.md")
      : join(itemsDir, "321.md");
    return {
      entries: JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
        number: number;
        action: string;
        reason: string;
      }>,
      markdown: readFileSync(storedPath, "utf8"),
      closedExists: existsSync(join(closedDir, "321.md")),
    };
  } finally {
    for (const [key, value] of Object.entries(original)) {
      const name =
        key === "enabled"
          ? "CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED"
          : key === "budget"
            ? "CLAWSWEEPER_AUTHOR_PR_BUDGET"
            : "CLAWSWEEPER_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN";
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("author PR-budget apply policy is default-off", () => {
  const result = runBudgetApply({ gateEnabled: false, proposed: true });
  assert.equal(
    result.entries.some((entry) => entry.action === "closed"),
    false,
  );
  assert.match(result.entries[0]?.reason ?? "", /author PR-budget apply policy is disabled/);
});

test("author PR-budget apply keeps an under-budget author open", () => {
  const result = runBudgetApply({ openPrCount: 15, proposed: true });
  assert.equal(
    result.entries.some((entry) => entry.action === "closed"),
    false,
  );
  assert.match(result.entries[0]?.reason ?? "", /author has 15 open PRs; author PR budget is 15/);
});

test("author PR-budget apply promotes and closes an over-budget idle D-rated PR", () => {
  const result = runBudgetApply({ openPrCount: 16, rating: "D", dryRun: false });
  assert.match(
    result.entries.find((entry) => entry.action === "closed")?.reason ?? "",
    /lowest-signal PR over the author's open-PR budget/,
  );
  assert.match(result.markdown, /^close_reason: author_pr_budget_exceeded$/m);
  assert.match(result.markdown, /@reporter currently has 16 open PRs.*budget of 15/);
  assert.match(result.markdown, /Closing or finishing other PRs frees review budget/);
  assert.match(
    result.markdown,
    /reopened once the author is under budget or when real proof is added/,
  );
});

test("author PR-budget apply protects S/A/B-rated PRs with real proof", () => {
  for (const rating of ["S", "A", "B"] as const) {
    const result = runBudgetApply({ rating, proof: "sufficient", proposed: true });
    assert.equal(
      result.entries.some((entry) => entry.action === "closed"),
      false,
    );
    assert.match(
      result.entries[0]?.reason ?? "",
      /cannot close a high-quality proven pull request/,
    );
  }
});

test("author PR-budget apply protects maintainer authors and protected labels", () => {
  const maintainer = runBudgetApply({ authorAssociation: "MEMBER", proposed: true });
  assert.equal(
    maintainer.entries.some((entry) => entry.action === "closed"),
    false,
  );
  assert.match(maintainer.entries[0]?.reason ?? "", /maintainer-authored/);

  const protectedLabel = runBudgetApply({ labels: ["security"], proposed: true });
  assert.equal(
    protectedLabel.entries.some((entry) => entry.action === "closed"),
    false,
  );
  assert.match(protectedLabel.entries[0]?.reason ?? "", /protected label: security/);
});

test("author PR-budget apply protects maintainer-engaged PRs", () => {
  const result = runBudgetApply({
    proposed: true,
    comments: [
      {
        id: 9321,
        created_at: "2026-05-01T01:00:00Z",
        updated_at: "2026-05-01T01:00:00Z",
        author_association: "MEMBER",
        user: { login: "maintainer", type: "User" },
        body: "I am reviewing this one.",
      },
    ],
  });
  assert.equal(
    result.entries.some((entry) => entry.action === "closed"),
    false,
  );
  assert.match(
    result.entries[0]?.reason ?? "",
    /maintainer issue comment blocks inactivity auto-close/,
  );
});

test("author PR-budget apply fails closed on author-count API uncertainty", () => {
  const incomplete = runBudgetApply({ authorSearchIncomplete: true, proposed: true });
  assert.equal(
    incomplete.entries.some((entry) => entry.action === "closed"),
    false,
  );
  assert.match(incomplete.entries[0]?.reason ?? "", /incomplete results/);

  const failed = runBudgetApply({ authorSearchError: "search unavailable", proposed: true });
  assert.equal(
    failed.entries.some((entry) => entry.action === "closed"),
    false,
  );
  assert.match(failed.entries[0]?.reason ?? "", /author PR-budget live check failed/);
});

test("author PR-budget apply treats recent check activity as active", () => {
  const result = runBudgetApply({
    proposed: true,
    checkActivityAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(
    result.entries.some((entry) => entry.action === "closed"),
    false,
  );
  assert.match(result.entries[0]?.reason ?? "", /requires 7 days without current-head commit/);
});

test("author PR-budget apply never trims an author below the budget in one run", () => {
  const root = mkdtempSync(tmpPrefix);
  const original = {
    enabled: process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED,
    budget: process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET,
    cap: process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN,
  };
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const scripts: Record<number, string> = {};
    for (const number of [331, 332]) {
      const source = budgetCandidateReport({ number, proposed: true });
      const synced = reportWithSyncedReviewComment(source, number, "author_pr_budget_exceeded");
      writeFileSync(join(itemsDir, `${number}.md`), synced.report, "utf8");
      // Search keeps returning 16 for both candidates, simulating index lag
      // after the first same-run close. Only the projected count may block.
      scripts[number] = promotionGhMock({
        number,
        title: `Idle low-signal PR ${number}`,
        labels: [],
        authorLogin: "same-author",
        openPrCount: 16,
        comment: synced.comment,
        itemCreatedAt: "2026-05-01T00:00:00Z",
        itemUpdatedAt: "2026-05-01T00:00:00Z",
        headActivityAt: "2026-05-01T01:00:00Z",
        headCommittedAt: "2026-05-01T00:00:00Z",
        mergeable: true,
        mergeableState: "clean",
      });
    }
    const multiplexer = `
const raw = process.argv.slice(2);
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
const joined = args.join(" ");
const match = joined.match(/\\/(?:issues|pulls)\\/(331|332)(?:\\D|$)/);
const selected = match ? Number(match[1]) : 331;
const scripts = ${JSON.stringify(scripts)};
eval(scripts[selected]);
`;

    process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED = "true";
    process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET = "15";
    process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN = "5";
    withMockGh(root, multiplexer, () => {
      runApplyDecisionsForTest({
        targetRepo: "openclaw/openclaw",
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--dry-run",
          "--apply-kind",
          "pull_request",
          "--apply-close-reasons",
          "author_pr_budget_exceeded",
          "--processed-limit",
          "6",
          "--item-numbers",
          "331,332",
        ],
      });
    });

    const entries = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      action: string;
      reason: string;
    }>;
    assert.equal(entries.filter((entry) => entry.action === "closed").length, 1);
    assert.equal(
      entries.some((entry) =>
        /projected at 15 open PRs after this run's closes; author PR budget is 15/.test(
          entry.reason,
        ),
      ),
      true,
    );
  } finally {
    if (original.enabled === undefined)
      delete process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED;
    else process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED = original.enabled;
    if (original.budget === undefined) delete process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET;
    else process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET = original.budget;
    if (original.cap === undefined)
      delete process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN;
    else process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN = original.cap;
    rmSync(root, { recursive: true, force: true });
  }
});

test("author PR-budget apply enforces the per-author per-run close cap", () => {
  const root = mkdtempSync(tmpPrefix);
  const original = {
    enabled: process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED,
    budget: process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET,
    cap: process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN,
  };
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const scripts: Record<number, string> = {};
    for (const number of [321, 322]) {
      const source = budgetCandidateReport({ number, proposed: true });
      const synced = reportWithSyncedReviewComment(source, number, "author_pr_budget_exceeded");
      writeFileSync(join(itemsDir, `${number}.md`), synced.report, "utf8");
      scripts[number] = promotionGhMock({
        number,
        title: `Idle low-signal PR ${number}`,
        labels: [],
        authorLogin: "same-author",
        openPrCount: 100,
        comment: synced.comment,
        itemCreatedAt: "2026-05-01T00:00:00Z",
        itemUpdatedAt: "2026-05-01T00:00:00Z",
        headActivityAt: "2026-05-01T01:00:00Z",
        headCommittedAt: "2026-05-01T00:00:00Z",
        mergeable: true,
        mergeableState: "clean",
      });
    }
    const multiplexer = `
const raw = process.argv.slice(2);
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
const joined = args.join(" ");
const match = joined.match(/\\/(?:issues|pulls)\\/(321|322)(?:\\D|$)/);
const selected = match ? Number(match[1]) : 321;
const scripts = ${JSON.stringify(scripts)};
eval(scripts[selected]);
`;

    process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED = "true";
    process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET = "15";
    process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN = "1";
    withMockGh(root, multiplexer, () => {
      runApplyDecisionsForTest({
        targetRepo: "openclaw/openclaw",
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--dry-run",
          "--apply-kind",
          "pull_request",
          "--apply-close-reasons",
          "author_pr_budget_exceeded",
          "--processed-limit",
          "6",
          "--item-numbers",
          "321,322",
        ],
      });
    });

    const entries = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      action: string;
      reason: string;
    }>;
    assert.equal(entries.filter((entry) => entry.action === "closed").length, 1);
    assert.equal(
      entries.some((entry) => /per-run close cap of 1 reached for @same-author/.test(entry.reason)),
      true,
    );
  } finally {
    if (original.enabled === undefined)
      delete process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED;
    else process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED = original.enabled;
    if (original.budget === undefined) delete process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET;
    else process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET = original.budget;
    if (original.cap === undefined)
      delete process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN;
    else process.env.CLAWSWEEPER_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN = original.cap;
    rmSync(root, { recursive: true, force: true });
  }
});
