import fs from "node:fs";
import { parseJob } from "../dist/repair/lib.js";
import { resolveTargetRepoToolchain } from "../dist/repair/target-toolchain-config.js";
import {
  repairActionsStepTimeoutMinutes,
  repairTimeoutBudgetFromEnv,
} from "../dist/repair/execute-fix-timeout-budget.js";

const job = parseJob(process.argv[2]);
const budget = repairTimeoutBudgetFromEnv(
  process.env,
  resolveTargetRepoToolchain(job.frontmatter.repo).validationTimeoutMs,
);
const timeoutMinutes = repairActionsStepTimeoutMinutes(budget);
fs.appendFileSync(process.env.GITHUB_OUTPUT, `timeout_minutes=${timeoutMinutes}\n`);
console.log(JSON.stringify({ ...budget, actionsStepTimeoutMinutes: timeoutMinutes }));
