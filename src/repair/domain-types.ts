import type { JsonArray, JsonObject, JsonValue } from "./json-types.js";

export type RepairMode = "plan" | "execute" | "autonomous";

export type RepairActionStatus =
  | "blocked"
  | "executed"
  | "failed"
  | "opened"
  | "planned"
  | "pushed"
  | "skipped";

export type RepairJobFrontmatter = JsonObject & {
  allowed_actions: JsonArray;
  allow_broad_fix_artifacts?: boolean;
  allow_fix_pr?: boolean;
  allow_instant_close?: boolean;
  allow_low_signal_pr_close?: boolean;
  allow_merge?: boolean;
  allow_post_merge_close?: boolean;
  allow_unmerged_fix_close?: boolean;
  blocked_actions?: JsonArray;
  candidates?: JsonArray;
  canonical?: JsonArray;
  cluster_id: string;
  cluster_refs?: JsonArray;
  job_intent?: string;
  mode: RepairMode;
  repair_mode?: "autofix" | "automerge";
  repo: string;
  require_fix_before_close?: boolean;
  require_human_for?: JsonArray;
  security_sensitive?: boolean;
};

export type RepairAction = JsonObject & {
  action?: string;
  reason?: string;
  status?: RepairActionStatus | string;
  target?: JsonValue;
};

export type RepairResult = JsonObject & {
  actions?: RepairAction[];
  cluster_id?: string;
  mode?: RepairMode;
  repo?: string;
};

export function isRepairMode(value: unknown): value is RepairMode {
  return value === "plan" || value === "execute" || value === "autonomous";
}
