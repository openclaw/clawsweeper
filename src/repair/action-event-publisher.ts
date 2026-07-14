import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { isActionEventPublishPath } from "../action-ledger.js";
import { ACTION_EVENT_SHARD_IMPORT_MAX_PUBLISH_PATHS } from "../action-ledger-runtime.js";
import {
  publishMainCommit,
  type GitPublishOptions,
  type PublishCoordination,
  type PublishResult,
} from "./git-publish.js";

export const ACTION_EVENT_PUBLISH_PATH_FILE_MAX_BYTES =
  ACTION_EVENT_SHARD_IMPORT_MAX_PUBLISH_PATHS * 512;

export type ActionEventPublishResult = {
  result: PublishResult;
  pathCount: number;
  coordination: PublishCoordination;
};

export function actionEventPublishPaths(content: string): string[] {
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

export function actionEventPublishCoordination(
  env: NodeJS.ProcessEnv = process.env,
): PublishCoordination {
  return env.CLAWSWEEPER_ACTION_LEDGER_IMMUTABLE_PUBLISH === "1" ? "immutable" : "exclusive";
}

export function publishActionEventPaths(options: {
  pathsFile: string;
  message: string;
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  publish?: (options: GitPublishOptions) => PublishResult;
}): ActionEventPublishResult {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const pathsFile = resolve(options.pathsFile);
  const manifestStat = lstatSync(pathsFile);
  if (!manifestStat.isFile()) {
    throw new Error(`action event publish path manifest is not a regular file: ${pathsFile}`);
  }
  if (manifestStat.size > ACTION_EVENT_PUBLISH_PATH_FILE_MAX_BYTES) {
    throw new Error(
      `action event publish path manifest exceeds ${ACTION_EVENT_PUBLISH_PATH_FILE_MAX_BYTES} bytes`,
    );
  }
  const paths = actionEventPublishPaths(readFileSync(pathsFile, "utf8"));
  for (const path of paths) {
    const source = resolve(workspaceRoot, path);
    const workspaceRelativeSource = relative(workspaceRoot, source);
    if (
      !workspaceRelativeSource ||
      workspaceRelativeSource.startsWith("..") ||
      isAbsolute(workspaceRelativeSource) ||
      !lstatSync(source).isFile()
    ) {
      throw new Error(`action event publish path is not a regular file: ${path}`);
    }
  }
  const coordination = actionEventPublishCoordination(options.env);
  const result = (options.publish ?? publishMainCommit)({
    message: options.message,
    paths,
    coordination,
    rebaseStrategy: "normal",
  });
  return {
    result,
    pathCount: paths.length,
    coordination,
  };
}
