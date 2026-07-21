export type DashboardHealth = {
  conclusion: "all_clear" | "needs_attention";
  severity: "green" | "amber" | "red";
  reasons: string[];
};

export function summarizeDashboardHealth(snapshot: Record<string, unknown>): DashboardHealth {
  const reasons: string[] = [];
  let severity: DashboardHealth["severity"] = "green";
  const raise = (next: DashboardHealth["severity"], reason: string) => {
    reasons.push(reason);
    if (next === "red" || (next === "amber" && severity === "green")) severity = next;
  };

  const diagnostics = objectValue(snapshot.diagnostics);
  const queue = objectValue(snapshot.exact_review_queue);
  const queueUnavailable =
    snapshot.exact_review_queue == null || Boolean(diagnostics.exact_review_queue_error);
  if (queueUnavailable) raise("amber", "queue_telemetry_unavailable");
  if (!queueUnavailable) {
    const handoffStatus = String(objectValue(queue.handoff_health).status || "");
    if (handoffStatus === "stalled") raise("red", "queue_handoff_stalled");
    else if (handoffStatus === "degraded") raise("amber", "queue_handoff_degraded");
    else if (!["healthy", "idle"].includes(handoffStatus)) {
      raise("amber", "queue_handoff_unavailable");
    }

    const publication = objectValue(objectValue(objectValue(queue.lanes).publication).health);
    const publicationStatus = String(publication.status || "");
    if (publicationStatus === "critical") raise("red", "publication_critical");
    else if (publicationStatus === "degraded") raise("amber", "publication_degraded");
    else if (!["healthy", "idle"].includes(publicationStatus)) {
      raise("amber", "publication_health_unavailable");
    }

    const openDeadLetters = nonNegativeNumber(
      objectValue(objectValue(objectValue(queue.lanes).publication).dead_letters).open,
    );
    if (openDeadLetters > 0) raise("amber", "publication_dlq_open");

    const reviewTelemetry = objectValue(queue.review_telemetry_health);
    const reviewTelemetryStatus = String(reviewTelemetry.status || "");
    if (reviewTelemetryStatus === "critical") raise("red", "orphan_review_status");
    else if (reviewTelemetryStatus === "degraded") raise("amber", "slow_review_status");
    else if (reviewTelemetryStatus !== "healthy") {
      raise("amber", "review_telemetry_unavailable");
    }
  }

  const operationalStatus = String(objectValue(snapshot.operational_health).status || "");
  if (operationalStatus === "stalled") raise("red", "workflow_execution_stalled");
  else if (!["healthy", "idle"].includes(operationalStatus)) {
    raise("amber", "workflow_execution_degraded");
  }

  const workerHealth = objectValue(snapshot.health);
  if (nonNegativeNumber(workerHealth.unresolved_failures) > 0) {
    raise("amber", "worker_failures_unresolved");
  }
  const recent = objectValue(snapshot.recent);
  const applyItems = arrayValue(objectValue(recent.apply_health).items);
  if (applyItems.some((item) => applyHealthNeedsAttention(objectValue(item).status))) {
    raise("amber", "apply_health_attention");
  }
  const automerge = objectValue(recent.automerge_reliability);
  if (
    nonNegativeNumber(automerge.unresolved_failures) > 0 ||
    nonNegativeNumber(automerge.stalled_attempts) > 0
  ) {
    raise("amber", "automerge_attention");
  }

  return {
    conclusion: reasons.length ? "needs_attention" : "all_clear",
    severity,
    reasons: [...new Set(reasons)],
  };
}

function applyHealthNeedsAttention(value: unknown) {
  return ["attention", "blocked", "degraded", "failed", "needs_attention", "warning"].includes(
    String(value || "").toLowerCase(),
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonNegativeNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}
