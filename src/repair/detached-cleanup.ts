export type DetachedCleanupProcess = {
  killed: boolean;
  kill: () => boolean;
  stdin: {
    destroy: () => void;
    end: () => void;
  };
};

/**
 * Finish a detached crash-recovery helper after its owner completed normally.
 *
 * The helper must keep its stdin open while the owner is alive so EOF can
 * trigger recovery after a crash. Once the owner has durably released its
 * ownership, however, leaving that helper alive adds no safety and can exhaust
 * a long-lived runner's PID budget. A failed or ambiguous release still gets
 * the helper's final recovery attempt through the existing EOF path.
 */
export function finishDetachedCleanupProcess(
  child: DetachedCleanupProcess,
  ownershipReleased: boolean,
): void {
  if (!ownershipReleased) {
    child.stdin.end();
    return;
  }
  child.stdin.destroy();
  if (!child.killed) child.kill();
}
