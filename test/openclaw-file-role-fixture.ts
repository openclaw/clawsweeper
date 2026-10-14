export const namedTestRoles = [
  "test-support",
  "test-helpers",
  "test-utils",
  "test-harness",
  "test-fixtures",
] as const;

// OpenClaw-style naming fixtures; no target code executes.
export const pinnedTestRolePaths = [
  "src/agents/embedded-agent-runner/run.workspace-ownership.test-support.ts",
  "extensions/browser/src/browser/session-tab-registry.sqlite.test-helpers.ts",
  "extensions/discord/src/monitor/model-picker.test-utils.ts",
  "extensions/browser/chrome-extension/background.test-harness.ts",
  "extensions/codex/src/session.test-fixtures.ts",
] as const;
