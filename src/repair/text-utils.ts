export function compactText(value: unknown, maxLength: number) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) return text;
  // Below the ellipsis width there's no room for "..."; slicing to `maxLength-3` and always
  // appending "..." overflowed the cap (e.g. maxLength 2 returned "..." of length 3).
  if (maxLength <= 16) {
    if (maxLength < 3) return text.slice(0, Math.max(0, maxLength));
    return `${text.slice(0, maxLength - 3)}...`;
  }

  const marker = " ... ";
  const available = Math.max(0, maxLength - marker.length);
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${text.slice(0, headLength)}${marker}${text.slice(text.length - tailLength)}`;
}

export function escapeRegExp(value: unknown) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function slug(value: unknown, fallback = "unknown", maxLength = 120) {
  return (
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, maxLength)
      .replace(/-+$/g, "") || fallback
  );
}
