import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

test("Pages reruns upload and deploy a run-attempt-scoped artifact", () => {
  const job = parse(readFileSync(".github/workflows/pages.yml", "utf8")).jobs.deploy as {
    env: Record<string, string>;
    steps: Array<{ uses?: string; with?: Record<string, string> }>;
  };
  assert.equal(job.env.PAGES_ARTIFACT_NAME, "github-pages-${{ github.run_attempt }}");
  const name = "${{ env.PAGES_ARTIFACT_NAME }}";
  const upload = job.steps.find((step) => step.uses === "actions/upload-pages-artifact@v5");
  const deploy = job.steps.find((step) => step.uses === "actions/deploy-pages@v5");
  assert.equal(upload?.with?.name, name);
  assert.equal(deploy?.with?.artifact_name, name);
});
