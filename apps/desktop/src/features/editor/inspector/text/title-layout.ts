import type { TextClip } from "@recordforge/contracts"

export interface TitleCanvas {
  width: number
  height: number
}
export interface TitlePlacement {
  column: 0 | 1 | 2
  row: 0 | 1 | 2
}

function rotatedBounds(clip: TextClip) {
  const angle = (clip.rotation * Math.PI) / 180
  const cos = Math.cos(angle),
    sin = Math.sin(angle)
  const ax = clip.width * clip.anchorX,
    ay = clip.height * clip.anchorY
  const corners = [
    [0, 0],
    [clip.width, 0],
    [0, clip.height],
    [clip.width, clip.height],
  ].map(([x, y]) => ({
    x: ax + (x - ax) * cos - (y - ay) * sin,
    y: ay + (x - ax) * sin + (y - ay) * cos,
  }))
  return {
    left: Math.min(...corners.map((p) => p.x)),
    right: Math.max(...corners.map((p) => p.x)),
    top: Math.min(...corners.map((p) => p.y)),
    bottom: Math.max(...corners.map((p) => p.y)),
  }
}

/** Fit the rotated box first, then place it; oversized presets cannot produce negative positions. */
export function fitTitleLayout(
  clip: TextClip,
  canvas: TitleCanvas,
  update: Partial<TextClip> = {},
  placement?: TitlePlacement,
): Partial<TextClip> {
  const next = { ...clip, ...update }
  const margin = Math.min(canvas.width, canvas.height) * 0.05
  const availableWidth = Math.max(20, canvas.width - margin * 2)
  const availableHeight = Math.max(20, canvas.height - margin * 2)
  next.width = Math.max(20, next.width)
  next.height = Math.max(20, next.height)
  let bounds = rotatedBounds(next)
  const scale = Math.min(
    1,
    availableWidth / (bounds.right - bounds.left),
    availableHeight / (bounds.bottom - bounds.top),
  )
  next.width = Math.max(20, next.width * scale)
  next.height = Math.max(20, next.height * scale)
  bounds = rotatedBounds(next)
  const minX = margin - bounds.left,
    maxX = canvas.width - margin - bounds.right
  const minY = margin - bounds.top,
    maxY = canvas.height - margin - bounds.bottom
  const x = placement ? minX + ((maxX - minX) * placement.column) / 2 : next.x
  const y = placement ? minY + ((maxY - minY) * placement.row) / 2 : next.y
  return {
    ...update,
    width: next.width,
    height: next.height,
    x: Math.min(Math.max(x, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(y, minY), Math.max(minY, maxY)),
  }
}
