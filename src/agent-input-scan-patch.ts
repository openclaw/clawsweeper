import { createHash } from "node:crypto";
import type { StagedScanInput } from "./agent-input-scan-fixtures.js";

interface ContextWitness {
  file: string;
  sourceLine: number;
  patchLine: number;
}

/** Bind every literal occurrence in a complete patch to unchanged committed source bytes. */
export function resolvePatchContextWitnesses(
  patch: StagedScanInput,
  literal: string,
  inputs: ReadonlyMap<string, StagedScanInput>,
): ContextWitness[] | undefined {
  if (patch.kind !== "patch" || !patch.bytes || !literal || /[\r\n]/.test(literal))
    return undefined;
  const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let lines: string[];
  try {
    lines = decode(patch.bytes).split("\n");
  } catch {
    return undefined;
  }
  const witnesses: ContextWitness[] = [];
  const blob = (id: string, source: string, revision: string, role: "base" | "head") => {
    const matches = [...inputs].filter(([, input]) => input.kind === "blob" && input.id === id);
    if (matches.length !== 1) return undefined;
    const [file, input] = matches[0]!;
    if (
      input.kind !== "blob" ||
      !input.bytes ||
      input.references.some(
        (reference) =>
          reference.mode !== "100644" ||
          !(
            (reference.role === "base" && reference.revision === patch.from) ||
            (reference.role === "head" && reference.revision === patch.to)
          ),
      ) ||
      !input.references.some(
        (reference) =>
          reference.source === source &&
          reference.revision === revision &&
          reference.role === role &&
          reference.mode === "100644",
      )
    )
      return undefined;
    const identity = createHash(id.length === 64 ? "sha256" : "sha1")
      .update(`blob ${input.bytes.length}\0`)
      .update(input.bytes)
      .digest("hex");
    if (identity !== id) return undefined;
    try {
      const text = decode(input.bytes);
      return { file, text, lines: text.split("\n") };
    } catch {
      return undefined;
    }
  };

  for (let start = 0; start < lines.length;) {
    let end = start + 1;
    while (end < lines.length && !lines[end]!.startsWith("diff --git ")) end++;
    const section = lines.slice(start, end);
    if (!section.some((line) => line.includes(literal))) {
      start = end;
      continue;
    }
    // Only the canonical, same-path regular-file header is eligible. Quoted or
    // otherwise ambiguous paths, mode changes, renames and binary patches refuse.
    const source = section[2]?.startsWith("--- a/") ? section[2].slice(6) : undefined;
    const index =
      /^index ([0-9a-f]{40}(?:[0-9a-f]{24})?)\.\.([0-9a-f]{40}(?:[0-9a-f]{24})?) 100644$/.exec(
        section[1] ?? "",
      );
    if (
      !source ||
      !index ||
      section[0] !== `diff --git a/${source} b/${source}` ||
      section[3] !== `+++ b/${source}` ||
      section.slice(0, 4).some((line) => line.includes(literal))
    )
      return undefined;
    const before = blob(index[1]!, source, patch.from, "base");
    const after = blob(index[2]!, source, patch.to, "head");
    if (!before || !after) return undefined;
    let oldLine = 0;
    let newLine = 0;
    let oldRemaining = 0;
    let newRemaining = 0;
    let inHunk = false;
    let previous: string | undefined;
    for (let position = 4; position < section.length; position++) {
      const line = section[position]!;
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
      if (hunk) {
        if (oldRemaining || newRemaining || line.includes(literal)) return undefined;
        [oldLine, oldRemaining, newLine, newRemaining] = [
          Number(hunk[1]),
          Number(hunk[2] ?? 1),
          Number(hunk[3]),
          Number(hunk[4] ?? 1),
        ];
        if (![oldLine, oldRemaining, newLine, newRemaining].every(Number.isSafeInteger))
          return undefined;
        inHunk = true;
        previous = undefined;
        continue;
      }
      if (line === "\\ No newline at end of file") {
        if (
          !previous ||
          (previous !== "+" &&
            (before.text.endsWith("\n") || oldLine - 1 !== before.lines.length)) ||
          (previous !== "-" && (after.text.endsWith("\n") || newLine - 1 !== after.lines.length))
        )
          return undefined;
        previous = undefined;
        continue;
      }
      if (position === section.length - 1 && line === "" && end === lines.length) continue;
      const prefix = line[0];
      if (!inHunk || (prefix !== " " && prefix !== "+" && prefix !== "-")) return undefined;
      const value = line.slice(1);
      if (
        (prefix !== "+" && (oldRemaining <= 0 || before.lines[oldLine - 1] !== value)) ||
        (prefix !== "-" && (newRemaining <= 0 || after.lines[newLine - 1] !== value))
      )
        return undefined;
      if (line.includes(literal)) {
        if (prefix !== " ") return undefined;
        witnesses.push(
          { file: before.file, sourceLine: oldLine, patchLine: start + position + 1 },
          { file: after.file, sourceLine: newLine, patchLine: start + position + 1 },
        );
      }
      if (prefix !== "+") {
        oldLine++;
        oldRemaining--;
      }
      if (prefix !== "-") {
        newLine++;
        newRemaining--;
      }
      previous = prefix;
    }
    if (!inHunk || oldRemaining || newRemaining) return undefined;
    start = end;
  }
  return witnesses.length ? witnesses : undefined;
}
