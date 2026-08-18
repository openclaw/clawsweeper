import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  attachReviewLiveProofArtifact,
  type LiveProofAttachDependencies,
  type LiveProofAttachResult,
} from "./attach.js";
import { parseLiveVerificationResult } from "./verification.js";

export async function publishReviewLiveProofArtifacts(
  artifactDirInput: string,
  dependencies: LiveProofAttachDependencies,
  selectTarget?: (repo: string) => void,
): Promise<Array<{ item: number; outcome: LiveProofAttachResult }>> {
  const artifactDir = resolve(artifactDirInput);
  if (!existsSync(artifactDir)) return [];
  const verificationPaths = regularFilesBelow(artifactDir).filter(
    (path) =>
      basename(path) === "live-verification.json" &&
      relative(artifactDir, path).split(sep).includes("live-proof"),
  );
  const results: Array<{ item: number; outcome: LiveProofAttachResult }> = [];
  for (const verificationPath of verificationPaths) {
    const verification = parseLiveVerificationResult(
      JSON.parse(readFileSync(verificationPath, "utf8")) as unknown,
    );
    selectTarget?.(verification.repo);
    const recordPath = uniqueRecordPath(artifactDir, verification.item);
    const outcome = await attachReviewLiveProofArtifact(
      { bundleDir: dirname(verificationPath), recordPath },
      dependencies,
    );
    results.push({ item: verification.item, outcome });
  }
  return results;
}

function uniqueRecordPath(artifactDir: string, item: number): string {
  const filename = `${item}.md`;
  const candidates = regularFilesBelow(artifactDir).filter(
    (path) =>
      basename(path) === filename && !relative(artifactDir, path).split(sep).includes("live-proof"),
  );
  if (candidates.length !== 1) {
    throw new Error(
      `live proof publication expected one review artifact for item ${item}, found ${candidates.length}`,
    );
  }
  return candidates[0]!;
}

function regularFilesBelow(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("live proof artifact must not contain symlinks");
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
      else throw new Error("live proof artifact contains a non-file entry");
    }
  };
  visit(root);
  return files.sort();
}
