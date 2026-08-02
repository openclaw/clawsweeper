import { readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isActionEventPublishPath } from "./action-ledger-paths.js";
import {
  ACTION_EVENT_SHARD_IMPORT_MAX_PUBLISH_PATHS,
  importActionEventShards,
  interruptOpenWorkflowActionEvents,
  workflowActionProducer,
} from "./action-ledger-runtime.js";
import { ACTION_EVENT_REASON_CODES } from "./action-ledger.js";
import { boolArg, optionalNumberArg, stringArg, type Args } from "./clawsweeper-args.js";
import { UserFacingCommandError } from "./command.js";
import { type RepositoryProfile } from "./repository-profiles.js";
import { publishStateBlob } from "./state-blob-client.js";

interface CreateActionCommandsDependencies {
  defaultClosedDir: (profile?: RepositoryProfile) => string;
  defaultItemsDir: (profile?: RepositoryProfile) => string;
  repoFromArgs: (args: Args) => RepositoryProfile;
  ROOT: string;
  updateDashboard: (itemsDir?: string, closedDir?: string) => void;
}

export function createActionCommands(dependencies: CreateActionCommandsDependencies) {
  const { defaultClosedDir, defaultItemsDir, repoFromArgs, ROOT, updateDashboard } = dependencies;

  function publishActionEventsCommand(args: Args): void {
    const sourceRoot = resolve(
      stringArg(args.source_root, join(ROOT, ".clawsweeper-repair", "action-ledger-download")),
    );
    const stateRoot = resolve(stringArg(args.state_root, ROOT));
    const expectedProducerJob = stringArg(args.expected_producer_job, "");
    if (!expectedProducerJob) {
      throw new UserFacingCommandError("--expected-producer-job is required");
    }
    const expectedProducerRunAttempt = optionalNumberArg(args.expected_producer_run_attempt);
    if (
      expectedProducerRunAttempt !== undefined &&
      (!Number.isInteger(expectedProducerRunAttempt) || expectedProducerRunAttempt < 1)
    ) {
      throw new UserFacingCommandError(
        "--expected-producer-run-attempt must be a positive integer",
      );
    }
    const expectedProducerRunId = stringArg(args.expected_producer_run_id, "");
    if (expectedProducerRunId && !/^\d{1,30}$/.test(expectedProducerRunId)) {
      throw new UserFacingCommandError(
        "--expected-producer-run-id must be a numeric workflow run ID",
      );
    }
    const expectedProducerSha = stringArg(args.expected_producer_sha, "");
    if (expectedProducerSha && !/^[0-9a-f]{40}$/.test(expectedProducerSha)) {
      throw new UserFacingCommandError("--expected-producer-sha must be a lowercase commit SHA");
    }
    const currentProducer = workflowActionProducer("action_event_publisher");
    const result = importActionEventShards(sourceRoot, stateRoot, {
      expectedProducer: {
        repository: currentProducer.repository,
        sha: expectedProducerSha || currentProducer.sha,
        workflow: currentProducer.workflow,
        job: expectedProducerJob,
        runId: expectedProducerRunId || currentProducer.runId,
        runAttempt: expectedProducerRunAttempt ?? currentProducer.runAttempt,
      },
    });
    console.log(JSON.stringify(result, null, 2));
  }

  const ACTION_EVENT_PUBLISH_PATH_FILE_MAX_BYTES =
    ACTION_EVENT_SHARD_IMPORT_MAX_PUBLISH_PATHS * 512;

  function actionEventPublishPathsForTest(content: string): string[] {
    if (Buffer.byteLength(content, "utf8") > ACTION_EVENT_PUBLISH_PATH_FILE_MAX_BYTES) {
      throw new Error(
        `action event publish path manifest exceeds ${ACTION_EVENT_PUBLISH_PATH_FILE_MAX_BYTES} bytes`,
      );
    }
    const paths = content.split("\n").filter(Boolean);
    if (paths.length === 0) throw new Error("action event publish path manifest is empty");
    if (paths.length > ACTION_EVENT_SHARD_IMPORT_MAX_PUBLISH_PATHS) {
      throw new Error(
        `action event publish path manifest exceeds ${ACTION_EVENT_SHARD_IMPORT_MAX_PUBLISH_PATHS} paths`,
      );
    }
    let previous = "";
    for (const path of paths) {
      if (!isActionEventPublishPath(path)) {
        throw new Error(`invalid action event publish path: ${path}`);
      }
      if (previous && path <= previous) {
        throw new Error("action event publish paths must be sorted and unique");
      }
      previous = path;
    }
    return paths;
  }

  async function publishActionEventPathsCommand(args: Args): Promise<void> {
    const pathsFile = resolve(stringArg(args.paths_file, ""));
    if (!pathsFile || pathsFile === ROOT) {
      throw new UserFacingCommandError("--paths-file is required");
    }
    const stat = statSync(pathsFile);
    if (!stat.isFile())
      throw new Error(`action event publish path manifest is not a file: ${pathsFile}`);
    if (stat.size > ACTION_EVENT_PUBLISH_PATH_FILE_MAX_BYTES) {
      throw new Error(
        `action event publish path manifest exceeds ${ACTION_EVENT_PUBLISH_PATH_FILE_MAX_BYTES} bytes`,
      );
    }
    const paths = actionEventPublishPathsForTest(readFileSync(pathsFile, "utf8"));
    for (const path of paths) {
      const source = resolve(ROOT, path);
      const rootRelativeSource = relative(ROOT, source);
      if (
        rootRelativeSource.startsWith("..") ||
        resolve(ROOT, rootRelativeSource) !== source ||
        !statSync(source).isFile()
      ) {
        throw new Error(`action event publish path is not a regular file: ${path}`);
      }
    }
    const baseUrl = process.env.QUEUE_URL ?? process.env.CLAWSWEEPER_RECORDS_URL ?? "";
    const webhookSecret = process.env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
    let uploaded = 0;
    let unchanged = 0;
    for (const path of paths) {
      const result = await publishStateBlob({
        baseUrl,
        webhookSecret,
        path,
        content: readFileSync(resolve(ROOT, path)),
      });
      if (result.unchanged) unchanged += 1;
      else uploaded += 1;
    }
    console.log(
      JSON.stringify({ result: "published", path_count: paths.length, uploaded, unchanged }),
    );
  }

  function isExplicitActionLedgerCommand(command: string): boolean {
    return (
      command === "finalize-action-events" ||
      command === "publish-action-events" ||
      command === "publish-action-event-paths"
    );
  }

  function dashboardCommand(args: Args): void {
    repoFromArgs(args);
    updateDashboard(
      resolve(stringArg(args.items_dir, defaultItemsDir())),
      resolve(stringArg(args.closed_dir, defaultClosedDir())),
    );
  }

  function finalizeActionEventsCommand(args: Args): void {
    if (!boolArg(args.interrupt_open_attempts)) return;
    const reason = stringArg(args.reason, ACTION_EVENT_REASON_CODES.timeout);
    if (
      reason !== ACTION_EVENT_REASON_CODES.timeout &&
      reason !== ACTION_EVENT_REASON_CODES.cancelled &&
      reason !== ACTION_EVENT_REASON_CODES.workflowFailed
    ) {
      throw new UserFacingCommandError(
        `Unsupported --reason for interrupted action events: ${reason}`,
      );
    }
    const interrupted = interruptOpenWorkflowActionEvents(ROOT, { reasonCode: reason });
    if (interrupted > 0) {
      console.error(
        `[action-ledger] recorded ${interrupted} ${reason} terminal event${
          interrupted === 1 ? "" : "s"
        }`,
      );
    }
  }

  return {
    actionEventPublishPathsForTest,
    dashboardCommand,
    finalizeActionEventsCommand,
    isExplicitActionLedgerCommand,
    publishActionEventPathsCommand,
    publishActionEventsCommand,
  };
}
