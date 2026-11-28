import { CLAWSWEEPER_APP_BOT_LOGINS } from "../clawsweeper-bot-identity.js";
import { ghPaged } from "../clawsweeper-github-context.js";
import { ghJson } from "../clawsweeper-github-execution.js";
import { withGitHubRun } from "../clawsweeper-github-runtime.js";
import { ghTextWithRetry } from "./github-cli.js";
import { requiredEnv } from "../required-env.js";
import { setTargetRepo } from "../repository-profiles.js";
import {
  clearInPlaceReviewStartStatus,
  commandReviewStartLeaseCommentMarker,
  reviewStartLeaseCommentMarker,
} from "../review-comment-markers.js";

type Comment = { id: number; user: { login: string }; body: string };

const repo = requiredEnv("TARGET_REPO");
const number = Number(requiredEnv("ITEM_NUMBER"));
if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid item number");
setTargetRepo(repo);
const issue = `repos/${repo}/issues/${number}`;
// A dedicated lease can be deleted. An in-place lease shares its comment with
// a durable review, so only its status header and lease marker can be removed.
function terminalLeaseUpdate(comment: Comment): { body: string } | "delete" | undefined {
  if (!CLAWSWEEPER_APP_BOT_LOGINS.has(comment.user?.login)) return;
  const body = comment.body;
  if (typeof body !== "string" || /<!--\s*clawsweeper-command-(?:ack|status):/i.test(body)) return;
  const cleared = clearInPlaceReviewStartStatus(body, number);
  if (cleared !== body) return { body: cleared };
  const tail = body.trimEnd();
  if (
    tail.endsWith(reviewStartLeaseCommentMarker(number)) ||
    tail.endsWith(commandReviewStartLeaseCommentMarker(number))
  )
    return "delete";
}

withGitHubRun(() => {
  const item = ghJson<{ state: string; locked: boolean }>(["api", issue]);
  if (item.state !== "closed") {
    throw new Error(`Cannot release terminal review leases on open item ${repo}#${number}`);
  }

  function cleanupWrite(path: string, method: "DELETE" | "PATCH", body?: string) {
    try {
      const args = ["api", path, "--method", method];
      if (body !== undefined) args.push("--input", "-");
      ghTextWithRetry(args, body === undefined ? {} : { input: JSON.stringify({ body }) });
    } catch (error) {
      // A locked conversation can reject an individual write even when the
      // installation can edit other comments or remove its eyes reaction.
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      if (!item.locked || !/^(?:gh:\s*)?HTTP 403\b|\(HTTP 403\)\s*$/im.test(stderr)) throw error;
      console.log(JSON.stringify({ action: "skipped_locked_conversation", method, path }));
    }
  }

  for (const listed of ghPaged<Comment>(`${issue}/comments`)) {
    if (!terminalLeaseUpdate(listed)) continue;
    const path = `repos/${repo}/issues/comments/${listed.id}`;
    const current = ghJson<Comment>(["api", path], { losslessJson: true });
    const update = terminalLeaseUpdate(current);
    if (update === "delete") cleanupWrite(path, "DELETE");
    else if (update) cleanupWrite(path, "PATCH", update.body);
  }

  type Reaction = { id: number; content: string; user: { login: string } };
  for (const reaction of ghPaged<Reaction>(`${issue}/reactions?content=eyes`)) {
    if (reaction.content === "eyes" && CLAWSWEEPER_APP_BOT_LOGINS.has(reaction.user?.login)) {
      cleanupWrite(`${issue}/reactions/${reaction.id}`, "DELETE");
    }
  }
});
