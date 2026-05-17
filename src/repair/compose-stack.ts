import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Per-repo Docker Compose test-stack support for the verify-reproduction
 * lane.
 *
 * A target repo opts into ephemeral service provisioning by shipping a
 * `docker-compose.test.yml` at its root. When the verify-reproduction lane
 * detects this file in the freshly-cloned target checkout, it brings the
 * stack up via `docker compose up -d --wait` BEFORE running the reviewer's
 * `work_validation` commands and tears it down via `down -v` afterwards,
 * regardless of whether the commands passed, failed, or threw.
 *
 * This is the universal contract that replaces the ClawSweeper-proprietary
 * service-manifest path: any repo whose test suite needs Postgres, Redis,
 * Mailpit, etc. owns its own compose file (same file works for local dev,
 * CI, and the autonomous lane). The lane stays repo-agnostic.
 *
 * Boot failure is fatal to the verification (we cannot run the reviewer's
 * commands without their declared services). Teardown failure is logged
 * but never fatal — orphaned containers on the runner are noisy but
 * recoverable; a misclassified test outcome is not.
 */

const COMPOSE_FILENAME = "docker-compose.test.yml";
const COMPOSE_UP_TIMEOUT_MS = 120_000; // includes Compose's --wait-timeout 90 + spawn overhead buffer
const COMPOSE_DOWN_TIMEOUT_MS = 60_000;
const COMPOSE_WAIT_TIMEOUT_SECONDS = "90";

export type ComposeContext = {
  composeFile: string;
  cwd: string;
};

/**
 * Return the absolute path to the target repo's test-stack compose file
 * if it declares one at its root, otherwise null.
 *
 * Pure function — exported for unit tests.
 */
export function detectComposeFile(targetCheckout: string): string | null {
  const candidate = path.join(targetCheckout, COMPOSE_FILENAME);
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Bring up the target repo's declared test stack via Docker Compose.
 *
 * Returns a `ComposeContext` the caller passes to `teardownComposeStack`
 * in a finally block, or null when the target repo does not declare a
 * compose file. Throws with the captured docker output on boot failure
 * so the caller can record a `verification_error` outcome with diagnostic
 * evidence.
 */
export function setupComposeStack(targetCheckout: string): ComposeContext | null {
  const composeFile = detectComposeFile(targetCheckout);
  if (!composeFile) return null;

  const result = spawnSync(
    "docker",
    [
      "compose",
      "-f",
      composeFile,
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      COMPOSE_WAIT_TIMEOUT_SECONDS,
    ],
    {
      cwd: targetCheckout,
      env: process.env,
      encoding: "utf8",
      timeout: COMPOSE_UP_TIMEOUT_MS,
    },
  );

  if (result.error) {
    throw new Error(
      `docker compose up failed for ${composeFile}: ${result.error.message ?? String(result.error)}`,
    );
  }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
    throw new Error(
      `docker compose up failed for ${composeFile} (exit ${result.status}):\n${detail || "no output captured"}`,
    );
  }

  return { composeFile, cwd: targetCheckout };
}

/**
 * Tear down the test stack. Best-effort: never throws. Failures are
 * surfaced to stderr so an operator scanning workflow logs sees the
 * orphan-container warning, but the lane's outcome is unaffected.
 */
export function teardownComposeStack(context: ComposeContext | null): void {
  if (!context) return;
  const result = spawnSync("docker", ["compose", "-f", context.composeFile, "down", "-v"], {
    cwd: context.cwd,
    env: process.env,
    encoding: "utf8",
    timeout: COMPOSE_DOWN_TIMEOUT_MS,
  });
  if (result.error) {
    process.stderr.write(
      `[compose-stack] teardown failed for ${context.composeFile}: ${result.error.message ?? String(result.error)}\n`,
    );
    return;
  }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
    process.stderr.write(
      `[compose-stack] teardown failed for ${context.composeFile} (exit ${result.status}): ${detail}\n`,
    );
  }
}
