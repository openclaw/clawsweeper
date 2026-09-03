#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

// No network implementation: only this one fixture comment can be read/edited.
const args = process.argv.slice(2);
const path = process.env.PROOF_COMMENT;
const comment = JSON.parse(readFileSync(path, "utf8"));
if (args[0] !== "api" || args[1] !== "repos/proof/terminal-review/issues/comments/" + comment.id) {
  throw new Error("fixture rejects unexpected GitHub address");
}
const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
appendFileSync(process.env.PROOF_CALLS, JSON.stringify({ method, comment_id: comment.id }) + "\n");
if (method === "PATCH") {
  if (process.env.PROOF_MODE === "fail") process.exit(1);
  const payload = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8"));
  comment.body = payload.body;
  comment.updated_at = "2026-09-04T00:00:00.000Z";
  writeFileSync(path, JSON.stringify(comment));
  if (process.env.PROOF_MODE === "mismatch") comment.body = "mismatched response body";
} else if (method !== "GET") {
  throw new Error("fixture rejects comment creation/deletion");
}
process.stdout.write(JSON.stringify(comment));
