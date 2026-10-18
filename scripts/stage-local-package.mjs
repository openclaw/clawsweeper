#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { init, parse } from "es-module-lexer";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ENTRIES = [
  "dist/clawsweeper-local.js",
  "dist/codex-process-worker.js",
  "dist/openclaw-process-worker.js",
  "dist/git-acquisition-worker.js",
  "scripts/setup-review-tools.mjs",
];
const ASSETS = [
  "prompts/review-item.md",
  "prompts/review-item-issue.md",
  "prompts/review-item-pr.md",
  "prompts/review-close-reasons.md",
  "schema/clawsweeper-decision.schema.json",
  "config/automation-limits.json",
  "config/target-repositories.json",
  "LICENSE",
];
const HOSTED = new Set([
  "dist/clawsweeper.js",
  "dist/clawsweeper-runtime.js",
  "dist/clawsweeper-review-runtime.js",
  "dist/clawsweeper-review-command-workflow.js",
  "dist/clawsweeper-status-context.js",
  "dist/clawsweeper-apply-decision-workflow.js",
  "dist/repair/command-runner.js",
  "dist/action-ledger.js",
  "dist/action-ledger-runtime.js",
  "dist/clawsweeper-review-ledger.js",
  "dist/clawsweeper-apply-ledger.js",
  "dist/clawsweeper-plan-command.js",
  "dist/clawsweeper-action-commands.js",
]);

function sourceFile(root, name) {
  const path = resolve(root, name);
  const local = relative(root, path);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error(`Package input escapes its source root: ${name}`);
  }
  if (!lstatSync(path).isFile() || realpathSync(path) !== path) {
    throw new Error(`Package input must be a regular file without symlinks: ${name}`);
  }
  return readFileSync(path);
}

export async function collectLocalModules(root, entries) {
  root = realpathSync(root);
  await init();
  const files = new Map();
  const packages = new Set();
  const pending = [...entries];
  while (pending.length) {
    const name = pending.pop().replaceAll("\\", "/");
    if (files.has(name)) continue;
    if (HOSTED.has(name)) throw new Error(`Hosted module entered local package: ${name}`);
    const bytes = sourceFile(root, name);
    const [imports] = parse(bytes.toString("utf8"), name);
    files.set(name, bytes);
    for (const entry of imports) {
      if (entry.type === "import-meta") continue;
      if (
        !["static", "reexport-star", "dynamic"].includes(entry.type) ||
        entry.phase !== null ||
        typeof entry.specifier !== "string" ||
        (entry.type === "dynamic" && entry.glob)
      ) {
        throw new Error(`Unresolved module request in ${name}`);
      }
      const specifier = entry.specifier;
      if (isBuiltin(specifier)) continue;
      if (!specifier.startsWith(".")) {
        if (specifier.startsWith("/") || specifier.includes(":")) {
          throw new Error(`Unsupported module request in ${name}: ${specifier}`);
        }
        packages.add(
          specifier.startsWith("@")
            ? specifier.split("/").slice(0, 2).join("/")
            : specifier.split("/")[0],
        );
        continue;
      }
      const target = relative(root, resolve(root, dirname(name), specifier)).replaceAll("\\", "/");
      if (!target.startsWith("dist/") || !target.endsWith(".js")) {
        throw new Error(`Module request leaves compiled runtime in ${name}: ${specifier}`);
      }
      pending.push(target);
    }
  }
  return { files, packages };
}

export async function stageLocalPackage(destination, root = ROOT) {
  root = realpathSync(root);
  const metadata = JSON.parse(sourceFile(root, "package.json").toString("utf8"));
  const { files, packages } = await collectLocalModules(root, ENTRIES);
  const dependencies = {};
  for (const name of [...packages].sort()) {
    if (typeof metadata.dependencies?.[name] !== "string") {
      throw new Error(`Local runtime dependency is not declared for production: ${name}`);
    }
    dependencies[name] = metadata.dependencies[name];
  }
  for (const name of ASSETS) files.set(name, sourceFile(root, name));
  files.set("README.md", sourceFile(root, "docs/local-package.md"));
  files.set(
    "package.json",
    Buffer.from(
      JSON.stringify(
        {
          name: metadata.name,
          version: metadata.version,
          private: true,
          license: metadata.license,
          type: "module",
          engines: metadata.engines,
          bin: { "clawsweeper-review": "dist/clawsweeper-local.js" },
          files: [...files.keys()].sort(),
          ...(packages.size ? { dependencies } : {}),
        },
        null,
        2,
      ) + "\n",
    ),
  );
  destination = resolve(destination);
  // Never replace a prior stage or delete caller-owned output on failure.
  mkdirSync(destination);
  try {
    for (const [name, bytes] of files) {
      const path = resolve(destination, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes, { flag: "wx", mode: 0o644 });
    }
    chmodSync(resolve(destination, "dist/clawsweeper-local.js"), 0o755);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  return [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3)
      throw new Error("Usage: stage-local-package.mjs <new-directory>");
    console.log(JSON.stringify(await stageLocalPackage(process.argv[2])));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
