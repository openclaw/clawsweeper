import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

import { captureCanonicalRecordBaseline } from "../repair/canonical-record-baseline.js";
import type { LiveProofAttachResult } from "./attach.js";

export const LIVE_PROOF_PUBLICATION_ATTEMPTS = 3;
export const LIVE_PROOF_PUBLICATION_BACKOFF_MS = 1_000;

export interface LiveProofPublicationDependencies {
  hydrateRecord: (attempt: number) => Promise<void> | void;
  attachRecord: (attempt: number) => Promise<LiveProofAttachResult>;
  publishRecord: (attempt: number) => Promise<void> | void;
  syncComment: () => Promise<void> | void;
  isCanonicalConflict: (error: unknown) => boolean;
  delay?: (milliseconds: number) => Promise<void>;
  log?: (message: string) => void;
}

export async function publishLiveProofAttachment(
  dependencies: LiveProofPublicationDependencies,
): Promise<LiveProofAttachResult> {
  const delay =
    dependencies.delay ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const log = dependencies.log ?? console.log;

  for (let attempt = 1; attempt <= LIVE_PROOF_PUBLICATION_ATTEMPTS; attempt += 1) {
    await dependencies.hydrateRecord(attempt);
    const outcome = await dependencies.attachRecord(attempt);
    if (outcome !== "attached") return outcome;

    try {
      await dependencies.publishRecord(attempt);
    } catch (error) {
      if (!dependencies.isCanonicalConflict(error) || attempt === LIVE_PROOF_PUBLICATION_ATTEMPTS) {
        throw error;
      }
      log(
        `[live-proof-attach] canonical publication conflicted on attempt ${attempt}/${LIVE_PROOF_PUBLICATION_ATTEMPTS}; rehydrating before retry`,
      );
      await delay(LIVE_PROOF_PUBLICATION_BACKOFF_MS * attempt);
      continue;
    }

    await dependencies.syncComment();
    return outcome;
  }

  throw new Error("live proof publication exhausted its retry loop");
}

export function captureLiveProofCanonicalBaseline(options: {
  root: string;
  repositorySlug: string;
  itemNumber: number;
  attempt: number;
}): string {
  const itemName = `${options.itemNumber}.md`;
  const baselineParent = join(options.root, ".artifacts", "live-proof-canonical-baseline");
  mkdirSync(baselineParent, { recursive: true });
  const baselineRoot = mkdtempSync(join(baselineParent, `attempt-${options.attempt}-`));
  const repositoryRoot = join(options.root, "records", options.repositorySlug);
  captureCanonicalRecordBaseline({
    baselineRoot,
    repositorySlug: options.repositorySlug,
    itemNumber: options.itemNumber,
    sources: [
      { section: "items", name: itemName, path: join(repositoryRoot, "items", itemName) },
      { section: "closed", name: itemName, path: join(repositoryRoot, "closed", itemName) },
      { section: "plans", name: itemName, path: join(repositoryRoot, "plans", itemName) },
      {
        section: "decision-packets",
        name: `${options.itemNumber}.json`,
        path: join(repositoryRoot, "decision-packets", `${options.itemNumber}.json`),
      },
    ],
  });
  return baselineRoot;
}

export function isCanonicalPublicationConflict(error: unknown): boolean {
  return errorText(error).includes("Canonical publication conflicted for all");
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const candidate = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
  return [candidate.message, candidate.stdout, candidate.stderr].map(commandOutputText).join("\n");
}

function commandOutputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}
