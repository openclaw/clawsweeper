import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Run the production router with an isolated ledger and a loopback-only gh transport.
export function keylessCommentRouter(origin: string) {
  const sourceRoot = path.resolve(import.meta.dirname, "../..");
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "keyless-comment-router-")),
  );
  fs.cpSync(path.join(sourceRoot, "dist"), path.join(root, "dist"), { recursive: true });
  fs.cpSync(path.join(sourceRoot, "config"), path.join(root, "config"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"));
  for (const name of ["comment-router-runner.mjs", "operator-skip-reasons.mjs"]) {
    fs.copyFileSync(path.join(sourceRoot, "scripts", name), path.join(root, "scripts", name));
  }
  const gh = path.join(root, "gh.mjs");
  fs.writeFileSync(
    gh,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
let endpoint, body, method = "GET";
if (args[0] === "api") {
  endpoint = args[1];
  method = args.includes("--method") ? value("--method") : "GET";
  if (args.includes("--input")) body = fs.readFileSync(value("--input"), "utf8");
} else if (args[0] === "issue" && args[1] === "edit") {
  endpoint = "repos/" + value("--repo") + "/issues/" + args[2] + "/labels";
  if (args.includes("--add-label")) {
    method = "POST";
    body = JSON.stringify({ labels: [value("--add-label")] });
  } else {
    method = "DELETE";
    endpoint += "/" + encodeURIComponent(value("--remove-label"));
  }
} else if (args[0] === "label" && args[1] === "create") {
  endpoint = "repos/" + value("--repo") + "/labels";
  method = "POST";
  body = JSON.stringify({ name: args[2] });
} else {
  throw new Error("Unexpected gh command: " + JSON.stringify(args));
}
const url = new URL(endpoint, process.env.GITHUB_API_URL + "/");
if (url.origin !== process.env.GITHUB_API_URL) throw new Error("Non-loopback destination");
const response = await fetch(url, { method, body });
const text = await response.text();
if (!response.ok) {
  process.stderr.write("gh: " + text + " (HTTP " + response.status + ")");
  process.exit(1);
}
const result = text ? JSON.parse(text) : {};
process.stdout.write(JSON.stringify(args.includes("--slurp") ? [result] : result));
`,
    { mode: 0o755 },
  );
  return {
    close: () => fs.rmSync(root, { recursive: true, force: true }),
    async run(payload: Record<string, unknown>) {
      const args = [
        path.join(root, "scripts/comment-router-runner.mjs"),
        "--",
        "--write-report",
        "--execute",
        "--repo",
        String(payload.target_repo),
        "--comment-ids",
        String(payload.comment_id),
        "--item-numbers",
        String(payload.item_number),
        "--max-comments",
        "1",
        "--dispatch-actor",
        "openclaw-clawsweeper[bot]",
      ];
      for (const field of [
        "target_branch",
        "status_comment_id",
        "source_delivery_id",
        "source_event",
        "source_action",
        "comment_event_auth",
        "comment_updated_at",
        "comment_body_sha256",
      ]) {
        if (payload[field] != null && payload[field] !== "") {
          args.push(`--${field.replaceAll("_", "-")}`, String(payload[field]));
        }
      }
      const child = spawn(process.execPath, args, {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          GH_BIN: gh,
          GH_TOKEN: "synthetic-loopback-token",
          GITHUB_API_URL: origin,
          CLAWSWEEPER_STATE_DIR: root,
          CLAWSWEEPER_ACTION_LEDGER_FORCE: "0",
          CLAWSWEEPER_COMMENT_LOOKUP_CONCURRENCY: "1",
        },
      });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      if (code !== 0) throw new Error(`Router exited ${code}: ${output}`);
      return JSON.parse(
        fs.readFileSync(path.join(root, "results/comment-router-latest.json"), "utf8"),
      );
    },
  };
}
