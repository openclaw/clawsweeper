import fs from "node:fs";
import path from "node:path";

import { normalizeRepo, slugForRepo } from "../repository-profiles.js";
import {
  chooseRecordTupleWinner,
  recordTupleContentsEqual,
  recordTuplePaths,
  type RecordTupleContents,
  type RecordTuplePaths,
} from "./record-tuple.js";

export type EventRecordStore = {
  targetRepo: string;
  itemNumber: string;
  snapshotDir: string;
};

export type EventRecordPaths = {
  targetSlug: string;
  itemRecord: string;
  closedRecord: string;
  planRecord: string;
  decisionPacket: string;
  snapshotBaseItem: string;
  snapshotBaseClosed: string;
  snapshotBasePlan: string;
  snapshotBaseDecisionPacket: string;
  snapshotItem: string;
  snapshotClosed: string;
  snapshotPlan: string;
  snapshotDecisionPacket: string;
};

export type EventRecordDirectories = {
  items: string;
  closed: string;
  plans: string;
  decisionPackets: string;
};

export type EventSnapshotApplyResult =
  | "closed"
  | "open"
  | "remote-closed"
  | "remote-newer"
  | "missing";

export function eventRecordPaths(store: EventRecordStore): EventRecordPaths {
  // Record tuples are written under the lowercased repository-profile slug
  // (normalizeRepo + slugForRepo); read with the same normalization so
  // display-cased target repos (steipete/Nameplate) resolve the same paths.
  const targetSlug = slugForRepo(normalizeRepo(store.targetRepo));
  const tuple = recordTuplePaths({ repository: targetSlug, number: store.itemNumber });
  return {
    targetSlug,
    itemRecord: tuple.item,
    closedRecord: tuple.closed,
    planRecord: tuple.plan,
    decisionPacket: tuple.packet,
    snapshotBaseItem: path.join(store.snapshotDir, "base", "items", `${store.itemNumber}.md`),
    snapshotBaseClosed: path.join(store.snapshotDir, "base", "closed", `${store.itemNumber}.md`),
    snapshotBasePlan: path.join(store.snapshotDir, "base", "plans", `${store.itemNumber}.md`),
    snapshotBaseDecisionPacket: path.join(
      store.snapshotDir,
      "base",
      "decision-packets",
      `${store.itemNumber}.json`,
    ),
    snapshotItem: path.join(store.snapshotDir, "candidate", "items", `${store.itemNumber}.md`),
    snapshotClosed: path.join(store.snapshotDir, "candidate", "closed", `${store.itemNumber}.md`),
    snapshotPlan: path.join(store.snapshotDir, "candidate", "plans", `${store.itemNumber}.md`),
    snapshotDecisionPacket: path.join(
      store.snapshotDir,
      "candidate",
      "decision-packets",
      `${store.itemNumber}.json`,
    ),
  };
}

export function eventRecordDirectories(
  paths: EventRecordPaths,
  root: string,
): EventRecordDirectories {
  return {
    items: path.resolve(root, path.dirname(paths.itemRecord)),
    closed: path.resolve(root, path.dirname(paths.closedRecord)),
    plans: path.resolve(root, path.dirname(paths.planRecord)),
    decisionPackets: path.resolve(root, path.dirname(paths.decisionPacket)),
  };
}

export function resetEventSnapshot(store: EventRecordStore): void {
  fs.rmSync(store.snapshotDir, { recursive: true, force: true });
  fs.mkdirSync(store.snapshotDir, { recursive: true });
}

export function captureEventBaseSnapshot(store: EventRecordStore): EventRecordPaths {
  const paths = eventRecordPaths(store);
  copyIfExists(paths.itemRecord, paths.snapshotBaseItem);
  copyIfExists(paths.closedRecord, paths.snapshotBaseClosed);
  copyIfExists(paths.planRecord, paths.snapshotBasePlan);
  copyIfExists(paths.decisionPacket, paths.snapshotBaseDecisionPacket);
  return paths;
}

