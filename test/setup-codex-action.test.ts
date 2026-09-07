import assert from "node:assert/strict";
import {
  existsSync,
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parse } from "yaml";

test(
  "scanner bootstrap refuses a corrupt download before extraction or execution",
  { skip: process.platform === "win32" },
  () => {
    const script = readFileSync(".github/actions/setup-review-tools/install.sh", "utf8");
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-scanner-install-test-"));
    const bin = join(root, "bin");
    const temporary = join(root, "temporary");
    const invoked = join(root, "extracted");
    for (const dir of [bin, temporary, join(root, "checkout")]) mkdirSync(dir);
    writeFileSync(
      join(bin, "uname"),
      '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "curl"),
      '#!/bin/sh\nwhile [ "$1" != "--output" ]; do shift; done\nprintf corrupt > "$2"\n',
      { mode: 0o755 },
    );
    if (process.platform === "darwin")
      writeFileSync(join(bin, "sha256sum"), '#!/bin/sh\nexec /usr/bin/shasum -a 256 "$@"\n', {
        mode: 0o755,
      });
    writeFileSync(
      join(bin, "tar"),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(invoked)}, 'unexpected');`,
      { mode: 0o755 },
    );
    try {
      const result = spawnSync("/bin/bash", ["-c", script], {
        encoding: "utf8",
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          RUNNER_TEMP: temporary,
          GITHUB_WORKSPACE: join(root, "checkout"),
          GITHUB_PATH: join(root, "github-path"),
        },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /FAILED|did NOT match/);
      assert.equal(existsSync(invoked), false);
      assert.equal(existsSync(join(root, "github-path")), false);
      assert.deepEqual(readdirSync(temporary), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

type CompositeAction = {
  inputs: Record<string, { default: string }>;
  runs?: {
    steps?: Array<{ if?: string; name?: string; run?: string }>;
  };
};

const actionPath = resolve(".github/actions/setup-codex");
const action = parse(readFileSync(join(actionPath, "action.yml"), "utf8")) as CompositeAction;
const version = action.inputs["codex-version"].default;
const proxyVersion = action.inputs["proxy-version"].default;
const triple =
  process.platform === "darwin"
    ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
    : `${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl`;

function fixture(home: string, proxy = false) {
  const name = proxy ? "codex-responses-api-proxy" : "codex";
  const prefix = join(home, ".clawsweeper-repair/codex");
  const pkg = join(prefix, "lib/node_modules/@openai", name);
  const alias = `@openai/codex-${process.platform}-${process.arch}`;
  const nativePackage = proxy ? pkg : join(pkg, "node_modules", alias);
  const native = join(nativePackage, "vendor", triple, proxy ? name : "bin", name);
  const launcher = join(pkg, "bin", `${name}.js`);
  mkdirSync(dirname(native), { recursive: true });
  mkdirSync(dirname(launcher), { recursive: true });
  mkdirSync(join(prefix, "bin"), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: `@openai/${name}`,
      version: proxy ? proxyVersion : version,
      type: "module",
      bin: { [name]: `bin/${name}.js` },
      optionalDependencies: proxy
        ? undefined
        : { [alias]: `npm:@openai/codex@${version}-${process.platform}-${process.arch}` },
    }),
  );
  if (!proxy)
    writeFileSync(
      join(nativePackage, "package.json"),
      JSON.stringify({
        name: "@openai/codex",
        version: `${version}-${process.platform}-${process.arch}`,
      }),
    );
  writeFileSync(
    launcher,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
let root = fileURLToPath(new URL("../", import.meta.url));
if (${!proxy}) {
  try {
    root = dirname(createRequire(import.meta.url).resolve(${JSON.stringify(`${alias}/package.json`)}));
  } catch {}
}
const native = join(root, "vendor", ${JSON.stringify(triple)}, ${JSON.stringify(proxy ? name : "bin")}, ${JSON.stringify(name)});
const result = spawnSync(native, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  writeFileSync(
    native,
    `#!/bin/sh
test -z "\${OPENAI_API_KEY:-}\${CODEX_API_KEY:-}\${PROXY_API_KEY:-}\${CLAWSWEEPER_INTERNAL_MODEL:-}\${CLAWSWEEPER_CLAWROUTER_CONFIG:-}\${GITHUB_TOKEN:-}" || exit 87
test "$1" = "${proxy ? "--help" : "--version"}" || exit 88
echo "${proxy ? "Usage: codex-responses-api-proxy [OPTIONS]" : `codex-cli ${version}`}"
`,
    { mode: 0o755 },
  );
  symlinkSync(`../lib/node_modules/@openai/${name}/bin/${name}.js`, join(prefix, "bin", name));
  return { pkg, native, launcher, nativePackage, prefix };
}

function installStep(
  home: string,
  mode: string,
  npmBody = "exit 89",
  source = action,
  sourcePath = actionPath,
) {
  const bin = join(home, "tools");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$HOME/npm-calls"
if [ "$1" = "config" ]; then exit 0; fi
test -z "\${OPENAI_API_KEY:-}\${CODEX_API_KEY:-}\${PROXY_API_KEY:-}\${CLAWSWEEPER_INTERNAL_MODEL:-}\${CLAWSWEEPER_CLAWROUTER_CONFIG:-}" || exit 87
${npmBody}
`,
    { mode: 0o755 },
  );
  const script = source.runs?.steps?.find((step) => step.name === "Install Codex CLI")?.run;
  assert.ok(script);
  return spawnSync(
    "/bin/bash",
    [
      "-c",
      script.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => {
        const input = /^inputs\['([^']+)'\]$/.exec(key)?.[1];
        if (input === "auth-mode") return mode;
        assert.ok(input && source.inputs[input], `unknown expression ${key}`);
        return source.inputs[input].default;
      }),
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        HOME: home,
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        GITHUB_PATH: join(home, "github-path"),
        GITHUB_ACTION_PATH: sourcePath,
        OPENAI_API_KEY: "fixture-only",
        CODEX_API_KEY: "fixture-only",
        PROXY_API_KEY: "fixture-only",
        CLAWSWEEPER_INTERNAL_MODEL: "fixture-only",
        CLAWSWEEPER_CLAWROUTER_CONFIG: "fixture-only",
        GITHUB_TOKEN: "fixture-only",
      },
    },
  );
}

