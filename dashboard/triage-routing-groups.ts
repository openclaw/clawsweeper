export type TriageRoutingGroup = {
  id: string;
  title: string;
  labels: string[];
};

export const TRIAGE_ROUTING_GROUPS: TriageRoutingGroup[] = [
  {
    id: "message-delivery",
    title: "Message delivery",
    labels: ["impact:message-loss"],
  },
  {
    id: "auth-providers",
    title: "Auth providers",
    labels: ["impact:auth-provider"],
  },
  {
    id: "state-data",
    title: "State and data",
    labels: ["impact:session-state", "impact:data-loss"],
  },
  {
    id: "reliability",
    title: "Reliability",
    labels: ["impact:crash-loop"],
  },
  {
    id: "security",
    title: "Security",
    labels: ["impact:security"],
  },
  {
    id: "other-impact",
    title: "Other impact",
    labels: ["impact:other"],
  },
  {
    id: "unclassified",
    title: "Unclassified",
    labels: [],
  },
];

export function triageRoutingGroupsForLabels(
  labels: Array<{ name?: string } | string>,
): TriageRoutingGroup[] {
  const names = new Set(
    labels.map((label) =>
      String(typeof label === "string" ? label : label.name || "").toLowerCase(),
    ),
  );
  const matches = TRIAGE_ROUTING_GROUPS.filter(
    (group) => group.labels.length > 0 && group.labels.some((label) => names.has(label)),
  );
  return matches.length
    ? matches
    : TRIAGE_ROUTING_GROUPS.filter((group) => group.id === "unclassified");
}
