#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { MANUAL_REVIEW_SOURCE_ACTION, RECORD_COMMENT_ONLY } from "../manual-publication-policy.js";
import { ExactReviewBatchQueueClient } from "./exact-review-batch-queue-client.js";
import { ghJsonWithRetry } from "./github-cli.js";
import { parseArgs } from "./lib.js";

export async function enqueueManualReviews(options: {
  targetRepo: string;
  targetBranch: string;
  codexTimeoutMs: number;
  additionalPrompt?: string;
  itemNumbers: number[];
  requestId: string;
  queueUrl: string;
  secret: string;
  itemKind: (number: number) => Promise<"issue" | "pull_request">;
  fetch?: typeof fetch;
}) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.targetRepo) ||
    !/^[A-Za-z0-9_./-]+$/.test(options.targetBranch) ||
    options.targetBranch.includes("..") ||
    !Number.isSafeInteger(options.codexTimeoutMs) ||
    options.codexTimeoutMs < 1 ||
    !/^[A-Za-z0-9_.:-]{1,150}$/.test(options.requestId) ||
    !options.itemNumbers.length ||
    options.itemNumbers.some((n) => !Number.isSafeInteger(n) || n < 1)
  ) {
    throw new Error("invalid explicit manual review selection");
  }
  const request = options.fetch ?? fetch;
  const response = await request(`${options.queueUrl.replace(/\/$/, "")}/api/exact-review-queue`, {
    signal: AbortSignal.timeout(20_000),
  });
  const capability = (await response.json()) as {
    manual_publication?: { policy?: unknown; enabled?: unknown };
  };
  if (
    !response.ok ||
    capability.manual_publication?.policy !== RECORD_COMMENT_ONLY ||
    capability.manual_publication.enabled !== true
  ) {
    throw new Error("queue does not advertise enabled manual record/comment-only publication");
  }
  const client = new ExactReviewBatchQueueClient({
    baseUrl: options.queueUrl,
    webhookSecret: options.secret,
    fetch: request,
  });
  const items: Array<{ number: number; accepted: boolean; error?: string }> = [];
  for (const number of new Set(options.itemNumbers)) {
    try {
      const itemKind = await options.itemKind(number);
      // No attempt number or mutable source metadata in the business identity.
      // The exact producer resolves live source under its coordinator claim.
      const result = await client.postEffect(
        "enqueue",
        JSON.stringify({
          delivery_id: `manual:${options.requestId}:${number}`,
          decision: {
            targetRepo: options.targetRepo,
            targetBranch: options.targetBranch,
            codexTimeoutMs: options.codexTimeoutMs,
            additionalPrompt: options.additionalPrompt ?? "",
            itemNumber: number,
            itemKind,
            sourceEvent: itemKind === "issue" ? "issues" : "pull_request",
            sourceAction: MANUAL_REVIEW_SOURCE_ACTION,
            publicationPolicy: RECORD_COMMENT_ONLY,
            supersedesInProgress: false,
          },
        }),
      );
      if (result.ok !== true || (result.queued !== true && result.deduped !== true))
        throw new Error("manual admission was not accepted");
      items.push({ number, accepted: true });
    } catch (error) {
      items.push({
        number,
        accepted: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    ok: items.every((item) => item.accepted),
    selected: items.length,
    accepted: items.filter((item) => item.accepted).length,
    items,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = (name: string) => {
    const value = args[name];
    if (typeof value !== "string" || !value) throw new Error(`--${name} is required`);
    return value;
  };
  const targetRepo = required("target-repo");
  const result = await enqueueManualReviews({
    targetRepo,
    targetBranch: required("target-branch"),
    codexTimeoutMs: Number(required("codex-timeout-ms")),
    additionalPrompt: process.env.ADDITIONAL_PROMPT || "",
    itemNumbers: required("item-numbers").split(",").map(Number),
    requestId: required("request-id"),
    queueUrl: required("queue-url"),
    secret: process.env.CLAWSWEEPER_WEBHOOK_SECRET || "",
    itemKind: async (number) => {
      const item = ghJsonWithRetry<{ pull_request?: unknown }>([
        "api",
        `repos/${targetRepo}/issues/${number}`,
      ]);
      return item.pull_request ? "pull_request" : "issue";
    },
  });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
