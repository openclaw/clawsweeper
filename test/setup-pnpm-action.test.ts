import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const action = parse(readFileSync(".github/actions/setup-pnpm/action.yml", "utf8"));
const storeStep = action.runs.steps.find((step: { id?: string }) => step.id === "pnpm-store");

for (const exitCode of [0, 23]) {
  test(
    `pnpm store resolution preserves ${exitCode === 0 ? "paths with spaces" : "failure status and stderr"}`,
    { skip: process.platform === "win32" },
    () => {
      const root = mkdtempSync(join(tmpdir(), "clawsweeper-pnpm-store-"));
      const output = join(root, "output");
      const storePath = join(root, "store with spaces");
      try {
        writeFileSync(output, "existing=value\n");
        writeFileSync(
          join(root, "pnpm"),
          `#!/bin/bash\n[ "$*" = "store path --silent" ] || exit 99\nprintf '%s\\n' "$PNPM_TEST_STORE"\nprintf '%s\\n' 'pnpm diagnostic' >&2\nexit ${exitCode}\n`,
          { mode: 0o755 },
        );
        assert.equal(storeStep.shell, "bash");
        const result = spawnSync(
          "/bin/bash",
          [
            "--noprofile",
            "--norc",
            "-eo",
            "pipefail",
            "-c",
            `${storeStep.run}\nprintf 'continued\\n'`,
          ],
          {
            encoding: "utf8",
            env: {
              PATH: `${root}:/usr/bin:/bin`,
              GITHUB_OUTPUT: output,
              PNPM_TEST_STORE: storePath,
            },
          },
        );
        assert.equal(result.status, exitCode, result.stderr);
        assert.equal(result.stderr, "pnpm diagnostic\n");
        assert.equal(result.stdout, exitCode === 0 ? "continued\n" : "");
        assert.equal(
          readFileSync(output, "utf8"),
          exitCode === 0 ? `existing=value\npath=${storePath}\n` : "existing=value\n",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
