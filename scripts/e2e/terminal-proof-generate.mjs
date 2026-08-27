// Generate supplied proof data in an empty, read-restricted workspace; never run the fixture here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const [directory, model] = process.argv.slice(2);
assert.ok(directory && process.argv.length <= 4, "usage: SCRIPT BUNDLE [MODEL]");
assert.equal(process.platform, "darwin", "this proof attests the macOS Seatbelt boundary only");
const bundle = realpathSync(resolve(directory));
for (const file of ["decision.json", "generation.json"])
  assert.ok(!existsSync(join(bundle, file)), "use a fresh prepared bundle");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const helperSha256 = hash(readFileSync(new URL(import.meta.url)));
const prompt = readFileSync(join(bundle, "prompt.md"));
const schema = readFileSync(join(bundle, "schema.json"));
const inputs = JSON.parse(readFileSync(join(bundle, "inputs.json"), "utf8"));
assert.equal(hash(prompt), inputs.promptSha256);
assert.equal(hash(schema), inputs.schemaSha256);
const runtime = realpathSync(mkdtempSync(join(tmpdir(), "terminal-proof-generation-")));
const workspace = join(runtime, "empty");
mkdirSync(workspace);
// Refuse ambient project configuration, including configuration in temporary-directory ancestors.
for (let path = workspace; ; path = dirname(path)) {
  assert.ok(!existsSync(join(path, ".codex")), "generation ancestors must not contain .codex");
  if (dirname(path) === path) break;
}
const env = Object.fromEntries(
  ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
const invoke = (args, options = {}) =>
  spawnSync("codex", args, {
    cwd: workspace,
    env,
    encoding: "utf8",
    timeout: 240_000,
    killSignal: "SIGTERM",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
const version = invoke(["--version"]);
assert.equal(version.status, 0);
// The flags and trace format below were inspected on this version. Re-attest before upgrading.
assert.equal(version.stdout.trim(), "codex-cli 0.150.0-alpha.13");
const settings = [
  'model_provider="openai"',
  'forced_login_method="chatgpt"',
  'approval_policy="never"',
  'default_permissions="terminal-proof"',
  'permissions.terminal-proof.filesystem={":minimal"="read",":workspace_roots"="read"}',
  "permissions.terminal-proof.network.enabled=false",
  "project_doc_max_bytes=0",
  "skills.include_instructions=false",
  "orchestrator.skills.enabled=false",
  "orchestrator.mcp.enabled=false",
  "mcp_servers={}",
  "agents.enabled=false",
  'web_search="disabled"',
  "tools.update_plan.enabled=false",
  "tools.experimental_request_user_input.enabled=false",
  'shell_environment_policy.inherit="none"',
  "allow_login_shell=false",
  ...[
    "shell_tool",
    "unified_exec",
    "shell_snapshot",
    "view_image",
    "hooks",
    "plugins",
    "apps",
    "multi_agent",
    "multi_agent_v2",
    "code_mode",
    "code_mode_only",
    "memories",
    "image_generation",
    "request_permissions_tool",
    "deferred_executor",
    "token_budget",
    "goals",
  ].map((feature) => `features.${feature}=false`),
  `log_dir=${JSON.stringify(join(runtime, "log"))}`,
];
const config = settings.flatMap((setting) => ["-c", setting]);
const sentinel = join(runtime, "outside-sentinel.txt");
writeFileSync(sentinel, "harmless proof sentinel\n", { flag: "wx" });
const probe = invoke([
  "sandbox",
  ...config,
  "-P",
  "terminal-proof",
  "-C",
  workspace,
  "--",
  "/bin/sh",
  "-c",
  'test -d . || exit 10; if /bin/cat "$1" >/dev/null 2>&1; then exit 11; fi; if (printf blocked > denied-write) 2>/dev/null; then exit 12; fi; printf "READ_DENIED WRITE_DENIED\\n"',
  "probe",
  sentinel,
]);
writeFileSync(join(runtime, "probe.stderr"), probe.stderr ?? "");
assert.equal(probe.status, 0, `sandbox denial preflight failed; inspect locally: ${runtime}`);
assert.equal(probe.stdout.trim(), "READ_DENIED WRITE_DENIED");
assert.deepEqual(readdirSync(workspace), []);
const startedAt = new Date().toISOString();
const stdoutFile = join(runtime, "stdout.log");
const stderrFile = join(runtime, "stderr.log");
const stdoutFd = openSync(stdoutFile, "wx");
const stderrFd = openSync(stderrFile, "wx");
const generated = invoke(
  [
    "--ask-for-approval",
    "never",
    ...config,
    ...(model ? ["-m", model] : []),
    "exec",
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-C",
    workspace,
    "--output-schema",
    join(bundle, "schema.json"),
    "-o",
    join(runtime, "decision.json"),
    "-",
  ],
  {
    input: prompt,
    stdio: ["pipe", stdoutFd, stderrFd],
    env: { ...env, CODEX_ROLLOUT_TRACE_ROOT: join(runtime, "trace") },
  },
);
// Raw diagnostics stay outside the bundle. Never publish them or put them in a receipt.
closeSync(stdoutFd);
closeSync(stderrFd);
generated.stderr = readFileSync(stderrFile, "utf8");
assert.equal(generated.status, 0, `Codex generation failed; inspect locally: ${runtime}`);
assert.ok(/^approval: never$/m.test(generated.stderr), "unexpected startup approval policy");
assert.ok(/^sandbox: read-only/m.test(generated.stderr), "unexpected startup sandbox");
assert.ok(!generated.stderr.includes("danger-full-access"), "unsafe startup sandbox");
assert.deepEqual(readdirSync(workspace), []);
const traceFiles = readdirSync(join(runtime, "trace"), { recursive: true }).filter((file) =>
  file.endsWith("trace.jsonl"),
);
assert.equal(traceFiles.length, 1, "expected exactly one generation thread trace");
const traceFile = join(runtime, "trace", traceFiles[0]);
const events = readFileSync(traceFile, "utf8").trim().split("\n").map(JSON.parse);
const payloads = events.map((event) => event.payload);
const configured = payloads.find((event) => event.event_type === "session_configured");
const session = JSON.parse(
  readFileSync(join(dirname(traceFile), configured.event_payload.path), "utf8"),
);
assert.equal(session.approval_policy, "never");
assert.equal(session.active_permission_profile.id, "terminal-proof");
const permissions = session.permission_profile;
assert.equal(permissions.type, "managed");
assert.equal(permissions.network, "restricted");
assert.equal(permissions.file_system.type, "restricted");
const readRoots = permissions.file_system.entries.map(({ path, access }) => {
  assert.equal(access, "read", "unexpected filesystem access");
  if (path.type === "special" && path.value.kind === "minimal") return ":minimal";
  assert.equal(path.type, "path");
  if (path.path === workspace) return "<empty-workspace>";
  if (path.path.endsWith("/codex-resources/zsh/bin/zsh")) return "<CLI bundled shell>";
  const authHome = realpathSync(process.env.CODEX_HOME ?? join(process.env.HOME, ".codex"));
  assert.equal(dirname(path.path), join(authHome, "tmp/arg0"), "unexpected readable root");
  assert.ok(path.path.split("/").at(-1).startsWith("codex-arg0"));
  return "<CLI executable shim>";
});
assert.ok(readRoots.includes(":minimal") && readRoots.includes("<empty-workspace>"));
assert.equal(payloads.filter((event) => event.type === "tool_call_started").length, 0);
const requests = payloads.filter((event) => event.type === "inference_started");
assert.ok(requests.length > 0, "no actual inference request recorded");
const toolNames = new Set();
const collectTools = (tools, namespace = "functions") => {
  for (const tool of tools) {
    if (tool.type === "namespace") collectTools(tool.tools, tool.name);
    else {
      assert.ok(["function", "custom"].includes(tool.type), "unexpected hosted tool");
      const name = `${namespace}.${tool.name}`;
      if (name === "functions.exec" || name === "functions.wait") {
        // Model metadata can require Code Mode despite feature flags. These exact inspected
        // wrappers expose only sandboxed apply_patch; V8 has no Node, filesystem, or network.
        const wrappers = {
          "functions.exec": "536740ba2218e0c3593f21a9edf5f0d171628c166496e04bd12dec5fec8a0467",
          "functions.wait": "c77b58997b78d5f9c4f14f1d1bf80136c5bd912d3f0487c8b3a74dbf04e98cff",
        };
        assert.equal(hash(JSON.stringify(tool)), wrappers[name], "unattested Code Mode tools");
        toolNames.add(name);
        if (name === "functions.exec") toolNames.add("functions.apply_patch");
        continue;
      }
      // apply_patch has no writable paths and verifies reads inside the sandbox.
      assert.ok(
        ["functions.apply_patch", "functions.send_user_message_async"].includes(name),
        "unexpected model tool; do not replay this decision",
      );
      toolNames.add(name);
    }
  }
};
for (const event of requests) {
  const request = JSON.parse(
    readFileSync(join(dirname(traceFile), event.request_payload.path), "utf8"),
  );
  collectTools(request.tools ?? []);
  for (const item of request.input ?? [])
    if (item.type === "additional_tools") collectTools(item.tools);
}
const decision = readFileSync(join(runtime, "decision.json"));
JSON.parse(decision);
writeFileSync(join(bundle, "decision.json"), decision, { flag: "wx" });
writeFileSync(
  join(bundle, "generation.json"),
  `${JSON.stringify(
    {
      generator: "Codex",
      cliVersion: version.stdout.trim(),
      provider: "openai",
      auth: "existing ChatGPT login",
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: generated.status,
      helperSha256,
      promptSha256: hash(prompt),
      schemaSha256: hash(schema),
      decisionSha256: hash(decision),
      isolation: {
        approval: "never",
        permissionProfile: "terminal-proof",
        filesystem: { ":minimal": "read", ":workspace_roots": "read" },
        effectiveReadRoots: readRoots,
        writablePaths: [],
        childNetworkEnabled: false,
        userConfigIgnored: true,
        execRulesIgnored: true,
        projectConfigAbsent: true,
        projectInstructionsDisabled: true,
        skillsDisabled: true,
        shellToolsDisabled: true,
        mcpDisabled: true,
        pluginsDisabled: true,
        webSearchDisabled: true,
        emptyWorkspaceBeforeAndAfter: true,
        outsideSentinelReadDenied: true,
        workspaceWriteDenied: true,
        startupSandbox: generated.stderr
          .match(/^sandbox: (.+)$/m)[1]
          .replaceAll(workspace, "<empty-workspace>"),
        toolInventory: [...toolNames].sort(),
        toolCalls: 0,
        inferenceRequests: requests.length,
        toolInventoryEvidence:
          "actual local inference request trace; no raw transcript retained in bundle",
      },
      recordingTested: false,
    },
    null,
    2,
  )}\n`,
  { flag: "wx" },
);
console.log(`PASS constrained generation; receipt: ${join(bundle, "generation.json")}`);
