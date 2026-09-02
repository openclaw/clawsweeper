import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkDocumentation } from "../scripts/check-docs.mjs";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-docs-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ scripts: { check: "node check.js" } }),
    "README.md": [
      "# Home",
      "",
      "[Guide](docs/guide.md#operation)",
      "[Punctuation](docs/guide.md#foo--bar)",
      "[Reference][guide-ref]",
      "[guide-ref]: docs/guide.md#foo--bar",
      "[Parentheses](docs/API_(legacy).md)",
      "[Rendered heading](docs/guide.md#linked-operations)",
      "[Setext heading](docs/guide.md#setext-operation-continuation)",
      "[Underscore heading](docs/guide.md#stalled_unproven_pr)",
      "[Directory heading](docs/#documentation-home)",
      "[Explicit anchor](docs/guide.md#MixedCase)",
      "[Escaped HTML-like heading](docs/guide.md#inline-span-html)",
      "[Custom URI scheme](web+clawsweeper://review/123)",
      "[Hyphenated URI scheme](x-devonthink-item:ABC123)",
      "`[Literal](docs/missing.md)`",
      "``[Literal `tick`](docs/missing.md)``",
      "```markdown",
      "[Example][missing]",
      "[missing]: docs/missing.md",
      "```",
      "",
      "    [Indented example](docs/missing.md)",
      "",
      "`pnpm run check`",
      "`pnpm --silent run check`",
      "`pnpm --filter dashboard run build`",
      "`pnpm -C dashboard test`",
      "`pnpm audit`",
      "`pnpm env use --global 24`",
      "`pnpm outdated`",
      "`pnpm prune`",
      "",
      "`scripts/example.mjs`",
      "",
      "`gh workflow run ci.yml`",
    ].join("\n"),
    "docs/guide.md":
      '# Operation\n\n<a id="MixedCase"></a>\n\n[Root](/README.md)\n\n## Foo & Bar\n\n## [Linked Operations](#operation)\n\n## `stalled_unproven_pr`\n\n## Inline &lt;span&gt; HTML\n\nSetext Operation\ncontinuation\n----------------\n\n~~~markdown\n## Example Only\n~~~\n\nCapacity is 50.\n\n# implemented\n',
    "docs/README.md": "# Documentation Home\n",
    "docs/API_(legacy).md": "# Legacy API\n",
    "docs/live-dashboard.md":
      "# Dashboard\n\nqueued runs from 30 through 1440 minutes old degrade operational health. queued runs older than 1440 minutes are reported separately as zombies. pre-queue pending reruns older than 60 minutes are reported separately as wedged. in-progress runs become stalled after 150 minutes. `zombie_queued_runs` `oldest_zombie_queued_minutes` `wedged_rerun_runs` `oldest_wedged_rerun_minutes` `approval_gated_runs` `oldest_approval_gated_minutes`\n",
    "docs/public-api.md": "# Public API\n",
    "docs/operator-configuration.md": "# Operator configuration\n",
    "scripts/example.mjs": "export {};\n",
    ".github/workflows/ci.yml": "name: CI\n",
    "dashboard/wrangler.toml": 'CAPACITY = "50"\n',
    "dashboard/operational-health.ts": [
      "export const OPERATIONAL_QUEUE_DEGRADED_MS = 30 * 60 * 1000;",
      "export const OPERATIONAL_WEDGED_RERUN_MS = 60 * 60 * 1000;",
      "export const OPERATIONAL_QUEUE_ZOMBIE_MS = 24 * 60 * 60 * 1000;",
      "export const OPERATIONAL_RUNNING_STALLED_MS = 150 * 60 * 1000;",
      "export type OperationalHealth = {",
      "  zombie_queued_runs: number;",
      "  oldest_zombie_queued_minutes: number;",
      "  wedged_rerun_runs: number;",
      "  oldest_wedged_rerun_minutes: number;",
      "  approval_gated_runs: number;",
      "  oldest_approval_gated_minutes: number;",
      "};",
    ].join("\n"),
    "dashboard/worker.ts": "export {};\n",
    "config/targets.json": JSON.stringify({ close: { issue: "implemented" } }),
    "config/documentation-sync.json": JSON.stringify({
      version: 1,
      sources: [
        {
          path: "dashboard/wrangler.toml",
          expect: { CAPACITY: "50" },
          claims: [{ document: "docs/guide.md", text: "Capacity is {{CAPACITY}}." }],
        },
        {
          path: "config/targets.json",
          claims: [{ document: "docs/guide.md", text: "# {{close.issue}}" }],
        },
      ],
    }),
    "config/documentation-site.json": JSON.stringify({
      version: 1,
      sections: [
        {
          name: "Docs",
          pages: [
            "README.md",
            "API_(legacy).md",
            "guide.md",
            "live-dashboard.md",
            "public-api.md",
            "operator-configuration.md",
          ],
        },
      ],
      noncanonical: [],
    }),
    "config/operator-documentation.json": JSON.stringify({
      version: 1,
      publicObserverRoutes: [],
      auditedDashboardVariables: [],
      auditedWorkflowSecrets: [],
    }),
  };
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return root;
}

