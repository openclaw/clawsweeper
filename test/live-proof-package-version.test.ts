import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";

import { mediaProofCommandRunner } from "../dist/clawsweeper-media-proof.js";
import { driveTerminal } from "../dist/live-proof/drivers.js";

const marker = "verified postcss@8.5.26";
const examples = [
  ...readFileSync(new URL("../prompts/review-item.md", import.meta.url), "utf8").matchAll(
    /<!-- live-proof-pnpm11-package-version-example -->\r?\n```bash\r?\n([\s\S]*?)\r?\n```/g,
  ),
];
assert.equal(examples.length, 1, "The production prompt must own one executable example.");
const example = examples[0][1];
assert.doesNotMatch(example, /[\r\n\u2028\u2029]/, "The terminal command must be single-line.");

// Representative pnpm 11 resolution schema with a development-tool dependency tree.
const resolution = {
  name: "postcss",
  version: "8.5.26",
  path: "/fixture/node_modules/.pnpm/postcss@8.5.26/node_modules/postcss",
  dependents: [
    {
      name: "vite",
      version: "8.0.16",
      dependents: [
        {
          name: "vitest",
          version: "4.1.10",
          dependents: [
            { name: "@openclaw/crabline", version: "0.1.17", depField: "devDependencies" },
          ],
        },
      ],
    },
  ],
};
const validJson = JSON.stringify([resolution], null, 2);

type Response = {
  stdout: string;
  stderr?: string;
  exitCode?: number;
  signal?: string;
  args?: string[];
};

function fixture(t: TestContext, response: Response, missingPnpm = false) {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-package-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  writeFileSync(join(root, "response.json"), JSON.stringify(response));
  if (!missingPnpm) {
    writeFileSync(
      join(bin, "pnpm"),
      [
        "#!/usr/bin/env node",
        'const {readFileSync, writeSync} = require("node:fs");',
        'const response = JSON.parse(readFileSync(require("node:path").join(__dirname, "../response.json"), "utf8"));',
        'require("node:assert/strict").deepEqual(process.argv.slice(2), response.args ?? ["why", "postcss", "--json"]);',
        'writeSync(1, response.stdout); writeSync(2, response.stderr ?? "");',
        "if (response.signal) process.kill(process.pid, response.signal);",
        "else process.exit(response.exitCode ?? 0);",
      ].join("\n"),
      { mode: 0o755 },
    );
  }
  return { root, bin };
}

