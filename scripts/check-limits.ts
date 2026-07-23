#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

type WorkerConfig = {
  workers: {
    max: number;
    reserve_for_interactive: number;
    expansion_reserve: number;
    minimum_background: number;
  };
  lanes: {
    exact_review: {
      max_concurrent: number;
      target_max_concurrent: number;
    };
    assist: {
      max: number;
    };
    repair: {
      cluster_max_live_runs: number;
    };
  };
};

type AutomationLimits = {
  exact_review: {
    concurrent_max: number;
    target_concurrent_max: number;
  };
  assist: {
    default: number;
  };
  review_shards: {
    normal_default: number;
    normal_active_floor: number;
    hot_intake_default: number;
    exact_item_default: number;
    hard_cap: number;
  };
  commit_review: {
    page_size_default: number;
    page_size_hard_cap: number;
  };
  repair_live_runs: {
    default: number;
    hard_cap: number;
    automerge_default: number;
    issue_implementation_default: number;
    cluster_default: number;
  };
  issue_implementation: {
    dispatches_per_sweep_default: number;
  };
};

const root = process.cwd();
const config = JSON.parse(
  fs.readFileSync(path.join(root, "config", "automation-limits.json"), "utf8"),
) as WorkerConfig;
const limits = deriveAutomationLimits(config);

const expectations: { file: string; label: string; pattern: RegExp }[] = [
  {
    file: ".github/workflows/sweep.yml",
    label: "manual workflow_dispatch shard_count default",
    pattern: new RegExp(
      `shard_count:[\\s\\S]{0,180}default: "${limits.review_shards.normal_default}"`,
    ),
  },
  {
    file: "dashboard/wrangler.toml",
    label: "dashboard worker budget",
    pattern: new RegExp(`WORKER_BUDGET = "${config.workers.max}"`),
  },
  {
    file: "dashboard/wrangler.toml",
    label: "exact review queue global cap",
    pattern: new RegExp(
      `EXACT_REVIEW_QUEUE_MAX_CONCURRENT = "${limits.exact_review.concurrent_max}"`,
    ),
  },
  {
    file: "dashboard/wrangler.toml",
    label: "exact review queue target cap",
    pattern: new RegExp(
      `EXACT_REVIEW_TARGET_MAX_CONCURRENT = "${limits.exact_review.target_concurrent_max}"`,
    ),
  },
  {
    file: "dashboard/exact-review-queue.ts",
    label: "dashboard worker budget fallback",
    pattern: new RegExp(`numberFrom\\(env\\.WORKER_BUDGET, ${config.workers.max}\\)`),
  },
  {
    file: "README.md",
    label: "manual plan shard-count example",
    pattern: new RegExp(`--shard-count ${limits.review_shards.normal_default}\\b`),
  },
  {
    file: "docs/commit-dispatcher.md",
    label: "commit review page size env example",
    pattern: new RegExp(
      `CLAWSWEEPER_COMMIT_REVIEW_PAGE_SIZE=${limits.commit_review.page_size_default}\\b`,
    ),
  },
  {
    file: "docs/commit-sweeper.md",
    label: "commit review page size default",
    pattern: new RegExp(`defaults to ${limits.commit_review.page_size_default}\\b`),
  },
  {
    file: "docs/repair/README.md",
    label: "normal repair live run default",
    pattern: new RegExp(`CLAWSWEEPER_MAX_LIVE_WORKERS=${limits.repair_live_runs.default}\\b`),
  },
  {
    file: "docs/repair/README.md",
    label: "imported cluster repair live run example",
    pattern: new RegExp(
      `CLAWSWEEPER_MAX_LIVE_WORKERS=${limits.repair_live_runs.cluster_default}\\b`,
    ),
  },
  {
    file: "docs/scheduler.md",
    label: "normal review shard default",
    pattern: new RegExp(`${limits.review_shards.normal_default} concurrent Codex\\s+review shards`),
  },
  {
    file: "docs/scheduler.md",
    label: "normal active shard floor",
    pattern: new RegExp(`fewer than ${limits.review_shards.normal_active_floor} items are due`),
  },
  {
    file: "docs/scheduler.md",
    label: "hot intake shard default",
    pattern: new RegExp(
      `broad hot intake: up to ${limits.review_shards.hot_intake_default} shards`,
    ),
  },
  {
    file: "docs/limits.md",
    label: "limits documentation references source file",
    pattern: /config\/automation-limits\.json/,
  },
  {
    file: "README.md",
    label: "readme exact review global cap",
    pattern: new RegExp(`leases at most ${limits.exact_review.concurrent_max} concurrent reviews`),
  },
  {
    file: "README.md",
    label: "readme exact review target cap",
    pattern: new RegExp(
      `up to ${limits.exact_review.target_concurrent_max} active exact reviews per target repository`,
    ),
  },
  {
    file: "docs/target-dispatcher.md",
    label: "target dispatcher exact review global cap",
    pattern: new RegExp(
      `at most ${limits.exact_review.concurrent_max} leased exact-review executors`,
    ),
  },
  {
    file: "docs/target-dispatcher.md",
    label: "target dispatcher exact review target cap",
    pattern: new RegExp(
      `up to ${limits.exact_review.target_concurrent_max} active\\s+reviews per target repository`,
    ),
  },
  {
    file: "docs/live-dashboard.md",
    label: "dashboard exact review global cap",
    pattern: new RegExp(
      `leases at most\\s+${limits.exact_review.concurrent_max} Actions executors`,
    ),
  },
  {
    file: "docs/live-dashboard.md",
    label: "dashboard exact review target cap",
    pattern: new RegExp(
      `with up to ${limits.exact_review.target_concurrent_max} active leases per target repository`,
    ),
  },
];

