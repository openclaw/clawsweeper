/** Fence-aware parsing for renderer-owned ClawSweeper review sections and markers. */

function markdownFenceDelimiter(line: string): string | null {
  return line.trimStart().match(/^(?:`{3,}|~{3,})/)?.[0] ?? null;
}

export function markdownFenceStateAfterLine(fence: string | null, line: string): string | null {
  const trimmed = line.trim();
  const delimiter = trimmed.match(/^(?:`{3,}|~{3,})/)?.[0];
  if (!delimiter) return fence;
  if (!fence) return delimiter;
  // Only a bare matching delimiter (same character, at least the opening length, no
  // trailing info text) closes the fence; anything else is fence content.
  const closes =
    delimiter[0] === fence[0] &&
    delimiter.length >= fence.length &&
    trimmed.slice(delimiter.length).trim() === "";
  return closes ? null : fence;
}

// Fence-aware so heading-shaped lines inside fenced blocks (for example the Mermaid
// architecture diagram) can never open or terminate a section.
export function markdownSection(body: string, heading: string): string {
  return markdownSectionInternal(body, heading, false);
}

// Renderer-owned scan-first sections always precede the collapsed details block, so
// lookups for them stop at the first top-level <details> boundary; model text inside
// the collapsed block can never supply them.
export function markdownTopLevelSection(body: string, heading: string): string {
  return markdownSectionInternal(body, heading, true);
}

function markdownSectionInternal(body: string, heading: string, topLevelOnly: boolean): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingPattern = new RegExp(
    `^(?:\\*\\*${escaped}\\*\\*|#{1,6}[ \\t]+${escaped})[ \\t]*$`,
    "i",
  );
  const boundaryPattern =
    /^(?:\*\*[^*\n]+\*\*[ \t]*$|#{1,6}[ \t]+\S.*$|<details>|<\/details>|<!--)/;
  const lines = body.split("\n").map((line) => line.replace(/\r$/, ""));
  let fence: string | null = null;
  let contentStart = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const delimiter = markdownFenceDelimiter(line);
    if (delimiter) {
      fence = markdownFenceStateAfterLine(fence, line);
      continue;
    }
    if (!fence && topLevelOnly && /^<details(?:\s|>)/i.test(line.trim())) break;
    if (!fence && headingPattern.test(line)) {
      contentStart = index + 1;
      break;
    }
  }
  if (contentStart < 0) return "";
  const section: string[] = [];
  fence = null;
  for (let index = contentStart; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const delimiter = markdownFenceDelimiter(line);
    if (delimiter) {
      fence = markdownFenceStateAfterLine(fence, line);
      section.push(line);
      continue;
    }
    if (!fence && boundaryPattern.test(line)) break;
    section.push(line);
  }
  return section.join("\n").trim();
}

export function firstLineAfterPrefix(body: string, prefix: string): string {
  const lowerBody = body.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  const index = lowerBody.indexOf(lowerPrefix);
  if (index < 0) return "";
  const start = index + prefix.length;
  const end = body.indexOf("\n", start);
  return body.slice(start, end < 0 ? undefined : end).trim();
}

export function htmlMarkerWithPrefix(body: string, prefix: string): string | null {
  const lowerPrefix = prefix.toLowerCase();
  let searchFrom = 0;
  while (searchFrom < body.length) {
    const start = body.indexOf("<!--", searchFrom);
    if (start < 0) return null;
    const end = body.indexOf("-->", start + 4);
    if (end < 0) return null;
    const marker = body.slice(start, end + 3);
    const inner = body
      .slice(start + 4, end)
      .trim()
      .toLowerCase();
    if (inner.startsWith(lowerPrefix)) return marker;
    searchFrom = end + 3;
  }
  return null;
}

export function markerAttribute(marker: string | null, name: string): string | null {
  if (!marker) return null;
  const inner = marker.slice(4, -3).trim();
  for (const part of inner.split(/\s+/)) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    if (part.slice(0, separator).toLowerCase() === name.toLowerCase()) {
      return part.slice(separator + 1) || null;
    }
  }
  return null;
}

export function firstNonEmptyLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function markdownTableCells(line: string): string[] {
  const value = line.trim();
  if (!value.startsWith("|") || !value.endsWith("|")) return [];
  const cells: string[] = [];
  let cell = "";
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    if (character === "|" && value[index - 1] !== "\\") {
      cells.push(cell.trim().replace(/\\\|/g, "|"));
      cell = "";
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim().replace(/\\\|/g, "|"));
  return cells;
}

