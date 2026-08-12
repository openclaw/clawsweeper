export function trailingHtmlComments(value: string): string[] {
  let end = value.length;
  const trailing: string[] = [];

  while (end > 0) {
    while (end > 0 && /\s/.test(value[end - 1] ?? "")) end -= 1;
    if (end === 0) break;
    if (!value.endsWith("-->", end)) break;

    const commentStart = value.lastIndexOf("<!--", end - 3);
    if (commentStart < 0) break;
    trailing.push(value.slice(commentStart, end));
    end = commentStart;
  }

  return trailing.reverse();
}
