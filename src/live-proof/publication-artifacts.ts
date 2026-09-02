import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  attachReviewLiveProofArtifact,
  LiveProofArtifactValidationError,
  type LiveProofAttachDependencies,
  type LiveProofAttachResult,
} from "./attach.js";

export type PublishReviewLiveProofArtifactsResult =
  | { status: "published"; results: Array<{ item: number; outcome: LiveProofAttachResult }> }
  | { status: "invalid_artifact" };

export async function publishReviewLiveProofArtifacts(
  artifactDirInput: string,
  dependencies: LiveProofAttachDependencies,
): Promise<PublishReviewLiveProofArtifactsResult> {
  const artifactDir = resolve(artifactDirInput);
  if (!existsSync(artifactDir)) return { status: "published", results: [] };
  try {
    const verificationPaths = regularFilesBelow(artifactDir).filter(
      (path) =>
        basename(path) === "live-verification.json" &&
        relative(artifactDir, path).split(sep).includes("live-proof"),
    );
    const results: Array<{ item: number; outcome: LiveProofAttachResult }> = [];
    for (const verificationPath of verificationPaths) {
      const bundleDir = dirname(verificationPath);
      const item = Number(basename(bundleDir));
      if (!Number.isSafeInteger(item) || item <= 0) {
        throw new LiveProofArtifactValidationError("live proof artifact path has an invalid item");
      }
      const outcome = await attachReviewLiveProofArtifact(
        { bundleDir, recordPath: uniqueRecordPath(artifactDir, item) },
        dependencies,
      );
      results.push({ item, outcome });
    }
    return { status: "published", results };
  } catch (error) {
    if (error instanceof LiveProofArtifactValidationError) return { status: "invalid_artifact" };
    throw error;
  }
}

function uniqueRecordPath(artifactDir: string, item: number): string {
  const filename = `${item}.md`;
  const candidates = regularFilesBelow(artifactDir).filter(
    (path) =>
      basename(path) === filename && !relative(artifactDir, path).split(sep).includes("live-proof"),
  );
  if (candidates.length !== 1) {
    throw new LiveProofArtifactValidationError(
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
      if (entry.isSymbolicLink())
        throw new LiveProofArtifactValidationError("live proof artifact must not contain symlinks");
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
      else
        throw new LiveProofArtifactValidationError("live proof artifact contains a non-file entry");
    }
  };
  visit(root);
  return files.sort();
}
