#!/usr/bin/env node

/**
 * Definition: run the repository-owned ClawSweeper automerge E2E harness.
 * Parameters: --scenario, --fixture, --candidate-root, --output, and --keep are optional.
 * Outputs: step logs plus summary.json under test-results/automerge by default;
 * exit 0 means the selected production flow reached its asserted terminal state.
 * Decision: external commands fail closed so newly introduced GitHub dependencies
 * cannot silently turn this into a partial integration test.
 */

import path from "node:path";
import { AUTOMERGE_E2E_SCENARIOS, runAutomergeE2E } from "../../test/e2e/automerge/run.mjs";
import { AUTOMERGE_E2E_FIXTURES } from "../../test/e2e/automerge/target-fixtures.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`Usage:
  node scripts/e2e/automerge.mjs [options]

Description:
  Runs the production automerge planner, executor, publisher, applicator, and
  exact-head comment-router merger against stateful GitHub/Codex simulators and
  a real local Git remote.

Options:
  --scenario <name>       Scenario to run; use all for the full suite
                          (default: happy-path)
  --fixture <name>        tiny, openclaw-shaped, or all (default: tiny)
  --expect <outcome>      success or setup-identity-failure (default: success)
  --list-scenarios        Print supported scenario names
  --list-fixtures         Print supported target fixture names
  --candidate-root <dir>  Built ClawSweeper checkout to validate (default: cwd)
  --output <dir>          Failure and proof artifact root
  --keep                  Keep the temporary scenario workspace
  -h, --help              Show this help

Outputs:
  <output>/<fixture>/<scenario>/summary.json and one stdout/stderr log per production step.
  Exit code 0 means all terminal-state and token-boundary assertions passed.

Examples:
  pnpm e2e:automerge
  pnpm e2e:automerge -- --scenario all --fixture all --output test-results/automerge
  pnpm e2e:automerge -- --scenario ci-regression-29623139111 --candidate-root ../clawsweeper-ci-regression --expect setup-identity-failure
`);
  process.exit(0);
}

if (args.listScenarios) {
  process.stdout.write(`${AUTOMERGE_E2E_SCENARIOS.join("\n")}\n`);
  process.exit(0);
}
if (args.listFixtures) {
  process.stdout.write(`${AUTOMERGE_E2E_FIXTURES.join("\n")}\n`);
  process.exit(0);
}

try {
  const selectedScenario = String(args.scenario ?? "happy-path");
  const selectedFixture = String(args.fixture ?? "tiny");
  const scenarios = selectedScenario === "all" ? AUTOMERGE_E2E_SCENARIOS : [selectedScenario];
  const fixtures = selectedFixture === "all" ? AUTOMERGE_E2E_FIXTURES : [selectedFixture];
  const results = fixtures.flatMap((fixture) =>
    scenarios.map((scenario) =>
      runAutomergeE2E({
        candidateRoot: path.resolve(String(args.candidateRoot ?? process.cwd())),
        outputRoot: path.resolve(
          String(args.output ?? path.join(process.cwd(), "test-results", "automerge")),
        ),
        expectedOutcome: String(args.expect ?? "success"),
        fixture,
        scenario,
        keep: Boolean(args.keep),
      }),
    ),
  );
  process.stdout.write(
    `${JSON.stringify(results.length === 1 ? results[0] : { status: "passed", results }, null, 2)}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "-h" || arg === "--help") out.help = true;
    else if (arg === "--list-scenarios") out.listScenarios = true;
    else if (arg === "--list-fixtures") out.listFixtures = true;
    else if (arg === "--keep") out.keep = true;
    else if (arg === "--scenario") out.scenario = requiredValue(argv, ++index, arg);
    else if (arg === "--fixture") out.fixture = requiredValue(argv, ++index, arg);
    else if (arg === "--expect") out.expect = requiredValue(argv, ++index, arg);
    else if (arg === "--candidate-root") out.candidateRoot = requiredValue(argv, ++index, arg);
    else if (arg === "--output") out.output = requiredValue(argv, ++index, arg);
    else throw new Error(`unknown option: ${arg}; use --help for usage`);
  }
  return out;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}
