import { readFileSync } from "node:fs";
import { oversizedPullRequestAdmission } from "./clawsweeper-oversized-pr-policy.js";
import type { Item } from "./clawsweeper-types.js";
import { labelNames } from "./clawsweeper-item-policy.js";
import { normalizeRepo } from "./repository-profiles.js";
import { recordOrEmpty, stringOrEmpty } from "./value-coerce.js";

/** Workflow-owned handoff of the metadata already read during live admission. */
export function readPrAdmissionInput(path: string, repo: string, numbers: readonly number[]) {
  const input = recordOrEmpty(JSON.parse(readFileSync(path, "utf8")));
  const pull = recordOrEmpty(input.pull);
  const number = Number(pull.number);
  // The workflow records the repo as GitHub spells it; fallback profiles carry
  // the lowercased slug, so compare the normalized forms.
  if (
    typeof input.repo !== "string" ||
    normalizeRepo(input.repo) !== normalizeRepo(repo) ||
    numbers.length !== 1 ||
    numbers[0] !== number ||
    pull.state !== "open"
  ) {
    throw new Error("PR admission metadata does not match the selected open pull request");
  }
  const labels = labelNames(pull.labels);
  const item: Item = {
    repo,
    number,
    kind: "pull_request",
    title: stringOrEmpty(pull.title),
    url: `https://github.com/${repo}/pull/${number}`,
    createdAt: stringOrEmpty(pull.created_at),
    updatedAt: stringOrEmpty(pull.updated_at),
    author: stringOrEmpty(recordOrEmpty(pull.user).login),
    authorAssociation: stringOrEmpty(pull.author_association) || "NONE",
    labels,
    locked: pull.locked === true,
  };
  const observedAt =
    typeof input.observedAt === "string" && Number.isFinite(Date.parse(input.observedAt))
      ? input.observedAt
      : undefined;
  return { item, pull, observedAt, admission: oversizedPullRequestAdmission(pull) };
}
