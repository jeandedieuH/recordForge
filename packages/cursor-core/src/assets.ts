import type { CursorShapeInfo, CursorShapeMode } from "@recordforge/contracts"

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
  /** Hotspot in 24x24 view box units. The overlay converts to CSS pixels. */
  hotspotX: number
  hotspotY: number
  /** When true the cursor should be centered on its point rather than offset by the hotspot. */
  isCenterHotspot: boolean
  /** Inner SVG markup (paths, circles, etc.) for the preview overlay. */
  svg: string
}

// The editor only supports the Recorded/System style, which resolves to the
// actual captured cursor shape when V2 telemetry is available. A small set of
// generic shape silhouettes (arrow, hand, ibeam, etc.) are kept so recorded
// cursors without embedded shape bitmaps still render correctly.
export type CursorAssetId =
  | "recorded-system"
  | "shape-arrow"
  | "shape-hand"
  | "shape-ibeam"
  | "shape-crosshair"
  | "shape-wait"
  | "shape-help"
  | "shape-move"
  | "shape-resize-diagonal-1"
  | "shape-resize-diagonal-2"
  | "shape-resize-horizontal"
  | "shape-resize-vertical"
  | "shape-unavailable"

const SVG_TOKENS = {
  fill: "{fill}",
  fillOpacity: "{fillOpacity}",
  stroke: "{stroke}",
  strokeWidth: "{strokeWidth}",
  strokeOpacity: "{strokeOpacity}",
  maxStroke: "{Math.max(2, strokeWidth)}",
  fallbackStroke: "{strokeWidth || 1.5}",
}