function withFixture(run: (root: string) => void): void {
  const root = fixture();
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepts synchronized documentation references", () => {
  withFixture((root) => assert.deepEqual(checkDocumentation(root), []));
});

test("reports unclassified and multiply classified documentation pages", () => {
  withFixture((root) => {
    writeFileSync(join(root, "docs/unclassified.md"), "# Unclassified\n");
    const manifest = JSON.parse(String(readFileSync(join(root, "config/documentation-site.json"))));
    manifest.noncanonical.push({ path: "guide.md", lifecycle: "historical", banner: "Old" });
    writeFileSync(join(root, "config/documentation-site.json"), JSON.stringify(manifest));
    const findings = checkDocumentation(root).filter(
      (finding) => finding.kind === "docs-lifecycle",
    );
    assert.ok(findings.some((finding) => finding.message.includes("unclassified.md has no")));
    assert.ok(findings.some((finding) => finding.message.includes("guide.md has multiple")));
  });
});

test("reports operational health documentation drift", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "dashboard/operational-health.ts"),
      [
        "export const OPERATIONAL_QUEUE_DEGRADED_MS = 31 * 60 * 1000;",
        "export const OPERATIONAL_QUEUE_ZOMBIE_MS = 24 * 60 * 60 * 1000;",
        "export const OPERATIONAL_RUNNING_STALLED_MS = 150 * 60 * 1000;",
      ].join("\n"),
    );
    const findings = checkDocumentation(root);
    assert.ok(findings.some((finding) => finding.kind === "operational-health-claim"));
  });
});

test("reports documented operational health fields missing from the runtime type", () => {
  withFixture((root) => {
    const sourcePath = join(root, "dashboard/operational-health.ts");
    writeFileSync(
      sourcePath,
      String(readFileSync(sourcePath)).replace("  oldest_approval_gated_minutes: number;\n", ""),
    );
    const findings = checkDocumentation(root);
    assert.ok(
      findings.some(
        (finding) =>
          finding.kind === "operational-health-source" &&
          finding.message.includes("oldest_approval_gated_minutes"),
      ),
    );
  });
});

test("accepts the full URI scheme syntax for external links", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "README.md"),
      "[Plus](web+clawsweeper://review/123)\n[Dot](x.dev-item:ABC123)\n[Hyphen](x-devonthink-item:ABC123)\n",
    );
    assert.deepEqual(checkDocumentation(root), []);
  });
});

test("reports wrong-case links and missing anchors", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "README.md"),
      "[Case](docs/Guide.md)\n[Anchor](docs/guide.md#missing)\n[Anchor case](docs/guide.md#Operation)\n[Fence](docs/guide.md#example-only)\n",
    );
    const findings = checkDocumentation(root);
    assert.ok(
      findings.some(
        (finding) => finding.kind === "link" && finding.message.includes("actual: docs/guide.md"),
      ),
    );
    assert.ok(
      findings.some((finding) => finding.kind === "anchor" && finding.message.includes("#missing")),
    );
    assert.ok(
      findings.some(
        (finding) => finding.kind === "anchor" && finding.message.includes("#example-only"),
      ),
    );
  });
});

