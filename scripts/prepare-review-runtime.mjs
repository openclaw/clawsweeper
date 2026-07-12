#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const outputArgIndex = process.argv.indexOf("--output");
const outputArg = outputArgIndex >= 0 ? process.argv[outputArgIndex + 1] : undefined;
if (!outputArg || outputArg.startsWith("--")) {
  throw new Error("Usage: node scripts/prepare-review-runtime.mjs --output <directory>");
}

const outputRoot = resolve(repoRoot, outputArg);
if (outputRoot === repoRoot) {
  throw new Error("Review runtime output must not be the repository root.");
}

const distSource = join(repoRoot, "dist");
const typescriptSource = realpathSync(join(repoRoot, "node_modules", "typescript"));
const nativePackageName = `typescript-${process.platform}-${process.arch}`;
const nativeSource = realpathSync(
  join(dirname(typescriptSource), "@typescript", nativePackageName),
);

assertPackageName(typescriptSource, "typescript");
assertPackageName(nativeSource, `@typescript/${nativePackageName}`);
if (!existsSync(distSource)) {
  throw new Error("Built runtime not found. Run the build before preparing the review artifact.");
}

rmSync(outputRoot, { force: true, recursive: true });
mkdirSync(join(outputRoot, "node_modules", "@typescript"), { recursive: true });
cpSync(distSource, join(outputRoot, "dist"), { dereference: true, recursive: true });
cpSync(typescriptSource, join(outputRoot, "node_modules", "typescript"), {
  dereference: true,
  recursive: true,
});
cpSync(nativeSource, join(outputRoot, "node_modules", "@typescript", nativePackageName), {
  dereference: true,
  recursive: true,
});

console.log(`Prepared review runtime for ${process.platform}-${process.arch}.`);

function assertPackageName(directory, expectedName) {
  const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (packageJson.name !== expectedName) {
    throw new Error(`Expected ${expectedName}, found ${String(packageJson.name)}.`);
  }
}
