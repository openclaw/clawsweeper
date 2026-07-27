#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { clusterIntakeIntent } from "./cluster-intake-state.js";
import { postStateAppend } from "./state-append-client.js";

export async function publishClusterIntake(
  intentPath: string,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<{ deduped: boolean }> {
  const env = options.env ?? process.env;
  const intent = clusterIntakeIntent(JSON.parse(readFileSync(intentPath, "utf8")));
  const queueUrl = env.QUEUE_URL ?? "";
  const webhookSecret = env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
  const deliveryId = `cluster-intake:${intent.repo_slug}:${intent.store_sha256}`;
  const result = await postStateAppend({
    queueUrl,
    webhookSecret,
    deliveryId,
    records: [
      {
        kind: "cluster_intake",
        key: `${intent.repo_slug}/${intent.store_sha256}`,
        payload: intent,
        produced_at: intent.accepted_at,
      },
    ],
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (!result.ok)
    throw new Error(
      result.shed ? "cluster intake durable queue is at capacity" : "cluster intake append failed",
    );
  console.log(
    `durable cluster intake ${result.deduped ? "already accepted" : "accepted"}: ${intent.jobs.length} job(s), delivery ${deliveryId}`,
  );
  return { deduped: result.deduped };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const intentPath = process.argv[2];
  if (!intentPath) {
    console.error("usage: publish-cluster-intake <intent.json>");
    process.exitCode = 2;
  } else {
    await publishClusterIntake(resolve(intentPath)).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
