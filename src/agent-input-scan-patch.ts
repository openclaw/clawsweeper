import type { StagedScanInput } from "./agent-input-scan-fixtures.js";
import { resolveScannedGitBlob } from "./agent-input-scan-git-metadata.js";

interface PatchWitness {
  file: string;
  sourceLine: number;
  patchLine: number;
  kind: "context" | "add" | "remove" | "hunk-label";
}

/** Bind every literal occurrence in a complete patch to its committed source bytes. */
export function resolvePatchWitnesses(
  patch: StagedScanInput,
  literal: string,
  inputs: ReadonlyMap<string, StagedScanInput>,
): PatchWitness[] | undefined {
  if (patch.kind !== "patch" || !patch.bytes || !literal || /[\r\n]/.test(literal))
    return undefined;
  let sourceBytes = patch.bytes;
  if (patch.metadataProof) {
    const proof = patch.metadataProof;
    const original = proof.original;
    if (
      proof.file === proof.originalFile ||
      inputs.get(proof.file) !== patch ||
      inputs.get(proof.originalFile) !== original ||
      original.kind !== "patch" ||
      original.metadataProof ||
      !original.bytes ||
      patch.id !== original.id ||
      patch.from !== original.from ||
      patch.to !== original.to ||
      !patch.bytes.equals(proof.bytes)
    )
      return undefined;
    // Native replay scans the exact masked bytes; only URI source attribution
    // needs the primary patch's intact Git index and committed blob witnesses.
    patch = original;
    sourceBytes = original.bytes;
  }
  const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let lines: string[];
  try {
    lines = decode(sourceBytes).split("\n");
  } catch {
    return undefined;
  }
  const witnesses: PatchWitness[] = [];
  const blob = (id: string, source: string, revision: string, role: "base" | "head") => {
    const input = resolveScannedGitBlob(patch, id, source, revision, role, inputs);
    if (!input) return undefined;
    try {
      const text = decode(input.bytes);
      const lines = text.split("\n");
      // A split terminator is not a source line that a hunk may consume.
      if (lines.at(-1) === "") lines.pop();
      return { file: input.file, text, lines };
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
    // File creation/deletion needs captured Git absence proof; /dev/null or a
    // zero textual index alone must never authorize a missing endpoint.
    const added = section[1] === "new file mode 100644";
    const removed = section[1] === "deleted file mode 100644";
    const indexLine = added || removed ? 2 : 1;
    const oldPath = section[indexLine + 1];
    const newPath = section[indexLine + 2];
    const source = added ? newPath?.slice(6) : oldPath?.slice(6);
    const index =
      /^index ([0-9a-f]{40}(?:[0-9a-f]{24})?)\.\.([0-9a-f]{40}(?:[0-9a-f]{24})?)( 100644)?$/.exec(
        section[indexLine] ?? "",
      );
    if (
      !source ||
      !index ||
      index[1]!.length !== index[2]!.length ||
      Boolean(index[3]) === (added || removed) ||
      /^0+$/.test(index[1]!) !== added ||
      /^0+$/.test(index[2]!) !== removed ||
      section[0] !== `diff --git a/${source} b/${source}` ||
      oldPath !== (added ? "--- /dev/null" : `--- a/${source}`) ||
      newPath !== (removed ? "+++ /dev/null" : `+++ b/${source}`) ||
      section.slice(0, indexLine + 3).some((line) => line.includes(literal))
    )
      return undefined;
    if (added || removed) {
      const raw = [...inputs.values()].filter(
        (input) => input.kind === "raw_diff" && input.from === patch.from && input.to === patch.to,
      );
      if (raw.length !== 1 || !raw[0]!.bytes) return undefined;
      let fields: string[];
      try {
        fields = decode(raw[0]!.bytes).split("\0");
      } catch {
        return undefined;
      }
      if (fields.pop() !== "" || fields.length % 2) return undefined;
      const matching: string[] = [];
      for (let i = 0; i < fields.length; i += 2) {
        if (
          !/^:\d{6} \d{6} [0-9a-f]{40}(?:[0-9a-f]{24})? [0-9a-f]{40}(?:[0-9a-f]{24})? [AMDT]$/.test(
            fields[i]!,
          ) ||
          !fields[i + 1]
        )
          return undefined;
        if (fields[i + 1] === source) matching.push(fields[i]!);
      }
      const expected = `:${added ? "000000 100644" : "100644 000000"} ${index[1]} ${index[2]} ${added ? "A" : "D"}`;
      if (matching.length !== 1 || matching[0] !== expected) return undefined;
      for (const input of inputs.values()) {
        if (
          "references" in input &&
          input.references.some(
            (reference) =>
              reference.source === source && reference.revision === (added ? patch.from : patch.to),
          )
        )
          return undefined;
      }
    }
    const before = added ? undefined : blob(index[1]!, source, patch.from, "base");
    const after = removed ? undefined : blob(index[2]!, source, patch.to, "head");
    if ((!added && !before) || (!removed && !after)) return undefined;
    let oldLine = 0;
    let newLine = 0;
    let oldRemaining = 0;
    let newRemaining = 0;
    let oldEnd = 0;
    let newEnd = 0;
    let inHunk = false;
    let previous: string | undefined;
    let needsNewlineMarker = false;
    for (let position = indexLine + 3; position < section.length; position++) {
      const line = section[position]!;
      if (needsNewlineMarker && line !== "\\ No newline at end of file") return undefined;
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/.exec(line);
      if (hunk) {
        if (oldRemaining || newRemaining || ((added || removed) && inHunk)) return undefined;
        [oldLine, oldRemaining, newLine, newRemaining] = [
          Number(hunk[1]),
          Number(hunk[2] ?? 1),
          Number(hunk[3]),
          Number(hunk[4] ?? 1),
        ];
        if (![oldLine, oldRemaining, newLine, newRemaining].every(Number.isSafeInteger))
          return undefined;
        // Zero-count coordinates name the insertion boundary, not a source
        // line. Both ranges must advance over the same unchanged gap.
        const oldOffset = oldLine - Number(oldRemaining > 0);
        const newOffset = newLine - Number(newRemaining > 0);
        if (
          oldOffset < oldEnd ||
          newOffset < newEnd ||
          oldOffset + oldRemaining > (before?.lines.length ?? 0) ||
          newOffset + newRemaining > (after?.lines.length ?? 0) ||
          oldOffset - oldEnd !== newOffset - newEnd ||
          ((added || removed) &&
            (oldRemaining !== (before?.lines.length ?? 0) ||
              newRemaining !== (after?.lines.length ?? 0)))
        )
          return undefined;
        if (line.includes(literal)) {
          const label = hunk[5];
          if (!before || !after || !label?.includes(literal)) return undefined;
          const oldGap = before.lines.slice(oldEnd, oldOffset);
          const newGap = after.lines.slice(newEnd, newOffset);
          if (oldGap.some((value, offset) => value !== newGap[offset])) return undefined;
          const offset = oldGap.indexOf(label);
          if (offset === -1 || oldGap.lastIndexOf(label) !== offset) return undefined;
          const patchLine = start + position + 1;
          // Git copies labels outside the hunk. Require both complete source lines;
          // the distinct kind also requires exact fixture policy in the classifier.
          witnesses.push(
            { file: before.file, sourceLine: oldEnd + offset + 1, patchLine, kind: "hunk-label" },
            { file: after.file, sourceLine: newEnd + offset + 1, patchLine, kind: "hunk-label" },
          );
        }
        oldEnd = oldOffset + oldRemaining;
        newEnd = newOffset + newRemaining;
        inHunk = true;
        previous = undefined;
        continue;
      }
      if (line === "\\ No newline at end of file") {
        if (
          !previous ||
          (previous !== "+" &&
            (!before || before.text.endsWith("\n") || oldLine - 1 !== before.lines.length)) ||
          (previous !== "-" &&
            (!after || after.text.endsWith("\n") || newLine - 1 !== after.lines.length))
        )
          return undefined;
        previous = undefined;
        needsNewlineMarker = false;
        continue;
      }
      if (position === section.length - 1 && line === "" && end === lines.length) continue;
      const prefix = line[0];
      if (!inHunk || (prefix !== " " && prefix !== "+" && prefix !== "-")) return undefined;
      const value = line.slice(1);
      if (
        (prefix !== "+" && (!before || oldRemaining <= 0 || before.lines[oldLine - 1] !== value)) ||
        (prefix !== "-" && (!after || newRemaining <= 0 || after.lines[newLine - 1] !== value))
      )
        return undefined;
      if (line.includes(literal)) {
        const kind = prefix === " " ? "context" : prefix === "+" ? "add" : "remove";
        const patchLine = start + position + 1;
        if (prefix !== "+")
          witnesses.push({ file: before!.file, sourceLine: oldLine, patchLine, kind });
        if (prefix !== "-")
          witnesses.push({ file: after!.file, sourceLine: newLine, patchLine, kind });
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
      needsNewlineMarker =
        (prefix !== "+" && !before!.text.endsWith("\n") && oldLine - 1 === before!.lines.length) ||
        (prefix !== "-" && !after!.text.endsWith("\n") && newLine - 1 === after!.lines.length);
    }
    if (!inHunk || oldRemaining || newRemaining || needsNewlineMarker) return undefined;
    // The final unchanged gap must not hide an omitted size-changing hunk.
    if ((before?.lines.length ?? 0) - oldEnd !== (after?.lines.length ?? 0) - newEnd)
      return undefined;
    start = end;
  }
  return witnesses.length ? witnesses : undefined;
}
