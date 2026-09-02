#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  observeGitHubDebugStderr,
  recordGithubEgressMember,
  recordUnobservedGitHubInvocation,
} from "./github-egress-observer.js";

const mode = process.argv[2];
const separator = process.argv.indexOf("--");
const args = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2);
if (mode === "record-member") {
  recordGithubEgressMember();
} else if (mode === "record-unobserved") {
  recordUnobservedGitHubInvocation(args);
} else {
  const stderr = readFileSync(0);
  const debugEnabled = process.env.CLAWSWEEPER_GITHUB_DEBUG_ENABLED === "true";
  const clean = debugEnabled
    ? observeGitHubDebugStderr(stderr, args)
    : (recordUnobservedGitHubInvocation(args), stderr);
  process.stdout.write(clean);
}
