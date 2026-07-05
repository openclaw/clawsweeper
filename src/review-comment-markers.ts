export function trailingHtmlComments(value: string): string[] {
  let cursor = 0;
  let trailing: string[] = [];

  while (cursor < value.length) {
    const commentStart = value.indexOf("<!--", cursor);
    if (commentStart < 0) break;
    const commentEnd = value.indexOf("-->", commentStart + 4);
    if (commentEnd < 0) break;

    if (value.slice(cursor, commentStart).trim()) trailing = [];
    trailing.push(value.slice(commentStart, commentEnd + 3));
    cursor = commentEnd + 3;
  }

  return value.slice(cursor).trim() ? [] : trailing;
}