export function captureEventSnapshot(store: EventRecordStore): EventRecordPaths {
  const paths = eventRecordPaths(store);
  for (const snapshotPath of [
    paths.snapshotItem,
    paths.snapshotClosed,
    paths.snapshotPlan,
    paths.snapshotDecisionPacket,
  ]) {
    fs.rmSync(snapshotPath, { force: true });
  }
  copyIfExists(paths.itemRecord, paths.snapshotItem);
  copyIfExists(paths.closedRecord, paths.snapshotClosed);
  copyIfExists(paths.planRecord, paths.snapshotPlan);
  copyIfExists(paths.decisionPacket, paths.snapshotDecisionPacket);
  const candidate = snapshotTuple(paths, "candidate");
  if (candidate.item !== null || candidate.closed !== null) {
    const base = snapshotTuple(paths, "base");
    chooseRecordTupleWinner({ base, local: candidate, remote: base });
  }
  return paths;
}

export function applyEventSnapshot(
  paths: EventRecordPaths,
  options: { remoteRoot?: string } = {},
): EventSnapshotApplyResult {
  const base = snapshotTuple(paths, "base");
  const candidate = snapshotTuple(paths, "candidate");
  if (candidate.item === null && candidate.closed === null) return "missing";
  const remote = recordTupleFromRoot(paths, options.remoteRoot ?? ".");
  const winner = chooseRecordTupleWinner({ base, local: candidate, remote });
  if (winner === "remote" || winner === "base") {
    const selected = winner === "remote" ? remote : base;
    return selected.closed !== null && candidate.item !== null ? "remote-closed" : "remote-newer";
  }

  applyTupleToRecords(paths, candidate);
  return candidate.closed !== null ? "closed" : "open";
}

export function applyEventSnapshotIfCurrent(
  paths: EventRecordPaths,
  options: { remoteRoot?: string },
  applyCurrent: () => void,
): EventSnapshotApplyResult {
  const result = applyEventSnapshot(paths, options);
  if (result === "open" || result === "closed") applyCurrent();
  return result;
}

export function eventSnapshotMatchesCurrent(paths: EventRecordPaths): boolean {
  return recordTupleContentsEqual(
    snapshotTuple(paths, "candidate"),
    recordTupleFromRoot(paths, "."),
  );
}

function snapshotTuple(
  paths: EventRecordPaths,
  snapshot: "base" | "candidate",
): RecordTupleContents {
  const tuplePaths = tuplePathsForEvent(paths);
  return {
    paths: tuplePaths,
    item: readIfExists(snapshot === "base" ? paths.snapshotBaseItem : paths.snapshotItem),
    closed: readIfExists(snapshot === "base" ? paths.snapshotBaseClosed : paths.snapshotClosed),
    plan: readIfExists(snapshot === "base" ? paths.snapshotBasePlan : paths.snapshotPlan),
    packet: readIfExists(
      snapshot === "base" ? paths.snapshotBaseDecisionPacket : paths.snapshotDecisionPacket,
    ),
  };
}

function recordTupleFromRoot(paths: EventRecordPaths, root: string): RecordTupleContents {
  return {
    paths: tuplePathsForEvent(paths),
    item: readIfExists(path.join(root, paths.itemRecord)),
    closed: readIfExists(path.join(root, paths.closedRecord)),
    plan: readIfExists(path.join(root, paths.planRecord)),
    packet: readIfExists(path.join(root, paths.decisionPacket)),
  };
}

function tuplePathsForEvent(paths: EventRecordPaths): RecordTuplePaths {
  return recordTuplePaths({
    repository: paths.targetSlug,
    number: path.basename(paths.itemRecord, ".md"),
  });
}

function applyTupleToRecords(paths: EventRecordPaths, tuple: RecordTupleContents): void {
  syncSnapshotPath(tuple.item, paths.itemRecord);
  syncSnapshotPath(tuple.closed, paths.closedRecord);
  syncSnapshotPath(tuple.plan, paths.planRecord);
  syncSnapshotPath(tuple.packet, paths.decisionPacket);
}

function syncSnapshotPath(content: string | null, destination: string): void {
  if (content === null) {
    fs.rmSync(destination, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, "utf8");
}

function readIfExists(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

function copyIfExists(source: string, destination: string): void {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}
