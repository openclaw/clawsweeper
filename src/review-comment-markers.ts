/**
 * Returns the final contiguous block of HTML comments at the end of `value`.
 *
 * Scanning is backward: from the end, each `-->` is paired with the nearest
 * preceding `<!--`. That pairing is only valid when the two genuinely delimit one
 * comment, so the candidate is rejected unless the opener's *first* terminator is
 * the one being matched — an HTML comment ends at its first `-->`, so anything
 * else means prose lies between them.
 *
 * Without that check, a stray `-->` in visible prose bridges back to an earlier
 * opener and swallows everything in between, including any real marker in that
 * span. Review bodies carry both: a mid-body `<!-- clawsweeper-review-history -->`
 * marker, and model-authored prose that can contain `-->` (Mermaid edges, ASCII
 * diagrams, Rust/Haskell arrows).
 */
export function trailingHtmlComments(value: string): string[] {
  let end = value.length;
  const trailing: string[] = [];

  while (end > 0) {
    while (end > 0 && /\s/.test(value[end - 1] ?? "")) end -= 1;
    if (end === 0) break;
    if (!value.endsWith("-->", end)) break;

    const commentStart = value.lastIndexOf("<!--", end - 3);
    if (commentStart < 0) break;
    // Prose between the opener and this terminator means the trailing block has
    // ended; stop rather than emitting a comment that spans visible text.
    if (value.indexOf("-->", commentStart + 4) !== end - 3) break;
    trailing.push(value.slice(commentStart, end));
    end = commentStart;
  }

  return trailing.reverse();
}
