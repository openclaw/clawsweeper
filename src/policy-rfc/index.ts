#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { numberArg, parseArgs, stringArg } from "../clawsweeper-args.js";
import { repositoryProfileFor } from "../repository-profiles.js";
import { sortStable } from "../stable-json.js";
import { collectPolicyPatterns } from "./collector.js";
import { scorePolicyPatterns } from "./scorer.js";
import { synthesizePolicyProposal } from "./synthesizer.js";

export { collectPolicyPatterns } from "./collector.js";
export { scorePolicyPatterns } from "./scorer.js";
export { synthesizePolicyProposal } from "./synthesizer.js";
export type * from "./types.js";

interface RunPolicyRfcOptions {
  recordsRoot: string;
  outputRoot: string;
  targetRepo: string;
  minOccurrences: number;
  createdAt?: string | undefined;
}

export function runPolicyRfc(options: RunPolicyRfcOptions): {
  proposals: number;
  outputDir: string;
} {
  const profile = repositoryProfileFor(options.targetRepo);
  const outputDir = join(options.outputRoot, profile.slug);
  const observations = collectPolicyPatterns({
    recordsRoot: options.recordsRoot,
    targetRepo: options.targetRepo,
  });
  const scored = scorePolicyPatterns(observations, {
    minOccurrences: options.minOccurrences,
  });

  mkdirSync(outputDir, { recursive: true });
  for (const pattern of scored) {
    const proposal = synthesizePolicyProposal(pattern, { createdAt: options.createdAt });
    writeFileSync(join(outputDir, `${proposal.id}.md`), proposal.markdown);
    writeFileSync(
      join(outputDir, `${proposal.id}.json`),
      `${JSON.stringify(sortStable(proposal.json), null, 2)}\n`,
    );
  }

  return { proposals: scored.length, outputDir };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const targetRepo = stringArg(args.target_repo, "openclaw/openclaw");
  const recordsRoot = resolve(stringArg(args.records_root, "records"));
  const outputRoot = resolve(stringArg(args.output_root, "results/policy-rfc"));
  const minOccurrences = numberArg(args.min_occurrences, 5);
  const createdAt = typeof args.created_at === "string" ? args.created_at : undefined;
  const result = runPolicyRfc({
    recordsRoot,
    outputRoot,
    targetRepo,
    minOccurrences,
    createdAt,
  });
  console.log(`Policy RFC proposals written: ${result.proposals}`);
  console.log(`Output directory: ${result.outputDir}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
