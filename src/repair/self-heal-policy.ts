import type { LooseRecord } from "./json-types.js";

export function shouldSelfHealRunRecord(record: LooseRecord): boolean {
  const postFlightOutcome = String(record.post_flight_outcome ?? "");
  if (postFlightOutcome === "requeue") return true;
  if (postFlightOutcome === "blocked") return false;
  return record.workflow_conclusion === "failure";
}