test("reports multiline links and unused definitions at their source lines", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "README.md"),
      "Paragraph text\n[Case](docs/Guide.md)\n\nMore text\n\n[unused]: docs/missing.md\n",
    );
    const findings = checkDocumentation(root).filter((finding) => finding.kind === "link");
    assert.deepEqual(
      findings.map((finding) => finding.line),
      [2, 6],
    );
  });
});

test("does not create Setext anchors from non-paragraph blocks", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "README.md"),
      "[List](docs/guide.md#list-item)\n[Quote](docs/guide.md#quote)\n[Code](docs/guide.md#code)\n[HTML](docs/guide.md#not-a-heading)\n",
    );
    writeFileSync(
      join(root, "docs/guide.md"),
      "- List item\n---\n\n> Quote\n===\n\n    Code\n---\n\n<div>\nNot a heading\n---\n</div>\n",
    );
    const findings = checkDocumentation(root).filter((finding) => finding.kind === "anchor");
    assert.equal(findings.length, 4);
  });
});

test("reports wrong-case reference definitions and encoded missing targets", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "README.md"),
      "[Case][guide]\n\n[guide]: docs/Guide.md\n[Escape](docs/100%-coverage.md)\n",
    );
    const findings = checkDocumentation(root);
    assert.ok(
      findings.some(
        (finding) => finding.kind === "link" && finding.message.includes("actual: docs/guide.md"),
      ),
    );
    assert.ok(
      findings.some(
        (finding) => finding.kind === "link" && finding.message.includes("100%-coverage.md"),
      ),
    );
  });
});

test("resumes link validation after a closed code fence", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "README.md"),
      "```markdown\n[Ignored](docs/missing.md)\n```\n[After](docs/Guide.md)\n",
    );
    const findings = checkDocumentation(root);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "link");
    assert.match(findings[0].message, /actual: docs\/guide\.md/);
  });
});

test("reports malformed and unclosed fenced code blocks", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "README.md"),
      "````yaml\nname: Outer\n```yaml\nname: Nested\n````\n\n```text\nunclosed\n",
    );
    const findings = checkDocumentation(root).filter(
      (finding) => finding.kind === "markdown-fence",
    );
    assert.ok(findings.some((finding) => finding.message.includes("exactly three")));
    assert.ok(findings.some((finding) => finding.message.includes("starts before")));
    assert.ok(findings.some((finding) => finding.message.includes("not closed")));
  });
});

test("preserves UTF-16 offsets around inline code", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "README.md"),
      "🦞 `[Ignored](docs/missing.md)` [After](docs/Guide.md)\n",
    );
    const findings = checkDocumentation(root);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "link");
    assert.match(findings[0].message, /actual: docs\/guide\.md/);
  });
});

test("reports nonexistent scripts, workflows, and repository paths", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "README.md"),
      "`pnpm run missing`\n``pnpm run missing-double `option` ``\n`gh workflow run absent.yml`\n`scripts/absent.mjs`\n~~~sh\npnpm run missing-tilde\n~~~\n\n    pnpm run missing-indented\n",
    );
    const kinds = new Set(checkDocumentation(root).map((finding) => finding.kind));
    assert.ok(kinds.has("pnpm-script"));
    assert.ok(kinds.has("workflow"));
    assert.ok(kinds.has("path"));
  });
});

test("keeps pnpm lifecycle aliases subject to script validation", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "README.md"),
      "`pnpm start`\n`pnpm test`\n`pnpm t`\n`pnpm it`\n`pnpm install-test`\n",
    );
    const findings = checkDocumentation(root).filter((finding) => finding.kind === "pnpm-script");
    assert.equal(findings.length, 5);
    assert.match(findings[0].message, /start/);
    assert.ok(findings.slice(1).every((finding) => finding.message.includes("test")));
  });
});

