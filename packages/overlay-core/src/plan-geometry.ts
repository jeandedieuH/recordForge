import type { OverlayRenderItem, OverlayRenderPlan, OverlayTransform } from "@recordforge/contracts"

/**
 * Geometry-only mutation for a retained WASM scene. Every other field must be
 * identical in the new plan; `diffOverlayPlanGeometry` is the guard that keeps
 * the fast path honest.
 */
export interface OverlayGeometryPatch {
  id: string
  transform: OverlayTransform
  endX?: number
  endY?: number
}

function isAnnotation(
  item: OverlayRenderItem,
): item is Extract<OverlayRenderItem, { kind: "annotation" }> {
  return item.kind === "annotation"
}

/**
 * The part of an item that a drag/resize never changes. Comparing this instead
 * of the whole item keeps text/style edits on the full-rebuild path while a
 * pure transform drag can patch the retained scene.
 */
function geometryFreeItem(item: OverlayRenderItem): unknown {
  if (isAnnotation(item)) {
    const { transform: _transform, endX: _endX, endY: _endY, ...rest } = item
    return rest
  }
  const { transform: _transform, ...rest } = item
  return rest
}

function sameGeometryFreeItem(left: OverlayRenderItem, right: OverlayRenderItem): boolean {
  return JSON.stringify(geometryFreeItem(left)) === JSON.stringify(geometryFreeItem(right))
}

function sameTransform(left: OverlayTransform, right: OverlayTransform): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.rotation === right.rotation &&
    left.anchorX === right.anchorX &&
    left.anchorY === right.anchorY &&
    left.zIndex === right.zIndex &&
    left.opacity === right.opacity
  )
}

/**
 * Return the geometry patches when `next` differs from `previous` only in item
 * transforms / connector endpoints, `[]` when nothing changed, or `null` when
 * the plan needs a full engine rebuild (canvas, assets, fonts, timing, style,
 * animation, item set or z-order changed).
 */
export function diffOverlayPlanGeometry(
  previous: OverlayRenderPlan,
  next: OverlayRenderPlan,
): OverlayGeometryPatch[] | null {
  if (
    previous.canvas.width !== next.canvas.width ||
    previous.canvas.height !== next.canvas.height
  ) {
    return null
  }
  if (JSON.stringify(previous.assets) !== JSON.stringify(next.assets)) return null
  if (JSON.stringify(previous.fonts) !== JSON.stringify(next.fonts)) return null
  if (previous.items.length !== next.items.length) return null

  const patches: OverlayGeometryPatch[] = []
  for (let index = 0; index < previous.items.length; index++) {
    const before = previous.items[index]!
    const after = next.items[index]!
    if (before.id !== after.id) return null
    if (before.transform.zIndex !== after.transform.zIndex) return null
    if (!sameGeometryFreeItem(before, after)) return null
    // The patch protocol can move defined endpoints but cannot clear one, so a
    // presence change (turning a callout pointer on/off) needs a full rebuild.
    if (!endPointPresenceMatches(before, after)) return null
    if (sameTransform(before.transform, after.transform) && endPointsEqual(before, after)) continue

    const patch: OverlayGeometryPatch = { id: after.id, transform: after.transform }
    if (isAnnotation(after)) {
      if (after.endX !== undefined) patch.endX = after.endX
      if (after.endY !== undefined) patch.endY = after.endY
    }
    patches.push(patch)
  }
  return patches
}

function endPointsEqual(left: OverlayRenderItem, right: OverlayRenderItem): boolean {
  if (!isAnnotation(left) || !isAnnotation(right)) return true
  return left.endX === right.endX && left.endY === right.endY
}

function endPointPresenceMatches(left: OverlayRenderItem, right: OverlayRenderItem): boolean {
  if (!isAnnotation(left) || !isAnnotation(right)) return true
  return (
    (left.endX === undefined) === (right.endX === undefined) &&
    (left.endY === undefined) === (right.endY === undefined)
  )
}
