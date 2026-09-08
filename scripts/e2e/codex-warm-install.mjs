#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { parse } from "yaml";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    base: { type: "string", default: "ff0156fb8628cbf9f22d00864810dea56e83122b" },
    repetitions: { type: "string", default: "5" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "node scripts/e2e/codex-warm-install.mjs --output /outside/repo/proof [--base SHA] [--repetitions 5]",
  );
  process.exit(0);
}
assert.equal(
  process.platform,
  "linux",
  "Run only in the coordinator's isolated Linux proof environment",
);
assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
assert.ok(values.output, "--output is required");
const repetitions = Number(values.repetitions);
assert.ok(Number.isInteger(repetitions) && repetitions >= 2 && repetitions <= 20);
const repo = process.cwd();
const output = resolve(values.output);
const outputRelative = relative(repo, output);
assert.ok(
  outputRelative.startsWith("../") || isAbsolute(outputRelative),
  "Evidence must be outside the checkout",
);
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "codex-warm-proof-"));
const actionRelative = ".github/actions/setup-codex/action.yml";
const actionPath = join(repo, dirname(actionRelative));
const after = parse(readFileSync(actionRelative, "utf8"));
const before = parse(
  execFileSync("git", ["show", `${values.base}:${actionRelative}`], { encoding: "utf8" }),
);
const version = after.inputs["codex-version"].default;
const proxyVersion = after.inputs["proxy-version"].default;
assert.equal(before.inputs["codex-version"].default, version);
assert.equal(before.inputs["proxy-version"].default, proxyVersion);
const realNpm = realpathSync(execFileSync("which", ["npm"], { encoding: "utf8" }).trim());
const tools = join(root, "tools");
mkdirSync(tools);
mkdirSync(join(root, "downloads"));
writeFileSync(
  join(tools, "npm"),
  `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PROOF_NPM_TRACE, JSON.stringify(args) + "\\n");
if (args[0] === "install") {
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "PROXY_API_KEY", "CLAWSWEEPER_INTERNAL_MODEL", "CLAWSWEEPER_CLAWROUTER_CONFIG"]) {
    if (process.env[key]) process.exit(87);
  }
}
const result = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(realNpm)}, ...args], { stdio: "inherit" });
if (args[0] === "install" && result.status === 0 && process.env.PROOF_CORRUPT_AFTER_INSTALL) {
  fs.writeFileSync(process.env.PROOF_CORRUPT_AFTER_INSTALL, "invalid JavaScript");
}
process.exit(result.status ?? 1);
`,
  { mode: 0o755 },
);

