import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { TestContext } from "node:test";

export function writeFakeScanner(bin: string, body = ""): void {
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "trufflehog"),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert.equal(args[0], 'filesystem');
for (const flag of ['--results=verified,unknown', '--fail', '--fail-on-scan-errors', '--no-update', '--json', '--no-color']) assert.ok(args.includes(flag));
for (const key of ['OPENAI_API_KEY', 'GH_TOKEN', 'CODEX_HOME', 'NODE_OPTIONS', 'GIT_CONFIG_COUNT']) assert.equal(process.env[key], undefined);
const inputDir = args[1];
assert.equal(fs.statSync(inputDir).mode & 0o777, 0o700);
const inputs = fs.readdirSync(inputDir).map(name => {
  const file = path.join(inputDir, name);
  assert.ok(fs.lstatSync(file).isFile());
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  return { name, bytes: fs.readFileSync(file) };
});
${body}
`,
    { mode: 0o755 },
  );
}

export function useFakeScanner(t: TestContext, body = ""): string {
  const bin = mkdtempSync(join(tmpdir(), "clawsweeper-scan-tool-test-"));
  writeFakeScanner(bin, body);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(bin, { recursive: true, force: true });
  });
  return bin;
}
