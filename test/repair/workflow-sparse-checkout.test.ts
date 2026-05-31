import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const REPAIR_PROOF_RUNTIME_PATHS = [
  "prompts/pr-close-coverage-proof.md",
  "schema/clawsweeper-pr-close-coverage-proof.schema.json",
  "src/clawsweeper-text.ts",
  "src/codex-env.ts",
  "src/pr-close-coverage-proof.ts",
] as const;

const SPARSE_REPAIR_BUILD_WORKFLOWS = [
  ".github/workflows/repair-comment-router.yml",
  ".github/workflows/spam-comment-intake.yml",
  ".github/workflows/spam-scanner.yml",
] as const;

test("sparse repair build workflows include PR close proof runtime files", () => {
  for (const workflowPath of SPARSE_REPAIR_BUILD_WORKFLOWS) {
    const workflow = fs.readFileSync(path.join(process.cwd(), workflowPath), "utf8");
    assert.match(workflow, /build-script: build:repair/);

    const entries = sparseCheckoutEntries(workflow);
    for (const requiredPath of REPAIR_PROOF_RUNTIME_PATHS) {
      assert.ok(entries.has(requiredPath), `${workflowPath} missing ${requiredPath}`);
    }
  }
});

function sparseCheckoutEntries(workflow: string): Set<string> {
  const entries = new Set<string>();
  const lines = workflow.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!/^\s+sparse-checkout:\s*\|/.test(line)) continue;

    const blockIndent = leadingSpaces(line);
    for (index += 1; index < lines.length; index += 1) {
      const entryLine = lines[index] ?? "";
      if (!entryLine.trim()) continue;
      if (leadingSpaces(entryLine) <= blockIndent) {
        index -= 1;
        break;
      }
      entries.add(entryLine.trim());
    }
  }

  return entries;
}

function leadingSpaces(value: string): number {
  return value.length - value.trimStart().length;
}