test("does not accept unrelated untracked files as repository paths", () => {
  withFixture((root) => {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    writeFileSync(join(root, "scripts/untracked.mjs"), "export {};\n");
    writeFileSync(join(root, "docs/untracked.md"), "[Broken](missing.md)\n");
    writeFileSync(join(root, "README.md"), "`scripts/untracked.mjs`\n");
    const findings = checkDocumentation(root);
    assert.ok(
      findings.some(
        (finding) => finding.kind === "path" && finding.message.includes("untracked.mjs"),
      ),
    );
  });
});

test("reports config-derived prose that no longer matches its source", () => {
  withFixture((root) => {
    writeFileSync(join(root, "dashboard/wrangler.toml"), 'CAPACITY = "51"\n');
    const findings = checkDocumentation(root);
    assert.ok(
      findings.some(
        (finding) => finding.kind === "config-claim" && finding.message.includes("Capacity is 51."),
      ),
    );
  });
});

test("reports public observer route and operator configuration drift", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "dashboard/worker.ts"),
      'if (url.pathname === "/api/new-observer") return statusJson();\n',
    );
    writeFileSync(join(root, "dashboard/wrangler.toml"), 'CAPACITY = "50"\nKNOWN = "1"\n');
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(root, ".github/workflows/operator.yml"),
      "name: Operator\nenv:\n  TOKEN: ${{ secrets.KNOWN_SECRET }}\n",
    );
    writeFileSync(join(root, "docs/operator-configuration.md"), "# Config\n");
    const manifest = {
      version: 1,
      publicObserverRoutes: [{ path: "/api/stale", method: "GET" }],
      auditedDashboardVariables: ["KNOWN"],
      auditedWorkflowSecrets: ["KNOWN_SECRET"],
    };
    writeFileSync(join(root, "config/operator-documentation.json"), JSON.stringify(manifest));
    const findings = checkDocumentation(root);
    assert.ok(
      findings.some((finding) =>
        finding.message.includes("missing public route /api/new-observer"),
      ),
    );
    assert.ok(
      findings.some((finding) => finding.message.includes("stale public route /api/stale")),
    );
    assert.ok(
      findings.some((finding) => finding.message.includes("missing dashboard variable KNOWN")),
    );
    assert.ok(
      findings.some((finding) => finding.message.includes("missing workflow secret KNOWN_SECRET")),
    );
  });
});

test("reports observer route method drift", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "dashboard/worker.ts"),
      'if (url.pathname === "/api/status") return statusJson();\n',
    );
    writeFileSync(
      join(root, "docs/public-api.md"),
      "# Public API\n\n| Route | Method |\n| --- | --- |\n| `/api/status` | `GET`  |\n",
    );
    const manifest = {
      version: 1,
      publicObserverRoutes: [{ path: "/api/status", method: "GET" }],
      auditedDashboardVariables: [],
      auditedWorkflowSecrets: [],
    };
    writeFileSync(join(root, "config/operator-documentation.json"), JSON.stringify(manifest));
    const findings = checkDocumentation(root);
    assert.ok(
      findings.some((finding) =>
        finding.message.includes("method drift for /api/status: expected ANY, found GET"),
      ),
    );
  });
});

test("reports API table routes missing from the checked inventory", () => {
  withFixture((root) => {
    writeFileSync(join(root, "dashboard/worker.ts"), "");
    writeFileSync(
      join(root, "docs/public-api.md"),
      "# Public API\n\n| Route | Method |\n| --- | --- |\n| `/api/removed` | `GET` |\n",
    );
    const findings = checkDocumentation(root);
    assert.ok(
      findings.some((finding) => finding.message.includes("stale documented route /api/removed")),
    );
  });
});

