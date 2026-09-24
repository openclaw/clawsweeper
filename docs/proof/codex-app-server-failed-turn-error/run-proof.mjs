// Before/after proof: a failed Codex app-server turn reports its own error instead of the
// host's missing-result ENOENT, so the review classifier can see capacity and access errors.
// Usage: node docs/proof/codex-app-server-failed-turn-error/run-proof.mjs --base <pre-fix-rev>
//        [--out <dir>]
// POSIX only: the synthetic Codex peer is an executable script with a shebang.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const BASELINE_FILES = ["src/codex-app-server-worker.ts", "src/codex-transient.ts"];
const RATE_LIMIT = "Rate limit reached for tokens per min (TPM). Please try again in 20s.";
const MODEL_DENIED = "The model proof-model does not exist or you do not have access to it.";

if (process.platform === "win32") throw new Error("Run this proof on Linux or macOS.");

const git = (...gitArgs) =>
  execFileSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8" }).trim();
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const baseRev = option("--base");
if (!baseRev || baseRev.startsWith("--")) {
  throw new Error("Pass --base <pre-fix-rev> to identify the failing baseline explicitly.");
}
const outDir = resolve(repoRoot, option("--out", ".artifacts/codex-app-server-failed-turn-error"));
mkdirSync(outDir, { recursive: true });

