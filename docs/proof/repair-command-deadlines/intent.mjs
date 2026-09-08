import { createHash } from "node:crypto";
import {
  acceptClusterIntakeIntent,
  CLUSTER_INTAKE_SCHEMA,
} from "../../../dist/repair/cluster-intake-state.js";
export const receiptSecret = "synthetic-deadline-receipt";
export function intent(clusterId = 42, storeSha = "a".repeat(64)) {
  const content = `---
repo: openclaw/openclaw
cluster_id: gitcrawl-${clusterId}-telegram-upload
mode: autonomous
job_intent: repair_cluster
allowed_actions:
  - comment
  - label
  - close
  - fix
  - raise_pr
blocked_actions:
  - force_push
  - bypass_checks
  - merge
require_human_for:
  - security_sensitive
  - failing_checks
  - conflicting_prs
  - unclear_canonical
  - broad_code_delta
canonical:
  - #${clusterId * 10}
candidates:
  - #${clusterId * 10}
  - #${clusterId * 10 + 1}
cluster_refs:
  - #${clusterId * 10}
  - #${clusterId * 10 + 1}
security_policy: central_security_only
security_sensitive: false
allow_instant_close: false
allow_fix_pr: true
allow_merge: false
allow_post_merge_close: true
require_fix_before_close: true
---

# Cluster ${clusterId}
`;
  return acceptClusterIntakeIntent(
    {
      schema: CLUSTER_INTAKE_SCHEMA,
      target_repo: "openclaw/openclaw",
      repo_slug: "openclaw-openclaw",
      store_sha256: storeSha,
      store_exported_at: "2026-07-26T00:00:00Z",
      manifest_path: "gitcrawl-store/data/openclaw__openclaw.sync.db.manifest.json",
      run_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
      accepted_at: "2026-07-26T00:01:00Z",
      runner: "blacksmith-4vcpu-ubuntu-2404",
      execution_runner: "blacksmith-16vcpu-ubuntu-2404",
      model: "gpt-5.4",
      selector_summary: { evaluated: 1, rejected: 0, reason_counts: {} },
      selector_decision: {
        rationale: "The cluster is narrow, current, and has a concrete validation path.",
        assessments: [
          {
            cluster_id: clusterId,
            decision: "selected",
            rationale: "The live reports describe one reproducible defect.",
            candidate_refs: [clusterId * 10, clusterId * 10 + 1],
            cluster_refs: [clusterId * 10, clusterId * 10 + 1],
          },
        ],
      },
      jobs: [
        {
          cluster_id: clusterId,
          path: `jobs/openclaw/inbox/gitcrawl-${clusterId}-telegram-upload.md`,
          content,
          digest: createHash("sha256").update(content).digest("hex"),
          dispatch_key: `cluster-intake:openclaw-openclaw:${clusterId}`,
        },
      ],
    },
    receiptSecret,
  );
}
