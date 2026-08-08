#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const scorecardPath = process.argv[2] || "qa/maturity-scores.yaml";

if (!existsSync(scorecardPath)) {
  console.error(`Maturity scorecard not found: ${scorecardPath}`);
  process.exit(1);
}

console.log(stableShortlist(readFileSync(scorecardPath, "utf8")));

function stableShortlist(text) {
  const scorecard = parse(text);
  const surfaces = Array.isArray(scorecard?.surfaces) ? scorecard.surfaces : [];
  const rows = surfaces.map(surfaceSummary);
  const stableRows = rows.filter((surface) => maturityCode(surface) >= 4);
  const nonStableRows = rows.filter((surface) => maturityCode(surface) < 4);

  return [
    "Conservative rule: maturity:stable is for broken existing behavior, not feature proposals, new capabilities, UX preferences, new config or policy choices, docs/support work, cleanup, or unclear reports. M4+ ownership is necessary but not sufficient; use no maturity label when the existing contract or primary owner is ambiguous.",
    "Primary-surface rule: classify the issue by the product surface that owns the broken behavior. Shared Gateway/CLI transit, APIs, hosting, or diagnostics do not make a lower-maturity owner eligible.",
    "",
    "M4+ candidate primary owners (the issue must still report broken existing behavior):",
    ...(stableRows.length > 0
      ? stableRows.map((surface) => {
          const categories = surface.categories.length
            ? ` | categories: ${surface.categories.join("; ")}`
            : "";
          return `${surface.id} | ${surface.name} | ${surface.code} ${surface.label} | q${surface.quality} c${surface.completeness}${categories}`;
        })
      : ["No M4+ maturity scorecard surfaces found."]),
    "",
    "Below-M4 primary surfaces (not eligible for maturity:stable):",
    ...(nonStableRows.length > 0
      ? nonStableRows.map(
          (surface) => `${surface.id} | ${surface.name} | ${surface.code} ${surface.label}`,
        )
      : ["No below-M4 maturity scorecard surfaces found."]),
  ].join("\n");
}

function maturityCode(surface) {
  return Number(surface.code.replace(/^M/, ""));
}

function surfaceSummary(surface) {
  return {
    id: String(surface?.id ?? ""),
    name: String(surface?.name ?? ""),
    code: String(surface?.level?.code ?? ""),
    label: String(surface?.level?.label ?? ""),
    quality: Number(surface?.scores?.quality?.score ?? 0),
    completeness: Number(surface?.scores?.completeness?.score ?? 0),
    categories: Array.isArray(surface?.categories)
      ? surface.categories.map((category) => String(category?.name ?? "")).filter(Boolean)
      : [],
  };
}
