// Workflow steps select ClawSweeper's own GitHub comments and reactions with
// this command. They run it from source with the runner Node, so it imports
// only Node built-ins and owner modules that have no imports.
//
//   bot-logins
//     Prints every login ClawSweeper writes as, as a JSON array for `jq --argjson`.
//   review-lease-comment-ids --item-number N [--owner OWNER]
//     Reads REST issue comments as JSON lines on stdin (`gh api --jq '.[]'`) and
//     prints the id of each review-start lease comment a ClawSweeper App posted
//     for item N, limited to lease OWNER when given.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CLAWSWEEPER_APP_BOT_LOGINS, CLAWSWEEPER_BOT_LOGINS } from "./clawsweeper-bot-identity.ts";
import { hasReviewStartLeaseCommentMarker } from "./review-comment-markers.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { "item-number": { type: "string" }, owner: { type: "string" } },
});

switch (positionals[0]) {
  case "bot-logins":
    console.log(JSON.stringify([...CLAWSWEEPER_BOT_LOGINS]));
    break;
  case "review-lease-comment-ids": {
    const itemNumber = Number(values["item-number"]);
    if (!Number.isSafeInteger(itemNumber) || itemNumber < 1) {
      throw new Error("--item-number must be a positive integer");
    }
    const owner = values.owner;
    for (const line of readFileSync(0, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const comment = JSON.parse(line) as { id?: number; user?: { login?: string }; body?: string };
      const login = comment.user?.login;
      const body = typeof comment.body === "string" ? comment.body : "";
      if (
        // A REST login of bare "clawsweeper" is a user account, so only App logins count.
        typeof login === "string" &&
        CLAWSWEEPER_APP_BOT_LOGINS.has(login) &&
        hasReviewStartLeaseCommentMarker(body, itemNumber) &&
        (owner === undefined || body.includes(`owner=${owner} `))
      ) {
        console.log(comment.id);
      }
    }
    break;
  }
  default:
    throw new Error(
      "usage: workflow-bot-comments.ts bot-logins | review-lease-comment-ids --item-number N [--owner OWNER]",
    );
}
