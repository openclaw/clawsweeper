// Compiled before/after proof that the spam scanner no longer publishes the configured
// internal model id when the OpenAI Responses call fails.
//
// Both arms run the real compiled scanner CLI (dist/repair/spam-scanner.js) end to end
// with `--write-report --repo proof/spam --comment-ids 1`: `GH_BIN` points at a fake `gh`
// that answers the single comment read and the minimization batch query, and an
// import-time transport shim redirects only `https://api.openai.com/v1/responses` to a
// loopback server that returns the two OpenAI error shapes that echo the model id: a 404
// model-access error and a 429 rate-limit error. `CLAWSWEEPER_INTERNAL_MODEL` carries a
// synthetic secret id, exactly as the spam-scanner workflow supplies it. The driver then
// reads the published outputs — the per-comment audit record, `spam-scanner-latest.json`,
// and the ledger `spam-scanner.json` — and counts the secret id and the redaction marker.
//
// Each arm compiles its own copy of src/ (baseline: src/repair/spam-scanner.ts and
// spam-scanner-core.ts from the base commit — default: merge base with origin/main, or
// HEAD~1 once the change is on main) under the output directory, so `results/` is
// isolated per arm and the tracked checkout is never modified.
//
// Usage: node docs/proof/spam-scanner-model-redaction/run-proof.mjs [--base <rev>]
//        [--out <dir>]
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const BASELINE_FILES = ["src/repair/spam-scanner.ts", "src/repair/spam-scanner-core.ts"];
const SECRET_MODEL = "gpt-secret-model-7f3a";
const REDACTED = "[REDACTED_INTERNAL_MODEL]";

const git = (...gitArgs) =>
  execFileSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8" }).trim();

// On a multi-commit branch the pre-change code is the merge base with origin/main, not
// HEAD~1; once the change is on main, HEAD~1 is the previous main commit.
function defaultBaseRev() {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return "HEAD~1";
  } catch {
    try {
      return git("merge-base", "HEAD", "origin/main");
    } catch (error) {
      console.warn(
        `origin/main is unavailable (${error.message.trim()}); using HEAD~1 as the baseline`,
      );
      return "HEAD~1";
    }
  }
}

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const baseRev = option("--base", defaultBaseRev());
const outDir = resolve(repoRoot, option("--out", ".artifacts/spam-scanner-model-redaction"));
mkdirSync(outDir, { recursive: true });
const posix = (value) => value.replace(/\\/g, "/");