test("rejects identical duplicate observer-route rows", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "dashboard/worker.ts"),
      'if (url.pathname === "/api/status" && request.method === "GET") return statusJson();\n',
    );
    writeFileSync(
      join(root, "docs/public-api.md"),
      [
        "# Public API",
        "",
        "| Route | Method |",
        "| --- | --- |",
        "| `/api/status` | `GET` |",
        "| `/api/status` | `GET` |",
      ].join("\n"),
    );
    const manifest = {
      version: 1,
      publicObserverRoutes: [
        { path: "/api/status", method: "GET" },
        { path: "/api/status", method: "GET" },
      ],
      auditedDashboardVariables: [],
      auditedWorkflowSecrets: [],
    };
    writeFileSync(join(root, "config/operator-documentation.json"), JSON.stringify(manifest));
    const findings = checkDocumentation(root);
    assert.ok(
      findings.some((finding) =>
        finding.message.includes("duplicate documented route /api/status"),
      ),
    );
    assert.ok(
      findings.some((finding) => finding.message.includes("duplicate manifest route /api/status")),
    );
  });
});

test("rejects conflicting duplicate observer-route rows", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "dashboard/worker.ts"),
      'if (url.pathname === "/api/status" && request.method === "POST") return statusJson();\n',
    );
    writeFileSync(
      join(root, "docs/public-api.md"),
      [
        "# Public API",
        "",
        "| Route | Method |",
        "| --- | --- |",
        "| `/api/status` | `GET` |",
        "| `/api/status` | `POST` |",
      ].join("\n"),
    );
    const manifest = {
      version: 1,
      publicObserverRoutes: [
        { path: "/api/status", method: "GET" },
        { path: "/api/status", method: "POST" },
      ],
      auditedDashboardVariables: [],
      auditedWorkflowSecrets: [],
    };
    writeFileSync(join(root, "config/operator-documentation.json"), JSON.stringify(manifest));
    const findings = checkDocumentation(root);
    assert.ok(
      findings.some((finding) =>
        finding.message.includes("duplicate documented route /api/status"),
      ),
    );
    assert.ok(
      findings.some((finding) => finding.message.includes("duplicate manifest route /api/status")),
    );
  });
});

test("requires each documented observer method on its route row", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "dashboard/worker.ts"),
      'if (url.pathname === "/api/status") return statusJson();\n',
    );
    writeFileSync(
      join(root, "docs/public-api.md"),
      [
        "# Public API",
        "",
        "| Route | Method |",
        "| --- | --- |",
        "| `/api/status` | `GET` |",
        "| `/api/unrelated` | `ANY` |",
      ].join("\n"),
    );
    const manifest = {
      version: 1,
      publicObserverRoutes: [{ path: "/api/status", method: "ANY" }],
      auditedDashboardVariables: [],
      auditedWorkflowSecrets: [],
    };
    writeFileSync(join(root, "config/operator-documentation.json"), JSON.stringify(manifest));
    const findings = checkDocumentation(root);
    assert.ok(
      findings.some(
        (finding) =>
          finding.file === "docs/public-api.md" &&
          finding.message.includes("missing route /api/status"),
      ),
    );
  });
});

test("reads multiline observer method guards in either condition order", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "dashboard/worker.ts"),
      [
        "if (",
        '  request.method === "GET" &&',
        '  url.pathname === "/api/status"',
        ") return statusJson();",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "docs/public-api.md"),
      "# Public API\n\n| Route | Method |\n| --- | --- |\n| `/api/status` | `GET` |\n",
    );
    const manifest = {
      version: 1,
      publicObserverRoutes: [{ path: "/api/status", method: "GET" }],
      auditedDashboardVariables: [],
      auditedWorkflowSecrets: [],
    };
    writeFileSync(join(root, "config/operator-documentation.json"), JSON.stringify(manifest));
    const findings = checkDocumentation(root);
    assert.deepEqual(
      findings.filter((finding) => finding.kind === "operator-route"),
      [],
    );
  });
});

