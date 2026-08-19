import assert from "node:assert/strict";
import test from "node:test";

import { validateFixArtifact } from "../../dist/repair/execute-fix-validation.js";

test("fix artifact validation rejects titles past the GitHub ceiling", () => {
  assert.throws(
    () =>
      validateFixArtifact({
        summary: "summary",
        pr_title: `fix: ${"a".repeat(256)}`,
        pr_body: "body",
        affected_surfaces: ["src"],
        likely_files: ["src/example.ts"],
        linked_refs: ["none"],
        validation_commands: ["pnpm check:changed"],
        credit_notes: ["ClawSweeper"],
        changelog_required: false,
        repair_strategy: "new_fix_pr",
        source_prs: [],
      }),
    /fix_artifact\.pr_title must be 256 characters or fewer/,
  );
});
