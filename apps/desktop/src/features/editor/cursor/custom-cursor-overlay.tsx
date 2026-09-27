import { useId, useMemo } from "react"
import {
  cursorSizeFactor,
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
  const spotlightFeatherId = `${spotlightMaskId}-feather`
  const clickGlowId = `${spotlightMaskId}-click`

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

  if (!containerWidth || !containerHeight) return null

  const posX = zoomed.x
  const posY = zoomed.y
  // DPI-consistent size factor (1 for legacy projects) — same math as export.
  const sizeFactor = cursorSizeFactor(cursorSettings, telemetry)
  const cursorScale =
    (cursorSettings.scale ?? 1) *
    sizeFactor *
    (fitted.scale ?? 1) *
    zoomed.scale *
    (frame.clickScale ?? 1)
  const isCursorVisible = cursorSettings.enabled && frame.visible && frame.opacity > 0

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
      {/* Spotlight mode background mask (black dim + feathered hole, same as export) */}
      {isCursorVisible && cursorSettings.spotlightMode
        ? (() => {
            const radius =
              (cursorSettings.spotlightRadius ?? 0) *
              (fitted.scale ?? 1) *
              (cursorSettings.scale ?? 1) *
              sizeFactor *
              zoomed.scale
            const feather = Math.max(1.5, 0.12 * radius)
            const outer = radius + feather
            const innerFrac = outer > 0 ? Math.min(1, radius / outer) : 1
            return (
              <svg className="pointer-events-none absolute inset-0 size-full">
                <defs>
                  <radialGradient
                    id={spotlightFeatherId}
                    gradientUnits="userSpaceOnUse"
                    cx={posX}
                    cy={posY}
                    r={outer}
                  >
                    <stop offset={innerFrac} stopColor="black" />
                    <stop offset="100%" stopColor="white" />
                  </radialGradient>
                  <mask id={spotlightMaskId}>
                    <rect width="100%" height="100%" fill="white" />
                    <circle cx={posX} cy={posY} r={outer} fill={`url(#${spotlightFeatherId})`} />
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
            )
          })()
        : null}

      {/* Click feedback rendered from engine expand/fade — same geometry as
          the export renderer: r = D/2 * (0.25 + 0.75*expand), alpha = 0.75*fade. */}
      {isCursorVisible && cursorSettings.clickFeedback !== "none"
        ? clickEffects.map((click, index) => {
            const clickSize =
              Math.max(10, cursorSettings.clickSize) *
              (click.fitted.scale ?? 1) *
              (cursorSettings.scale ?? 1) *
              sizeFactor *
              click.zoomed.scale
            const radius = Math.max(1, (clickSize / 2) * (0.25 + 0.75 * click.expand))
            const alpha = 0.75 * click.fade
            if (alpha <= 0) return null
            const color = cursorSettings.clickColor
            const diameter = radius * 2 + 2
            const center = diameter / 2

            return (
              <svg
                key={`${click.startMs}-${index}`}
                className="pointer-events-none absolute overflow-visible"
                style={{
                  left: click.zoomed.x - center,
                  top: click.zoomed.y - center,
                  width: diameter,
                  height: diameter,
                }}
              >
                {cursorSettings.clickFeedback === "ripple" ? (
                  <circle
                    cx={center}
                    cy={center}
                    r={radius}
                    fill="none"
                    stroke={color}
                    strokeWidth={Math.max(1, 0.08 * clickSize)}
                    strokeOpacity={alpha}
                  />
                ) : cursorSettings.clickFeedback === "spotlight" ? (
                  <>
                    <defs>
                      <radialGradient
                        id={`${clickGlowId}-${index}`}
                        gradientUnits="userSpaceOnUse"
                        cx={center}
                        cy={center}
                        r={radius}
                      >
                        {/* Core at alpha to 0.55r, then quadratic ×0.5 halo. */}
                        <stop offset="0%" stopColor={color} stopOpacity={alpha} />
                        <stop offset="55%" stopColor={color} stopOpacity={alpha} />
                        <stop offset="55.0001%" stopColor={color} stopOpacity={alpha * 0.5} />
                        <stop offset="77.5%" stopColor={color} stopOpacity={alpha * 0.125} />
                        <stop offset="100%" stopColor={color} stopOpacity={0} />
                      </radialGradient>
                    </defs>
                    <circle
                      cx={center}
                      cy={center}
                      r={radius}
                      fill={`url(#${clickGlowId}-${index})`}
                    />
                  </>
                ) : (
                  <circle cx={center} cy={center} r={radius} fill={color} fillOpacity={alpha} />
                )}
              </svg>
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