// Decision-only reviews render an empty Before merge checklist while the
// outstanding maintainer question lives under "Decision needed"; surface that
// question as the remaining action.
function firstDecisionNeededQuestion(body: string): string {
  const section = markdownTopLevelSection(body, "Decision needed");
  if (!section) return "";
  for (const line of section.split(/\r?\n/)) {
    const cells = markdownTableCells(line);
    if (cells.length < 2) continue;
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const label = cells[0]?.trim().toLowerCase() ?? "";
    if (label === "question") continue;
    if (cells[0]) return cells[0];
  }
  return firstNonEmptyLine(section);
}

export function firstBeforeMergeAction(body: string): string {
  const section = markdownTopLevelSection(body, "Before merge");
  // "None." is the no-action sentinel; a checked task is finished work, not a
  // remaining action.
  if (!section || /^none[.!]?$/i.test(section.trim())) {
    return firstDecisionNeededQuestion(body);
  }
  let sawTask = false;
  for (const line of section.split(/\r?\n/)) {
    if (/^- \[[xX]\]/.test(line)) {
      sawTask = true;
      continue;
    }
    const task = line.match(/^- \[ \][ \t]+(?:\*\*(?:\\.|[^*\\\n])+\*\*[ \t]+-[ \t]+)?(\S.*)$/);
    if (task?.[1]) return task[1].trim();
    if (line.startsWith("- [")) sawTask = true;
    const cells = markdownTableCells(line);
    if (cells.length < 2) continue;
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const labels = cells.map((cell) =>
      cell
        .replace(/^\*\*|\*\*$/g, "")
        .trim()
        .toLowerCase(),
    );
    if (labels[0] === "needed" && labels[1] === "why") continue;
    if (cells[1]) return cells[1];
  }
  // A checklist whose tasks are all checked has no remaining checklist action, but
  // an outstanding maintainer decision still is one.
  return sawTask ? firstDecisionNeededQuestion(body) : firstNonEmptyLine(section);
}

export function previousReviewStatus(body: string): string {
  const status = firstLineAfterPrefix(body, "Codex review:");
  const reviewedIndex = status.toLowerCase().indexOf("_reviewed ");
  return (reviewedIndex < 0 ? status : status.slice(0, reviewedIndex)).trim();
}

export function previousReviewReviewedAt(body: string): string | null {
  const value = firstLineAfterPrefix(body, "**Latest ClawSweeper review:**");
  if (value) return value.replace(/\.$/, "").trim();
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  const lowerFirstLine = firstLine.toLowerCase();
  const prefix = "_reviewed ";
  const start = lowerFirstLine.indexOf(prefix);
  if (start < 0) return null;
  const valueStart = start + prefix.length;
  const end = firstLine.indexOf("._", valueStart);
  const inline = firstLine.slice(valueStart, end < 0 ? undefined : end).trim();
  return inline || null;
}

export function sectionLabeledValue(body: string, heading: string, prefix: string): string {
  const section = markdownTopLevelSection(body, heading);
  if (!section) return "";
  const lowerPrefix = prefix.toLowerCase();
  const plain = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().startsWith(lowerPrefix));
  if (plain) return plain;
  const label = prefix.replace(/:$/, "");
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tableRow = section.match(
    new RegExp(`^\\|\\s*\\*\\*${escaped}\\*\\*\\s*\\|\\s*(.*?)\\s*\\|`, "im"),
  );
  return tableRow?.[1] ? `${label}: ${tableRow[1]}` : "";
}

function firstMergeReadinessLine(body: string, prefix: string): string {
  return sectionLabeledValue(body, "Merge readiness", prefix);
}

export function previousReviewRating(body: string): string {
  // Prefer the renderer-owned score table; the free-form legacy blocks can contain
  // model text that merely starts with the legacy label.
  return (
    sectionLabeledValue(body, "Review scores", "Overall readiness:") ||
    firstNonEmptyLine(markdownSection(body, "PR rating")) ||
    firstMergeReadinessLine(body, "Overall:")
  );
}

export function previousReviewProofStatus(body: string): string {
  // Prefer the renderer-owned tables; the free-form legacy blocks can contain model
  // text that merely starts with the legacy label.
  const fromNewSections =
    sectionLabeledValue(body, "Review scores", "Proof confidence:") ||
    sectionLabeledValue(body, "Verification", "Real behavior:");
  if (fromNewSections) return fromNewSections;
  const oldProofStatus = firstNonEmptyLine(markdownSection(body, "Real behavior proof"));
  if (oldProofStatus) return oldProofStatus;
  const readiness = markdownSection(body, "Merge readiness");
  if (!readiness) return "";
  const lines = readiness.split(/\r?\n/);
  const proofGuidanceIndex = lines.findIndex(
    (line) => line.trim().toLowerCase() === "proof guidance:",
  );
  if (proofGuidanceIndex >= 0) {
    const guidance = lines
      .slice(proofGuidanceIndex + 1)
      .map((line) => line.trim())
      .find(Boolean);
    if (guidance) return guidance;
  }
  return firstMergeReadinessLine(body, "Proof:");
}
