import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { resolveSpawnCommand } from "../dist/command.js";
import { collectLocalModules, stageLocalPackage } from "../scripts/stage-local-package.mjs";

const sourceRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));

function tree(root: string): Array<{ path: string; sha256: string }> {
  const result: Array<{ path: string; sha256: string }> = [];
  function visit(dir: string): void {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) visit(path);
      else {
        assert.ok(lstatSync(path).isFile(), `unexpected non-file in artifact: ${path}`);
        result.push({
          path: relative(root, path).replaceAll("\\", "/"),
          sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        });
      }
    }
  }
  visit(root);
  return result;
}

test(
  "packed local reviewer installs and runs outside the source checkout",
  { timeout: 240_000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "local-package-install-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const stage = join(root, "stage");
    const seed = join(root, "seed");
    const prefix = join(root, "install");
    const cwd = join(root, "target with spaces 雪");
    mkdirSync(cwd);
    const emptyConfig = join(root, "empty.npmrc");
    const globalConfig = join(root, "global.npmrc");
    writeFileSync(emptyConfig, "");
    writeFileSync(globalConfig, "");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NPM_CONFIG_USERCONFIG: emptyConfig,
      NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_CACHE: join(root, "npm-cache"),
      NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
    };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    // This is a separate test runner, not an internal Node test worker.
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    const run = (command: string, args: string[], options = {}) => {
      const invocation = resolveSpawnCommand(command, args, { cwd: root, env, ...options });
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 220_000,
        maxBuffer: 8 * 1024 * 1024,
        ...options,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      return result.stdout;
    };
    const manifest = await stageLocalPackage(stage);
    const localStaged = tree(stage);
    const sourceBefore = localStaged.map(({ path }) => {
      const source = join(sourceRoot, path === "README.md" ? "docs/local-package.md" : path);
      return { source, bytes: readFileSync(source) };
    });
    assert.deepEqual(
      localStaged,
      manifest.map(({ path, sha256 }) => ({ path, sha256 })),
    );
    const metadata = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
    assert.equal(metadata.private, true);
    assert.equal(metadata.scripts, undefined);
    assert.equal(metadata.devDependencies, undefined);
    const sourceMetadata = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
    const { packages: runtimeDependencies } = await collectLocalModules(sourceRoot, [
      "dist/clawsweeper-local.js",
      "dist/codex-process-worker.js",
      "dist/openclaw-process-worker.js",
      "dist/git-acquisition-worker.js",
      "scripts/setup-review-tools.mjs",
    ]);
    assert.deepEqual(
      metadata.dependencies ?? {},
      Object.fromEntries(
        [...runtimeDependencies].sort().map((name) => [name, sourceMetadata.dependencies[name]]),
      ),
    );
    assert.equal(metadata.bin["clawsweeper-review"], "dist/clawsweeper-local.js");
    assert.ok(localStaged.some(({ path }) => path === "dist/repair/contained-command-worker.js"));
    assert.ok(
      !localStaged.some(({ path }) => /close-coverage|app-server|action-ledger/.test(path)),
    );

    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const requestedInput = process.env.CLAWSWEEPER_TEST_PACKAGE_INPUT;
    const requestedOutput = process.env.CLAWSWEEPER_TEST_PACKAGE_OUTPUT;
    assert.ok(!requestedInput || !requestedOutput, "consumers must not export a repacked envelope");
    const input = requestedInput ? realpathSync(requestedInput) : undefined;
    if (input) assert.ok(lstatSync(join(input, "manifest.json")).isFile());
    const producer = input
      ? JSON.parse(readFileSync(join(input, "manifest.json"), "utf8"))
      : undefined;
    const inputBefore = input ? tree(input) : undefined;
    if (input) {
      assert.deepEqual(readdirSync(input).sort(), [
        "clawsweeper-local.tgz",
        "manifest.json",
        "package-lock.json",
        "package.json",
      ]);
      assert.equal(producer.source, run("git", ["-C", sourceRoot, "rev-parse", "HEAD"]).trim());
      assert.equal(
        producer.sourceTree,
        run("git", ["-C", sourceRoot, "rev-parse", "HEAD^{tree}"]).trim(),
      );
      assert.equal(
        producer.sourceDiffSha256,
        createHash("sha256")
          .update(
            run("git", [
              "-C",
              sourceRoot,
              "diff",
              "HEAD",
              "--binary",
              "--full-index",
              "--no-ext-diff",
              "--no-textconv",
            ]),
          )
          .digest("hex"),
      );
      assert.deepEqual(producer.files.map(({ path }: { path: string }) => path).sort(), [
        "clawsweeper-local.tgz",
        "package-lock.json",
        "package.json",
      ]);
      for (const file of producer.files) {
        assert.ok(lstatSync(join(input, file.path)).isFile());
        const bytes = readFileSync(join(input, file.path));
        assert.equal(bytes.length, file.bytes, `envelope input size mismatch: ${file.path}`);
        assert.equal(
          createHash("sha256").update(bytes).digest("hex"),
          file.sha256,
          `envelope input hash mismatch: ${file.path}`,
        );
      }
    }
    const staged: Array<{ path: string; sha256: string }> = producer
      ? producer.stagedFiles.map(({ path, sha256 }: { path: string; sha256: string }) => ({
          path,
          sha256,
        }))
      : localStaged;
    // The payload comes from the producer; local builds remain available only
    // for source-unit assertions and the rejected-import probes below.
    assert.deepEqual(
      staged.map(({ path }) => path),
      localStaged.map(({ path }) => path),
    );
    const [packed] = input
      ? [{ filename: "clawsweeper-local.tgz" }]
      : JSON.parse(run(npm, ["pack", stage, "--ignore-scripts", "--json", "--offline"]));
    if (!input)
      assert.deepEqual(
        packed.files.map(({ path }: { path: string }) => path).sort(),
        staged.map(({ path }) => path),
      );
    const tarball = join(input ?? root, packed.filename);
    const tarballHash = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    mkdirSync(seed);
    if (input) {
      for (const name of ["package.json", "package-lock.json"])
        copyFileSync(join(input, name), join(seed, name));
    } else {
      writeFileSync(
        join(seed, "package.json"),
        JSON.stringify(
          {
            name: "clawsweeper-local-install",
            version: "0.0.0",
            private: true,
            dependencies: { [metadata.name]: "file:clawsweeper-local.tgz" },
          },
          null,
          2,
        ) + "\n",
      );
    }
    copyFileSync(tarball, join(seed, "clawsweeper-local.tgz"));
    run(
      npm,
      [
        input ? "ci" : "install",
        "--prefix",
        seed,
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: seed },
    );
    if (input)
      for (const name of ["clawsweeper-local.tgz", "package.json", "package-lock.json"])
        assert.deepEqual(readFileSync(join(seed, name)), readFileSync(join(input, name)));
    // Seed the isolated cache online, then prove a clean lock-driven offline
    // install. Keeping the original manifest/lock prevents cache warmth from
    // silently changing which package or transitive versions are exercised.
    mkdirSync(prefix);
    const installInputs = ["clawsweeper-local.tgz", "package.json", "package-lock.json"].map(
      (name) => {
        copyFileSync(join(seed, name), join(prefix, name));
        return { name, bytes: readFileSync(join(prefix, name)) };
      },
    );
    rmSync(join(seed, "node_modules"), { recursive: true });
    run(npm, [
      "ci",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--omit=dev",
      "--offline",
      "--no-audit",
      "--no-fund",
    ]);
    for (const { name, bytes } of installInputs)
      assert.deepEqual(readFileSync(join(prefix, name)), bytes);
    const installed = join(prefix, "node_modules", "@openclaw", "clawsweeper");
    assert.deepEqual(tree(installed), staged);
    const installedPackages = new Map<
      string,
      { root: string; version: string; dependencies: Record<string, string>; declared: string[] }
    >();
    type NpmNode = {
      name: string;
      version: string;
      path: string;
      problems?: unknown[];
      missing?: boolean;
      invalid?: boolean | string;
      extraneous?: boolean;
      dependencies?: Record<string, NpmNode>;
    };
    function verifyDependencies(node: NpmNode, isRoot = false): void {
      assert.deepEqual(node.problems ?? [], []);
      assert.ok(!node.missing && !node.invalid && !node.extraneous);
      assert.ok(lstatSync(node.path).isDirectory());
      assert.equal(
        realpathSync(node.path),
        node.path,
        "installed package root must not be a symlink",
      );
      assert.ok(
        isRoot ? node.path === prefix : node.path.startsWith(join(prefix, "node_modules") + sep),
      );
      const packageJson = JSON.parse(readFileSync(join(node.path, "package.json"), "utf8"));
      if (!isRoot) {
        assert.equal(node.name, packageJson.name);
        assert.equal(node.version, packageJson.version);
      }
      const dependencies = node.dependencies ?? {};
      const declared = Object.keys(packageJson.dependencies ?? {}).sort();
      const entry = installedPackages.get(node.path) ?? {
        root: node.path,
        version: packageJson.version,
        dependencies: {},
        declared,
      };
      // npm's logical tree can omit children at a repeated physical node. Merge
      // each visible parent edge, then check completeness after traversing it.
      assert.deepEqual(entry.declared, declared);
      for (const [name, child] of Object.entries(dependencies)) {
        assert.equal(name, child.name);
        assert.ok(!entry.dependencies[name] || entry.dependencies[name] === child.path);
        entry.dependencies[name] = child.path;
      }
      if (!isRoot) installedPackages.set(node.path, entry);
      else assert.deepEqual(Object.keys(dependencies).sort(), declared);
      for (const child of Object.values(dependencies)) verifyDependencies(child);
    }
    verifyDependencies(
      JSON.parse(run(npm, ["ls", "--prefix", prefix, "--all", "--long", "--json"])),
      true,
    );
    for (const entry of installedPackages.values())
      assert.deepEqual(Object.keys(entry.dependencies).sort(), entry.declared);
    const dependencyTrees = [...installedPackages.keys()].map((path) => ({
      path,
      files: tree(path),
    }));
    const bin = join(
      prefix,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "clawsweeper-review.cmd" : "clawsweeper-review",
    );

    // Only installed processes activate this hook. The parity suite's one
    // explicit test preload is allowed; product imports follow verified package
    // roots and each importing package's declared dependency edges.
    const guard = join(root, "installed-only.mjs");
    writeFileSync(
      guard,
      `import { registerHooks } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
if (process.argv[1] && realpathSync(process.argv[1]).startsWith(${JSON.stringify(installed + sep)})) {
  const packages = ${JSON.stringify([...installedPackages.values()].sort((a, b) => b.root.length - a.root.length))};
  const owner = url => {
    const path = realpathSync(fileURLToPath(url));
    return packages.find(pkg => path.startsWith(pkg.root + ${JSON.stringify(sep)}));
  };
  registerHooks({ resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (result.url.startsWith("node:") || result.url === ${JSON.stringify(new URL("./local-entry-import-guard.mjs", import.meta.url).href)}) return result;
    const target = result.url.startsWith("file:") ? owner(result.url) : undefined;
    const parent = context.parentURL?.startsWith("file:") ? owner(context.parentURL) : undefined;
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    if (!target || (parent && parent.root !== target.root && parent.dependencies[name] !== target.root) || (!parent && target.root !== ${JSON.stringify(installed)})) {
      throw new Error("Installed reviewer imported outside its declared dependency closure");
    }
    return result;
  } });
}
`,
    );
    const installedEnv = { ...env, NODE_OPTIONS: `--import=${pathToFileURL(guard).href}` };
    const probe = join(installed, "package-boundary-probe.mjs");
    const transitive = [...installedPackages.keys()].find(
      (path) =>
        path !== installed &&
        !Object.values(installedPackages.get(installed)!.dependencies).includes(path),
    );
    assert.ok(transitive, "exercise an undeclared hoisted transitive dependency");
    const transitiveName = JSON.parse(readFileSync(join(transitive, "package.json"), "utf8")).name;
    try {
      writeFileSync(probe, "await import(process.argv[2]);\n");
      for (const specifier of [
        pathToFileURL(join(sourceRoot, "dist/clawsweeper-local.js")).href,
        pathToFileURL(join(stage, "dist/clawsweeper-local.js")).href,
        transitiveName,
      ]) {
        const result = spawnSync(process.execPath, [probe, specifier], {
          env: installedEnv,
          encoding: "utf8",
          timeout: 10_000,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /outside its declared dependency closure/);
      }
    } finally {
      rmSync(probe);
    }
    run("git", ["init", "-q", cwd]);
    const targetBefore = tree(cwd);
    for (const flag of ["--help", "--version"]) {
      const stdout = run(bin, [flag], { cwd, env: installedEnv });
      assert.match(
        stdout,
        flag === "--help"
          ? /Local ClawSweeper/
          : new RegExp(`^${metadata.version.replaceAll(".", "\\.")}`),
      );
    }
    for (const args of [["apply-decisions"], ["--diagnostics"]]) {
      const invocation = resolveSpawnCommand(bin, args, { cwd, env: installedEnv });
      const result = spawnSync(invocation.command, invocation.args, {
        cwd,
        env: installedEnv,
        encoding: "utf8",
        timeout: 10_000,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Use --help for usage/);
    }
    assert.deepEqual(tree(cwd), targetBefore);

    const parity = run(
      process.execPath,
      [
        "--test",
        "--test-reporter=tap",
        fileURLToPath(new URL("./local-range-review.test.ts", import.meta.url)),
      ],
      {
        cwd,
        env: {
          ...installedEnv,
          CLAWSWEEPER_TEST_LOCAL_ENTRY_PATH: bin,
        },
      },
    );
    const skipped = process.platform === "win32" ? 3 : 0;
    for (const [label, expected] of Object.entries({
      tests: 18,
      pass: 18 - skipped,
      fail: 0,
      cancelled: 0,
      skipped,
      todo: 0,
    })) {
      assert.match(parity, new RegExp(`^# ${label} ${expected}$`, "m"));
    }
    assert.deepEqual(tree(installed), staged, "review must not change the installed package");
    for (const { path, files } of dependencyTrees)
      assert.deepEqual(tree(path), files, "review must not change installed runtime dependencies");
    assert.deepEqual(tree(stage), localStaged, "review must not change staged inputs");
    assert.deepEqual(tree(cwd), targetBefore);
    for (const { source, bytes } of sourceBefore)
      assert.deepEqual(readFileSync(source), bytes, "review must not change source inputs");
    if (input) assert.deepEqual(tree(input), inputBefore, "consumer must not change its envelope");
    const lock = JSON.parse(readFileSync(join(prefix, "package-lock.json"), "utf8"));
    assert.equal(lock.packages[""].dependencies[metadata.name], "file:clawsweeper-local.tgz");
    assert.equal(lock.packages[""].name, "clawsweeper-local-install");
    for (const path of Object.keys(lock.packages)) {
      assert.ok(
        path === "" || (path.startsWith("node_modules/") && !path.split("/").includes("..")),
      );
      assert.ok(
        path === "" || installedPackages.has(join(prefix, path)),
        "lock contains unverified package",
      );
    }
    const resolution = [...installedPackages.values()]
      .map(({ root, version }) => {
        const path = relative(prefix, root).replaceAll("\\", "/");
        const entry = lock.packages[path];
        assert.equal(entry.version, version);
        assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
        if (root === installed) assert.equal(entry.resolved, "file:clawsweeper-local.tgz");
        else {
          const url = new URL(entry.resolved);
          assert.equal(url.protocol, "https:");
          assert.equal(url.host, "registry.npmjs.org");
          assert.equal(url.username + url.password + url.search + url.hash, "");
        }
        return { path, version, resolved: entry.resolved, integrity: entry.integrity };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
    if (producer) assert.deepEqual(resolution, producer.resolution);
    const npmVersion = run(npm, ["--version"]).trim();
    if (requestedOutput) {
      assert.ok(isAbsolute(requestedOutput), "package output must be an absolute new directory");
      const output = join(
        realpathSync(dirname(resolve(requestedOutput))),
        basename(requestedOutput),
      );
      // Export only the exact inputs that survived the relocated install and
      // parity checks. The caller owns a new destination, never an existing one.
      for (const protectedRoot of [sourceRoot, root])
        assert.ok(output !== protectedRoot && !output.startsWith(protectedRoot + sep));
      mkdirSync(output);
      try {
        for (const { name, bytes } of installInputs) writeFileSync(join(output, name), bytes);
        const files = installInputs.map(({ name, bytes }) => ({
          path: name,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }));
        writeFileSync(
          join(output, "manifest.json"),
          JSON.stringify(
            {
              source: run("git", ["-C", sourceRoot, "rev-parse", "HEAD"]).trim(),
              sourceTree: run("git", ["-C", sourceRoot, "rev-parse", "HEAD^{tree}"]).trim(),
              sourceDiffSha256: createHash("sha256")
                .update(
                  run("git", [
                    "-C",
                    sourceRoot,
                    "diff",
                    "HEAD",
                    "--binary",
                    "--full-index",
                    "--no-ext-diff",
                    "--no-textconv",
                  ]),
                )
                .digest("hex"),
              node: process.version,
              npm: npmVersion,
              platform: process.platform,
              arch: process.arch,
              files,
              stagedFiles: manifest,
              resolution,
            },
            null,
            2,
          ) + "\n",
        );
      } catch (error) {
        rmSync(output, { recursive: true, force: true });
        throw error;
      }
    }
    t.diagnostic(
      JSON.stringify({
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        files: staged.length,
        source: producer?.source,
        sourceTree: producer?.sourceTree,
        producerPlatform: producer?.platform,
        unpackedBytes: producer
          ? producer.stagedFiles.reduce(
              (total: number, file: { bytes: number }) => total + file.bytes,
              0,
            )
          : packed.unpackedSize,
        tarballBytes: readFileSync(tarball).length,
        tarballSha256: tarballHash,
        parity: parity.match(/# tests \d+/)?.[0],
        npmVersion,
        runtimePackages: [...installedPackages.keys()].map((path) =>
          relative(join(prefix, "node_modules"), path).replaceAll("\\", "/"),
        ),
      }),
    );
  },
);
