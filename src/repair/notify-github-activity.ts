#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  normalizeGithubActivity,
  renderGithubActivityMessage,
  routineGithubActivityReason,
} from "./github-activity.js";
import { writeJsonFile } from "./json-file.js";
import { parseArgs, repoRoot } from "./lib.js";
import {
  boolEnv,
  describeHookDelivery,
  errorText,
  hookDeliveryFromError,
  hookDeliveryReport,
  isConclusiveHookDelivery,
  postOpenClawAgentHook,
  resolveOpenClawHookConfig,
  stringArg,
} from "./openclaw-hook.js";
import type { OpenClawHookDelivery } from "./openclaw-hook.js";

export type GithubActivityNotifierSummary = {
  status: "ok" | "skipped";
  sent: number;
  failed: number;
  exitCode: number;
  reason: string | null;
};

export type GithubActivityNotifierRuntime = {
  root?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (message: string) => void;
};

const DEFAULT_REPORT_PATH = "notifications/github-activity-report.json";

export async function runGithubActivityNotifier(
  argv: string[],
  runtime: GithubActivityNotifierRuntime = {},
): Promise<GithubActivityNotifierSummary> {
  const args = parseArgs(argv);
  const root = runtime.root ?? repoRoot();
  const env = runtime.env ?? process.env;
  const log = runtime.log ?? console.log;
  const fetcher = runtime.fetch ?? fetch;
  const now = runtime.now ?? (() => new Date());
  const eventPath = stringArg(args.input) ?? env.GITHUB_EVENT_PATH;
  const eventName = stringArg(args.event) ?? env.GITHUB_EVENT_NAME;
  const reportPath = path.resolve(root, stringArg(args.report) ?? DEFAULT_REPORT_PATH);
  const dryRun = Boolean(args["dry-run"] || env.CLAWSWEEPER_GITHUB_ACTIVITY_DRY_RUN === "1");
  const strict = Boolean(args.strict || env.CLAWSWEEPER_GITHUB_ACTIVITY_STRICT === "1");
  const deliver = boolEnv(env.CLAWSWEEPER_GITHUB_ACTIVITY_DELIVER, false);

  if (!eventPath || !eventName || !fs.existsSync(eventPath)) {
    const summary = summaryRow("skipped", 0, 0, "GitHub event payload missing");
    log(JSON.stringify(summary));
    return summary;
  }

  const activity = normalizeGithubActivity({
    eventName,
    payload: JSON.parse(fs.readFileSync(eventPath, "utf8")),
    env,
  });
  if (!activity) {
    const summary = summaryRow("skipped", 0, 0, `unsupported GitHub event: ${eventName}`);
    log(JSON.stringify(summary));
    return summary;
  }
  const observedAt = now().toISOString();
  const routineReason = routineGithubActivityReason(activity);
  if (routineReason) {
    if (args["write-report"]) {
      writeJsonFile(reportPath, {
        version: 1,
        generated_at: observedAt,
        event_name: eventName,
        event_path: path.relative(root, eventPath),
        dry_run: dryRun,
        deliver,
        hook_run_id: null,
        failed: 0,
        reason: routineReason,
        activity,
      });
    }
    const summary = summaryRow("skipped", 0, 0, routineReason);
    log(JSON.stringify(summary));
    return summary;
  }

  const config = resolveOpenClawHookConfig(env);
  if (!config) {
    const summary = summaryRow("skipped", 0, 0, "OpenClaw hook notification is not configured");
    log(JSON.stringify(summary));
    return summary;
  }

  let hookRunId: string | null = null;
  let delivery: OpenClawHookDelivery | null = null;
  let failed = 0;
  let reason: string | null = null;
  if (!dryRun) {
    try {
      const result = await postOpenClawAgentHook({
        config,
        fetcher,
        post: {
          name: `GitHub ${activity.type} ${activity.repo}`,
          message: renderGithubActivityMessage(activity, {
            discordTarget: config.discordTarget,
            observedAt,
          }),
          idempotencyKey: activity.idempotencyKey,
          deliver,
        },
      });
      hookRunId = result.runId;
      delivery = result.delivery;
      if (!isConclusiveHookDelivery(delivery)) {
        failed = 1;
        reason = describeHookDelivery(delivery);
      }
    } catch (error) {
      delivery = hookDeliveryFromError(error);
      failed = 1;
      reason = describeHookDelivery(delivery);
    }
  }

  if (args["write-report"]) {
    writeJsonFile(reportPath, {
      version: 1,
      generated_at: observedAt,
      event_name: eventName,
      event_path: path.relative(root, eventPath),
      dry_run: dryRun,
      deliver,
      hook_run_id: hookRunId,
      delivery: delivery ? hookDeliveryReport(delivery) : null,
      failed,
      reason,
      activity,
    });
  }
  if (delivery && env.GITHUB_STEP_SUMMARY) {
    appendGithubStepSummary(env.GITHUB_STEP_SUMMARY, delivery);
  }

  const summary = summaryRow("ok", failed ? 0 : 1, failed, reason);
  summary.exitCode = failed > 0 && strict ? 1 : 0;
  log(JSON.stringify(summary, null, 2));
  return summary;
}

function summaryRow(
  status: "ok" | "skipped",
  sent: number,
  failed: number,
  reason: string | null,
): GithubActivityNotifierSummary {
  return { status, sent, failed, exitCode: 0, reason };
}

function appendGithubStepSummary(summaryPath: string, delivery: OpenClawHookDelivery): void {
  const suppression = delivery.suppressionReason
    ? ` (${delivery.suppressionReason.replaceAll("`", "'")})`
    : "";
  fs.appendFileSync(
    summaryPath,
    `### OpenClaw notification\n\n- Delivery: \`${delivery.status}\`${suppression}\n`,
  );
}

async function main() {
  const summary = await runGithubActivityNotifier(process.argv.slice(2));
  if (summary.exitCode) process.exitCode = summary.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(errorText(error));
    process.exit(1);
  });
}
