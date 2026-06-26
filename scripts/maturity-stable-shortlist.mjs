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
  const rows = surfaces
    .map(surfaceSummary)
    .filter((surface) => Number(surface.code.replace(/^M/, "")) >= 4);

  if (rows.length === 0) return "No M4+ maturity scorecard surfaces found.";
  return rows
    .map((surface) => {
      const categories = surface.categories.length
        ? ` | categories: ${surface.categories.join("; ")}`
        : "";
      return `${surface.id} | ${surface.name} | ${surface.code} ${surface.label} | q${surface.quality} c${surface.completeness}${categories}`;
    })
    .join("\n");
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
