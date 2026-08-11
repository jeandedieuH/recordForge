// Shared cursor asset manifest.
//
// Preview and export should resolve the same asset id to the same geometry,
// hotspot, and view box. The React overlay renders the `svg` markup; the Rust
// export can rasterize the equivalent paths from this manifest.

export interface CursorAsset {
  id: string
  label: string
  viewBox: string
  width: number
  height: number
  /** Hotspot in source asset coordinates. */
  hotspotX: number
  hotspotY: number
  /** When true the cursor should be centered on its point rather than offset by the hotspot. */
  isCenterHotspot: boolean
  /** Inner SVG markup (paths, circles, etc.) for the preview overlay. */
  svg: string
}

export type CursorAssetId =
  | "recorded-system"
  | "clean-pointer"
  | "high-contrast"
  | "touch-dot"
  | "default"
  | "modern-neon"
  | "sleek-dark"
  | "highlighter-circle"
  | "mac-pro"
  | "cyberpunk"
  | "minimal-dot"
  | "hand-pointer"

export const CURSOR_ASSET_MANIFEST: Record<CursorAssetId, CursorAsset> = {
  "recorded-system": {
    id: "recorded-system",
    label: "Recorded / System",
    viewBox: "0 0 24 24",
    width: 28,
    height: 28,
    hotspotX: 0,
    hotspotY: 0,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M3 3L10.07 19.97L12.58 12.58L19.97 10.07L3 3Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
    </g>`,
  },
  "clean-pointer": {
    id: "clean-pointer",
    label: "Clean Pointer",
    viewBox: "0 0 24 24",
    width: 28,
    height: 28,
    hotspotX: 0,
    hotspotY: 0,
    isCenterHotspot: false,
    svg: `<path d="M3 3L11 20L14 13.5L20.5 10.5L3 3Z" fill="#FFFFFF" fill-opacity="{fillOpacity}" stroke="#1E1E1E" stroke-width="{strokeWidth || 1.5}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />`,
  },
  "high-contrast": {
    id: "high-contrast",
    label: "High Contrast",
    viewBox: "0 0 32 32",
    width: 32,
    height: 32,
    hotspotX: 16,
    hotspotY: 16,
    isCenterHotspot: true,
    svg: `<circle cx="16" cy="16" r="13" fill="{fill}" fill-opacity="0.35" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" />
      <circle cx="16" cy="16" r="3" fill="{stroke}" opacity="{strokeOpacity}" />`,
  },
  "touch-dot": {
    id: "touch-dot",
    label: "Touch Dot",
    viewBox: "0 0 20 20",
    width: 28,
    height: 28,
    hotspotX: 10,
    hotspotY: 10,
    isCenterHotspot: true,
    svg: `<circle cx="10" cy="10" r="7" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" />`,
  },
  default: {
    id: "default",
    label: "Classic Arrow",
    viewBox: "0 0 24 24",
    width: 28,
    height: 28,
    hotspotX: 0,
    hotspotY: 0,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M3 3L10.07 19.97L12.58 12.58L19.97 10.07L3 3Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
    </g>`,
  },
  "modern-neon": {
    id: "modern-neon",
    label: "Modern Neon",
    viewBox: "0 0 24 24",
    width: 28,
    height: 28,
    hotspotX: 0,
    hotspotY: 0,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.25, 0.25)">
      <path d="M3 3L10.5 20.5L13.8 13.8L20.5 10.5L3 3Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
      <circle cx="4" cy="4" r="2" fill="{stroke}" opacity="{strokeOpacity}" />
    </g>`,
  },
  "sleek-dark": {
    id: "sleek-dark",
    label: "Sleek Dark",
    viewBox: "0 0 24 24",
    width: 28,
    height: 28,
    hotspotX: 0,
    hotspotY: 0,
    isCenterHotspot: false,
    svg: `<path d="M3 3L10 21L13.5 13.5L21 10L3 3Z" fill="#121212" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{Math.max(2, strokeWidth)}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />`,
  },
  "highlighter-circle": {
    id: "highlighter-circle",
    label: "Highlighter",
    viewBox: "0 0 32 32",
    width: 32,
    height: 32,
    hotspotX: 16,
    hotspotY: 16,
    isCenterHotspot: true,
    svg: `<circle cx="16" cy="16" r="13" fill="{fill}" fill-opacity="0.35" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" />
      <circle cx="16" cy="16" r="3" fill="{stroke}" opacity="{strokeOpacity}" />`,
  },
  "mac-pro": {
    id: "mac-pro",
    label: "Mac Pro",
    viewBox: "0 0 24 24",
    width: 28,
    height: 28,
    hotspotX: 0,
    hotspotY: 0,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.25, 0.25)">
      <path d="M3 3L11 20L14 13.5L20.5 10.5L3 3Z" fill="#FFFFFF" fill-opacity="{fillOpacity}" stroke="#1E1E1E" stroke-width="{strokeWidth || 1.5}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
    </g>`,
  },
  cyberpunk: {
    id: "cyberpunk",
    label: "Cyberpunk",
    viewBox: "0 0 32 32",
    width: 32,
    height: 32,
    hotspotX: 16,
    hotspotY: 16,
    isCenterHotspot: true,
    svg: `<circle cx="16" cy="16" r="12" stroke="{fill}" stroke-width="{strokeWidth || 2}" fill="none" stroke-dasharray="4 2" />
      <line x1="16" y1="2" x2="16" y2="8" stroke="{stroke}" stroke-width="2" />
      <line x1="16" y1="24" x2="16" y2="30" stroke="{stroke}" stroke-width="2" />
      <line x1="2" y1="16" x2="8" y2="16" stroke="{stroke}" stroke-width="2" />
      <line x1="24" y1="16" x2="30" y2="16" stroke="{stroke}" stroke-width="2" />
      <circle cx="16" cy="16" r="3" fill="{fill}" />`,
  },
  "minimal-dot": {
    id: "minimal-dot",
    label: "Minimal Dot",
    viewBox: "0 0 20 20",
    width: 28,
    height: 28,
    hotspotX: 10,
    hotspotY: 10,
    isCenterHotspot: true,
    svg: `<circle cx="10" cy="10" r="7" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" />`,
  },
  "hand-pointer": {
    id: "hand-pointer",
    label: "Hand Pointer",
    viewBox: "0 0 24 24",
    width: 28,
    height: 28,
    hotspotX: 0,
    hotspotY: 0,
    isCenterHotspot: false,
    svg: `<g transform="translate(-0.11, 0.15)">
      <path d="M10 11V4.5C10 3.67 9.33 3 8.5 3C7.67 3 7 3.67 7 4.5V12.79L5.44 11.23C4.85 10.64 3.9 10.64 3.31 11.23C2.72 11.82 2.72 12.77 3.31 13.36L8.5 18.55C9.88 19.93 11.75 20.7 13.7 20.7H16.5C19.26 20.7 21.5 18.46 21.5 15.7V11.5C21.5 10.67 20.83 10 20 10C19.17 10 18.5 10.67 18.5 11.5V10C18.5 9.17 17.83 8.5 17 8.5C16.17 8.5 15.5 9.17 15.5 10V9.5C15.5 8.67 14.83 8 14 8C13.17 8 12.5 8.67 12.5 9.5V11" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
    </g>`,
  },
}