// Preset SVGs are authored in a 24x24 view box. Their `hotspotX`/`hotspotY`
// represent the active point within that view box.
const PRESET_SVGS: Record<CursorAssetId, Omit<CursorAsset, "id" | "label">> = {
  // Recorded/System fallback: a generic arrow with the active point at the
  // arrow tip. The recorded shape builder aligns this point with the captured
  // hotspot, so the drawn cursor touches exactly where the user clicked.
  "recorded-system": {
    viewBox: "0 0 24 24",
    width: 28,
    height: 28,
    hotspotX: 3.5,
    hotspotY: 3.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M3 3L10 19L13 12L20 10L3 3Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
    </g>`,
  },
  // Generic recorded-shape SVGs. The active point is marked by hotspotX/Y and
  // is drawn at that coordinate in the 24x24 view box.
  "shape-arrow": {
    viewBox: "0 0 24 24",
    width: 24,
    height: 24,
    hotspotX: 3.5,
    hotspotY: 3.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M3 3L10 19L13 12L20 10L3 3Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
    </g>`,
  },
  "shape-hand": {
    viewBox: "0 0 24 24",
    width: 24,
    height: 24,
    hotspotX: 9,
    hotspotY: 2.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M8.5 2 C7.4 2 6.5 2.9 6.5 4 L6.5 11.8 C5.8 11.2 4.9 11 4 11.5 C3 12 2.5 13 2.7 14.2 C3.3 16.8 5.5 21 9.5 21.8 C14 22.5 17.8 20 18 16 L18 11.5 C18 10.4 17.1 9.5 16 9.5 C15.7 9.5 15.4 9.6 15.1 9.7 C14.8 8.7 13.9 8 12.8 8 C12.5 8 12.2 8.1 11.9 8.2 C11.6 7.2 10.6 6.5 9.5 6.5 C9.1 6.5 8.7 6.6 8.5 6.8 L8.5 4 C8.5 2.9 7.6 2 8.5 2 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
    </g>`,
  },
  "shape-ibeam": {
    viewBox: "0 0 24 24",
    width: 24,
    height: 24,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linecap="round">
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="8" y1="4" x2="16" y2="4" />
      <line x1="8" y1="20" x2="16" y2="20" />
    </g>`,
  },
  "shape-crosshair": {
    viewBox: "0 0 24 24",
    width: 24,
    height: 24,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linecap="round">
      <line x1="12" y1="2" x2="12" y2="22" />
      <line x1="2" y1="12" x2="22" y2="12" />
    </g>`,
  },
  "shape-wait": {
    viewBox: "0 0 24 24",
    width: 24,
    height: 24,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="12" x2="12" y2="6" stroke-linecap="round" />
      <line x1="12" y1="12" x2="16" y2="14" stroke-linecap="round" />
    </g>`,
  },
  "shape-help": {
    viewBox: "0 0 24 24",
    width: 24,
    height: 24,
    hotspotX: 3.5,
    hotspotY: 3.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M3 3L10 19L13 12L20 10L3 3Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
      <text x="14" y="14" font-size="8" fill="{stroke}" font-family="sans-serif" font-weight="bold">?</text>
    </g>`,
  },
  "shape-move": {
    viewBox: "0 0 24 24",
    width: 24,
    height: 24,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linecap="round">
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="12" y1="4" x2="9" y2="7" />
      <line x1="12" y1="4" x2="15" y2="7" />
      <line x1="4" y1="12" x2="7" y2="9" />
      <line x1="4" y1="12" x2="7" y2="15" />
      <line x1="20" y1="12" x2="17" y2="9" />
      <line x1="20" y1="12" x2="17" y2="15" />
      <line x1="12" y1="20" x2="9" y2="17" />
      <line x1="12" y1="20" x2="15" y2="17" />
    </g>`,
  },
  "shape-resize-diagonal-1": {
    viewBox: "0 0 24 24",
    width: 24,
    height: 24,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linecap="round">
      <line x1="4" y1="20" x2="20" y2="4" />
      <line x1="4" y1="20" x2="7" y2="17" />
      <line x1="4" y1="20" x2="7" y2="23" />
      <line x1="20" y1="4" x2="17" y2="1" />
      <line x1="20" y1="4" x2="23" y2="7" />
    </g>`,
  },
  "shape-resize-diagonal-2": {
    viewBox: "0 0 24 24",
    width: 24,
    height: 24,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linecap="round">
      <line x1="4" y1="4" x2="20" y2="20" />
      <line x1="4" y1="4" x2="7" y2="1" />
      <line x1="4" y1="4" x2="1" y2="7" />
      <line x1="20" y1="20" x2="17" y2="23" />
      <line x1="20" y1="20" x2="23" y2="17" />
    </g>`,
  },
  "shape-resize-horizontal": {
    viewBox: "0 0 24 24",
    width: 24,
    height: 24,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linecap="round">
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="12" x2="7" y2="9" />
      <line x1="4" y1="12" x2="7" y2="15" />
      <line x1="20" y1="12" x2="17" y2="9" />
      <line x1="20" y1="12" x2="17" y2="15" />
    </g>`,
  },
  "shape-resize-vertical": {
    viewBox: "0 0 24 24",
    width: 24,
    height: 24,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linecap="round">
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="12" y1="4" x2="9" y2="7" />
      <line x1="12" y1="4" x2="15" y2="7" />
      <line x1="12" y1="20" x2="9" y2="17" />
      <line x1="12" y1="20" x2="15" y2="17" />
    </g>`,
  },
  "shape-unavailable": {
    viewBox: "0 0 24 24",
    width: 24,
    height: 24,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}">
      <circle cx="12" cy="12" r="8" fill="{fill}" fill-opacity="{fillOpacity}" />
      <line x1="6" y1="6" x2="18" y2="18" stroke-linecap="round" />
    </g>`,
  },
}

export const CURSOR_ASSET_MANIFEST: Record<CursorAssetId, CursorAsset> = Object.fromEntries(
  (Object.keys(PRESET_SVGS) as CursorAssetId[]).map((id) => [
    id,
    { id, label: labelForAssetId(id), ...PRESET_SVGS[id] },
  ]),
) as Record<CursorAssetId, CursorAsset>

function labelForAssetId(id: CursorAssetId): string {
  const labels: Record<CursorAssetId, string> = {
    "recorded-system": "Recorded / System",
    "shape-arrow": "Arrow",
    "shape-hand": "Hand",
    "shape-ibeam": "I-Beam",
    "shape-crosshair": "Crosshair",
    "shape-wait": "Wait",
    "shape-help": "Help",
    "shape-move": "Move",
    "shape-resize-diagonal-1": "Resize Diagonal 1",
    "shape-resize-diagonal-2": "Resize Diagonal 2",
    "shape-resize-horizontal": "Resize Horizontal",
    "shape-resize-vertical": "Resize Vertical",
    "shape-unavailable": "Unavailable",
  }
  return labels[id] ?? id
}

// Map V2 cursor `kind` strings from `capture/cursor_v2.rs` to the generic shape
// asset used when the user selects the Recorded/System preset.
export const SHAPE_ID_TO_ASSET: Record<string, CursorAssetId> = {
  arrow: "shape-arrow",
  hand: "shape-hand",
  ibeam: "shape-ibeam",
  crosshair: "shape-crosshair",
  wait: "shape-wait",
  help: "shape-help",
  move: "shape-move",
  "resize-diagonal-1": "shape-resize-diagonal-1",
  "resize-diagonal-2": "shape-resize-diagonal-2",
  "resize-horizontal": "shape-resize-horizontal",
  "resize-vertical": "shape-resize-vertical",
  unavailable: "shape-unavailable",
}

export interface ResolvedCursorAsset extends CursorAsset {
  effectiveId: string
}

interface ResolveCursorAssetOptions {
  shapeMode?: CursorShapeMode
  shapes?: CursorShapeInfo[]
}

function buildRecordedShapeAsset(shape: CursorShapeInfo): ResolvedCursorAsset | null {
  const baseId = SHAPE_ID_TO_ASSET[shape.kind] ?? "recorded-system"
  const base = CURSOR_ASSET_MANIFEST[baseId]
  if (!base) return null

  // The recorded cursor may have different dimensions and a different hotspot
  // than our generic 24x24 base asset. Wrap the base SVG in a translate so the
  // active point (base.hotspotX/Y) aligns with the recorded hotspot scaled to
  // the 24x24 view box.
  const targetHotspotX = (shape.hotspotX * 24) / shape.width
  const targetHotspotY = (shape.hotspotY * 24) / shape.height
  const offsetX = targetHotspotX - base.hotspotX
  const offsetY = targetHotspotY - base.hotspotY

  return {
    ...base,
    id: `${base.id}:${shape.shapeId}`,
    label: `Recorded ${shape.kind}`,
    viewBox: "0 0 24 24",
    width: shape.width,
    height: shape.height,
    // Store the hotspot in 24x24 view box units so the overlay can convert it
    // to CSS pixels using width/24 * cursorScale. This keeps the drawn active
    // point (arrow tip, finger tip, etc.) exactly at the source coordinate.
    hotspotX: targetHotspotX,
    hotspotY: targetHotspotY,
    isCenterHotspot: false,
    effectiveId: shape.shapeId,
    svg:
      offsetX === 0 && offsetY === 0
        ? base.svg
        : `<g transform="translate(${offsetX.toFixed(2)} ${offsetY.toFixed(2)})">${base.svg}</g>`,
  }
}

/** Resolve a cursor asset from a telemetry shape id or a chosen preset. */
export function resolveCursorAsset(
  shapeId: string | undefined | null,
  preset: string,
  options: ResolveCursorAssetOptions = {},
): ResolvedCursorAsset {
  const manifest = CURSOR_ASSET_MANIFEST
  const fallback = (manifest[preset as CursorAssetId] ?? manifest["recorded-system"]) as CursorAsset

  // Recorded/System always attempts to render the captured shape, then falls
  // back to the generic recorded-system arrow when no shape info is available.
  if (preset === "recorded-system") {
    const honorShape = options.shapeMode !== "preset"
    if (honorShape && shapeId && options.shapes) {
      const shape = options.shapes.find((s) => s.shapeId === shapeId)
      if (shape) {
        const recorded = buildRecordedShapeAsset(shape)
        if (recorded) return recorded
      }
    }

    if (honorShape && shapeId) {
      const directAsset = manifest[shapeId as CursorAssetId]
      if (directAsset) return { effectiveId: shapeId, ...directAsset }

      const mappedAssetId = SHAPE_ID_TO_ASSET[shapeId]
      if (mappedAssetId && manifest[mappedAssetId]) {
        return { effectiveId: mappedAssetId, ...manifest[mappedAssetId] }
      }
    }

    return { effectiveId: preset, ...fallback }
  }

  const shapeMode = options.shapeMode ?? "optimized"

  if (!shapeId || shapeMode === "preset") {
    return { effectiveId: preset, ...fallback }
  }

  // For a curated preset style, the only telemetry shape ids we honor are the
  // preset ids themselves. We do not switch to a recorded hand/ibeam/etc. while
  // the user has explicitly chosen an arrow style.
  if (shapeMode === "recorded") {
    const directAsset = manifest[shapeId as CursorAssetId]
    if (directAsset) return { effectiveId: shapeId, ...directAsset }
    return { effectiveId: preset, ...fallback }
  }

  // Optimized mode: only map to the curated preset assets. Recorded shape kinds
  // are reserved for the Recorded/System preset.
  const directAsset = manifest[shapeId as CursorAssetId]
  if (directAsset) return { effectiveId: shapeId, ...directAsset }

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
  svg = replaceToken(svg, SVG_TOKENS.fill, values.fill)
  svg = replaceToken(svg, SVG_TOKENS.fillOpacity, String(values.fillOpacity))
  svg = replaceToken(svg, SVG_TOKENS.stroke, values.stroke)
  svg = replaceToken(svg, SVG_TOKENS.strokeWidth, String(values.strokeWidth))
  svg = replaceToken(svg, SVG_TOKENS.strokeOpacity, String(values.strokeOpacity))
  svg = replaceToken(svg, SVG_TOKENS.maxStroke, String(Math.max(2, values.strokeWidth)))
  svg = replaceToken(svg, SVG_TOKENS.fallbackStroke, String(values.strokeWidth || 1.5))
  return svg
}
