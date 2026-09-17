import { createHash } from "node:crypto";
import type {
  ReviewedAttribution,
  ScanSourceReference,
  StagedScanInput,
} from "./agent-input-scan-fixtures.js";

export interface ReviewedMaterialPin {
  kind: "raw_diff" | "patch" | "blob";
  from?: string;
  to?: string;
  blob?: string;
  references?: readonly ScanSourceReference[];
  size: number;
  sha256: string;
}

export interface ReviewedMaterialPolicy {
  attributions: readonly ReviewedAttribution[];
  materials: readonly ReviewedMaterialPin[];
}

const base = "80936b0933a1b21bdb6097916cf69035a14dedc8";
const head = "5145fb19ee07515ff3dfd7482d245e73f1ad43e4";
const receiver = "scripts/crabbox-source-receiver.mts";
const fixture = "test/scripts/crabbox-wrapper.test.ts";

const reviewedLiteral = [
  "be8e2ee07c71e0dc8896a56301bb2741e8095ca566d255ba13b0b58943e46ecd",
  "e04102aeed9f8734a735d359863e57671444f3e05042880655bde073da78dfc1",
  "5000a198f4d90e887e114b4235627241dd466181503c330101401223d5ad99fc",
  fixture,
  "100644",
] as const;

// Temporary host-reviewed material for OpenClaw PR 149120, not decoded-origin
// proof. Retire after landing and all scan consumers finish; never refresh pins
// automatically. Any source-pair or repository-input change needs new review.
export const REVIEWED_SOURCE_MATERIAL: ReviewedMaterialPolicy = {
  // The pinned scanner emitted both labels for these same immutable inputs.
  // Keep each observed tuple exact; other decoder labels remain ineligible.
  attributions: [
    [17, "URI", "PLAIN", ...reviewedLiteral],
    [17, "URI", "ESCAPED_UNICODE", ...reviewedLiteral],
  ],
  materials: [
    {
      kind: "raw_diff",
      from: base,
      to: head,
      size: 271,
      sha256: "781168949b6f47e47e466a3ebe74e10c5ef1f7dcabdb8fa23eb341dde86c03ce",
    },
    {
      kind: "patch",
      from: base,
      to: head,
      size: 14435,
      sha256: "474097bd0b2798d0e12b3c7f863c8fbaa455b3670e0f059d53fd917caccb2df3",
    },
    {
      kind: "blob",
      blob: "da52c5e3ec5e9ef61124b427540d0d1afe3a3b84",
      references: [{ source: receiver, revision: base, role: "base", mode: "100644" }],
      size: 14768,
      sha256: "427ede42207f690f4429ec1350e74438e48d10952a958e39b96f935544141155",
    },
    {
      kind: "blob",
      blob: "467350d5494bb3109de7c08db5ab4d97e3610280",
      references: [{ source: receiver, revision: head, role: "head", mode: "100644" }],
      size: 17113,
      sha256: "45b1278e0cc1918a3ac0b37495bd1a5b4f7fe343fc7a9a4570c8c05f14dd3233",
    },
    {
      kind: "blob",
      blob: "f4167de5dabce5778f92e1e6176fdf1457b430c0",
      references: [{ source: fixture, revision: base, role: "base", mode: "100644" }],
      size: 236255,
      sha256: "352892d7d449e1b8439279ce1e47ed9b88d806b14054cad8fd1ec7625930c017",
    },
    {
      kind: "blob",
      blob: "820096bb0988aec70b86acbbbaf59c005e935b89",
      references: [{ source: fixture, revision: head, role: "head", mode: "100644" }],
      size: 244129,
      sha256: "e9e855e90cccd2e8aa3399cccb0ac114d111ecb8b88b79301a701171729c9cc5",
    },
  ],
};

function materialKey(pin: ReviewedMaterialPin): string {
  return JSON.stringify([
    pin.kind,
    pin.from ?? null,
    pin.to ?? null,
    pin.blob ?? null,
    pin.references
      ?.map(({ source, mode, revision, role }) => [source, mode, revision, role])
      .sort() ?? null,
    pin.size,
    pin.sha256,
  ]);
}

export function qualifyReviewedMaterial(
  inputs: ReadonlyMap<string, StagedScanInput>,
  policy: ReviewedMaterialPolicy,
): readonly ReviewedAttribution[] | undefined {
  const actual: string[] = [];
  for (const input of inputs.values()) {
    // These inputs are still scanned and cannot use this qualification. The
    // repository set is closed, including extra copies with identical ids.
    if (input.kind === "prompt" || input.kind === "schema" || input.kind === "additional") continue;
    if (input.kind === "worktree" || !input.bytes) return undefined;
    actual.push(
      materialKey({
        kind: input.kind,
        ...(input.kind === "blob" ? { blob: input.id, references: input.references } : {}),
        ...(input.kind === "raw_diff" || input.kind === "patch"
          ? { from: input.from, to: input.to }
          : {}),
        size: input.bytes.length,
        sha256: createHash("sha256").update(input.bytes).digest("hex"),
      }),
    );
  }
  const expected = policy.materials.map(materialKey).sort();
  actual.sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
    ? policy.attributions
    : undefined;
}
