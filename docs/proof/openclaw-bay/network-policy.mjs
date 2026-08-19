export function isGitHubApiHostname(value) {
  const hostname = String(value || "")
    .trim()
    .toLowerCase();
  return hostname === "api.github.com" || hostname === "api.github.com.";
}
