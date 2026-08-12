import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const configPath = "tsconfig.dashboard-strict.json";
const tscPath = path.resolve("node_modules/typescript/bin/tsc");
const showConfig = runTsc(["-p", configPath, "--showConfig"]);
if (showConfig.status !== 0) {
  process.stderr.write(showConfig.output);
  process.exit(1);
}

const config = JSON.parse(showConfig.stdout);
const strictFiles = new Set(config.files.map(normalizeFile));
if (
  strictFiles.size === 0 ||
  config.compilerOptions?.strict !== true ||
  config.compilerOptions?.noUncheckedIndexedAccess !== true ||
  config.compilerOptions?.exactOptionalPropertyTypes !== true
) {
  throw new Error(
    "dashboard strict config must enable all strict flags and list at least one file",
  );
}

const check = runTsc(["-p", configPath, "--pretty", "false"]);
if (check.status === 0) process.exit(0);

const selected = [];
let includeContinuation = false;
let recognizedDiagnostic = false;
for (const line of check.output.split(/(?<=\n)/)) {
  const match = /^(.+?)\(\d+,\d+\): error TS\d+:/.exec(line);
  if (match) {
    recognizedDiagnostic = true;
    includeContinuation = strictFiles.has(normalizeFile(match[1]));
  } else if (/^error TS\d+:/.test(line)) {
    recognizedDiagnostic = true;
    includeContinuation = true;
  }
  if (includeContinuation) selected.push(line);
}

if (selected.length > 0 || !recognizedDiagnostic) {
  process.stderr.write(selected.length > 0 ? selected.join("") : check.output);
  process.exitCode = 1;
}

function normalizeFile(file) {
  return path.normalize(file).replace(/^\.\//, "");
}

function runTsc(args) {
  const result = spawnSync(process.execPath, [tscPath, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    output: `${result.stdout}${result.stderr}`,
  };
}
