#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

import { parse } from "yaml";

const runtimeRoot = process.cwd();
const typescriptPackage = readJson(join(runtimeRoot, "node_modules", "typescript", "package.json"));
const typescriptVersion = stringProperty(typescriptPackage, "version");
const nativeName = `typescript-${process.platform}-${process.arch}`;
if (!/^typescript-[a-z0-9]+-[a-z0-9]+$/.test(nativeName)) {
  throw new Error(`Unsupported TypeScript compiler package name: ${nativeName}`);
}
const nativePackage = `@typescript/${nativeName}`;
const lockfile = parse(readFileSync(join(runtimeRoot, "pnpm-lock.yaml"), "utf8"));
const packageKey = `${nativePackage}@${typescriptVersion}`;
const integrity = lockfile?.packages?.[packageKey]?.resolution?.integrity;
if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
  throw new Error(`Missing SHA-512 lockfile integrity for ${packageKey}.`);
}

const artifactDir = join(runtimeRoot, ".artifacts", "native-compiler");
mkdirSync(artifactDir, { recursive: true });
const suppliedTarball = process.env.CLAWSWEEPER_NATIVE_PACKAGE_TARBALL;
const tarballPath = suppliedTarball
  ? resolve(runtimeRoot, suppliedTarball)
  : packNativeCompiler(nativePackage, typescriptVersion, artifactDir);
verifyIntegrity(tarballPath, integrity);

const namespaceDir = join(runtimeRoot, "node_modules", "@typescript");
const nativeDir = join(namespaceDir, nativeName);
mkdirSync(namespaceDir, { recursive: true });
if (existsSync(nativeDir) && lstatSync(nativeDir).isSymbolicLink()) {
  throw new Error(`Refusing to replace symbolic-link compiler directory: ${nativeDir}`);
}
rmSync(nativeDir, { force: true, recursive: true });
mkdirSync(nativeDir, { recursive: true });
execFileSync("tar", ["-xzf", tarballPath, "-C", nativeDir, "--strip-components=1"], {
  stdio: "pipe",
});

const installedPackage = readJson(join(nativeDir, "package.json"));
if (
  stringProperty(installedPackage, "name") !== nativePackage ||
  stringProperty(installedPackage, "version") !== typescriptVersion
) {
  throw new Error(`Installed compiler package does not match ${packageKey}.`);
}
const compilerPath = join(nativeDir, "lib", process.platform === "win32" ? "tsc.exe" : "tsc");
accessSync(compilerPath, constants.X_OK);
execFileSync(compilerPath, ["--version"], { stdio: "pipe" });
console.log(`Installed verified review compiler ${packageKey}.`);

function packNativeCompiler(packageName, version, outputDirectory) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const output = execFileSync(
    npmCommand,
    [
      "pack",
      `${packageName}@${version}`,
      "--pack-destination",
      outputDirectory,
      "--ignore-scripts",
      "--json",
    ],
    { encoding: "utf8" },
  );
  const packed = JSON.parse(output);
  const filename = Array.isArray(packed) ? packed[0]?.filename : undefined;
  if (
    typeof filename !== "string" ||
    filename !== basename(filename) ||
    !filename.endsWith(".tgz")
  ) {
    throw new Error(`npm pack returned an invalid filename for ${packageName}@${version}.`);
  }
  return join(outputDirectory, filename);
}

function verifyIntegrity(tarballPath, integrity) {
  const expected = Buffer.from(integrity.slice("sha512-".length), "base64");
  const actual = createHash("sha512").update(readFileSync(tarballPath)).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error(`Compiler tarball integrity mismatch for ${tarballPath}.`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function stringProperty(value, property) {
  const result =
    value && typeof value === "object" && !Array.isArray(value) ? value[property] : undefined;
  if (typeof result !== "string" || !result) {
    throw new Error(`Expected non-empty ${property} in package metadata.`);
  }
  return result;
}
