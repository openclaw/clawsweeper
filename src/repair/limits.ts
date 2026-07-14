import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./paths.js";

export type WorkerConfig = {
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

export type AutomationLimits = {
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

export type WorkerLane =
  | "normal_review"
  | "hot_intake"
  | "commit_review"
  | "repair"
  | "automerge_repair"
  | "issue_implementation"
  | "cluster_repair"
  | "exact_item"
  | "assist";

export const WORKER_CONFIG = readWorkerConfig();
export const AUTOMATION_LIMITS = deriveAutomationLimits(WORKER_CONFIG);

export function readWorkerConfig(
  filePath = join(repoRoot(), "config", "automation-limits.json"),
): WorkerConfig {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  return validateWorkerConfig(parsed);
}

export function deriveAutomationLimits(config: WorkerConfig): AutomationLimits {
  const max = config.workers.max;
  const clusterRepairMax = Math.min(config.lanes.repair.cluster_max_live_runs, max);
  return {
    exact_review: {
      concurrent_max: Math.min(config.lanes.exact_review.max_concurrent, max),
      target_concurrent_max: Math.min(
        config.lanes.exact_review.target_max_concurrent,
        config.lanes.exact_review.max_concurrent,
        max,
      ),
    },
    assist: {
      default: Math.min(config.lanes.assist.max, max),
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

export function workerLimit(
  lane: WorkerLane,
  {
    activeCritical = 0,
    activeBackground = 0,
    config = WORKER_CONFIG,
    limits = AUTOMATION_LIMITS,
  }: {
    activeCritical?: number;
    activeBackground?: number;
    config?: WorkerConfig;
    limits?: AutomationLimits;
  } = {},
): number {
  if (lane === "exact_item") return limits.review_shards.exact_item_default;
  if (lane === "assist") return priorityLimit(limits.assist.default, activeCritical);
  if (lane === "repair") return priorityLimit(limits.repair_live_runs.default, activeCritical);
  if (lane === "automerge_repair")
    return priorityLimit(limits.repair_live_runs.automerge_default, activeCritical);
  if (lane === "issue_implementation")
    return priorityLimit(limits.repair_live_runs.issue_implementation_default, activeCritical);
  if (lane === "cluster_repair")
    return priorityLimit(limits.repair_live_runs.cluster_default, activeCritical);
  if (lane === "commit_review")
    return backgroundLimit(
      limits.commit_review.page_size_default,
      activeCritical,
      activeBackground,
    );
  if (lane === "hot_intake")
    return backgroundLimit(
      limits.review_shards.hot_intake_default,
      activeCritical,
      activeBackground,
    );
  return backgroundLimit(limits.review_shards.normal_default, activeCritical, activeBackground);

  function priorityLimit(laneMax: number, active: number): number {
    const available = Math.max(1, config.workers.max - nonNegative(active));
    return Math.max(1, Math.min(laneMax, available));
  }

  function backgroundLimit(laneMax: number, active: number, background: number): number {
    const rawAvailable =
      config.workers.max -
      config.workers.reserve_for_interactive -
      config.workers.expansion_reserve -
      nonNegative(active) -
      nonNegative(background);
    if (rawAvailable <= 0) return 1;
    const withFloor =
      rawAvailable >= config.workers.minimum_background ? rawAvailable : Math.max(1, rawAvailable);
    return Math.max(1, Math.min(laneMax, withFloor));
  }
}

function validateWorkerConfig(value: unknown): WorkerConfig {
  if (!isRecord(value)) throw new Error("automation limits must be an object");
  return {
    workers: {
      max: positiveInteger(value, "workers.max"),
      reserve_for_interactive: nonNegativeInteger(value, "workers.reserve_for_interactive"),
      expansion_reserve: nonNegativeInteger(value, "workers.expansion_reserve"),
      minimum_background: positiveInteger(value, "workers.minimum_background"),
    },
    lanes: {
      exact_review: {
        max_concurrent: positiveInteger(value, "lanes.exact_review.max_concurrent"),
        target_max_concurrent: optionalPositiveInteger(
          value,
          "lanes.exact_review.target_max_concurrent",
          positiveInteger(value, "lanes.exact_review.max_concurrent"),
        ),
      },
      assist: {
        max: positiveInteger(value, "lanes.assist.max"),
      },
      repair: {
        cluster_max_live_runs: optionalPositiveInteger(
          value,
          "lanes.repair.cluster_max_live_runs",
          1,
        ),
      },
    },
  };
}

function percent(max: number, value: number): number {
  return Math.max(1, Math.floor((max * value) / 100));
}

function positiveInteger(root: Record<string, unknown>, path: string): number {
  const value = getPath(root, path);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`automation limit ${path} must be a positive integer`);
  }
  return value;
}

function optionalPositiveInteger(
  root: Record<string, unknown>,
  path: string,
  fallback: number,
): number {
  const value = getOptionalPath(root, path);
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`automation limit ${path} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(root: Record<string, unknown>, path: string): number {
  const value = getPath(root, path);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`automation limit ${path} must be a non-negative integer`);
  }
  return value;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function getPath(root: Record<string, unknown>, path: string): unknown {
  const value = getOptionalPath(root, path);
  if (value === undefined) throw new Error(`automation limit ${path} is missing`);
  return value;
}

function getOptionalPath(root: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = root;
  for (const segment of path.split(".")) {
    if (!isRecord(cursor) || !(segment in cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
