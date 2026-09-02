export const namedTestRoles = [
  "test-support",
  "test-helpers",
  "test-utils",
  "test-harness",
  "test-fixtures",
] as const;

// OpenClaw 5ce7518f720a2ce9af8ebde7642010b4083c8ecd naming evidence; no target code executes.
export const pinnedTestRolePaths = [
  "src/agents/embedded-agent-runner/run.workspace-ownership.test-support.ts",
  "extensions/browser/src/browser/session-tab-registry.sqlite.test-helpers.ts",
  "extensions/discord/src/monitor/model-picker.test-utils.ts",
  "extensions/browser/chrome-extension/background.test-harness.ts",
  "extensions/codex/src/app-server/codex-app-server.test-fixtures.ts",
] as const;