test(
  "install step preserves literal action paths in validator arguments",
  { skip: process.platform === "win32" },
  () => {
    const home = mkdtempSync(join(tmpdir(), "codex-action-path-test-"));
    try {
      const bin = join(home, "tools");
      const trace = join(home, "node-argv");
      const marker = join(home, "marker");
      mkdirSync(bin);
      for (const folder of [
        "checkout with spaces",
        `checkout$(touch "${marker}")`,
        "checkout \"double\" 'single'",
      ]) {
        for (const repair of [false, true]) {
          const sourcePath = join(home, folder, ".github/actions/setup-codex");
          const label = `${folder}, repair=${repair}`;
          writeFileSync(trace, "");
          rmSync(join(home, "npm-calls"), { force: true });
          writeFileSync(
            join(bin, "node"),
            `#!${process.execPath}
const fs = require("node:fs");
const trace = process.env.HOME + "/node-argv";
const args = process.argv.slice(2);
const calls = fs.readFileSync(trace, "utf8").trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line));
fs.appendFileSync(trace, JSON.stringify(args) + "\\n");
if (${repair} && !calls.some((call) => call[1] === args[1])) process.exit(1);
`,
            { mode: 0o755 },
          );
          const result = installStep(home, "proxy", "exit 0", action, sourcePath);
          assert.equal(result.status, 0, `${label}: ${result.stderr}`);
          assert.equal(existsSync(marker), false, label);
          const codexArgs = [join(sourcePath, "validate-install.mjs"), "codex", version];
          const proxyArgs = [
            join(sourcePath, "validate-install.mjs"),
            "codex-responses-api-proxy",
            proxyVersion,
          ];
          assert.deepEqual(
            readFileSync(trace, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
            repair ? [codexArgs, codexArgs, proxyArgs, proxyArgs] : [codexArgs, proxyArgs],
            label,
          );
          assert.deepEqual(
            existsSync(join(home, "npm-calls"))
              ? readFileSync(join(home, "npm-calls"), "utf8").trim().split("\n")
              : [],
            repair
              ? [
                  `config set prefix ${join(home, ".clawsweeper-repair/codex")}`,
                  `config set cache ${join(home, ".npm")}`,
                  `install -g @openai/codex@${version} --prefer-online --no-audit --no-fund --ignore-scripts`,
                  `install -g @openai/codex-responses-api-proxy@${proxyVersion} --prefer-online --no-audit --no-fund --ignore-scripts`,
                ]
              : [],
            label,
          );
        }
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "warm managed pins reuse working launchers without invoking npm",
  { skip: process.platform === "win32" },
  () => {
    for (const mode of ["login", "clawrouter", "proxy"]) {
      const home = mkdtempSync(join(tmpdir(), "codex-warm-test-"));
      try {
        fixture(home);
        if (mode === "proxy") fixture(home, true);
        const result = installStep(home, mode);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, new RegExp(`codex-cli ${version.replaceAll(".", "\\.")}`));
        assert.equal(existsSync(join(home, "npm-calls")), false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  },
);

test(
  "warm aliases ignore shadowed candidates and unused local vendor",
  { skip: process.platform === "win32" },
  () => {
    for (const mutation of ["malformed", "fifo", "dangling escape", "outside", "unused vendor"]) {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "codex-shadowed-test-")));
      try {
        const { pkg, prefix } = fixture(home);
        const alias = `@openai/codex-${process.platform}-${process.arch}`;
        const shadowed = join(
          mutation === "outside" ? home : join(prefix, "lib"),
          "node_modules",
          alias,
        );
        if (mutation === "unused vendor") {
          symlinkSync(join(home, "outside-missing"), join(pkg, "vendor"));
        } else {
          mkdirSync(dirname(shadowed), { recursive: true });
          if (mutation === "dangling escape") {
            symlinkSync(join(home, "outside-missing"), shadowed);
          } else {
            mkdirSync(shadowed);
            const manifest = join(shadowed, "package.json");
            if (mutation === "fifo") assert.equal(spawnSync("mkfifo", [manifest]).status, 0);
            else writeFileSync(manifest, "{");
          }
        }
        const result = installStep(home, "login");
        assert.equal(result.status, 0, `${mutation}: ${result.stderr}`);
        assert.match(result.stdout, new RegExp(`codex-cli ${version.replaceAll(".", "\\.")}`));
        assert.equal(existsSync(join(home, "npm-calls")), false, mutation);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  },
);

test(
  "present invalid aliases cannot be skipped for a healthy lower candidate",
  { skip: process.platform === "win32" },
  () => {
    for (const mutation of [
      "malformed",
      "fifo",
      "missing manifest",
      "dangling manifest",
      "dangling alias",
      "dangling search directory",
      "escaping search directory",
      "escaping missing manifest",
      "escaping manifest",
      "escaping native",
      "outside search directory",
    ]) {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "codex-visited-test-")));
      try {
        const { pkg, nativePackage, native, prefix } = fixture(home);
        const alias = `@openai/codex-${process.platform}-${process.arch}`;
        const lower = join(prefix, "lib/node_modules", alias);
        cpSync(nativePackage, lower, { recursive: true });
        const marker = join(home, "native-executed");
        for (const path of [native, join(lower, "vendor", triple, "bin/codex")])
          writeFileSync(path, `${readFileSync(path, "utf8")}touch ${JSON.stringify(marker)}\n`);
        const manifest = join(nativePackage, "package.json");
        if (mutation === "malformed") writeFileSync(manifest, "{");
        if (mutation === "fifo") {
          rmSync(manifest);
          assert.equal(spawnSync("mkfifo", [manifest]).status, 0);
        }
        if (mutation === "missing manifest") rmSync(manifest);
        if (mutation === "dangling manifest" || mutation === "escaping manifest") {
          rmSync(manifest);
          symlinkSync(
            join(mutation === "escaping manifest" ? home : prefix, "missing.json"),
            manifest,
          );
        }
        if (mutation === "dangling alias") {
          rmSync(nativePackage, { recursive: true });
          symlinkSync(join(prefix, "missing-alias"), nativePackage);
        }
        if (mutation === "escaping missing manifest") {
          rmSync(nativePackage, { recursive: true });
          const outside = join(home, "outside");
          mkdirSync(outside);
          symlinkSync(outside, nativePackage);
        }
        if (mutation.endsWith("search directory")) {
          const directory =
            mutation === "outside search directory"
              ? join(home, "node_modules")
              : join(pkg, "node_modules");
          if (mutation === "outside search directory") {
            renameSync(join(nativePackage, "vendor"), join(pkg, "vendor"));
            rmSync(lower, { recursive: true });
          }
          rmSync(join(pkg, "node_modules"), { recursive: true });
          symlinkSync(
            join(mutation === "dangling search directory" ? prefix : home, "missing-search"),
            directory,
          );
        }
        if (mutation === "escaping native") {
          rmSync(native);
          symlinkSync(join(home, "outside-missing"), native);
        }
        const unsafe = mutation.startsWith("escaping") || mutation === "outside search directory";
        if (unsafe) writeFileSync(join(pkg, "package.json"), "{");
        const result = installStep(home, "login", "exit 0");
        assert.equal(result.status, unsafe ? 2 : 1, `${mutation}: ${result.stderr}`);
        assert.equal(existsSync(marker), false, mutation);
        if (unsafe) {
          assert.equal(existsSync(join(home, "npm-calls")), false, mutation);
        } else {
          const calls = readFileSync(join(home, "npm-calls"), "utf8").trim().split("\n");
          assert.deepEqual(
            calls.filter((line) => line.startsWith("install ")),
            [
              `install -g @openai/codex@${version} --prefer-online --no-audit --no-fund --ignore-scripts`,
            ],
            mutation,
          );
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  },
);

test(
  "invalid managed installs get one pinned repair and must pass revalidation",
  { skip: process.platform === "win32" },
  () => {
    const mutations: Record<string, (paths: ReturnType<typeof fixture>) => void> = {
      cold: ({ prefix }) => rmSync(prefix, { recursive: true }),
      "invalid metadata": ({ pkg }) => writeFileSync(join(pkg, "package.json"), "{"),
      "wrong identity": ({ pkg }) => {
        const path = join(pkg, "package.json");
        const data = JSON.parse(readFileSync(path, "utf8"));
        data.name = "@example/codex";
        writeFileSync(path, JSON.stringify(data));
      },
      "wrong version": ({ pkg }) => {
        const path = join(pkg, "package.json");
        const data = JSON.parse(readFileSync(path, "utf8"));
        data.version = "0.0.1";
        writeFileSync(path, JSON.stringify(data));
      },
      "wrong native version": ({ native }) =>
        writeFileSync(native, "#!/bin/sh\necho 'codex-cli 0.0.1'\n"),
      "missing native": ({ native }) => rmSync(native),
      "non-executable native": ({ native }) => chmodSync(native, 0o644),
      "broken launcher": ({ launcher }) => writeFileSync(launcher, "this is not JavaScript"),
      "broken launcher shebang": ({ launcher }) =>
        writeFileSync(
          launcher,
          readFileSync(launcher, "utf8").replace("#!/usr/bin/env node", "#!/nonexistent/node"),
        ),
      "wrong alias version": ({ nativePackage }) =>
        writeFileSync(
          join(nativePackage, "package.json"),
          JSON.stringify({ name: "@openai/codex", version: `${version}-wrong-platform` }),
        ),
      "wrong launcher": ({ prefix }) => {
        const path = join(prefix, "bin/codex");
        rmSync(path);
        writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      },
    };
    for (const [label, mutate] of Object.entries(mutations)) {
      const home = mkdtempSync(join(tmpdir(), "codex-repair-test-"));
      const pristine = mkdtempSync(join(tmpdir(), "codex-pristine-test-"));
      try {
        const paths = fixture(home);
        const source = fixture(pristine);
        mutate(paths);
        writeFileSync(
          join(home, "repair.cjs"),
          `
const fs = require("node:fs");
fs.rmSync(${JSON.stringify(paths.prefix)}, { recursive: true, force: true });
fs.cpSync(${JSON.stringify(source.prefix)}, ${JSON.stringify(paths.prefix)}, { recursive: true, verbatimSymlinks: true });
`,
        );
        const result = installStep(home, "login", `exec "${process.execPath}" "$HOME/repair.cjs"`);
        assert.equal(result.status, 0, `${label}: ${result.stderr}`);
        assert.ok(existsSync(join(home, "npm-calls")), `${label} must trigger repair`);
        const calls = readFileSync(join(home, "npm-calls"), "utf8").trim().split("\n");
        assert.deepEqual(
          calls.filter((line) => line.startsWith("install ")),
          [
            `install -g @openai/codex@${version} --prefer-online --no-audit --no-fund --ignore-scripts`,
          ],
          label,
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(pristine, { recursive: true, force: true });
      }
    }
  },
);

test(
  "a successful npm exit cannot authorize a persistently broken installation",
  { skip: process.platform === "win32" },
  () => {
    const home = mkdtempSync(join(tmpdir(), "codex-invalid-test-"));
    try {
      const { native } = fixture(home);
      rmSync(native);
      const result = installStep(home, "login", "exit 0");
      assert.equal(result.status, 1, result.stderr);
      assert.equal(
        readFileSync(join(home, "npm-calls"), "utf8")
          .split("\n")
          .filter((line) => line.startsWith("install ")).length,
        1,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "proxy mode repairs only its missing proxy and never probes proxy --version",
  { skip: process.platform === "win32" },
  () => {
    const home = mkdtempSync(join(tmpdir(), "codex-proxy-test-"));
    const pristine = mkdtempSync(join(tmpdir(), "codex-proxy-pristine-"));
    try {
      fixture(home);
      fixture(pristine);
      const proxy = fixture(pristine, true);
      cpSync(proxy.prefix, join(home, "proxy-restore"), {
        recursive: true,
        verbatimSymlinks: true,
      });
      writeFileSync(
        join(home, "repair.cjs"),
        `
const fs = require("node:fs");
const path = require("node:path");
const prefix = path.join(process.env.HOME, ".clawsweeper-repair/codex");
const name = "codex-responses-api-proxy";
fs.cpSync(path.join(process.env.HOME, "proxy-restore/lib/node_modules/@openai", name), path.join(prefix, "lib/node_modules/@openai", name), { recursive: true });
fs.symlinkSync("../lib/node_modules/@openai/" + name + "/bin/" + name + ".js", path.join(prefix, "bin", name));
`,
      );
      const result = installStep(home, "proxy", `exec "${process.execPath}" "$HOME/repair.cjs"`);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        readFileSync(join(home, "npm-calls"), "utf8")
          .trim()
          .split("\n")
          .filter((line) => line.startsWith("install ")),
        [
          `install -g @openai/codex-responses-api-proxy@${proxyVersion} --prefer-online --no-audit --no-fund --ignore-scripts`,
        ],
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(pristine, { recursive: true, force: true });
    }
  },
);

test(
  "the launcher local-vendor fallback remains reusable",
  { skip: process.platform === "win32" },
  () => {
    for (const aliasState of [
      "valid",
      "outside empty directory",
      "outside empty directory link",
      "outside alias directory",
      "outside alias directory link",
      "outside non-directory link",
      "outside regular file",
      "contained regular file",
      "contained scope link to outside file",
      "missing",
      "wrong",
      "self-linked",
    ]) {
      const home = mkdtempSync(join(tmpdir(), "codex-vendor-test-"));
      try {
        const { pkg, nativePackage, native } = fixture(home);
        const trace = join(home, "native-trace");
        const bytes = readFileSync(native, "utf8");
        writeFileSync(native, `${bytes}printf 'local-vendor\\n' >> ${JSON.stringify(trace)}\n`);
        if (aliasState.startsWith("outside")) {
          const linked = aliasState.endsWith("link");
          const directory = join(home, linked ? "shared-node-modules" : "node_modules");
          if (aliasState === "outside non-directory link" || aliasState === "outside regular file")
            writeFileSync(directory, "");
          else mkdirSync(directory);
          if (aliasState.startsWith("outside alias")) {
            const outside = join(directory, `@openai/codex-${process.platform}-${process.arch}`);
            mkdirSync(dirname(outside));
            cpSync(nativePackage, outside, { recursive: true });
            writeFileSync(
              join(outside, "vendor", triple, "bin/codex"),
              `${bytes}printf 'outside-alias\\n' >> ${JSON.stringify(trace)}\n`,
            );
          }
          if (linked) symlinkSync(directory, join(home, "node_modules"));
        }
        renameSync(join(nativePackage, "vendor"), join(pkg, "vendor"));
        rmSync(nativePackage, { recursive: true });
        if (aliasState === "contained regular file") {
          const directory = join(pkg, "node_modules");
          rmSync(directory, { recursive: true });
          writeFileSync(directory, "");
        }
        if (aliasState === "contained scope link to outside file") {
          const scope = join(pkg, "node_modules/@openai");
          const outside = join(home, "outside-file");
          rmSync(scope, { recursive: true });
          writeFileSync(outside, "");
          symlinkSync(outside, scope);
        }
        if (aliasState === "self-linked") symlinkSync("../..", nativePackage);
        if (aliasState === "missing" || aliasState === "wrong") {
          const manifest = join(pkg, "package.json");
          const data = JSON.parse(readFileSync(manifest, "utf8"));
          data.optionalDependencies =
            aliasState === "missing"
              ? {}
              : {
                  [`@openai/codex-${process.platform}-${process.arch}`]: "npm:@openai/codex@0.0.1",
                };
          writeFileSync(manifest, JSON.stringify(data));
        }
        const result = installStep(home, "login", "exit 0");
        const valid = aliasState === "valid" || aliasState.startsWith("outside empty directory");
        const unsafe =
          aliasState.startsWith("outside") || aliasState === "contained scope link to outside file";
        const status = valid ? 0 : unsafe ? 2 : 1;
        assert.equal(result.status, status, `${aliasState}: ${result.stderr}`);
        assert.deepEqual(
          existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n") : [],
          valid ? ["local-vendor", "local-vendor"] : [],
          aliasState,
        );
        assert.equal(existsSync(join(home, "npm-calls")), status === 1, aliasState);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  },
);

test(
  "canonical launcher location owns native dependency resolution",
  { skip: process.platform === "win32" },
  () => {
    for (const escaping of [false, true]) {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "codex-canonical-test-")));
      try {
        const { prefix, pkg } = fixture(home);
        const alias = `@openai/codex-${process.platform}-${process.arch}`;
        const relocated = join(prefix, "shared/codex");
        mkdirSync(dirname(relocated), { recursive: true });
        renameSync(pkg, relocated);
        symlinkSync(relocated, pkg);
        const hoisted = join(prefix, "lib/node_modules", alias);
        renameSync(join(relocated, "node_modules", alias), hoisted);
        const actual = join(prefix, "shared/node_modules", alias);
        mkdirSync(dirname(actual), { recursive: true });
        const payload = escaping ? join(home, "outside") : actual;
        cpSync(hoisted, payload, { recursive: true });
        writeFileSync(join(hoisted, "package.json"), "{");
        if (escaping) symlinkSync(payload, actual);
        const marker = join(home, "actual-native");
        const native = join(payload, "vendor", triple, "bin/codex");
        writeFileSync(native, `${readFileSync(native, "utf8")}touch ${JSON.stringify(marker)}\n`);
        const result = installStep(home, "login");
        assert.equal(result.status, escaping ? 2 : 0, result.stderr);
        assert.equal(existsSync(marker), !escaping);
        assert.equal(existsSync(join(home, "npm-calls")), false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  },
);

test(
  "chained directory links cannot hide an escaping native target",
  { skip: process.platform === "win32" },
  () => {
    const cases = [
      { variant: "chained-contained", proxy: false, absolute: true, status: 0 },
      { variant: "chained-escape", proxy: false, absolute: true, status: 2 },
    ];
    for (const proxy of [false, true])
      for (const absolute of [false, true])
        for (const variant of ["compound-contained", "compound-live", "compound-missing"])
          cases.push({
            variant,
            proxy,
            absolute,
            status: variant === "compound-contained" ? 0 : 2,
          });
    for (const [variant, status] of [
      ["missing-parent", 1],
      ["missing-caller", 1],
      ["missing-escape", 2],
      ["missing-manifest-escape", 2],
      ["file-parent", 1],
      ["file-dot", 1],
      ["file-slash", 1],
      ["directory-suffix", 0],
      ["depth-32", 0],
      ["depth-33", 2],
    ] as const)
      cases.push({ variant, proxy: false, absolute: true, status });
    for (const { variant, proxy, absolute, status } of cases) {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "codex-chain-test-")));
      try {
        if (proxy) fixture(home);
        const { native, prefix, pkg } = fixture(home, proxy);
        const bytes = readFileSync(native, "utf8");
        const trace = join(home, "payload-trace");
        const payload = (path: string, label: string) =>
          writeFileSync(path, `${bytes}printf '${label}\\n' >> ${JSON.stringify(trace)}\n`, {
            mode: 0o755,
          });
        mkdirSync(join(prefix, "deep"));
        mkdirSync(join(prefix, "flat"));
        if (variant.startsWith("chained-")) {
          const escaping = variant === "chained-escape";
          rmSync(dirname(native), { recursive: true });
          symlinkSync("../flat", join(prefix, "deep/link"));
          symlinkSync(join(prefix, "deep/link"), dirname(native));
          const target = join(escaping ? dirname(prefix) : prefix, "payload");
          payload(target, escaping ? "outside" : "intended");
          symlinkSync(escaping ? "../../payload" : "../payload", join(prefix, "flat/codex"));
        } else if (variant.startsWith("compound-") || variant === "missing-manifest-escape") {
          const contained = variant === "compound-contained";
          const anchor = contained ? join(prefix, "flat") : prefix;
          symlinkSync(anchor, join(prefix, "deep/link"));
          rmSync(native);
          const start = absolute ? prefix : relative(dirname(native), prefix);
          symlinkSync(`${start}/deep/link/../payload`, native);
          payload(join(prefix, "deep/payload"), "decoy");
          if (variant !== "compound-missing")
            payload(
              join(contained ? prefix : dirname(prefix), "payload"),
              contained ? "intended" : "outside",
            );
          if (variant === "missing-manifest-escape") rmSync(join(pkg, "package.json"));
        } else if (variant === "missing-caller" || variant === "directory-suffix") {
          rmSync(dirname(native), { recursive: true });
          symlinkSync(
            `${prefix}/${variant === "missing-caller" ? "missing/.." : "flat/./"}`,
            dirname(native),
          );
          if (variant === "missing-caller")
            symlinkSync(join(home, "outside-missing"), join(prefix, "codex"));
          else payload(join(prefix, "flat/codex"), "intended");
        } else {
          rmSync(native);
          payload(join(prefix, "payload"), "intended");
          if (variant.startsWith("depth-")) {
            const count = Number(variant.slice(6));
            for (let hop = 1; hop < count; hop++)
              symlinkSync(
                hop === count - 1 ? "payload" : `hop-${hop + 1}`,
                join(prefix, `hop-${hop}`),
              );
            symlinkSync(join(prefix, "hop-1"), native);
          } else {
            writeFileSync(join(prefix, "file"), "");
            const suffixes: Record<string, string> = {
              "missing-parent": "missing/../payload",
              "missing-escape": "missing/../../payload",
              "file-parent": "file/../payload",
              "file-dot": "file/.",
              "file-slash": "file/",
            };
            const suffix = suffixes[variant];
            assert.ok(suffix);
            symlinkSync(`${prefix}/${suffix}`, native);
          }
        }
        const label = `${variant}, proxy=${proxy}, absolute=${absolute}`;
        const result = installStep(home, proxy ? "proxy" : "login", "exit 0");
        assert.equal(result.status, status, `${label}: ${result.stderr}`);
        assert.deepEqual(
          existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n") : [],
          status === 0 ? ["intended", "intended"] : [],
          label,
        );
        const calls = existsSync(join(home, "npm-calls"))
          ? readFileSync(join(home, "npm-calls"), "utf8").trim().split("\n")
          : [];
        if (status === 1)
          assert.deepEqual(
            calls.filter((line) => line.startsWith("install ")),
            [
              `install -g @openai/codex@${version} --prefer-online --no-audit --no-fund --ignore-scripts`,
            ],
            label,
          );
        else assert.deepEqual(calls, [], label);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  },
);

test(
  "non-regular package metadata fails before Node resolution can block",
  { skip: process.platform === "win32" },
  () => {
    for (const field of ["pkg", "nativePackage"] as const) {
      const home = mkdtempSync(join(tmpdir(), "codex-metadata-test-"));
      try {
        const paths = fixture(home);
        const manifest = join(paths[field], "package.json");
        rmSync(manifest);
        assert.equal(spawnSync("mkfifo", [manifest]).status, 0);
        const result = spawnSync(
          process.execPath,
          [join(actionPath, "validate-install.mjs"), "codex", version],
          {
            env: { HOME: home, PATH: "/usr/bin:/bin" },
            encoding: "utf8",
            timeout: 5_000,
          },
        );
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /missing, mismatched, or unusable/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  },
);

test(
  "escaping managed paths refuse execution and automatic repair even with mismatched metadata",
  { skip: process.platform === "win32" },
  () => {
    for (const field of ["native", "launcher", "pkg", "nativePackage", "prefix"] as const) {
      const home = mkdtempSync(join(tmpdir(), "codex-escape-test-"));
      try {
        const paths = fixture(home);
        writeFileSync(join(paths.pkg, "package.json"), '{"name":"wrong"}');
        rmSync(paths[field], { recursive: true, force: true });
        symlinkSync(join(home, "outside-missing"), paths[field]);
        const result = installStep(home, "login");
        assert.equal(result.status, 2, `${field}: ${result.stderr}`);
        assert.match(result.stderr, /Unsafe managed/);
        assert.equal(existsSync(join(home, "npm-calls")), false);
        assert.equal(existsSync(join(home, "outside-missing")), false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  },
);

test(
  "native probes bound hangs and excessive output",
  { skip: process.platform === "win32" },
  () => {
    for (const body of ["sleep 60", "yes overflow"]) {
      const home = mkdtempSync(join(tmpdir(), "codex-bounded-test-"));
      try {
        const { native } = fixture(home);
        writeFileSync(native, `#!/bin/sh\n${body}\n`);
        const started = Date.now();
        const result = spawnSync(
          process.execPath,
          [join(actionPath, "validate-install.mjs"), "codex", version],
          {
            env: { HOME: home, PATH: "/usr/bin:/bin" },
            timeout: 10_000,
            encoding: "utf8",
          },
        );
        assert.equal(result.status, 1, result.stderr);
        assert.ok(Date.now() - started < 9_000);
        assert.ok(result.stderr.length < 200);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  },
);

test(
  "hosted Linux sandbox preflight propagates Codex startup failures",
  { skip: process.platform === "win32" ? "requires Bash" : false },
  () => {
    const action = parse(readFileSync(".github/actions/setup-codex/action.yml", "utf8")) as
      | CompositeAction
      | undefined;
    const step = action?.runs?.steps?.find(
      (candidate) => candidate.name === "Enable Linux user namespaces for bubblewrap",
    );

    assert.equal(step?.if, "${{ runner.os == 'Linux' && runner.environment == 'github-hosted' }}");
    assert.ok(step?.run);

    const root = mkdtempSync(join(tmpdir(), "clawsweeper-codex-sandbox-preflight-"));
    const bin = join(root, "bin");
    const codex = join(bin, "codex");
    const sysctl = join(bin, "sysctl");

    try {
      mkdirSync(bin);
      writeFileSync(sysctl, "#!/bin/bash\nexit 1\n", { mode: 0o755 });
      writeFileSync(codex, "#!/bin/bash\nexit 23\n", { mode: 0o755 });

      const result = spawnSync("/bin/bash", ["-c", step.run], {
        cwd: root,
        env: {
          ...process.env,
          GITHUB_WORKSPACE: root,
          PATH: `${bin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });

      assert.equal(result.status, 23, result.stderr);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);
