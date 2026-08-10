import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
    "scripts/example.mjs": "export {};\n",
    ".github/workflows/ci.yml": "name: CI\n",
    "dashboard/wrangler.toml": 'CAPACITY = "50"\n',
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