// Compile an isolated copy of src/ per arm so the tracked checkout is never rewritten.
function compileArm(name, sourceOverrides) {
  const armRoot = join(outDir, `${name}-build`);
  rmSync(armRoot, { recursive: true, force: true });
  cpSync(join(repoRoot, "src"), join(armRoot, "src"), { recursive: true });
  // Compiled modules read repository data files relative to their own root.
  for (const dataDir of ["config", "schema", "prompts", "instructions"]) {
    if (existsSync(join(repoRoot, dataDir))) {
      cpSync(join(repoRoot, dataDir), join(armRoot, dataDir), { recursive: true });
    }
  }
  for (const [file, source] of Object.entries(sourceOverrides)) {
    writeFileSync(join(armRoot, file), source);
  }
  writeFileSync(join(armRoot, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  symlinkSync(join(repoRoot, "node_modules"), join(armRoot, "node_modules"), "dir");
  writeFileSync(
    join(armRoot, "tsconfig.json"),
    JSON.stringify({
      extends: join(repoRoot, "tsconfig.json"),
      compilerOptions: {
        rootDir: join(armRoot, "src"),
        outDir: join(armRoot, "dist"),
        typeRoots: [join(repoRoot, "node_modules", "@types")],
      },
      include: [join(armRoot, "src", "**", "*.ts")],
      exclude: [join(armRoot, "src", "repair", "**")],
    }),
  );
  execFileSync(
    process.execPath,
    [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", join(armRoot, "tsconfig.json")],
    { cwd: repoRoot, stdio: "inherit" },
  );
  return { name, dist: join(armRoot, "dist") };
}

// Minimal app-server peer: handshake, one turn, then the scenario's turn/completed.
// Failing peers also log a stderr line so the proof covers the runtime preferring the
// protocol's turn error over captured stderr.
function writePeer(dir, scenario) {
  const binary = join(dir, "codex");
  const turn =
    scenario === "completed"
      ? { status: "completed", error: null }
      : scenario === "interrupted"
        ? { status: "interrupted", error: null }
        : {
            status: "failed",
            error: {
              message: scenario === "failed-rate-limit" ? RATE_LIMIT : MODEL_DENIED,
              codexErrorInfo: null,
            },
          };
  writeFileSync(
    binary,
    `#!${process.execPath}
const rl = require("node:readline").createInterface({ input: process.stdin });
const threadId = "019f0560-0000-7000-8000-000000000001";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: threadId, sessionId: threadId } } });
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn", status: "inProgress" } } });
    setTimeout(() => {
      send({ method: "item/completed", params: {
        threadId, turnId: "turn", item: { type: "agentMessage", id: "m", text: '{"decision":"keep_open"}' }
      } });
      if (${JSON.stringify(turn.status)} !== "completed") {
        process.stderr.write("WARN codex_app_server: turn ended without a final message\\n");
      }
      send({ method: "turn/completed", params: { threadId, turn: { id: "turn", ...${JSON.stringify(turn)} } } });
    }, 5);
  }
});
`,
    { mode: 0o700 },
  );
  return binary;
}

async function runScenario(arm, scenario) {
  const { runCodexProcess } = await import(pathToFileURL(join(arm.dist, "codex-process.js")).href);
  const { codexFailureDecisionForTest, redactInternalCodexModel } = await import(
    pathToFileURL(join(arm.dist, "clawsweeper.js")).href
  );
  const transient = await import(pathToFileURL(join(arm.dist, "codex-transient.js")).href);
  const dir = join(outDir, arm.name, scenario);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const outputPath = join(dir, "42.json");
  const result = runCodexProcess({
    args: ["exec", "--cd", dir, "--sandbox", "read-only", "--output-last-message", outputPath, "--json", "-"],
    cwd: dir,
    env: { ...process.env, CODEX_BIN: writePeer(dir, scenario) },
    input: "Review the fixture.",
    timeoutMs: 10_000,
    outputLastMessagePath: outputPath,
    // The review runtime always bounds the managed result file.
    outputLastMessageBytes: 4 * 1024 * 1024,
    appServer: { statePath: join(dir, "thread.json") },
  });
  const observed = {
    arm: arm.name,
    scenario,
    status: result.status,
    error: result.error?.message ?? null,
    output: existsSync(outputPath),
    stderr: result.stderr.trim(),
  };
  if (!result.error && existsSync(outputPath)) return observed;
  // The same composition runCodex applies to a non-native (app-server) review result.
  const failureDetail = result.error
    ? `Codex review failed for #42: ${redactInternalCodexModel(result.error.message)}`
    : `Codex review failed for #42 with exit ${result.status ?? "unknown"}.`;
  // runCodex tails stderr with redactedOutputTail; the synthetic stderr is one short line.
  const trusted = redactInternalCodexModel(
    transient.codexJsonlFailureDetail(result.stdout) || result.stderr.trim(),
  );
  const detail = [failureDetail, trusted].filter(Boolean).join("\n");
  const terminal = transient.isTerminalCodexErrorMessage(detail);
  const retryable =
    !terminal &&
    (result.signal !== null ||
      (result.status === 0 && !existsSync(outputPath)) ||
      transient.isRetryableCodexErrorMessage(detail) ||
      /\b(?:ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|transport failure)\b/i.test(
        detail,
      ));
  const decision = codexFailureDecisionForTest(result.status, detail, result.stdout, result.stderr, {
    signal: result.signal,
    diagnostic: trusted || failureDetail,
  });
  return {
    ...observed,
    retryable,
    terminal: decision.codexTerminalFailure,
    summary: decision.summary,
  };
}

const baseSha = git("rev-parse", baseRev);
const head = git("rev-parse", "HEAD");
const overrides = Object.fromEntries(
  BASELINE_FILES.map((file) => [file, git("show", `${baseSha}:${file}`)]),
);
const arms = [compileArm("baseline", overrides), compileArm("candidate", {})];
const scenarios = ["completed", "failed-rate-limit", "failed-model-denied", "interrupted"];
const rows = [];
for (const arm of arms) {
  for (const scenario of scenarios) {
    const row = await runScenario(arm, scenario);
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}

const find = (arm, scenario) => rows.find((row) => row.arm === arm && row.scenario === scenario);
const checks = [
  ["control: both arms publish the completed turn", ["baseline", "candidate"].every((arm) => {
    const row = find(arm, "completed");
    return row.status === 0 && row.output && row.error === null;
  })],
  ["baseline: failed turns surface the host ENOENT", ["failed-rate-limit", "failed-model-denied", "interrupted"].every(
    (scenario) => /ENOENT/.test(find("baseline", scenario).error ?? ""),
  )],
  ["baseline: rate limit is not retryable", find("baseline", "failed-rate-limit").retryable === false],
  ["baseline: model denial is not terminal", find("baseline", "failed-model-denied").terminal === false],
  ["candidate: no failed turn surfaces ENOENT", ["failed-rate-limit", "failed-model-denied", "interrupted"].every(
    (scenario) => !/ENOENT/.test(find("candidate", scenario).error ?? "") && !find("candidate", scenario).output,
  )],
  ["candidate: rate limit is retryable capacity", (() => {
    const row = find("candidate", "failed-rate-limit");
    return row.retryable === true && /retryable codex transport failure \(capacity\)/.test(row.summary);
  })()],
  ["candidate: model denial is terminal and not retried", (() => {
    const row = find("candidate", "failed-model-denied");
    return row.stderr !== "" && row.terminal === true && row.retryable === false;
  })()],
  ["candidate: interrupted turn names its status", find("candidate", "interrupted").error === "Codex turn interrupted."],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
const pass = checks.every(([, ok]) => ok);
writeFileSync(
  join(outDir, "summary.json"),
  `${JSON.stringify({ base: baseSha, head, node: process.version, rows, checks, pass }, null, 2)}\n`,
);
console.log(`PROOF_RESULT=${pass ? "PASS" : "FAIL"} base=${baseSha} head=${head}`);
process.exitCode = pass ? 0 : 1;
