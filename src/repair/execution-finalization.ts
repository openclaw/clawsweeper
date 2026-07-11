import fs from "node:fs";

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
