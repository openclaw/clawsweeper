#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { acceptClusterIntakeIntent } from "./cluster-intake-state.js";
import { postStateAppend } from "./state-append-client.js";

export async function publishClusterIntake(
  intentPath: string,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<{ deduped: boolean }> {
  const env = options.env ?? process.env;
  const queueUrl = env.QUEUE_URL ?? "";
  const webhookSecret = env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
  const intent = acceptClusterIntakeIntent(
    JSON.parse(readFileSync(intentPath, "utf8")),
    webhookSecret,
  );
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
  // `pnpm run <script> -- <arg>` forwards the `--` separator literally on the
  // hosted runner's pnpm; accept the first real positional either way.
  const intentPath = process.argv.slice(2).find((argument) => argument !== "--");
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