// Compile an isolated copy of src/ with the repair tsconfig. The copy has its own
// package.json and node_modules link so module resolution matches the checkout even when
// the output directory lives outside the repository; repoRoot() inside the compiled
// scanner then resolves to the copy, which keeps results/ per arm.
function compileArm(name, sourceOverrides) {
  const armRoot = join(outDir, `${name}-build`);
  const armSrc = join(armRoot, "src");
  rmSync(armRoot, { recursive: true, force: true });
  cpSync(join(repoRoot, "src"), armSrc, { recursive: true });
  // The compiled scanner reads repository data files relative to its own root.
  for (const dataDir of ["config", "schema", "prompts", "instructions"]) {
    if (existsSync(join(repoRoot, dataDir))) {
      cpSync(join(repoRoot, dataDir), join(armRoot, dataDir), { recursive: true });
    }
  }
  for (const [file, source] of Object.entries(sourceOverrides)) {
    writeFileSync(join(armRoot, file), source);
  }
  writeFileSync(join(armRoot, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  symlinkSync(join(repoRoot, "node_modules"), join(armRoot, "node_modules"), "junction");
  const repairConfig = JSON.parse(readFileSync(join(repoRoot, "tsconfig.repair.json"), "utf8"));
  writeFileSync(
    join(armRoot, "tsconfig.json"),
    JSON.stringify(
      {
        extends: posix(join(repoRoot, "tsconfig.repair.json")),
        compilerOptions: {
          rootDir: posix(armSrc),
          outDir: posix(join(armRoot, "dist")),
          typeRoots: [posix(join(repoRoot, "node_modules", "@types"))],
        },
        include: repairConfig.include.map((entry) => posix(join(armRoot, entry))),
      },
      null,
      2,
    ),
  );
  execFileSync(
    process.execPath,
    [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", join(armRoot, "tsconfig.json")],
    { cwd: repoRoot, stdio: "inherit" },
  );
  return { name, root: armRoot, scanner: join(armRoot, "dist", "repair", "spam-scanner.js") };
}

const baseSha = git("rev-parse", baseRev);
const head = git("rev-parse", "HEAD");
const baselineOverrides = Object.fromEntries(
  BASELINE_FILES.map((file) => [file, git("show", `${baseSha}:${file}`)]),
);
for (const [file, source] of Object.entries(baselineOverrides)) {
  writeFileSync(join(outDir, `baseline-${file.split("/").pop()}`), source);
}
const arms = [compileArm("baseline", baselineOverrides), compileArm("candidate", {})];

// The fake gh answers exactly the two reads an exact-id scan performs: the comment itself
// and the minimization batch query. Anything else is a failure, not a silent default.
const fakeGh = join(outDir, "fake-gh.cjs");
writeFileSync(
  fakeGh,
  `const args = process.argv.slice(2);
if (args.includes("graphql")) {
  process.stdout.write(JSON.stringify({ data: { nodes: [{ id: "IC_1", isMinimized: false, minimizedReason: null }] } }));
} else if (args.some((arg) => /repos\\/proof\\/spam\\/issues\\/comments\\/1$/.test(arg))) {
  process.stdout.write(JSON.stringify({
    id: 1,
    node_id: "IC_1",
    html_url: "https://github.com/proof/spam/issues/1#issuecomment-1",
    issue_url: "https://api.github.com/repos/proof/spam/issues/1",
    body: "I specialize in web scraping & data extraction. Fast turnaround, clean output.\\n\\n$5 flash sale -> https://tinyurl.com/example",
    user: { login: "proof-user" },
    author_association: "NONE",
    created_at: "2026-09-17T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
  }));
} else {
  process.stderr.write("unexpected gh call: " + args.join(" ") + "\\n");
  process.exit(2);
}
`,
);

// Only the expected model endpoint is redirected; the original request initialization
// (headers, body, abort signal) is forwarded unchanged.
const transport = join(outDir, "transport.mjs");
writeFileSync(
  transport,
  `const target = process.env.CLAWSWEEPER_PROOF_OPENAI_ENDPOINT;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) =>
  originalFetch(String(input) === "https://api.openai.com/v1/responses" ? target : input, init);
`,
);

const cases = [
  {
    name: "404 model access",
    status: 404,
    body: {
      error: {
        message: `The model \`${SECRET_MODEL}\` does not exist or you do not have access to it.`,
        type: "invalid_request_error",
        param: "model",
        code: "model_not_found",
      },
    },
  },
  {
    name: "429 rate limit",
    status: 429,
    body: {
      error: {
        message: `Rate limit reached for ${SECRET_MODEL} in organization org-proof on tokens per min (TPM): Limit 30000, Used 30000, Requested 1200.`,
        type: "tokens",
        code: "rate_limit_exceeded",
      },
    },
  },
];

let activeCase = cases[0];
const requestedModels = [];
const server = createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => (raw += chunk));
  request.on("end", () => {
    let model = null;
    try {
      model = JSON.parse(raw).model ?? null;
    } catch {}
    requestedModels.push({ path: request.url, model });
    response.writeHead(activeCase.status, { "content-type": "application/json" });
    response.end(JSON.stringify(activeCase.body));
  });
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const endpoint = `http://127.0.0.1:${server.address().port}/v1/responses`;

// The loopback server lives in this process, so the scanner must run asynchronously: a
// blocking spawn would never let the server answer the redirected model request.
function runScanner(arm, endpoint) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(transport).href,
        arm.scanner,
        "--write-report",
        "--repo",
        "proof/spam",
        "--comment-ids",
        "1",
      ],
      {
        cwd: arm.root,
        env: {
          ...process.env,
          GH_BIN: process.execPath,
          GH_BIN_ARGS: JSON.stringify([fakeGh]),
          OPENAI_API_KEY: "synthetic-proof-key",
          CLAWSWEEPER_INTERNAL_MODEL: SECRET_MODEL,
          CLAWSWEEPER_PROOF_OPENAI_ENDPOINT: endpoint,
          CLAWSWEEPER_GH_RETRY_ATTEMPTS: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", rejectRun);
    child.once("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

function readOutputs(armRoot) {
  const resultsDir = join(armRoot, "results");
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json")) files.push(full);
    }
  };
  if (existsSync(resultsDir)) walk(resultsDir);
  return files.sort().map((file) => {
    const text = readFileSync(file, "utf8");
    const parsed = JSON.parse(text);
    const modelError =
      parsed.model_error ?? parsed.entries?.[0]?.model_error ?? null;
    return {
      file: posix(file.slice(armRoot.length + 1)),
      bytes: Buffer.byteLength(text),
      secretOccurrences: text.split(SECRET_MODEL).length - 1,
      redactedOccurrences: text.split(REDACTED).length - 1,
      modelError,
    };
  });
}

const results = [];
for (const arm of arms) {
  for (const testCase of cases) {
    activeCase = testCase;
    requestedModels.length = 0;
    rmSync(join(arm.root, "results"), { recursive: true, force: true });
    const startedAt = Date.now();
    const run = await runScanner(arm, endpoint);
    const elapsedMs = Date.now() - startedAt;
    const stdout = run.stdout;
    let report = null;
    try {
      report = JSON.parse(stdout);
    } catch {}
    const outputs = readOutputs(arm.root);
    const auditRecord = outputs.find((entry) => entry.file.includes("spam-audit"));
    if (auditRecord) {
      cpSync(
        join(arm.root, auditRecord.file),
        join(outDir, `${arm.name}-${testCase.status}-audit-record.json`),
      );
    }
    results.push({
      arm: arm.name,
      case: testCase.name,
      exitCode: run.status,
      elapsedMs,
      modelSentToEndpoint: requestedModels.map((entry) => entry.model),
      reportModel: report?.model ?? null,
      stdoutSecretOccurrences: stdout.split(SECRET_MODEL).length - 1,
      stderrSecretOccurrences: run.stderr.split(SECRET_MODEL).length - 1,
      outputs,
    });
  }
}
server.close();

const expectedFiles = [
  "results/spam-audit/proof-spam/issue_comment-1.json",
  "results/spam-scanner-latest.json",
  "results/spam-scanner.json",
];
const ran = (entry) =>
  entry.exitCode === 0 &&
  entry.modelSentToEndpoint.length === 1 &&
  entry.modelSentToEndpoint[0] === SECRET_MODEL &&
  entry.reportModel === "internal" &&
  expectedFiles.every((file) => entry.outputs.some((output) => output.file === file));
// Before the change every published file carries the raw OpenAI error text with the
// configured model id.
const baselineLeaks = (entry) =>
  ran(entry) &&
  entry.outputs.every((output) => output.secretOccurrences >= 1) &&
  entry.stdoutSecretOccurrences >= 1;
const candidateRedacts = (entry) =>
  ran(entry) &&
  entry.outputs.every(
    (output) => output.secretOccurrences === 0 && output.redactedOccurrences >= 1,
  ) &&
  entry.stdoutSecretOccurrences === 0 &&
  entry.stderrSecretOccurrences === 0;
const pass =
  results.filter((entry) => entry.arm === "baseline").every(baselineLeaks) &&
  results.filter((entry) => entry.arm === "candidate").every(candidateRedacts);
const summary = {
  head,
  base: baseSha,
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  secretModel: SECRET_MODEL,
  results,
  pass,
};
writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log(`PROOF_RESULT=${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
