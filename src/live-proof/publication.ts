import type { LiveProofAttachResult } from "./attach.js";

export const LIVE_PROOF_PUBLICATION_ATTEMPTS = 3;
export const LIVE_PROOF_PUBLICATION_BACKOFF_MS = 1_000;

export interface LiveProofPublicationDependencies {
  hydrateRecord: () => Promise<void> | void;
  attachRecord: () => Promise<LiveProofAttachResult>;
  publishRecord: () => Promise<void> | void;
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
    await dependencies.hydrateRecord();
    const outcome = await dependencies.attachRecord();
    if (outcome !== "attached") return outcome;

    try {
      await dependencies.publishRecord();
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
