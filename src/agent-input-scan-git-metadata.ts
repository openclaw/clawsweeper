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
  if (
    (patch.kind !== "patch" && patch.kind !== "raw_diff") ||
    !/^[0-9a-f]{40}$/.test(oid) ||
    /^0+$/.test(oid)
  )
    return undefined;
  const literal = Buffer.from(oid);
  const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const records = new Set<string>();
  const matchedRecords = new Set<string>();
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
      const paths = new Set<string>();
      for (let i = 0; i < fields.length; i += 2) {
        const header = fields[i]!;
        const source = fields[i + 1]!;
        if (
          !/^:\d{6} \d{6} [0-9a-f]{40} [0-9a-f]{40} [AMDT]$/.test(header) ||
          !source ||
          paths.has(source) ||
          source.includes(oid) ||
          Buffer.from(source).some((byte) => byte < 32 || byte === 92) ||
          source.startsWith("/") ||
          /^[A-Za-z]:/.test(source) ||
          source
            .split("/")
            .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
        )
          return undefined;
        paths.add(source);
        if (!header.includes(oid)) continue;
        const match =
          /^:(100644|000000) (100644|000000) ([0-9a-f]{40}) ([0-9a-f]{40}) ([MAD])$/.exec(header);
        const added = match?.[5] === "A";
        const removed = match?.[5] === "D";
        if (
          !match ||
          (match[3] !== oid && match[4] !== oid) ||
          (match[1] === "000000") !== added ||
          (match[2] === "000000") !== removed ||
          /^0+$/.test(match[3]!) !== added ||
          /^0+$/.test(match[4]!) !== removed ||
          (!added &&
            !resolveScannedGitBlob(input, match[3]!, source, input.from, "base", inputs)) ||
          (!removed && !resolveScannedGitBlob(input, match[4]!, source, input.to, "head", inputs))
        )
          return undefined;
        if (
          (added || removed) &&
          [...inputs.values()].some(
            (candidate) =>
              "references" in candidate &&
              candidate.references.some(
                (reference) =>
                  reference.source === source &&
                  reference.revision === (added ? input.from : input.to),
              ),
          )
        )
          return undefined;
        const record = [input.from, input.to, source, match[3], match[4], match[5]].join("\0");
        if (records.has(record)) return undefined;
        records.add(record);
        if (input === patch) witnesses.push({ source, patchLine: 1 });
      }
    }
    for (const input of inputs.values()) {
      if (input.kind !== "patch" || !input.bytes?.includes(literal)) continue;
      const lines = decode(input.bytes).split("\n");
      for (const [i, line] of lines.entries()) {
        if (!line.includes(oid)) continue;
        const match = /^index ([0-9a-f]{40})\.\.([0-9a-f]{40})( 100644)?$/.exec(line);
        const added = lines[i - 1] === "new file mode 100644";
        const removed = lines[i - 1] === "deleted file mode 100644";
        const source = added ? lines[i + 2]?.slice(6) : lines[i + 1]?.slice(6);
        const record = [
          input.from,
          input.to,
          source,
          match?.[1],
          match?.[2],
          added ? "A" : removed ? "D" : "M",
        ].join("\0");
        if (
          !match ||
          !source ||
          (match[1] !== oid && match[2] !== oid) ||
          Boolean(match[3]) === (added || removed) ||
          /^0+$/.test(match[1]!) !== added ||
          /^0+$/.test(match[2]!) !== removed ||
          lines[i - (added || removed ? 2 : 1)] !== `diff --git a/${source} b/${source}` ||
          lines[i + 1] !== (added ? "--- /dev/null" : `--- a/${source}`) ||
          lines[i + 2] !== (removed ? "+++ /dev/null" : `+++ b/${source}`) ||
          !lines[i + 3]?.startsWith("@@ ") ||
          !records.has(record) ||
          matchedRecords.has(record)
        )
          return undefined;
        matchedRecords.add(record);
        if (input === patch) witnesses.push({ source, patchLine: i + 1 });
      }
    }
  } catch {
    return undefined;
  }
  return witnesses.length && [...records].every((record) => matchedRecords.has(record))
    ? witnesses
    : undefined;
}
