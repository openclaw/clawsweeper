import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import YAML from "yaml";

const workflow = YAML.parse(readFileSync(".github/workflows/sweep.yml", "utf8"));
const gate = workflow.jobs["event-review-apply"].steps.find(
  (step) => step.name === "Fail unsuccessful exact review generation",
);

function evaluate(expression, values) {
  const javascript = expression
    .replace(/\balways\(\)/g, "true")
    .replace(
      /steps\.([a-z0-9-]+)\.(outputs\.([a-z0-9_]+)|outcome)/g,
      (_match, stepId, access, outputName) =>
        JSON.stringify(values[`${stepId}.${outputName ?? access}`] ?? ""),
    );
  return Function(`"use strict"; return (${javascript});`)();
}

function resolve(template, values) {
  return String(template).replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, expression) =>
    String(evaluate(expression, values)),
  );
}

const scenarios = [
  {
    name: "durable-queue publication lane (direct publication not accepted), review generated and\n          published fine, only the lease completion callback failed (queue outage, 3 attempts)",
    values: {
      "claim-exact-review-queue.claimed": "true",
      "direct-exact-review-publication.accepted": "false",
      "complete-exact-review-queue.outcome": "failure",
      "reserve-exact-review-lease.status": "posted",
      "review-exact-event-item.superseded": "false",
      "review-exact-event-item.outcome": "success",
      "review-exact-event-item.exit_code": "0",
      "exact-review-generation-result.outcome": "success",
      "exact-review-generation-result.retry_kind": "",
    },
  },
  {
    name: "held same-head reservation (review skipped, durable retry deferral), only the lease\n          completion callback failed",
    values: {
      "claim-exact-review-queue.claimed": "true",
      "direct-exact-review-publication.accepted": "false",
      "complete-exact-review-queue.outcome": "failure",
      "reserve-exact-review-lease.status": "held",
      "review-exact-event-item.superseded": "false",
      "review-exact-event-item.outcome": "skipped",
      "review-exact-event-item.exit_code": "",
      "exact-review-generation-result.outcome": "failure",
      "exact-review-generation-result.retry_kind": "coordination",
    },
  },
  {
    name: "genuine review-lane failure (codex exited non-zero) with a durable lease completion",
    values: {
      "claim-exact-review-queue.claimed": "true",
      "direct-exact-review-publication.accepted": "false",
      "complete-exact-review-queue.outcome": "success",
      "reserve-exact-review-lease.status": "posted",
      "review-exact-event-item.superseded": "false",
      "review-exact-event-item.outcome": "failure",
      "review-exact-event-item.exit_code": "1",
      "exact-review-generation-result.outcome": "failure",
      "exact-review-generation-result.retry_kind": "",
    },
  },
];

for (const scenario of scenarios) {
  console.log(`scenario: ${scenario.name}`);
  const fires = Boolean(evaluate(gate.if.replace(/^\s*\$\{\{|\}\}\s*$/g, ""), scenario.values));
  console.log(
    `guard step if-expression evaluates: ${fires} -> ${fires ? "step runs, job goes red" : "step skipped"}`,
  );
  if (!fires) {
    console.log("");
    continue;
  }
  const env = Object.fromEntries(
    Object.entries(gate.env ?? {}).map(([name, template]) => [
      name,
      resolve(template, scenario.values),
    ]),
  );
  let stdout = "";
  let status = 0;
  try {
    stdout = execFileSync("bash", ["-c", gate.run], { env, encoding: "utf8" });
  } catch (error) {
    stdout = String(error.stdout ?? "");
    status = Number(error.status ?? 1);
  }
  console.log(
    `guard step run block executed verbatim, exit code ${status}, sole annotation emitted:`,
  );
  process.stdout.write(stdout);
  console.log("");
}
