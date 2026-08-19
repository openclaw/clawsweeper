#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseJob, repoRoot, validateJob } from "./lib.js";

export function discoverJobFiles(jobsDir: string): string[] {
  const directories = [path.resolve(jobsDir)];
  const files: string[] = [];
  for (const directory of directories) {
    // Preserve readdir's fail-closed behavior before globbing direct children.
    fs.readdirSync(directory);
    for (const entry of fs.globSync(["*", ".*"], { cwd: directory, withFileTypes: true })) {
      const candidate = path.join(entry.parentPath, entry.name);
      if (entry.isDirectory() && entry.name !== "closed") directories.push(candidate);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(candidate);
    }
  }
  return files.sort();
}

function main() {
  const root = repoRoot();
  const jobsDir = path.join(root, "jobs");
  const files = discoverJobFiles(jobsDir);

  let failed = false;
  for (const file of files) {
    const job = parseJob(file);
    const errors = validateJob(job);
    if (errors.length > 0) {
      failed = true;
      console.error(`invalid job: ${job.relativePath}`);
      for (const error of errors) console.error(`- ${error}`);
    } else {
      console.log(`valid job: ${job.relativePath}`);
    }
  }

  if (failed) process.exit(1);
  console.log(`validated ${files.length} job(s)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
