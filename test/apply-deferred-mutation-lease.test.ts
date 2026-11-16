import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  itemSourceRevisionSha256,
  reviewTimelineDigestParts,
} from "../dist/clawsweeper-source-revision.js";
import { sha256 } from "../dist/content-hash.js";
import { stableJson } from "../dist/stable-json.js";
import {
  readText,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  withMockGh,
  workPlanCandidateReport,
} from "./helpers.ts";

// Shape of openclaw/openclaw#191008: a current-tuple close proposal that apply keeps open
// because a maintainer decision is required. Deleting apply's own lease comment moves the
// item's updated_at with no live trace, so every visit that posted one read as source drift
// on the next visit and requeued a full review, about once an hour.
const maintainerDecision = {
  required: true,
  kind: "product_direction",
  question: "Should a maintainer sponsor this feature direction?",
  rationale: "Core implementation needs an explicit product owner.",
  options: [
    {
      title: "Sponsor",
      body: "Keep the request open with a maintainer owner.",
      recommended: false,
    },
    {
      title: "Leave unsponsored",
      body: "Close until a maintainer sponsors the direction.",
      recommended: true,
    },
  ],
  likelyOwner: {
    person: "@alice",
    reason: "Recent history shows ownership of this product area.",
    confidence: "high",
  },
};

