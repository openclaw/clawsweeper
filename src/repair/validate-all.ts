#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseJob, repoRoot, validateJob } from "./lib.js";

export function discoverJobFiles(jobsDir: string): string[] {
  return (
    fs
      .globSync("**/*.md", {
        cwd: jobsDir,
        withFileTypes: true,
        exclude: (entry) => entry.isDirectory() && entry.name === "closed",
      })
      // Preserve the old Dirent walker's refusal to follow or return symlinks.
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name))
      .sort()
  );
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
