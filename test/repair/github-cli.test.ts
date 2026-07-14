import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ghPagedLimit,
  githubLimitedPagePath,
  githubPaginatedPath,
} from "../../dist/repair/github-cli.js";
import { withMockGh } from "../helpers.ts";

test("githubPaginatedPath requests maximum REST page size by default", () => {
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues/123/comments"),
    "repos/openclaw/openclaw/issues/123/comments?per_page=100",
  );
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues?state=open&sort=created"),
    "repos/openclaw/openclaw/issues?state=open&sort=created&per_page=100",
  );
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues?per_page=50&state=open"),
    "repos/openclaw/openclaw/issues?per_page=50&state=open",
  );
});

test("githubLimitedPagePath caps one REST page and preserves existing filters", () => {
  assert.equal(
    githubLimitedPagePath("repos/openclaw/openclaw/pulls/123/files", 80),
    "repos/openclaw/openclaw/pulls/123/files?per_page=80&page=1",
  );
  assert.equal(
    githubLimitedPagePath(
      "repos/openclaw/openclaw/pulls/123/files?state=open&per_page=100",
      250,
      3,
    ),
    "repos/openclaw/openclaw/pulls/123/files?state=open&per_page=100&page=3",
  );
  assert.equal(
    githubLimitedPagePath("repos/openclaw/openclaw/pulls/123/files", 0, 0),
    "repos/openclaw/openclaw/pulls/123/files?per_page=1&page=1",
  );
});

test("ghPagedLimit accepts legacy slurp-shaped single-page responses", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-github-cli-"));
  try {
    withMockGh(
      root,
      `#!/usr/bin/env node
const path = process.argv[3] || "";
if (path.includes("page=1")) {
  console.log(JSON.stringify([[{ id: 1 }, { id: 2 }]]));
} else {
  console.log(JSON.stringify([[]]));
}
`,
      () => {
        assert.deepEqual(ghPagedLimit<{ id: number }>("repos/example/repo/pulls/1/files", 3), [
          { id: 1 },
          { id: 2 },
        ]);
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
