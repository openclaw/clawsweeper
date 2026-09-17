import { createHash } from "node:crypto";
import type { StagedScanInput } from "./agent-input-scan-fixtures.js";

export function resolveScannedGitBlob(
  scope: Extract<StagedScanInput, { kind: "raw_diff" | "patch" }>,
  id: string,
  source: string,
  revision: string,
  role: "base" | "head",
  inputs: ReadonlyMap<string, StagedScanInput>,
): { file: string; bytes: Buffer } | undefined {
  const matches = [...inputs].filter(([, entry]) => entry.kind === "blob" && entry.id === id);
  if (matches.length !== 1) return undefined;
  const [file, entry] = matches[0]!;
  if (
    entry.kind !== "blob" ||
    !entry.bytes ||
    entry.references.some(
      (reference) =>
        reference.mode !== "100644" ||
        !(
          (reference.role === "base" && reference.revision === scope.from) ||
          (reference.role === "head" && reference.revision === scope.to)
        ),
    ) ||
    !entry.references.some(
      (reference) =>
        reference.source === source && reference.role === role && reference.revision === revision,
    )
  )
    return undefined;
  const identity = createHash(id.length === 64 ? "sha256" : "sha1")
    .update(`blob ${entry.bytes.length}\0`)
    .update(entry.bytes)
    .digest("hex");
  return identity === id ? { file, bytes: entry.bytes } : undefined;
}

/** Prove a complete Git object ID occurs only in host-generated diff metadata. */
export function resolveGitObjectMetadata(
  patch: StagedScanInput,
  oid: string,
  inputs: ReadonlyMap<string, StagedScanInput>,
): Array<{ source: string; patchLine: number }> | undefined {
  if (patch.kind !== "patch" || !/^[0-9a-f]{40}$/.test(oid)) return undefined;
  const literal = Buffer.from(oid);
  const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const records = new Set<string>();
  const witnesses: Array<{ source: string; patchLine: number }> = [];
  try {
    // Native deduplication must never hide an identical credential in another
    // material. Missing retained bytes cannot establish this absence proof.
    for (const input of inputs.values()) {
      if (!input.bytes) return undefined;
      if (!input.bytes.includes(literal)) continue;
      if (input.kind !== "raw_diff" && input.kind !== "patch") return undefined;
      if (input.kind !== "raw_diff") continue;
      const fields = decode(input.bytes).split("\0");
      if (fields.pop() !== "" || fields.length % 2 !== 0) return undefined;
      for (let i = 0; i < fields.length; i += 2) {
        const header = fields[i]!;
        const source = fields[i + 1]!;
        if (source.includes(oid)) return undefined;
        if (!header.includes(oid)) continue;
        const match = /^:100644 100644 ([0-9a-f]{40}) ([0-9a-f]{40}) M$/.exec(header);
        if (
          !match ||
          (match[1] !== oid && match[2] !== oid) ||
          !resolveScannedGitBlob(input, match[1]!, source, input.from, "base", inputs) ||
          !resolveScannedGitBlob(input, match[2]!, source, input.to, "head", inputs)
        )
          return undefined;
        records.add([input.from, input.to, source, match[1], match[2]].join("\0"));
      }
    }
    for (const input of inputs.values()) {
      if (input.kind !== "patch" || !input.bytes?.includes(literal)) continue;
      const lines = decode(input.bytes).split("\n");
      for (const [i, line] of lines.entries()) {
        if (!line.includes(oid)) continue;
        const match = /^index ([0-9a-f]{40})\.\.([0-9a-f]{40}) 100644$/.exec(line);
        const source = lines[i + 1]?.startsWith("--- a/") ? lines[i + 1]!.slice(6) : undefined;
        if (
          !match ||
          !source ||
          (match[1] !== oid && match[2] !== oid) ||
          lines[i - 1] !== `diff --git a/${source} b/${source}` ||
          lines[i + 2] !== `+++ b/${source}` ||
          !lines[i + 3]?.startsWith("@@ ") ||
          !records.has([input.from, input.to, source, match[1], match[2]].join("\0"))
        )
          return undefined;
        if (input === patch) witnesses.push({ source, patchLine: i + 1 });
      }
    }
  } catch {
    return undefined;
  }
  return witnesses.length ? witnesses : undefined;
}
