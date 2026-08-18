import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type { LiveProofPlan } from "../dist/clawsweeper-types.js";
import { executeReviewLiveProofs } from "../dist/live-proof/review-artifacts.js";
import { parseLiveVerificationResult } from "../dist/live-proof/verification.js";

test(
  "review live proof runs an unsandboxed static plan with a sanitized child environment",
  { timeout: 60_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-review-"));
    const target = join(root, "target");
    const records = join(root, "records");
    const output = join(root, "output");
    mkdirSync(target);
    mkdirSync(records);
    const plan: LiveProofPlan = {
      status: "recommended",
      surface: "terminal",
      reason: "The command prints a deterministic result.",
      payoff: { kind: "static_text", justification: "A recording adds no value." },
      entry:
        "test ! -e install-script-ran && test -z \"${OPENAI_API_KEY-}${GH_TOKEN-}${AWS_SECRET_ACCESS_KEY-}${CLAWSWEEPER_R2_TOKEN-}${DATABASE_PASSWORD-}${PACKAGE_KEY-}\" && printf 'sanitized-ready\\n'",
      steps: [{ action: "expect_output", text: "sanitized-ready" }],
    };
    try {
      writeFileSync(
        join(target, "package.json"),
        `${JSON.stringify({
          name: "sanitized-fixture",
          private: true,
          scripts: {
            preinstall:
              "node -e \"require('node:fs').writeFileSync('install-script-ran', 'unsafe')\"",
          },
        })}\n`,
      );
      writeFileSync(
        join(target, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n",
      );
      git(target, "init", "-b", "main");
      git(target, "config", "user.name", "ClawSweeper Test");
      git(target, "config", "user.email", "test@example.com");
      git(target, "add", ".");
      git(target, "commit", "-m", "fixture");
      const head = git(target, "rev-parse", "HEAD").trim();
      writeFileSync(
        join(records, "42.md"),
        `---\nnumber: 42\nrepository: openclaw/sanitized-fixture\ntype: pull_request\npull_head_sha: ${head}\n---\n\n## Live Proof\n\nStatus: recommended\n\nSurface: terminal\n\nReason: The command prints a deterministic result.\n\nPayoff: static_text\n\nPayoff justification: A recording adds no value.\n\nEntry: ${plan.entry}\n\nSteps:\n\n- {"action":"expect_output","text":"sanitized-ready"}\n\n## Work Candidate\n\nCandidate: none\n`,
      );
      const logs: string[] = [];
      executeReviewLiveProofs(
        {
          checkoutPath: target,
          entrypoint: resolve("dist/clawsweeper.js"),
          itemNumbers: [42],
          outputRoot: output,
          recordsDir: records,
          repo: "openclaw/sanitized-fixture",
        },
        {
          env: {
            ...process.env,
            OPENAI_API_KEY: "must-not-cross",
            GH_TOKEN: "must-not-cross",
            AWS_SECRET_ACCESS_KEY: "must-not-cross",
            CLAWSWEEPER_R2_TOKEN: "must-not-cross",
            DATABASE_PASSWORD: "must-not-cross",
            PACKAGE_KEY: "must-not-cross",
          },
          frontMatterValue: (markdown, key) =>
            new RegExp(`^${key}:\\s*(.*)$`, "m").exec(markdown)?.[1]?.trim(),
          reportLiveProofPlan: () => plan,
          repositoryProfileFor: () => ({
            targetRepo: "openclaw/sanitized-fixture",
            slug: "openclaw-sanitized-fixture",
            displayName: "fixture",
            checkoutDir: "fixture",
            promptNote: "fixture",
            applyCloseRules: {},
            liveTest: {
              enabled: true,
              surfaceDefault: "terminal",
              setup: ["pnpm install --frozen-lockfile"],
              allowInstallScripts: false,
              readyTimeoutSeconds: 10,
              maxRecordingSeconds: 90,
            },
          }),
          log: (message) => logs.push(message),
        },
      );

      const verification = parseLiveVerificationResult(
        JSON.parse(readFileSync(join(output, "42", "live-verification.json"), "utf8")) as unknown,
      );
      assert.equal(verification.overall_pass, true, JSON.stringify(verification));
      assert.equal(verification.output.includes("sanitized-ready"), true);
      assert.match(logs.join("\n"), /sanitized environment assertion passed: credentials=0/);
      assert.match(logs.join("\n"), /execution=unsandboxed credentials=0/);
      assert.equal(logs.join("\n").includes("must-not-cross"), false);
      console.log(logs.join("\n"));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
