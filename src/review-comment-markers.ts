// Workflow steps run src/workflow-bot-comments.ts from source, and it imports
// this module, so this module has no imports.

// Why a review comment carries a needs-human verdict (`hold=` marker attribute).
// The repair router routes on this value. It must not read review prose for this decision.
export type NeedsHumanHold =
  | "normalization_failed"
  | "review_identity"
  | "maintainer_decision"
  | "review_failed"
  | "security"
  | "proof"
  | "not_opted_in"
  | "blocked"
  | "undecided";

export function validReviewLeaseIdentity(
  owner: string | null | undefined,
  commentId: string | null | undefined,
): boolean {
  return (
    Boolean(owner?.trim()) &&
    owner?.trim() !== "unknown" &&
    /^[1-9]\d*$/.test(commentId ?? "") &&
    Number.isSafeInteger(Number(commentId))
  );
}

// The trailing marker of the comment that holds an item's review-start lease.
export function reviewStartLeaseCommentMarker(itemNumber: number): string {
  return `<!-- clawsweeper-review-lease item=${itemNumber} -->`;
}

// The trailing marker of a command status comment that holds the lease.
export function commandReviewStartLeaseCommentMarker(itemNumber: number): string {
  return `<!-- clawsweeper-command-review-lease item=${itemNumber} -->`;
}

export function hasReviewStartLeaseCommentMarker(body: string, itemNumber: number): boolean {
  return (
    body.includes(reviewStartLeaseCommentMarker(itemNumber)) ||
    body.includes(commandReviewStartLeaseCommentMarker(itemNumber))
  );
}

export function trailingHtmlComments(value: string): string[] {
  let end = value.length;
  const trailing: string[] = [];

  while (end > 0) {
    while (end > 0 && /\s/.test(value[end - 1] ?? "")) end -= 1;
    if (end === 0) break;
    if (!value.endsWith("-->", end)) break;

    const commentStart = value.lastIndexOf("<!--", end - 3);
    if (commentStart < 0) break;
    // An earlier terminator means this candidate spans visible prose.
    if (value.indexOf("-->", commentStart + 4) !== end - 3) break;
    trailing.push(value.slice(commentStart, end));
    end = commentStart;
  }

  return trailing.reverse();
}
