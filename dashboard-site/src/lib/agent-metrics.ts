// These contracts describe evidence we do not collect yet. Keep them separate
// from model assessments and operational proxies; missing evidence is not zero.
export const outcomeMeasures = [
  {
    name: "Verified useful outcomes",
    behavior: "Resolve real maintenance work correctly.",
    evidence: "Independent acceptance and an observed downstream result, linked to the reviewed revision.",
  },
  {
    name: "Time to useful outcome · p50 / p90",
    behavior: "Finish useful work sooner, including time spent waiting.",
    evidence: "Eligibility, accepted outcome and unresolved episode timestamps; report unresolved count and age too.",
  },
  {
    name: "Material decision error rate",
    behavior: "Avoid harmful closes, missed defects and misleading advice.",
    evidence: "Independent, sampled audits across all decision classes, including clean and held reviews.",
  },
  {
    name: "Human minutes per useful outcome",
    behavior: "Reduce maintainer effort without shifting work to contributors.",
    evidence: "Measured review, correction and escalation time; include effort spent on unsuccessful attempts.",
  },
  {
    name: "Total cost per useful outcome",
    behavior: "Spend less for the same independently verified result.",
    evidence: "Model, retry, tool and compute costs across every attempt in the cohort, including failed work.",
  },
  {
    name: "Correct abstention and escalation",
    behavior: "Ask for human judgment when evidence or authority is insufficient.",
    evidence: "Independent disposition of sampled escalations and sampled decisions made without escalation.",
  },
] as const;
