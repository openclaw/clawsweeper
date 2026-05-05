export type PolicyPatternType =
  | "file_conflict_type"
  | "label"
  | "repair_marker"
  | "review_verdict"
  | "safe_close_reason"
  | "automerge_repair_cause";

export interface PolicyPatternObservation {
  patternType: PolicyPatternType;
  value: string;
  repo: string;
  item: string;
  sourceRecord: string;
  observedAt?: string | undefined;
  successfulOutcome: boolean;
  detail?: string | undefined;
}

export interface PatternCollectorOptions {
  recordsRoot: string;
  targetRepo?: string | undefined;
}

export interface ScoredPolicyPattern {
  id: string;
  patternType: PolicyPatternType;
  value: string;
  title: string;
  confidenceScore: number;
  occurrenceCount: number;
  distinctItems: string[];
  distinctRepos: string[];
  successfulOutcomes: number;
  latestObservedAt?: string | undefined;
  evidenceItems: PolicyPatternObservation[];
  proposedConditions: string[];
  proposedAction: string;
  safetyConstraints: string[];
  sourceRecords: string[];
}

export interface PatternScorerOptions {
  minOccurrences: number;
  minDistinctItems?: number | undefined;
  minDistinctRepos?: number | undefined;
  now?: Date | undefined;
}

export interface PolicyProposalJson {
  id: string;
  title: string;
  status: "Draft";
  pattern_type: PolicyPatternType;
  evidence_items: Array<{
    repo: string;
    item: string;
    source_record: string;
    observed_at?: string | undefined;
    detail?: string | undefined;
  }>;
  confidence_score: number;
  proposed_conditions: string[];
  proposed_action: string;
  safety_constraints: string[];
  created_at: string;
  source_records: string[];
}

export interface SynthesizedPolicyProposal {
  id: string;
  markdown: string;
  json: PolicyProposalJson;
}

export interface SynthesizeOptions {
  createdAt?: string | undefined;
}
