import {
  githubReadModelCommentObject,
  githubReadModelRequestSync,
  usableGithubReadModelResponse,
  type GithubReadModelResponse,
} from "../github-webhook-read-model-client.js";
import type { LooseRecord } from "./json-types.js";

export function readRepairLoopComments(options: {
  repository: string;
  number: number;
  liveRead: () => LooseRecord[];
  readModelRequest?: (
    operation: "comments" | "repair",
    payload: Record<string, unknown>,
  ) => GithubReadModelResponse | null;
}): LooseRecord[] {
  const request = options.readModelRequest ?? githubReadModelRequestSync;
  const snapshot = request("comments", {
    repository: options.repository,
    number: options.number,
  });
  if (usableGithubReadModelResponse(snapshot, "comment_router_repair_labels", "issue_comments")) {
    return Array.isArray(snapshot.comments) ? (snapshot.comments as LooseRecord[]) : [];
  }
  const comments = options.liveRead();
  const objects = comments.flatMap((comment) => {
    const object = githubReadModelCommentObject(options.repository, options.number, comment);
    return object ? [object] : [];
  });
  request("repair", {
    repository: options.repository,
    repair_kind: "comments",
    complete_comment_items: [options.number],
    objects,
  });
  return comments;
}
