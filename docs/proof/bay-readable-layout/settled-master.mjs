// Geometry checks over actual browser measurements. Motion is deliberately
// outside this invariant: intentional sweep/climb/settle overlaps are allowed.
const valid = (rect) =>
  rect &&
  ["x", "y", "right", "bottom", "width", "height"].every((key) => Number.isFinite(rect[key])) &&
  rect.width > 0 &&
  rect.height > 0;
export function settledMasterViolations(snapshot) {
  if (
    snapshot.phase !== "resting" ||
    !snapshot.resting ||
    snapshot.moving ||
    snapshot.settling ||
    snapshot.transitioning
  )
    return { checked: false, reason: "not_settled", violations: [] };
  const violations = [];
  if (!snapshot.visible || !snapshot.imagesLoaded) violations.push({ kind: "not_visible" });
  const master = snapshot.master,
    beach = snapshot.beach;
  if (!valid(master) || !valid(beach))
    return { checked: true, violations: [...violations, { kind: "invalid_bounds" }] };
  if (
    master.x < beach.x ||
    master.y < beach.y ||
    master.right > beach.right ||
    master.bottom > beach.bottom
  )
    violations.push({ kind: "clipped_by_beach" });
  for (const obstacle of snapshot.obstacles) {
    if (!valid(obstacle.bounds)) {
      violations.push({ kind: "invalid_obstacle_bounds", target: obstacle.target });
      continue;
    }
    const width =
      Math.min(master.right, obstacle.bounds.right) - Math.max(master.x, obstacle.bounds.x);
    const height =
      Math.min(master.bottom, obstacle.bounds.bottom) - Math.max(master.y, obstacle.bounds.y);
    if (width > 0 && height > 0)
      violations.push({ kind: "overlap", target: obstacle.target, width, height });
  }
  return { checked: true, violations };
}

// Preserve the pre-reservation mobile anchor, independent of footer height.
export function activeMobileMasterTop(sceneHeight, masterHeight) {
  return sceneHeight - masterHeight - 16;
}
