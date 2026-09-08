#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { CommandProofConsumer } from "./command-proof-consumer.js";
import { CommandProofHttpTransport } from "./command-proof-http.js";
import { proofRecord, commandProofProducersFromEnv } from "../command-proof-contract.js";
import { parseOptions, runCommandStatusUpdate } from "./update-command-status.js";
import { planCommandProof } from "./command-proof-planner.js";

try {
  const transport = new CommandProofHttpTransport({
    githubToken: process.env.GH_TOKEN ?? "",
    queueUrl: process.env.QUEUE_URL ?? "",
    queueSecret: process.env.CLAWSWEEPER_WEBHOOK_SECRET ?? "",
    status: async (claim, state, detail) => {
      await runCommandStatusUpdate(
        parseOptions([
          "--repo",
          claim.repository,
          "--item-number",
          String(claim.pullRequest),
          "--marker",
          "<!-- clawsweeper-command-status:" +
            claim.pullRequest +
            ":request_proof:" +
            claim.requestId +
            " -->",
          "--state",
          state,
          "--detail",
          detail,
          "--locked-conversation-terminal-skip",
          "true",
        ]),
      );
    },
  });
  const consumer = new CommandProofConsumer(
    transport,
    commandProofProducersFromEnv(process.env),
    planCommandProof,
  );
  if (process.argv[2] === "reconcile" && process.argv.length === 3) {
    console.log(JSON.stringify(await consumer.reconcile()));
  } else if (process.argv[2] === "request" && process.argv.length === 4) {
    const file = process.argv[3]!;
    if (!statSync(file).isFile() || statSync(file).size > 4096)
      throw new Error("invalid_proof_input");
    const input = proofRecord(JSON.parse(readFileSync(file, "utf8")));
    console.log(
      JSON.stringify(
        await consumer.request({
          repository: String(input.repository),
          pullRequest: Number(input.pullRequest),
          commentId: String(input.commentId),
        }),
      ),
    );
  } else throw new Error("invalid_proof_command");
} catch {
  // Transport exceptions can include signed URLs or headers. Never mirror them.
  console.error("command_proof_operation_unavailable");
  process.exitCode = 1;
}