export interface ResolvedCursorAsset extends CursorAsset {
  effectiveId: string
}

/** Resolve a cursor asset from a telemetry shape id or a chosen preset. */
export function resolveCursorAsset(
  shapeId: string | undefined | null,
  preset: string,
): ResolvedCursorAsset {
  const manifest = CURSOR_ASSET_MANIFEST
  const fallback = (manifest[preset as CursorAssetId] ?? manifest.default) as CursorAsset

  if (shapeId && manifest[shapeId as CursorAssetId]) {
    return { effectiveId: shapeId, ...manifest[shapeId as CursorAssetId] }
  }

  return { effectiveId: preset, ...fallback }
}

export interface CursorAssetRenderProps {
  fill: string
  fillOpacity: number
  stroke: string
  strokeWidth: number
  strokeOpacity: number
}

function replaceToken(input: string, token: string, value: string): string {
  return input.split(token).join(value)
}

/** Substitute the template tokens in an asset's SVG markup with runtime colors. */
export function renderCursorAssetSvg(
  asset: CursorAsset,
  props: Partial<CursorAssetRenderProps>,
): string {
  const values: Required<CursorAssetRenderProps> = {
    fill: props.fill ?? "#3b82f6",
    fillOpacity: props.fillOpacity ?? 1,
    stroke: props.stroke ?? "#ffffff",
    strokeWidth: props.strokeWidth ?? 2,
    strokeOpacity: props.strokeOpacity ?? 1,
  }

  let svg = asset.svg
  svg = replaceToken(svg, "{fill}", values.fill)
  svg = replaceToken(svg, "{fillOpacity}", String(values.fillOpacity))
  svg = replaceToken(svg, "{stroke}", values.stroke)
  svg = replaceToken(svg, "{strokeWidth}", String(values.strokeWidth))
  svg = replaceToken(svg, "{strokeOpacity}", String(values.strokeOpacity))
  svg = replaceToken(svg, "{Math.max(2, strokeWidth)}", String(Math.max(2, values.strokeWidth)))
  svg = replaceToken(svg, "{strokeWidth || 1.5}", String(values.strokeWidth || 1.5))
  return svg
}
