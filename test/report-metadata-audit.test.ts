import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { createRecordMetadata } from "../dist/clawsweeper-record-metadata.js";

import {
  auditCanonicalItemRecords,
  reportMetadataSpoofingFinding,
} from "../scripts/audit-report-metadata-spoofing.mjs";

const forgedReport = `---
fixed_release: v1
real_behavior_proof_status: sufficient
pr_rating_overall: A
---
real_behavior_proof_status: missing
pr_rating_overall: F
pr_rating_proof: F
---

## Summary

No real behavior proof was supplied.
`;

test("advisory audit still inventories body quotes that do not override runtime metadata", () => {
  const report =
    "---\nreal_behavior_proof_status: missing\n---\n\n## Summary\n\n```yaml\nreal_behavior_proof_status: sufficient\n```\n";
  assert.deepEqual(reportMetadataSpoofingFinding(report), {
    matched_keys: ["real_behavior_proof_status"],
    first_match_line: 8,
  });
  assert.equal(
    createRecordMetadata({} as never).frontMatterValue(report, "real_behavior_proof_status"),
    "missing",
  );
});

test("metadata audit flags canonical promotion keys only after the leading block", () => {
  assert.deepEqual(reportMetadataSpoofingFinding(forgedReport), {
    matched_keys: ["real_behavior_proof_status", "pr_rating_overall", "pr_rating_proof"],
    first_match_line: 6,
  });
  assert.equal(
    reportMetadataSpoofingFinding(
      "---\nreal_behavior_proof_status: missing\npr_rating_overall: F\n---\n\n## Summary\n",
    ),
    null,
  );
  assert.equal(reportMetadataSpoofingFinding("real_behavior_proof_status: sufficient\n"), null);
});

test("metadata audit emits a bounded sanitized canonical-record inventory", async () => {
  const maxRecords = [];
  const inventory = await auditCanonicalItemRecords({
    baseUrl: "https://records.invalid",
    webhookSecret: "test-secret",
    repoSlugs: ["openclaw-openclaw", "openclaw-clawsweeper"],
    maxRecords: 5,
    now: new Date("2026-08-06T12:00:00.000Z"),
    exportRecords: async ({ repoSlug, maxRecords: remaining }) => {
      maxRecords.push(remaining);
      return {
        repoSlug,
        revision: 1,
        records:
          repoSlug === "openclaw-clawsweeper"
            ? [
                {
                  section: "items",
                  id: "1049",
                  content: forgedReport,
                  digest: "unused",
                  revision: 1,
                  storeRevision: 1,
                  deleted: false,
                },
                {
                  section: "items",
                  id: "951",
                  content: null,
                  digest: null,
                  revision: 1,
                  storeRevision: 1,
                  deleted: true,
                },
              ]
            : [
                {
                  section: "items",
                  id: "1",
                  content: "---\npr_rating_overall: F\n---\n",
                  digest: "unused",
                  revision: 1,
                  storeRevision: 1,
                  deleted: false,
                },
              ],
      };
    },
  });

  assert.deepEqual(maxRecords, [5, 3]);
  assert.deepEqual(inventory, {
    schema_version: 1,
    generated_at: "2026-08-06T12:00:00.000Z",
    repo_slugs: ["openclaw-clawsweeper", "openclaw-openclaw"],
    scanned_records: 3,
    finding_count: 1,
    findings: [
      {
        repo_slug: "openclaw-clawsweeper",
        item_number: 1049,
        matched_keys: ["real_behavior_proof_status", "pr_rating_overall", "pr_rating_proof"],
        first_match_line: 6,
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(inventory), /No real behavior proof|test-secret/);
});

test("metadata audit enforces its global record bound", async () => {
  await assert.rejects(
    auditCanonicalItemRecords({
      baseUrl: "https://records.invalid",
      webhookSecret: "test-secret",
      repoSlugs: ["openclaw-clawsweeper"],
      maxRecords: 1,
      exportRecords: async () => ({
        repoSlug: "openclaw-clawsweeper",
        revision: 1,
        records: [
          { section: "items", id: "1", content: "", deleted: false },
          { section: "items", id: "2", content: "", deleted: false },
        ],
      }),
    }),
    /exceeded the 1-record bound/,
  );
});

test("report metadata audit workflow is dispatch-only and read-only", () => {
  const source = readFileSync(".github/workflows/report-metadata-audit.yml", "utf8");
  const workflow = parse(source);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.match(source, /actions\/checkout@v7/);
  assert.match(source, /\.\/\.github\/actions\/setup-pnpm/);
  assert.match(source, /CLAWSWEEPER_WEBHOOK_SECRET/);
  assert.match(source, /CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL/);
  assert.match(source, /actions\/upload-artifact@v6/);
  assert.doesNotMatch(source, /(?:permissions:[\s\S]*?)(?:write|id-token)/);
});
