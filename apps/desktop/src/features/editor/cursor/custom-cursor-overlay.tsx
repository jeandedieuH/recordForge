import { useId, useMemo } from "react"
import {
  fitCursorPoint,
  mapCursorPointThroughZoom,
  renderCursorAssetSvg,
  resolveCursorAsset,
  type CursorFrame,
  type CursorZoomTransform,
} from "@recordforge/cursor-core"
import type { CursorSettings, CursorTelemetryFile } from "@recordforge/contracts"

interface CustomCursorOverlayProps {
  /** Canonical cursor frame from the engine. */
  frame: CursorFrame
  cursorSettings: CursorSettings
  telemetry: CursorTelemetryFile
  containerWidth: number
  containerHeight: number
  canvasWidth: number
  canvasHeight: number
  offsetX?: number
  offsetY?: number
  /** The structured transform used by the video, not a second CSS transform. */
  zoomTransform?: CursorZoomTransform | null
  /** Radius for clipping the overlay to the video screen. */
  borderRadius?: number | string
}

function fitSourcePoint(
  point: { x: number; y: number },
  telemetry: CursorTelemetryFile,
  width: number,
  height: number,
) {
  return fitCursorPoint(point, telemetry, width, height)
}

export function CustomCursorOverlay({
  frame,
  cursorSettings,
  telemetry,
  containerWidth,
  containerHeight,
  canvasWidth,
  canvasHeight,
  offsetX = 0,
  offsetY = 0,
  zoomTransform,
  borderRadius,
}: CustomCursorOverlayProps) {
  const instanceId = useId()
  const spotlightMaskId = `spotlight-mask-${instanceId.replace(/:/g, "")}`

  const fitted = useMemo(
    () =>
      fitSourcePoint(
        { x: frame.sourceX, y: frame.sourceY },
        telemetry,
        containerWidth,
        containerHeight,
      ),
    [frame.sourceX, frame.sourceY, telemetry, containerWidth, containerHeight],
  )

  const zoomed = useMemo(
    () =>
      mapCursorPointThroughZoom(
        { x: fitted.x, y: fitted.y },
        { width: containerWidth, height: containerHeight },
        { width: canvasWidth, height: canvasHeight },
        zoomTransform,
      ),
    [fitted.x, fitted.y, containerWidth, containerHeight, canvasWidth, canvasHeight, zoomTransform],
  )

  const clickEffects = useMemo(
    () =>
      frame.activeClicks.map((click) => {
        const clickFitted = fitSourcePoint(
          { x: click.sourceX, y: click.sourceY },
          telemetry,
          containerWidth,
          containerHeight,
        )
        return {
          ...click,
          fitted: clickFitted,
          zoomed: mapCursorPointThroughZoom(
            { x: clickFitted.x, y: clickFitted.y },
            { width: containerWidth, height: containerHeight },
            { width: canvasWidth, height: canvasHeight },
            zoomTransform,
          ),
        }
      }),
    [
      frame.activeClicks,
      telemetry,
      containerWidth,
      containerHeight,
      canvasWidth,
      canvasHeight,
      zoomTransform,
    ],
  )

  const asset = useMemo(
    () =>
      resolveCursorAsset(frame.shapeId, cursorSettings.preset, {
        shapeMode: cursorSettings.shapeMode,
        shapes: telemetry.shapes,
      }),
    [frame.shapeId, cursorSettings.preset, cursorSettings.shapeMode, telemetry],
  )

  if (!containerWidth || !containerHeight) return null

  const posX = zoomed.x
  const posY = zoomed.y
  const cursorScale = (cursorSettings.scale ?? 1) * (fitted.scale ?? 1) * zoomed.scale
  const isCursorVisible = cursorSettings.enabled && frame.visible && frame.opacity > 0

  const cursorMarkup = useMemo(
    () =>
      renderCursorAssetSvg(asset, {
        fill: cursorSettings.fillColor,
        fillOpacity: cursorSettings.fillOpacity,
        stroke: cursorSettings.strokeColor,
        strokeWidth: cursorSettings.strokeWidth,
        strokeOpacity: cursorSettings.strokeOpacity,
      }),
    [
      asset,
      cursorSettings.fillColor,
      cursorSettings.fillOpacity,
      cursorSettings.strokeColor,
      cursorSettings.strokeWidth,
      cursorSettings.strokeOpacity,
    ],
  )

  return (
    <div
      aria-hidden={!isCursorVisible}
      className="pointer-events-none absolute z-10 overflow-hidden rounded-lg"
      style={{
        left: offsetX,
        top: offsetY,
        width: containerWidth,
        height: containerHeight,
        borderRadius,
      }}
    >
      {/* Spotlight mode background mask */}
      {isCursorVisible && cursorSettings.spotlightMode ? (
        <svg className="pointer-events-none absolute inset-0 size-full">
          <defs>
            <mask id={spotlightMaskId}>
              <rect width="100%" height="100%" fill="white" />
              <circle
                cx={posX}
                cy={posY}
                r={
                  cursorSettings.spotlightRadius *
                  (fitted.scale ?? 1) *
                  (cursorSettings.scale ?? 1) *
                  zoomed.scale
                }
                fill="black"
              />
            </mask>
          </defs>
          <rect
            width="100%"
            height="100%"
            fill="black"
            fillOpacity={cursorSettings.spotlightDimOpacity ?? 0.5}
            mask={`url(#${spotlightMaskId})`}
          />
        </svg>
      ) : null}

      {/* Click feedback rendered from project-time effect progress. */}
      {isCursorVisible && cursorSettings.clickFeedback !== "none"
        ? clickEffects.map((click, index) => {
            const size =
              cursorSettings.clickSize *
              (click.fitted.scale ?? 1) *
              (cursorSettings.scale ?? 1) *
              click.zoomed.scale
            const scale = 0.25 + click.progress * 0.75
            const opacity = click.intensity * 0.75
            const color = cursorSettings.clickColor

            return (
              <div
                key={`${click.startMs}-${index}`}
                className="pointer-events-none absolute rounded-full"
                style={{
                  left: click.zoomed.x,
                  top: click.zoomed.y,
                  width: size,
                  height: size,
                  transform: `translate(-50%, -50%) scale(${scale})`,
                  opacity,
                  backgroundColor:
                    cursorSettings.clickFeedback === "ripple" ? "transparent" : color,
                  borderColor: color,
                  borderStyle: "solid",
                  borderWidth: cursorSettings.clickFeedback === "ripple" ? 3 : 0,
                  boxShadow:
                    cursorSettings.clickFeedback === "spotlight"
                      ? `0 0 ${size * 0.4}px ${color}`
                      : undefined,
                }}
              />
            )
          })
        : null}

      {/* Custom cursor icon */}
      {isCursorVisible ? (
        <div
          className="pointer-events-none absolute"
          style={{
            left: posX - asset.hotspotX * (asset.width / 24) * cursorScale,
            top: posY - asset.hotspotY * (asset.height / 24) * cursorScale,
            transform: asset.isCenterHotspot
              ? `translate(-50%, -50%) scale(${cursorScale})`
              : `scale(${cursorScale})`,
            transformOrigin: asset.isCenterHotspot ? "center" : "top left",
            filter: cursorSettings.shadowEnabled
              ? `drop-shadow(${cursorSettings.shadowOffsetX}px ${cursorSettings.shadowOffsetY}px ${cursorSettings.shadowBlur}px ${cursorSettings.shadowColor})`
              : "none",
            opacity: frame.opacity,
            willChange: "transform, opacity",
          }}
        >
          <svg
            width={asset.width}
            height={asset.height}
            viewBox={asset.viewBox}
            className="overflow-visible"
            aria-hidden
          >
            <g dangerouslySetInnerHTML={{ __html: cursorMarkup }} />
          </svg>
        </div>
      ) : null}
    </div>
  )
}