test("ignores observer-like text outside executable route conditions", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "dashboard/worker.ts"),
      [
        '// if (url.pathname === "/api/comment") return commentJson();',
        'const example = `if (url.pathname === "/api/template") return templateJson();`;',
        'if (url.pathname === "/api/status") return statusJson();',
      ].join("\n"),
    );
    writeFileSync(
      join(root, "docs/public-api.md"),
      "# Public API\n\n| Route | Method |\n| --- | --- |\n| `/api/status` | `ANY` |\n",
    );
    const manifest = {
      version: 1,
      publicObserverRoutes: [{ path: "/api/status", method: "ANY" }],
      auditedDashboardVariables: [],
      auditedWorkflowSecrets: [],
    };
    writeFileSync(join(root, "config/operator-documentation.json"), JSON.stringify(manifest));
    const findings = checkDocumentation(root);
    assert.deepEqual(
      findings.filter((finding) => finding.kind === "operator-route"),
      [],
    );
  });
});

test("preserves multiple method guards for one observer route", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "dashboard/worker.ts"),
      [
        'if (url.pathname === "/api/status" && request.method === "GET") return statusJson();',
        'if (url.pathname === "/api/status" && request.method === "POST") return statusJson();',
      ].join("\n"),
    );
    writeFileSync(
      join(root, "docs/public-api.md"),
      "# Public API\n\n| Route | Method |\n| --- | --- |\n| `/api/status` | `GET` |\n",
    );
    const manifest = {
      version: 1,
      publicObserverRoutes: [{ path: "/api/status", method: "GET" }],
      auditedDashboardVariables: [],
      auditedWorkflowSecrets: [],
    };
    writeFileSync(join(root, "config/operator-documentation.json"), JSON.stringify(manifest));
    const findings = checkDocumentation(root);
    assert.ok(
      findings.some((finding) =>
        finding.message.includes("method drift for /api/status: expected GET, POST, found GET"),
      ),
    );
  });
});

test("preserves multiple method guards in one observer condition", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "dashboard/worker.ts"),
      'if (url.pathname === "/api/status" && (request.method === "GET" || request.method === "HEAD")) return statusJson();\n',
    );
    writeFileSync(
      join(root, "docs/public-api.md"),
      "# Public API\n\n| Route | Method |\n| --- | --- |\n| `/api/status` | `GET` |\n",
    );
    const manifest = {
      version: 1,
      publicObserverRoutes: [{ path: "/api/status", method: "GET" }],
      auditedDashboardVariables: [],
      auditedWorkflowSecrets: [],
    };
    writeFileSync(join(root, "config/operator-documentation.json"), JSON.stringify(manifest));
    const findings = checkDocumentation(root);
    assert.ok(
      findings.some((finding) =>
        finding.message.includes("method drift for /api/status: expected GET, HEAD, found GET"),
      ),
    );
  });
});

test("inventories multiple observer routes in one condition", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "dashboard/worker.ts"),
      'if ((url.pathname === "/api/status" || url.pathname === "/api/alternate") && request.method === "GET") return statusJson();\n',
    );
    writeFileSync(
      join(root, "docs/public-api.md"),
      "# Public API\n\n| Route | Method |\n| --- | --- |\n| `/api/status` | `GET` |\n",
    );
    const manifest = {
      version: 1,
      publicObserverRoutes: [{ path: "/api/status", method: "GET" }],
      auditedDashboardVariables: [],
      auditedWorkflowSecrets: [],
    };
    writeFileSync(join(root, "config/operator-documentation.json"), JSON.stringify(manifest));
    const findings = checkDocumentation(root);
    assert.ok(
      findings.some((finding) => finding.message.includes("missing public route /api/alternate")),
    );
  });
});