const denied = [];
const deny = createServer((request, response) => {
  denied.push({ method: request.method, path: request.url });
  response.writeHead(503);
  response.end("registry deliberately denied\n");
});
await new Promise((ready) => deny.listen(0, "127.0.0.1", ready));
const registry = `http://127.0.0.1:${deny.address().port}/`;
const records = [];
const timings = [];
const files = [
  actionRelative,
  ".github/actions/setup-codex/validate-install.mjs",
  "test/setup-codex-action.test.ts",
  "scripts/e2e/codex-warm-install.mjs",
];
const sourceHashes = Object.fromEntries(
  files.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
);
function scrub(value) {
  return value
    .replaceAll(root, "$FIXTURE")
    .replaceAll(repo, "$CHECKOUT")
    .replaceAll(dirname(realNpm), "$NPM")
    .replaceAll(dirname(process.execPath), "$NODE");
}
function makeHome(label, copy) {
  const home = join(root, label);
  mkdirSync(home);
  symlinkSync(join(root, "downloads"), join(home, ".npm"));
  if (copy)
    cpSync(join(copy, ".clawsweeper-repair"), join(home, ".clawsweeper-repair"), {
      recursive: true,
      verbatimSymlinks: true,
    });
  return home;
}
function environment(home, offline = false) {
  const selectedRegistry = offline ? registry : "https://registry.npmjs.org/";
  writeFileSync(
    join(home, ".npmrc"),
    `registry=${selectedRegistry}\n@openai:registry=${selectedRegistry}\n`,
  );
  return {
    HOME: home,
    PATH: `${tools}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    GITHUB_PATH: join(home, "github-path"),
    GITHUB_ACTION_PATH: actionPath,
    PROOF_NPM_TRACE: join(home, "npm-trace.jsonl"),
    npm_config_userconfig: join(home, ".npmrc"),
    npm_config_globalconfig: join(root, "empty-npmrc"),
    npm_config_registry: selectedRegistry,
    npm_config_fetch_retries: "0",
    npm_config_fetch_timeout: "15000",
    OPENAI_API_KEY: "fixture-only",
    CODEX_API_KEY: "fixture-only",
    PROXY_API_KEY: "fixture-only",
    CLAWSWEEPER_INTERNAL_MODEL: "fixture-only",
    CLAWSWEEPER_CLAWROUTER_CONFIG: "fixture-only",
  };
}
function killGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
function run(command, args, env, timeout = 120_000) {
  const started = performance.now();
  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd: repo,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    let failed = false;
    let stopped = false;
    const kill = () => {
      if (stopped) return;
      stopped = true;
      killGroup(child.pid);
    };
    const timer = setTimeout(() => {
      failed = true;
      kill();
    }, timeout);
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        if (text.length + chunk.length > 1024 * 1024) {
          failed = true;
          kill();
        } else text += chunk.toString();
      });
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      kill();
      if (failed) reject(new Error("proof child failed, exceeded output bound, or timed out"));
      else done({ status, elapsedMs: performance.now() - started, output: scrub(text) });
    });
  });
}
function render(action, mode) {
  const step = action.runs.steps.find((entry) => entry.name === "Install Codex CLI");
  return step.run.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expression) => {
    const key = /^inputs\['([^']+)'\]$/.exec(expression)?.[1];
    if (key === "auth-mode") return mode;
    assert.ok(key && action.inputs[key], `unexpected expression ${expression}`);
    return action.inputs[key].default;
  });
}
async function install(
  label,
  home,
  { action = after, mode = "proxy", offline = false, expected = 0, corruptAfterInstall } = {},
) {
  const trace = join(home, "npm-trace.jsonl");
  writeFileSync(trace, "");
  denied.length = 0;
  const env = environment(home, offline);
  if (corruptAfterInstall) env.PROOF_CORRUPT_AFTER_INSTALL = corruptAfterInstall;
  const result = await run("bash", ["-c", render(action, mode)], env);
  const calls = readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const record = {
    label,
    mode,
    offline,
    ...result,
    calls: calls.map((args) => args.map(scrub)),
    deniedRequests: [...denied],
  };
  records.push(record);
  writeFileSync(join(output, `${label}.json`), `${JSON.stringify(record, null, 2)}\n`);
  assert.equal(result.status, expected, `${label}: ${result.output}`);
  return record;
}
function installs(record) {
  return record.calls
    .filter((args) => args[0] === "install")
    .map((args) => {
      assert.deepEqual(args.slice(3), [
        "--prefer-online",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
      ]);
      return args[2];
    });
}
function paths(home, name = "codex") {
  const prefix = join(home, ".clawsweeper-repair/codex");
  const pkg = join(prefix, "lib/node_modules/@openai", name);
  const launcher = join(pkg, "bin", `${name}.js`);
  const nativeRoot =
    name === "codex"
      ? dirname(createRequire(launcher).resolve(`@openai/codex-linux-${process.arch}/package.json`))
      : pkg;
  const triple = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl`;
  return {
    prefix,
    pkg,
    launcher,
    nativeRoot,
    native: join(nativeRoot, "vendor", triple, name === "codex" ? "bin" : name, name),
  };
}
async function proxyLifecycle(home) {
  const info = join(home, "server-info.json");
  const child = spawn(
    join(paths(home, "codex-responses-api-proxy").prefix, "bin/codex-responses-api-proxy"),
    ["--http-shutdown", "--server-info", info, "--upstream-url", registry],
    {
      cwd: home,
      env: { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    },
  );
  const exited = new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  child.stdin.end("fixture-only\n");
  try {
    for (let index = 0; index < 100 && !existsSync(info); index++) {
      assert.equal(child.exitCode, null, "proxy exited before startup");
      await delay(50);
    }
    assert.ok(existsSync(info), "proxy did not start");
    const { port } = JSON.parse(readFileSync(info, "utf8"));
    assert.ok(Number.isInteger(port) && port > 0);
    denied.length = 0;
    const response = await fetch(`http://127.0.0.1:${port}/shutdown`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    const status = await Promise.race([exited, delay(5_000).then(() => "timeout")]);
    assert.equal(status, 0);
    assert.equal(denied.length, 0);
    return { startup: true, shutdownStatus: response.status, exitStatus: status, modelRequests: 0 };
  } finally {
    killGroup(child.pid);
    await exited;
  }
}

let passed = false;
let lifecycle;
let packageIdentity;
try {
  const cold = makeHome("cold");
  assert.deepEqual(installs(await install("cold", cold)), [
    `@openai/codex@${version}`,
    `@openai/codex-responses-api-proxy@${proxyVersion}`,
  ]);
  packageIdentity = {
    codex: JSON.parse(readFileSync(join(paths(cold).pkg, "package.json"), "utf8")).version,
    alias: JSON.parse(readFileSync(join(paths(cold).nativeRoot, "package.json"), "utf8")).version,
    proxy: JSON.parse(
      readFileSync(join(paths(cold, "codex-responses-api-proxy").pkg, "package.json"), "utf8"),
    ).version,
  };
  const control = makeHome("deny-control");
  const refused = await run(
    "npm",
    ["view", `@openai/codex@${version}`, "version"],
    environment(control, true),
  );
  assert.notEqual(refused.status, 0);
  assert.ok(denied.length > 0, "registry deny must reject a real npm request");
  writeFileSync(
    join(output, "registry-deny-control.json"),
    JSON.stringify({ ...refused, requests: [...denied] }, null, 2),
  );
  const warm = makeHome("warm", cold);
  const warmResult = await install("warm-offline", warm, { offline: true });
  assert.deepEqual(warmResult.calls, []);
  assert.deepEqual(warmResult.deniedRequests, []);
  const fallback = makeHome("outside-empty-link-fallback", cold);
  const fallbackPaths = paths(fallback);
  renameSync(join(fallbackPaths.nativeRoot, "vendor"), join(fallbackPaths.pkg, "vendor"));
  rmSync(fallbackPaths.nativeRoot, { recursive: true });
  const emptyDirectory = join(fallback, "empty-node-modules");
  mkdirSync(emptyDirectory);
  symlinkSync(emptyDirectory, join(fallback, "node_modules"));
  const fallbackResolution = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import assert from "node:assert/strict";
import { createRequire } from "node:module";
assert.throws(() => createRequire(process.argv[1]).resolve(process.argv[2]), { code: "MODULE_NOT_FOUND" });`,
      fallbackPaths.launcher,
      `@openai/codex-linux-${process.arch}/package.json`,
    ],
    environment(fallback, true),
    5_000,
  );
  assert.equal(fallbackResolution.status, 0, fallbackResolution.output);
  const fallbackResult = await install("outside-empty-link-fallback", fallback, {
    mode: "login",
    offline: true,
  });
  assert.equal(fallbackResult.output.trim(), `codex-cli ${version}`);
  assert.deepEqual(fallbackResult.calls, []);
  assert.deepEqual(fallbackResult.deniedRequests, []);
  rmSync(join(fallback, "node_modules"));
  writeFileSync(join(fallback, "node_modules"), "");
  const outsideFile = await install("outside-file-refusal", fallback, {
    mode: "login",
    offline: true,
    expected: 2,
  });
  assert.deepEqual(outsideFile.calls, []);
  assert.deepEqual(outsideFile.deniedRequests, []);
  rmSync(fallback, { recursive: true });
  for (const mutation of ["shadowed-malformed-alias", "unused-vendor-escape"]) {
    const home = makeHome(mutation, cold);
    const item = paths(home);
    const alias = `@openai/codex-linux-${process.arch}`;
    const nested = join(item.pkg, "node_modules", alias);
    if (item.nativeRoot !== nested) {
      mkdirSync(dirname(nested), { recursive: true });
      cpSync(item.nativeRoot, nested, { recursive: true });
    }
    if (mutation === "shadowed-malformed-alias") {
      const shadowed = join(item.prefix, "lib/node_modules", alias);
      mkdirSync(shadowed, { recursive: true });
      writeFileSync(join(shadowed, "package.json"), "{");
    } else {
      symlinkSync(join(home, "outside-missing"), join(item.pkg, "vendor"));
    }
    const record = await install(mutation, home, { offline: true });
    assert.deepEqual(record.calls, []);
    assert.deepEqual(record.deniedRequests, []);
    rmSync(home, { recursive: true });
  }
  const old = await install("before-offline-control", makeHome("old", cold), {
    action: before,
    offline: true,
    expected: 1,
  });
  assert.ok(installs(old).length > 0);
  assert.ok(old.deniedRequests.length > 0);
  lifecycle = await proxyLifecycle(warm);

  const repairs = [
    "partial",
    "self-linked-alias",
    "corrupt-metadata",
    "wrong-version",
    "missing-native",
    "broken-launcher",
    "broken-shebang",
    "non-executable",
  ].map((mutation) => ({ mutation, name: "codex", label: mutation }));
  for (const mutation of ["missing-native", "wrong-version"])
    repairs.push({ mutation, name: "codex-responses-api-proxy", label: `proxy-${mutation}` });
  for (const { mutation, name, label } of repairs) {
    const home = makeHome(label, cold);
    const item = paths(home, name);
    if (mutation === "partial") rmSync(item.nativeRoot, { recursive: true });
    if (mutation === "self-linked-alias") {
      renameSync(join(item.nativeRoot, "vendor"), join(item.pkg, "vendor"));
      rmSync(item.nativeRoot, { recursive: true });
      symlinkSync(relative(dirname(item.nativeRoot), item.pkg), item.nativeRoot);
    }
    if (mutation === "corrupt-metadata") writeFileSync(join(item.pkg, "package.json"), "{");
    if (mutation === "wrong-version") {
      const manifest = join(item.pkg, "package.json");
      const data = JSON.parse(readFileSync(manifest, "utf8"));
      writeFileSync(manifest, JSON.stringify({ ...data, version: "0.0.1" }));
    }
    if (mutation === "missing-native") rmSync(item.native);
    if (mutation === "broken-launcher") writeFileSync(item.launcher, "invalid JavaScript");
    if (mutation === "broken-shebang")
      writeFileSync(
        item.launcher,
        readFileSync(item.launcher, "utf8").replace("#!/usr/bin/env node", "#!/nonexistent/node"),
      );
    if (mutation === "non-executable") chmodSync(item.native, 0o644);
    assert.deepEqual(installs(await install(label, home)), [
      `@openai/${name}@${name === "codex" ? version : proxyVersion}`,
    ]);
    rmSync(home, { recursive: true });
  }
  const login = makeHome("login");
  assert.deepEqual(installs(await install("login-cold", login, { mode: "login" })), [
    `@openai/codex@${version}`,
  ]);
  for (const mode of ["login", "clawrouter"]) {
    const record = await install(`${mode}-offline`, login, { mode, offline: true });
    assert.deepEqual(record.calls, []);
    assert.deepEqual(record.deniedRequests, []);
  }
  assert.deepEqual(installs(await install("login-to-proxy", login)), [
    `@openai/codex-responses-api-proxy@${proxyVersion}`,
  ]);
  const persistent = makeHome("persistent-invalid", cold);
  const persistentPaths = paths(persistent);
  rmSync(persistentPaths.native);
  const stillBroken = await install("persistent-invalid", persistent, {
    expected: 1,
    corruptAfterInstall: persistentPaths.launcher,
  });
  assert.deepEqual(installs(stillBroken), [`@openai/codex@${version}`]);

  const escape = makeHome("escape", cold);
  const escapedNative = paths(escape).native;
  rmSync(escapedNative);
  const external = join(root, "outside-native");
  const marker = join(root, "executed-unsafe");
  writeFileSync(external, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`, { mode: 0o755 });
  symlinkSync(external, escapedNative);
  const unsafe = await install("unsafe-escape", escape, { expected: 2 });
  assert.deepEqual(unsafe.calls, []);
  assert.equal(existsSync(marker), false);
  assert.ok(existsSync(external));

  for (const name of ["codex", "codex-responses-api-proxy"]) {
    for (const variant of ["contained", "live-escape", "missing-escape"]) {
      const label = `${name}-compound-${variant}`;
      const home = makeHome(label, cold);
      const item = paths(home, name);
      const deep = join(item.prefix, "path-order-deep");
      const flat = join(item.prefix, "path-order-flat");
      const contained = variant === "contained";
      const filename = `${name}-payload`;
      const payload = join(contained ? item.prefix : dirname(item.prefix), filename);
      const executed = join(home, "unexpected-payload");
      const banner =
        name === "codex" ? `codex-cli ${version}` : "Usage: codex-responses-api-proxy [OPTIONS]";
      const decoy = `#!/bin/sh\ntouch ${JSON.stringify(executed)}\nprintf '%s\\n' ${JSON.stringify(banner)}\n`;
      mkdirSync(deep);
      mkdirSync(flat);
      symlinkSync(contained ? flat : item.prefix, join(deep, "link"));
      if (contained) renameSync(item.native, payload);
      else rmSync(item.native);
      if (variant === "live-escape") writeFileSync(payload, decoy, { mode: 0o755 });
      writeFileSync(join(deep, filename), decoy, { mode: 0o755 });
      symlinkSync(`${deep}/link/../${filename}`, item.native);
      const record = await install(label, home, { offline: true, expected: contained ? 0 : 2 });
      assert.deepEqual(record.calls, []);
      assert.deepEqual(record.deniedRequests, []);
      assert.equal(existsSync(executed), false);
      assert.equal(existsSync(payload), variant !== "missing-escape");
      rmSync(home, { recursive: true });
    }
  }

  for (let index = 0; index < repetitions; index++) {
    const order = index % 2 === 0 ? ["before", "after"] : ["after", "before"];
    for (const variant of order) {
      const home = makeHome(`timing-${index}-${variant}`, cold);
      const result = await install(`timing-${index}-${variant}`, home, {
        action: variant === "before" ? before : after,
      });
      assert.equal(installs(result).length, variant === "before" ? 2 : 0);
      timings.push({ pair: index, variant, elapsedMs: result.elapsedMs });
      rmSync(home, { recursive: true });
    }
  }
  passed = true;
} finally {
  const means = Object.fromEntries(
    ["before", "after"].map((variant) => {
      const samples = timings
        .filter((entry) => entry.variant === variant)
        .map((entry) => entry.elapsedMs);
      return [
        variant,
        samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : null,
      ];
    }),
  );
  const summary = {
    passed,
    base: values.base,
    head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceHashes,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pins: { codex: version, proxy: proxyVersion },
    packageIdentity,
    lifecycle,
    scenarios: records.map(({ label, status }) => ({ label, status })),
    timings,
    means,
    measuredNetImprovementMs: passed ? means.before - means.after : null,
    limits:
      "Actual pinned npm packages and extracted install shell in isolated HOME/prefix; full-block alternating timings include validation. The persistent-invalid case injects launcher corruption after a real successful npm install. Loopback denies the configured registry, not arbitrary process egress. No real credentials, model calls, hosted cache restore, scanner bootstrap, or live job mutation. No Bay contracts change. Separate focused test executes unchanged sandbox-failure propagation.",
  };
  writeFileSync(join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  deny.closeAllConnections();
  await new Promise((done) => deny.close(done));
  rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed, output }, null, 2));