for (const [limitPath, value] of Object.entries(flattenLimits(limits))) {
  expectations.push({
    file: "docs/limits.md",
    label: `${limitPath} documented current value`,
    pattern: limitTableValuePattern(limitPath, value),
  });
}
for (const [limitPath, value] of Object.entries(flattenLimits(config))) {
  expectations.push({
    file: "docs/limits.md",
    label: `${limitPath} documented worker config value`,
    pattern: limitTableValuePattern(limitPath, value),
  });
}

const missing: string[] = [];
for (const expectation of expectations) {
  const text = fs.readFileSync(path.join(root, expectation.file), "utf8");
  if (!expectation.pattern.test(text)) {
    missing.push(`${expectation.file}: ${expectation.label}`);
  }
}

if (missing.length > 0) {
  console.error("Automation limits drift check failed:");
  for (const item of missing) console.error(`- ${item}`);
  process.exit(1);
}

function flattenLimits(value: unknown, prefix = ""): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(value)) return out;
  for (const [key, child] of Object.entries(value)) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (Number.isInteger(child)) {
      out[childPath] = child;
    } else {
      Object.assign(out, flattenLimits(child, childPath));
    }
  }
  return out;
}

function deriveAutomationLimits(workerConfig: WorkerConfig): AutomationLimits {
  const max = workerConfig.workers.max;
  const clusterRepairMax = Math.min(workerConfig.lanes.repair.cluster_max_live_runs, max);
  return {
    exact_review: {
      concurrent_max: Math.min(workerConfig.lanes.exact_review.max_concurrent, max),
      target_concurrent_max: Math.min(
        workerConfig.lanes.exact_review.target_max_concurrent,
        workerConfig.lanes.exact_review.max_concurrent,
        max,
      ),
    },
    assist: {
      default: Math.min(workerConfig.lanes.assist.max, max),
    },
    review_shards: {
      normal_default: percent(max, 70),
      normal_active_floor: percent(max, 30),
      hot_intake_default: percent(max, 35),
      exact_item_default: 1,
      hard_cap: max,
    },
    commit_review: {
      page_size_default: percent(max, 5),
      page_size_hard_cap: max,
    },
    repair_live_runs: {
      default: percent(max, 40),
      hard_cap: max,
      automerge_default: percent(max, 40),
      issue_implementation_default: percent(max, 40),
      cluster_default: clusterRepairMax,
    },
    issue_implementation: {
      dispatches_per_sweep_default: percent(max, 4),
    },
  };
}

function percent(max: number, value: number): number {
  return Math.max(1, Math.floor((max * value) / 100));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function limitTableValuePattern(limitPath: string, value: number): RegExp {
  return new RegExp(`\\|\\s+\`${escapeRegExp(limitPath)}\`\\s+\\|\\s+${value}\\s+\\|`);
}
