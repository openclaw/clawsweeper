import fs from "node:fs";

export function pinRepairBase(resolveBaseSha: () => string): Readonly<{ sha: string }> {
  const sha = resolveBaseSha().trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error("repair target base did not resolve to a full commit SHA");
  }
  return Object.freeze({ sha });
}

export function reviewAfterFinalBaseSync<T>({
  syncChanged,
  currentReview,
  reviewSynchronizedTree,
  checkpointSynchronizedTree,
}: {
  syncChanged: boolean;
  currentReview: T;
  reviewSynchronizedTree: () => T;
  checkpointSynchronizedTree: () => void;
}): T {
  if (!syncChanged) return currentReview;
  const review = reviewSynchronizedTree();
  checkpointSynchronizedTree();
  return review;
}

export function finalBaseSyncRequiresReview({
  syncStatus,
  synchronizedBaseSha,
  validatedBaseSha,
}: {
  syncStatus: string;
  synchronizedBaseSha: string;
  validatedBaseSha: string;
}): boolean {
  return syncStatus !== "already-current" || synchronizedBaseSha !== validatedBaseSha;
}

export function persistBeforePublication({
  reportPath,
  serialize,
  publish,
}: {
  reportPath: string;
  serialize: () => string;
  publish: () => void;
}): void {
  fs.writeFileSync(reportPath, serialize());
  try {
    publish();
  } finally {
    fs.writeFileSync(reportPath, serialize());
  }
}

export function finalizeExecutionReport({
  deferPublication,
  reportPath,
  serialize,
  publish,
}: {
  deferPublication: boolean;
  reportPath: string;
  serialize: () => string;
  publish: () => void;
}): void {
  if (deferPublication) {
    fs.writeFileSync(reportPath, serialize());
    return;
  }
  persistBeforePublication({ reportPath, serialize, publish });
}