test("preserves route-specific methods across Boolean branches", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "dashboard/worker.ts"),
      'if ((url.pathname === "/api/a" && request.method === "GET") || (url.pathname === "/api/b" && request.method === "POST")) return statusJson();\n',
    );
    writeFileSync(
      join(root, "docs/public-api.md"),
      [
        "# Public API",
        "",
        "| Route | Method |",
        "| --- | --- |",
        "| `/api/a` | `GET` |",
        "| `/api/b` | `POST` |",
      ].join("\n"),
    );
    const manifest = {
      version: 1,
      publicObserverRoutes: [
        { path: "/api/a", method: "GET" },
        { path: "/api/b", method: "POST" },
      ],
      auditedDashboardVariables: [],
      auditedWorkflowSecrets: [],
    };
    writeFileSync(join(root, "config/operator-documentation.json"), JSON.stringify(manifest));
    const findings = checkDocumentation(root);
    assert.deepEqual(
      findings.filter((finding) => finding.kind === "operator-route"),
      [],
    );
  });
});

test("preserves enclosing method guards for nested observer routes", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "dashboard/worker.ts"),
      [
        'if (request.method === "GET") {',
        '  if (url.pathname === "/api/status") return statusJson();',
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "docs/public-api.md"),
      "# Public API\n\n| Route | Method |\n| --- | --- |\n| `/api/status` | `GET` |\n",
    );
    const manifest = {
      version: 1,
      publicObserverRoutes: [{ path: "/api/status", method: "GET" }],
      auditedDashboardVariables: [],
      auditedWorkflowSecrets: [],
    };
    writeFileSync(join(root, "config/operator-documentation.json"), JSON.stringify(manifest));
    const findings = checkDocumentation(root);
    assert.deepEqual(
      findings.filter((finding) => finding.kind === "operator-route"),
      [],
    );
  });
});

test("matches workflow secret names exactly", () => {
  withFixture((root) => {
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(root, ".github/workflows/operator.yml"),
      "name: Operator\nenv:\n  TOKEN: ${{ secrets.KNOWN_SECRET_V2 }}\n",
    );
    writeFileSync(join(root, "docs/operator-configuration.md"), "# Config\n\n`KNOWN_SECRET`\n");
    const manifest = {
      version: 1,
      publicObserverRoutes: [],
      auditedDashboardVariables: [],
      auditedWorkflowSecrets: ["KNOWN_SECRET"],
    };
    writeFileSync(join(root, "config/operator-documentation.json"), JSON.stringify(manifest));
    const findings = checkDocumentation(root);
    assert.ok(
      findings.some((finding) => finding.message.includes("stale workflow secret KNOWN_SECRET")),
    );
  });
});

test("ignores workflow secret names in comments and inert literals", () => {
  withFixture((root) => {
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(root, ".github/workflows/operator.yml"),
      [
        "name: Operator",
        "# ${{ secrets.KNOWN_SECRET }}",
        "jobs:",
        "  inspect:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo secrets.KNOWN_SECRET",
      ].join("\n"),
    );
    writeFileSync(join(root, "docs/operator-configuration.md"), "# Config\n\n`KNOWN_SECRET`\n");
    const manifest = {
      version: 1,
      publicObserverRoutes: [],
      auditedDashboardVariables: [],
      auditedWorkflowSecrets: ["KNOWN_SECRET"],
    };
    writeFileSync(join(root, "config/operator-documentation.json"), JSON.stringify(manifest));
    const findings = checkDocumentation(root);
    assert.ok(
      findings.some((finding) => finding.message.includes("stale workflow secret KNOWN_SECRET")),
    );
  });
});

test("checks prompt and agent-skill instruction roots", () => {
  withFixture((root) => {
    mkdirSync(join(root, "prompts"), { recursive: true });
    mkdirSync(join(root, ".agents/skills/example"), { recursive: true });
    writeFileSync(join(root, "prompts/example.md"), "`pnpm run missing-prompt-script`\n");
    writeFileSync(
      join(root, ".agents/skills/example/SKILL.md"),
      "`scripts/missing-skill-tool.mjs`\n",
    );
    const findings = checkDocumentation(root);
    assert.ok(findings.some((finding) => finding.file === "prompts/example.md"));
    assert.ok(findings.some((finding) => finding.file === ".agents/skills/example/SKILL.md"));
  });
});
