import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parse } from "yaml";

type CompositeAction = {
  runs?: {
    steps?: Array<{ if?: string; name?: string; run?: string }>;
  };
};

test(
  "hosted Linux sandbox preflight propagates Codex startup failures",
  { skip: process.platform === "win32" ? "requires Bash" : false },
  () => {
    const action = parse(readFileSync(".github/actions/setup-codex/action.yml", "utf8")) as
      | CompositeAction
      | undefined;
    const step = action?.runs?.steps?.find(
      (candidate) => candidate.name === "Enable Linux user namespaces for bubblewrap",
    );

    assert.equal(step?.if, "${{ runner.os == 'Linux' && runner.environment == 'github-hosted' }}");
    assert.ok(step?.run);

    const root = mkdtempSync(join(tmpdir(), "clawsweeper-codex-sandbox-preflight-"));
    const bin = join(root, "bin");
    const codex = join(bin, "codex");
    const sysctl = join(bin, "sysctl");

    try {
      mkdirSync(bin);
      writeFileSync(sysctl, "#!/bin/bash\nexit 1\n", { mode: 0o755 });
      writeFileSync(codex, "#!/bin/bash\nexit 23\n", { mode: 0o755 });

      const result = spawnSync("/bin/bash", ["-c", step.run], {
        cwd: root,
        env: {
          ...process.env,
          GITHUB_WORKSPACE: root,
          PATH: `${bin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });

      assert.equal(result.status, 23, result.stderr);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);