function runExample(t: TestContext, response: Response, missingPnpm = false) {
  const { root, bin } = fixture(t, response, missingPnpm);
  const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", example], {
    cwd: root,
    // Only the fixture tools are available, so missing pnpm cannot fall back to a real install.
    env: { ...process.env, PATH: bin },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

const cases = [
  { name: "resolution with Vite/Vitest dependents", stdout: validJson, passes: true },
  {
    name: "two matching resolutions",
    stdout: JSON.stringify([resolution, { ...resolution, path: "/second/postcss" }]),
    passes: true,
  },
  {
    name: "dependents are not resolutions",
    stdout: JSON.stringify([
      { ...resolution, dependents: [{ name: "postcss", version: "0.0.0" }] },
    ]),
    passes: true,
  },
  { name: "empty output", stdout: "" },
  { name: "whitespace output", stdout: " \n\t" },
  { name: "empty resolutions", stdout: "[]" },
  { name: "missing name", stdout: JSON.stringify([{ version: "8.5.26" }]) },
  { name: "missing version", stdout: JSON.stringify([{ name: "postcss" }]) },
  { name: "null resolution", stdout: "[null]" },
  { name: "string resolution", stdout: '["postcss@8.5.26"]' },
  { name: "wrong name", stdout: JSON.stringify([{ ...resolution, name: "other-postcss" }]) },
  ...["8.5.25", "8.5.260", "8.5.26-beta.1", "8.5.26+local"].map((version) => ({
    name: `wrong exact version ${version}`,
    stdout: JSON.stringify([{ ...resolution, version }]),
  })),
  ...[false, true].map((wrongFirst) => {
    const mixed = [resolution, { ...resolution, version: "8.5.25" }];
    return {
      name: `mixed versions, wrong ${wrongFirst ? "first" : "last"}`,
      stdout: JSON.stringify(wrongFirst ? mixed.reverse() : mixed),
    };
  }),
  {
    name: "correct dependent cannot rescue wrong resolution",
    stdout: JSON.stringify([{ name: "vite", version: "7.0.0", dependents: [resolution] }]),
  },
  { name: "malformed JSON", stdout: "not JSON" },
  { name: "truncated JSON", stdout: validJson.slice(0, -1) },
  { name: "correct JSON followed by junk", stdout: `${validJson}\npostcss@8.5.26` },
  { name: "unsupported object root", stdout: JSON.stringify(resolution) },
  {
    name: "unsupported importer schema",
    stdout: JSON.stringify([{ name: "fixture", dependencies: { postcss: resolution } }]),
  },
  { name: "null root", stdout: "null" },
  { name: "human display", stdout: "postcss@8.5.26\n" },
];

for (const scenario of cases) {
  test(`prompt package-version example: ${scenario.name}`, (t) => {
    const result = runExample(t, { stdout: scenario.stdout });
    if ("passes" in scenario && scenario.passes) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${marker}\n`);
      assert.equal(result.stderr, "");
    } else {
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.ok(result.stderr.trim(), "Rejection must be visible.");
      assert.ok(!result.stderr.includes(marker), "Failure must not echo a success marker.");
    }
  });
}

for (const failure of [
  { name: "nonzero exit after valid JSON", exitCode: 7, diagnostic: /pnpm why failed: 7/ },
  { name: "signal after valid JSON", signal: "SIGTERM", diagnostic: /pnpm why failed: SIGTERM/ },
  { name: "spawn failure", missingPnpm: true, diagnostic: /ENOENT/ },
]) {
  test(`prompt package-version example rejects ${failure.name}`, (t) => {
    const result = runExample(t, { stdout: validJson, ...failure }, "missingPnpm" in failure);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, failure.diagnostic);
    assert.ok(!result.stderr.includes(marker));
  });
}

for (const scenario of [
  {
    name: "literal space-separated expectation rejects @ display despite exit zero",
    entry: "pnpm why postcss",
    expected: "postcss 8.5.26",
    response: { stdout: "postcss@8.5.26\n", args: ["why", "postcss"] },
    passes: false,
  },
  {
    name: "exact prompt example verifies structured pnpm output",
    entry: example,
    expected: marker,
    response: { stdout: validJson },
    passes: true,
  },
  {
    name: "exact prompt example rejects child failure after valid JSON",
    entry: example,
    expected: marker,
    response: { stdout: validJson, exitCode: 7 },
    passes: false,
  },
]) {
  test(`terminal package-version proof: ${scenario.name}`, { timeout: 30_000 }, (t) => {
    const { root, bin } = fixture(t, scenario.response);
    const fixturePath = `${bin}${delimiter}${process.env.PATH ?? ""}`.replaceAll("'", "'\\''");
    const result = driveTerminal({
      plan: {
        status: "recommended",
        surface: "terminal",
        terminalCompletion: "exit_zero",
        reason: "Verify the resolved package version.",
        payoff: { kind: "static_text", justification: "A version marker is sufficient." },
        // Bind the fixture at the target command, independently of tmux's server environment.
        entry: `PATH='${fixturePath}' ${scenario.entry}`,
        steps: [{ action: "expect_output", text: scenario.expected }],
      },
      checkout: root,
      rawVideoPath: join(root, "proof.webm"),
      maxRecordingSeconds: 20,
      recordMedia: false,
      runner: mediaProofCommandRunner,
    });
    assert.equal(result.status, scenario.passes ? "completed" : "failed", JSON.stringify(result));
    assert.equal(result.steps[0]?.satisfied, scenario.passes);
    if (scenario.passes) {
      assert.match(result.output, /verified postcss@8\.5\.26/);
    } else if (scenario.entry === "pnpm why postcss") {
      assert.match(result.output, /postcss@8\.5\.26/);
      assert.match(
        result.steps[0]?.detail ?? "",
        /exited successfully before expected output appeared/,
      );
    } else {
      assert.match(result.output, /pnpm why failed: 7/);
      assert.match(result.steps[0]?.detail ?? "", /exit status 1/);
    }
  });
}
