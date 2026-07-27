#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export function changedStatePaths(options: {
  worktree: string;
  stateRoot: string;
  roots: readonly string[];
}): string[] {
  const paths = new Set<string>();
  for (const root of options.roots) {
    collectFiles(resolve(options.worktree, root), options.worktree, paths);
    collectFiles(resolve(options.stateRoot, root), options.stateRoot, paths);
  }
  return [...paths]
    .filter(
      (path) =>
        fileDigest(resolve(options.worktree, path)) !==
        fileDigest(resolve(options.stateRoot, path)),
    )
    .sort();
}

function collectFiles(directory: string, base: string, paths: Set<string>): void {
  if (!existsSync(directory)) return;
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink())
    throw new Error(`state delta root must not be a symlink: ${directory}`);
  if (stat.isFile()) {
    paths.add(relative(base, directory).split(sep).join("/"));
    return;
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = resolve(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`state delta path must not be a symlink: ${target}`);
    if (entry.isDirectory()) collectFiles(target, base, paths);
    else if (entry.isFile()) paths.add(relative(base, target).split(sep).join("/"));
  }
}

function fileDigest(path: string): string | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`state delta path is not a regular file: ${path}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (process.argv[1]?.endsWith("state-delta-paths.js")) {
  const values = process.argv.slice(2);
  const value = (name: string): string => {
    const index = values.indexOf(name);
    if (index < 0 || !values[index + 1]) throw new Error(`${name} is required`);
    return values[index + 1]!;
  };
  const roots = values.flatMap((item, index) =>
    item === "--root" && values[index + 1] ? [values[index + 1]!] : [],
  );
  if (roots.length === 0) throw new Error("at least one --root is required");
  const output = changedStatePaths({
    worktree: process.cwd(),
    stateRoot: resolve(value("--state-root")),
    roots,
  });
  writeFileSync(resolve(value("--out")), `${output.join("\n")}${output.length ? "\n" : ""}`);
  console.log(`state delta contains ${output.length} exact path(s)`);
}
