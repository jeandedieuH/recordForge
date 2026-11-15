import { useId } from "react"
import type { BorderGradient, BorderStyle } from "@recordforge/contracts"

export interface BorderOverlayProps {
  /** Frame size in CSS px. */
  width: number
  height: number
  /** Corner radius in CSS px (ignored when `circular`). */
  radius: number
  /** Rim thickness in CSS px. */
  borderWidth: number
  style?: BorderStyle
  color?: string
  opacity?: number
  gradient?: BorderGradient
  /** Draw an ellipse instead of a rounded rect (circle camera shape). */
  circular?: boolean
}

interface RingProps {
  width: number
  height: number
  radius: number
  circular: boolean
  /** Band start, measured inward from the frame edge, in CSS px. */
  lo: number
  /** Band end, measured inward from the frame edge, in CSS px. */
  hi: number
  stroke: string
  strokeOpacity: number
}

/**
 * One band of a frame border. Bands are inset from the frame edge rather than
 * centred on it, matching the export plates and the GPU compositor's analytic
 * ring, so the preview and the render agree on where the ink lands.
 */
function BorderRing({
  width,
  height,
  radius,
  circular,
  lo,
  hi,
  stroke,
  strokeOpacity,
}: RingProps) {
  const strokeWidth = Math.max(0.5, hi - lo)
  const mid = (lo + hi) / 2
  if (circular) {
    const rx = width / 2 - mid
    const ry = height / 2 - mid
    if (rx <= 0 || ry <= 0) return null
    return (
      <ellipse
        cx={width / 2}
        cy={height / 2}
        rx={rx}
        ry={ry}
        fill="none"
        stroke={stroke}
        strokeOpacity={strokeOpacity}
        strokeWidth={strokeWidth}
      />
    )
  }
  const insetWidth = width - mid * 2
  const insetHeight = height - mid * 2
  if (insetWidth <= 0 || insetHeight <= 0) return null
  return (
    <rect
      x={mid}
      y={mid}
      width={insetWidth}
      height={insetHeight}
      rx={Math.max(0, radius - mid)}
      ry={Math.max(0, radius - mid)}
      fill="none"
      stroke={stroke}
      strokeOpacity={strokeOpacity}
      strokeWidth={strokeWidth}
    />
  )
}

/**
 * Preview frame border. Mirrors the export renderers: `solid` is one stroke,
 * `gradient` ramps `borderGradient` across the frame, `double` paints two
 * strokes with a gap, and `glass` a translucent rim with a bright inner
 * highlight.
 */
export function BorderOverlay({
  width,
  height,
  radius,
  borderWidth,
  style = "solid",
  color = "#ffffff",
  opacity = 1,
  gradient,
  circular = false,
}: BorderOverlayProps) {
  const gradientId = useId()
  if (borderWidth <= 0 || width <= 1 || height <= 1) return null

  const bw = Math.min(borderWidth, Math.min(width, height) / 2)
  const alpha = Math.min(1, Math.max(0, opacity))
  const usesGradient = style === "gradient" && gradient !== undefined
  const stroke = usesGradient ? `url(#${gradientId})` : color

  const ramp = gradient ?? { from: color, to: color, angle: 135 }
  const angle = (ramp.angle * Math.PI) / 180
  const dirX = Math.sin(angle)
  const dirY = -Math.cos(angle)
  const half = 0.5 * (Math.abs(dirX) * width + Math.abs(dirY) * height)

  return (
    <svg
      className="pointer-events-none absolute inset-0"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
    >
      {usesGradient ? (
        <defs>
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1={width / 2 - dirX * half}
            y1={height / 2 - dirY * half}
            x2={width / 2 + dirX * half}
            y2={height / 2 + dirY * half}
          >
            <stop offset="0%" stopColor={ramp.from} />
            <stop offset="100%" stopColor={ramp.to} />
          </linearGradient>
        </defs>
      ) : null}

      {style === "double" ? (
        <>
          <BorderRing
            width={width}
            height={height}
            radius={radius}
            circular={circular}
            lo={0}
            hi={bw * 0.55}
            stroke={stroke}
            strokeOpacity={alpha}
          />
          <BorderRing
            width={width}
            height={height}
            radius={radius}
            circular={circular}
            lo={bw * 0.72}
            hi={bw}
            stroke={stroke}
            strokeOpacity={alpha}
          />
        </>
      ) : style === "glass" ? (
        <>
          <BorderRing
            width={width}
            height={height}
            radius={radius}
            circular={circular}
            lo={0}
            hi={bw}
            stroke={color}
            strokeOpacity={alpha * 0.35}
          />
          <BorderRing
            width={width}
            height={height}
            radius={radius}
            circular={circular}
            lo={bw * 0.72}
            hi={bw}
            stroke="#ffffff"
            strokeOpacity={alpha * 0.55}
          />
        </>
      ) : (
        <BorderRing
          width={width}
          height={height}
          radius={radius}
          circular={circular}
          lo={0}
          hi={bw}
          stroke={stroke}
          strokeOpacity={alpha}
        />
      )}
    </svg>
  )
}
