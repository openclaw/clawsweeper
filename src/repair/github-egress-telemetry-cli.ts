#!/usr/bin/env node
import { join } from "node:path";
import {
  githubEgressTelemetrySubmissions,
  submitGitHubEgressTelemetry,
} from "./github-egress-telemetry-client.js";

if (process.argv[2] !== "submit") {
  throw new Error("usage: github-egress-telemetry-cli.ts submit");
}

const root = process.env.GITHUB_WORKSPACE || process.cwd();
const metricsPath =
  process.env.CLAWSWEEPER_GITHUB_EGRESS_METRICS_PATH ||
  join(root, ".artifacts/github-egress/metrics-v2.jsonl");
const rateLimitPath =
  process.env.CLAWSWEEPER_GITHUB_RATE_LIMIT_DETAILS_PATH ||
  join(root, ".artifacts/github-egress/rate-limits-v2.jsonl");
const submissions = githubEgressTelemetrySubmissions({ metricsPath, rateLimitPath });
let accepted = 0;
let deduped = 0;
for (const submission of submissions) {
  const result = await submitGitHubEgressTelemetry({
    baseUrl: env("EXACT_REVIEW_QUEUE_URL"),
    webhookSecret: env("CLAWSWEEPER_WEBHOOK_SECRET"),
    submission,
  });
  if (result.accepted) accepted += 1;
  if (result.deduped) deduped += 1;
}
console.log(JSON.stringify({ ok: true, submissions: submissions.length, accepted, deduped }));

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