function applyTwice(triagePriority?: string) {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const statePath = join(root, "gh-state.json");
    const logPath = join(root, "gh.log");
    for (const d of [itemsDir, closedDir, plansDir]) mkdirSync(d, { recursive: true });
    const reviewedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const issueBase = {
      number: 321,
      title: "Kept-open close proposal",
      body: "Reported behavior.",
      html_url: "https://github.com/openclaw/openclaw/issues/321",
      created_at: "2026-05-01T00:00:00Z",
      updated_at: reviewedAt.replace(/\.\d+Z$/, "Z"),
      closed_at: null,
      state: "open",
      locked: false,
      active_lock_reason: null,
      author_association: "CONTRIBUTOR",
      user: { login: "reporter" },
      labels: [],
      assignees: [],
      milestone: null,
      comments: 1,
      pull_request: null,
    };
    const report = `${workPlanCandidateReport(
      {
        repository: "openclaw/openclaw",
        number: 321,
        title: issueBase.title,
        type: "issue",
        decision: "close",
        action_taken: "proposed_close",
        close_reason: "unsponsored_feature_request",
        confidence: "high",
        work_candidate: "none",
        work_status: "none",
        item_snapshot_hash: "reviewed-snapshot",
        item_created_at: issueBase.created_at,
        item_updated_at: issueBase.updated_at,
        reviewed_at: reviewedAt,
        item_source_revision: itemSourceRevisionSha256(issueBase, []),
        review_timeline_revision: sha256(stableJson(reviewTimelineDigestParts([]))),
        review_lease_owner: "completed-review",
        review_lease_comment_id: "700321",
        author_association: "CONTRIBUTOR",
        item_category: "feature",
        requires_product_decision: "true",
        maintainer_decision: JSON.stringify(maintainerDecision),
        ...(triagePriority ? { triage_priority: triagePriority } : {}),
      },
      {
        itemCategory: "feature",
        requiresProductDecision: true,
        maintainerDecision,
        closeComment: "Not planned.",
      },
    )}\n\n## Evidence\n\n- **direction:** unsponsored.\n\n## Close Comment\n\nNot planned.\n`;
    const synced = reportWithSyncedReviewComment(report, 321, "unsponsored_feature_request");
    writeFileSync(
      join(itemsDir, "321.md"),
      synced.report.replaceAll("openclaw/clawsweeper/issues/321", "openclaw/openclaw/issues/321"),
    );
    const durable = {
      id: 9321,
      html_url: "https://github.com/openclaw/openclaw/issues/321#issuecomment-9321",
      created_at: issueBase.updated_at,
      updated_at: issueBase.updated_at,
      author_association: "NONE",
      user: { login: "clawsweeper[bot]", type: "Bot" },
      body: synced.comment,
    };
    writeFileSync(statePath, JSON.stringify({ issue: issueBase, comments: [durable], tick: 0 }));
    // Stateful GitHub: a comment POST or DELETE moves the issue's updated_at, as GitHub does.
    const ghMock = `
const fs = require("fs");
const raw = process.argv.slice(2);
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
const st = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));
const save = () => fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(st));
const now = () => { st.tick += 1; return new Date(Date.now() + st.tick * 1000).toISOString().replace(/\\.\\d+Z$/, "Z"); };
const include = args.includes("-i") || args.includes("--include");
const path = args.find((arg, index) => index > 0 && /^(repos|search)\\//.test(arg)) || "";
const mi = args.findIndex((a) => a === "-X" || a === "--method");
const method = mi >= 0 ? args[mi + 1].toUpperCase() : "GET";
const out = (v) => console.log(include ? "HTTP/2 200\\n\\n" + JSON.stringify(v) : JSON.stringify(v));
const bodyArg = () => { const i = args.findIndex((a) => a === "-f" || a === "--raw-field" || a === "-F" || a === "--field"); if (i >= 0) return args[i+1].replace(/^body=/, ""); const j = args.indexOf("--input"); if (j >= 0) { const t = fs.readFileSync(args[j+1] === "-" ? 0 : args[j+1], "utf8"); try { return JSON.parse(t).body; } catch { return t; } } return ""; };
if (args[0] !== "api") { console.log(args[0] === "issue" && args[1] === "view" ? JSON.stringify({ closedByPullRequestsReferences: [] }) : ""); process.exit(0); }
if (path.startsWith("search/issues")) { out({ items: [] }); }
else if (/issues\\/321\\/timeline/.test(path)) { out(include ? [] : [[]]); }
else if (/issues\\/321\\/comments/.test(path) && method === "POST") {
  const at = now(); const c = { id: 800000 + st.tick, html_url: "x#issuecomment-" + (800000 + st.tick), created_at: at, updated_at: at, author_association: "NONE", user: { login: "clawsweeper[bot]", type: "Bot" }, body: bodyArg() };
  st.comments.push(c); st.issue.updated_at = at; st.issue.comments = st.comments.length; save(); out(c);
}
else if (/issues\\/321\\/comments/.test(path)) { out(args.includes("--paginate") || args.includes("--slurp") ? [st.comments] : st.comments); }
else if (/issues\\/comments\\/(\\d+)$/.test(path)) {
  const id = Number(path.match(/(\\d+)$/)[1]); const c = st.comments.find((x) => x.id === id);
  if (method === "DELETE") { const at = now(); st.comments = st.comments.filter((x) => x.id !== id); st.issue.updated_at = at; st.issue.comments = st.comments.length; save(); fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(["DELETED", id, at]) + "\\n"); console.log(""); }
  else if (method === "PATCH") { c.body = bodyArg(); c.updated_at = now(); save(); out(c); }
  else if (!c) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); } else out(c);
}
else if (/issues\\/321$/.test(path) && method === "GET") { out(st.issue); }
else if (/repos\\/openclaw\\/openclaw\\/labels/.test(path)) { out(include ? [] : [[]]); }
else if (method !== "GET") { out({}); }
else { fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(["UNHANDLED", args]) + "\\n"); out({}); }
`;
    const results: Array<Array<{ action: string; reason: string }>> = [];
    const original = process.env.CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED;
    process.env.CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED = "true";
    try {
      for (let visit = 0; visit < 2; visit += 1) {
        withMockGh(root, ghMock, () => {
          runApplyDecisionsForTest({
            itemsDir,
            closedDir,
            plansDir,
            reportPath,
            extraArgs: [
              "--target-repo",
              "openclaw/openclaw",
              "--apply-close-reasons",
              "all",
              "--apply-kind",
              "issue",
              "--item-number",
              "321",
              "--processed-limit",
              "1",
              "--skip-dashboard",
            ],
          });
        });
        results.push(JSON.parse(readText(reportPath)));
      }
    } finally {
      if (original === undefined) delete process.env.CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED;
      else process.env.CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED = original;
    }
    const writes = readText(logPath)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
      .filter(
        (args) =>
          args.includes("POST") ||
          args.includes("DELETE") ||
          args.includes("PATCH") ||
          args[0] === "label" ||
          (args[0] === "issue" && args[1] !== "view"),
      )
      .map((args) => args.slice(0, 4).join(" "));
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return {
      results,
      writes,
      updatedAt: state.issue.updated_at,
      reviewedUpdatedAt: issueBase.updated_at,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a kept-open visit writes nothing to GitHub, so the next visit sees no drift", () => {
  const run = applyTwice();
  assert.deepEqual(run.writes, []);
  assert.equal(run.updatedAt, run.reviewedUpdatedAt);
  for (const result of run.results) {
    assert.deepEqual(
      result.map((entry) => entry.action),
      ["kept_open"],
    );
    assert.match(result[0]!.reason, /^maintainer decision required/);
  }
});

test("a visit that writes posts apply's lease before its first write and deletes it after", () => {
  const writes = applyTwice("P1").writes;
  const lease = writes.indexOf("api repos/openclaw/openclaw/issues/321/comments --method POST");
  const label = writes.indexOf("issue edit 321 --add-label");
  const release = writes.findIndex((write) =>
    /^api repos\/openclaw\/openclaw\/issues\/comments\/\d+ --method DELETE$/.test(write),
  );
  assert.ok(lease >= 0 && label > lease && release > label, writes.join("\n"));
});
