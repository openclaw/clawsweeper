#!/usr/bin/env node
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

import {
  clusterJobTargetRepository,
  validateClusterJobContent,
  verifyClusterDispatchAuthenticationTag,
} from "./cluster-intake-state.js";

type RestoreClusterIntakeJobOptions = {
  root: string;
  jobPath: string;
  payload: string;
  digest: string;
  dispatchKey: string;
  authenticationTag: string;
  authenticationSecret: string;
  allowedOwner: string;
  mode: string;
  runner: string;
  executionRunner: string;
  plannerSandbox: string;
  model: string;
  dryRun: string;
};

export function restoreClusterIntakeJob(options: RestoreClusterIntakeJobOptions): void {
  const match = options.jobPath.match(
    /^jobs\/([A-Za-z0-9_.-]+)\/inbox\/gitcrawl-([1-9]\d*)-[A-Za-z0-9_.-]+\.md$/,
  );
  if (!match) throw new Error("invalid durable cluster intake job path");
  const owner = match[1]!;
  const clusterId = Number(match[2]);
  if (owner !== options.allowedOwner || !/^[A-Za-z0-9_.-]+$/.test(options.allowedOwner)) {
    throw new Error("durable cluster intake owner is not allowed");
  }
  if (!/^[a-f0-9]{64}$/.test(options.digest)) {
    throw new Error("invalid durable cluster intake job digest");
  }
  if (
    options.mode !== "autonomous" ||
    options.plannerSandbox !== "read-only" ||
    options.dryRun !== "false" ||
    !/^[A-Za-z0-9._-]{1,80}$/.test(options.runner) ||
    !/^[A-Za-z0-9._-]{1,80}$/.test(options.executionRunner) ||
    !/^[A-Za-z0-9._-]{1,80}$/.test(options.model)
  ) {
    throw new Error("durable cluster intake execution settings are invalid");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(options.payload) || options.payload.length % 4 !== 0) {
    throw new Error("invalid durable cluster intake payload encoding");
  }
  verifyClusterDispatchAuthenticationTag(
    options.authenticationSecret,
    {
      jobPath: options.jobPath,
      jobDigest: options.digest,
      dispatchKey: options.dispatchKey,
      mode: options.mode,
      runner: options.runner,
      executionRunner: options.executionRunner,
      plannerSandbox: options.plannerSandbox,
      model: options.model,
      dryRun: options.dryRun,
    },
    options.authenticationTag,
  );
  const content = Buffer.from(options.payload, "base64");
  if (content.length === 0 || content.length > 32 * 1024) {
    throw new Error("durable cluster intake payload size is invalid");
  }
  if (content.toString("base64") !== options.payload) {
    throw new Error("durable cluster intake payload encoding is not canonical");
  }
  if (createHash("sha256").update(content).digest("hex") !== options.digest) {
    throw new Error("durable cluster intake job digest mismatch");
  }
  const targetRepo = clusterJobTargetRepository(content.toString("utf8"));
  if (
    targetRepo.split("/")[0] !== owner ||
    options.dispatchKey !== `cluster-intake:${targetRepo.replace("/", "-")}:${clusterId}`
  ) {
    throw new Error("durable cluster intake dispatch identity mismatch");
  }
  validateClusterJobContent(content.toString("utf8"), targetRepo, clusterId);

  const root = resolve(options.root);
  const destination = resolve(root, options.jobPath);
  if (destination === root || !destination.startsWith(`${root}${sep}`)) {
    throw new Error("durable cluster intake job escapes the checkout");
  }
  const parent = dirname(destination);
  assertNoSymlinkComponents(root, parent);
  mkdirSync(parent, { recursive: true });
  assertNoSymlinkComponents(root, parent);
  if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) {
    throw new Error("refusing durable cluster intake job symlink");
  }
  const temporary = resolve(parent, `.${basename(destination)}.restore-${randomUUID()}`);
  let descriptor: number | undefined;
  let temporaryCreated = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    temporaryCreated = true;
    writeFileSync(descriptor, content);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporaryCreated) rmSync(temporary, { force: true });
  }
}

function assertNoSymlinkComponents(root: string, target: string): void {
  const relative = target.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const part of relative) {
    current = resolve(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error("durable cluster intake path contains a symlink");
    }
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name] ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  restoreClusterIntakeJob({
    root: process.cwd(),
    jobPath: requiredEnv("CLUSTER_JOB_PATH"),
    payload: requiredEnv("CLUSTER_JOB_PAYLOAD"),
    digest: requiredEnv("CLUSTER_JOB_DIGEST"),
    dispatchKey: requiredEnv("CLUSTER_DISPATCH_KEY"),
    authenticationTag: requiredEnv("CLUSTER_JOB_AUTH"),
    authenticationSecret: requiredEnv("CLAWSWEEPER_WEBHOOK_SECRET"),
    allowedOwner: requiredEnv("CLAWSWEEPER_ALLOWED_OWNER"),
    mode: requiredEnv("CLUSTER_WORKER_MODE"),
    runner: requiredEnv("CLUSTER_WORKER_RUNNER"),
    executionRunner: requiredEnv("CLUSTER_EXECUTION_RUNNER"),
    plannerSandbox: requiredEnv("CLUSTER_PLANNER_SANDBOX"),
    model: requiredEnv("CLUSTER_WORKER_MODEL"),
    dryRun: requiredEnv("CLUSTER_WORKER_DRY_RUN"),
  });
}
