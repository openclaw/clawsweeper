import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { TestContext } from "node:test";
import { windowsSystemExecutable } from "../dist/command.js";
import { TRUFFLEHOG_VERSION } from "../dist/review-tool-bootstrap.js";

export function writeFakeScanner(bin: string, body = ""): void {
  mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") {
    if (body) throw new Error("The native Windows scanner fixture supports only the empty body");
    const source = join(bin, "scanner.cs");
    const compiler = join(bin, "compile.ps1");
    writeFileSync(
      source,
      `using System;
using System.IO;
public class Scanner {
  public static int Main(string[] args) {
    try {
      foreach (string name in new[] { "OPENAI_API_KEY", "GH_TOKEN", "CODEX_HOME", "NODE_OPTIONS", "GIT_CONFIG_COUNT" })
        if (Environment.GetEnvironmentVariable(name) != null) throw new Exception("Unexpected inherited environment: " + name);
      if (args.Length == 1 && args[0] == "--version") {
        Console.WriteLine("trufflehog ${TRUFFLEHOG_VERSION}");
        return 0;
      }
      if (args.Length != 8 || args[0] != "filesystem") throw new Exception("Unexpected scanner arguments");
      foreach (string flag in new[] { "--results=verified,unknown", "--fail", "--fail-on-scan-errors", "--no-update", "--json", "--no-color" })
        if (Array.IndexOf(args, flag) < 0) throw new Exception("Missing scanner flag: " + flag);
      string directory = args[1];
      if (!Directory.Exists(directory) || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
        throw new Exception("Expected a regular scan directory");
      foreach (string path in Directory.GetFileSystemEntries(directory)) {
        FileAttributes attributes = File.GetAttributes(path);
        if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
          throw new Exception("Expected a regular scan file");
        File.ReadAllBytes(path);
      }
      return 0;
    } catch (Exception error) {
      Console.Error.WriteLine(error.Message);
      return 1;
    }
  }
}
`,
    );
    writeFileSync(
      compiler,
      `param([string]$Source, [string]$Output)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5) { throw 'Windows PowerShell 5 is required for the native fixture compiler' }
Add-Type -Path $Source -OutputAssembly $Output -OutputType ConsoleApplication
`,
    );
    // The production scanner requires a native .exe; a .cmd or Node shebang
    // would bypass the Windows trust boundary instead of exercising it.
    execFileSync(
      windowsSystemExecutable("WindowsPowerShell/v1.0/powershell.exe", process.env),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        compiler,
        source,
        join(bin, "trufflehog.exe"),
      ],
      { timeout: 30_000, stdio: "pipe" },
    );
    return;
  }
  writeFileSync(
    join(bin, "trufflehog"),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
for (const key of ['OPENAI_API_KEY', 'GH_TOKEN', 'CODEX_HOME', 'NODE_OPTIONS', 'GIT_CONFIG_COUNT']) assert.equal(process.env[key], undefined);
if (args.length === 1 && args[0] === '--version') {
  console.log('trufflehog ${TRUFFLEHOG_VERSION}');
  process.exit(0);
}
assert.equal(args[0], 'filesystem');
for (const flag of ['--results=verified,unknown', '--fail', '--fail-on-scan-errors', '--no-update', '--json', '--no-color']) assert.ok(args.includes(flag));
const inputDir = args[1];
assert.ok(fs.lstatSync(inputDir).isDirectory());
if (process.platform !== 'win32') assert.equal(fs.statSync(inputDir).mode & 0o777, 0o700);
const inputs = fs.readdirSync(inputDir).map(name => {
  const file = path.join(inputDir, name);
  assert.ok(fs.lstatSync(file).isFile());
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
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
