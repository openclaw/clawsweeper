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
