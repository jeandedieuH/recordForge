import { useMemo } from "react"
import {
  renderCursorAssetSvg,
  resolveCursorAsset,
  type CursorAsset,
} from "@recordforge/cursor-core"
import { cn } from "@recordforge/ui"

export interface CursorAssetSvgProps {
  /** Cursor shape id from telemetry; falls back to the chosen preset. */
  shapeId?: string
  /** Preset/style to use when no telemetry shape is available. */
  preset: string
  fillColor?: string
  fillOpacity?: number
  strokeColor?: string
  strokeWidth?: number
  strokeOpacity?: number
  className?: string
  /** Nudges the preview slightly so the hotspot looks correct inside a small square. */
  isPreview?: boolean
}

export function RenderCursorPreset({
  shapeId,
  preset,
  fillColor = "#3b82f6",
  fillOpacity = 1,
  strokeColor = "#ffffff",
  strokeWidth = 2,
  strokeOpacity = 1,
  className,
}: CursorAssetSvgProps) {
  const asset = useMemoizedAsset(shapeId, preset)
  const markup = renderCursorAssetSvg(asset, {
    fill: fillColor,
    fillOpacity,
    stroke: strokeColor,
    strokeWidth,
    strokeOpacity,
  })

  return (
    <svg
      width={asset.width}
      height={asset.height}
      viewBox={asset.viewBox}
      className={cn("overflow-visible", className)}
      aria-hidden
    >
      <g dangerouslySetInnerHTML={{ __html: markup }} />
    </svg>
  )
}

function useMemoizedAsset(shapeId: string | undefined, preset: string): CursorAsset {
  return useMemo(() => resolveCursorAsset(shapeId, preset), [shapeId, preset])
}
