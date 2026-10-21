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
  | "shape-grab"
  | "shape-grabbing"
  | "shape-zoom-in"
  | "shape-zoom-out"
  | "shape-copy"
  | "shape-progress"
  | "shape-cell"
  | "shape-col-resize"
  | "shape-row-resize"
  | "shape-resize-n"
  | "shape-resize-e"
  | "shape-resize-s"
  | "shape-resize-w"
  | "shape-vertical-text"
  | "shape-context-menu"
  | "shape-alias"

const SVG_TOKENS = {
  fill: "{fill}",
  fillOpacity: "{fillOpacity}",
  stroke: "{stroke}",
  strokeWidth: "{strokeWidth}",
  strokeOpacity: "{strokeOpacity}",
  maxStroke: "{Math.max(2, strokeWidth)}",
  fallbackStroke: "{strokeWidth || 1.5}",
}

// Default base dimension for modern presentation cursors (CSS pixels on 1.0x scale).
export const DEFAULT_CURSOR_SIZE = 64

// Preset SVGs are authored in a 24x24 view box. Their `hotspotX`/`hotspotY`
// represent the active point within that view box.
const PRESET_SVGS: Record<CursorAssetId, Omit<CursorAsset, "id" | "label">> = {
  // Recorded/System fallback: a modern pointer arrow with an aerodynamic head,
  // clean stem, and active point at the arrow tip (3.5, 3.5).
  "recorded-system": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 3.5,
    hotspotY: 3.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 3 3 L 3 18.5 L 7.8 14.8 L 11.2 21.8 L 14.5 20.3 L 11.1 13.5 L 17.5 13.5 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" stroke-linecap="round" />
    </g>`,
  },
  // Generic recorded-shape SVGs. The active point is marked by hotspotX/Y and
  // is drawn at that coordinate in the 24x24 view box.
  "shape-arrow": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 3.5,
    hotspotY: 3.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 3 3 L 3 18.5 L 7.8 14.8 L 11.2 21.8 L 14.5 20.3 L 11.1 13.5 L 17.5 13.5 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" stroke-linecap="round" />
    </g>`,
  },
  "shape-hand": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 9,
    hotspotY: 2.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 8.5 2 C 7.6 2 7 2.7 7 3.6 L 7 10.2 C 6.2 9.6 5.1 9.4 4.1 10.1 C 3.1 10.9 2.8 12.2 3.3 13.6 C 4 15.6 5.6 19.2 8.5 20.8 C 9.6 21.4 11.1 21.5 13 21.5 C 16.5 21.5 18 19.8 18.2 17.5 L 18.2 12.8 C 18.2 11.8 17.3 11 16.3 11 C 15.8 11 15.4 11.2 15 11.5 C 14.8 10.4 13.9 9.6 12.8 9.6 C 12.4 9.6 12 9.8 11.7 10 C 11.4 8.9 10.4 8.2 9.4 8.2 C 9.1 8.2 8.7 8.3 8.5 8.5 L 8.5 3.6 C 8.5 2.7 7.6 2 8.5 2 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" stroke-linecap="round" />
      <path d="M 11.7 10.1 C 11.6 11.0 11.6 11.9 11.7 12.8" fill="none" stroke="{stroke}" stroke-width="1.3" stroke-linecap="round" stroke-opacity="0.85" />
      <path d="M 15.0 11.6 C 14.9 12.5 14.9 13.4 15.0 14.3" fill="none" stroke="{stroke}" stroke-width="1.3" stroke-linecap="round" stroke-opacity="0.85" />
    </g>`,
  },
  // I-beam drawn as a single filled glyph: thin stem with horizontal serifs
  // that taper into the stem through diagonal flares (the classic text-caret
  // silhouette), ~1:2 width-to-height so it reads as slender, not a column.
  "shape-ibeam": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 8.1 4.2 L 15.9 4.2 L 15.9 5.9 L 12.9 7.2 L 12.9 16.8 L 15.9 18.1 L 15.9 19.8 L 8.1 19.8 L 8.1 18.1 L 11.1 16.8 L 11.1 7.2 L 8.1 5.9 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" stroke-linecap="round" />
    </g>`,
  },
  "shape-crosshair": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <line x1="12" y1="2" x2="12" y2="8" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linecap="round" />
      <line x1="12" y1="16" x2="12" y2="22" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linecap="round" />
      <line x1="2" y1="12" x2="8" y2="12" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linecap="round" />
      <line x1="16" y1="12" x2="22" y2="12" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linecap="round" />
      <circle cx="12" cy="12" r="3.5" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" />
      <circle cx="12" cy="12" r="1.2" fill="{stroke}" fill-opacity="{strokeOpacity}" />
    </g>`,
  },
  "shape-wait": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 7.5 4.5 C 7.5 8.5 10.2 10.8 11.5 12 C 10.2 13.2 7.5 15.5 7.5 19.5 L 16.5 19.5 C 16.5 15.5 13.8 13.2 12.5 12 C 13.8 10.8 16.5 8.5 16.5 4.5 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
      <line x1="6" y1="4" x2="18" y2="4" stroke="{stroke}" stroke-width="{Math.max(2, strokeWidth)}" stroke-opacity="{strokeOpacity}" stroke-linecap="round" />
      <line x1="6" y1="20" x2="18" y2="20" stroke="{stroke}" stroke-width="{Math.max(2, strokeWidth)}" stroke-opacity="{strokeOpacity}" stroke-linecap="round" />
      <path d="M 9.5 18.5 C 9.5 17 11 16 12 16 C 13 16 14.5 17 14.5 18.5 Z" fill="{stroke}" fill-opacity="0.85" />
      <line x1="12" y1="11" x2="12" y2="15.5" stroke="{stroke}" stroke-width="1.2" stroke-linecap="round" stroke-opacity="0.75" />
    </g>`,
  },
  "shape-help": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 3.5,
    hotspotY: 3.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 3 3 L 3 16.5 L 6.8 13.5 L 9.5 19 L 12 17.8 L 9.3 12.4 L 14.5 12.4 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" stroke-linecap="round" />
      <circle cx="16" cy="16" r="5.5" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" />
      <path d="M 14.4 14.2 C 14.4 13.2 15.1 12.5 16 12.5 C 16.9 12.5 17.6 13.2 17.6 14 C 17.6 14.8 17 15.3 16.4 15.7 C 16 16 15.8 16.3 15.8 16.8" fill="none" stroke="{stroke}" stroke-width="1.3" stroke-linecap="round" />
      <circle cx="15.8" cy="18.5" r="0.75" fill="{stroke}" />
    </g>`,
  },
  "shape-move": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 12 2 L 8 6.5 L 10.5 6.5 L 10.5 10.5 L 6.5 10.5 L 6.5 8 L 2 12 L 6.5 16 L 6.5 13.5 L 10.5 13.5 L 10.5 17.5 L 8 17.5 L 12 22 L 16 17.5 L 13.5 17.5 L 13.5 13.5 L 17.5 13.5 L 17.5 16 L 22 12 L 17.5 8 L 17.5 10.5 L 13.5 10.5 L 13.5 6.5 L 16 6.5 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
      <circle cx="12" cy="12" r="1.8" fill="{stroke}" fill-opacity="{strokeOpacity}" />
    </g>`,
  },
  "shape-resize-diagonal-1": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <g transform="rotate(45 12 12)">
        <path d="M 2 12 L 6.5 7.5 L 6.5 10.5 L 17.5 10.5 L 17.5 7.5 L 22 12 L 17.5 16.5 L 17.5 13.5 L 6.5 13.5 L 6.5 16.5 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
        <line x1="12" y1="9" x2="12" y2="15" stroke="{stroke}" stroke-width="1.5" stroke-linecap="round" />
      </g>
    </g>`,
  },
  "shape-resize-diagonal-2": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <g transform="rotate(-45 12 12)">
        <path d="M 2 12 L 6.5 7.5 L 6.5 10.5 L 17.5 10.5 L 17.5 7.5 L 22 12 L 17.5 16.5 L 17.5 13.5 L 6.5 13.5 L 6.5 16.5 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
        <line x1="12" y1="9" x2="12" y2="15" stroke="{stroke}" stroke-width="1.5" stroke-linecap="round" />
      </g>
    </g>`,
  },
  "shape-resize-horizontal": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 2 12 L 6.5 7.5 L 6.5 10.5 L 17.5 10.5 L 17.5 7.5 L 22 12 L 17.5 16.5 L 17.5 13.5 L 6.5 13.5 L 6.5 16.5 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
      <line x1="12" y1="9" x2="12" y2="15" stroke="{stroke}" stroke-width="1.5" stroke-linecap="round" />
    </g>`,
  },
  "shape-resize-vertical": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 12 2 L 7.5 6.5 L 10.5 6.5 L 10.5 17.5 L 7.5 17.5 L 12 22 L 16.5 17.5 L 13.5 17.5 L 13.5 6.5 L 16.5 6.5 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
      <line x1="9" y1="12" x2="15" y2="12" stroke="{stroke}" stroke-width="1.5" stroke-linecap="round" />
    </g>`,
  },
  "shape-unavailable": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <circle cx="12" cy="12" r="8.5" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" />
      <line x1="6" y1="6" x2="18" y2="18" stroke="{stroke}" stroke-width="{Math.max(2, strokeWidth)}" stroke-linecap="round" stroke-opacity="{strokeOpacity}" />
    </g>`,
  },
  // Open "grab" hand: rounded palm with four fused finger bumps across the top
  // (fingers together, not splayed) and a thumb angled out to the left. Short
  // stroke-colored crease lines continue the finger valleys into the palm so
  // the fingers read as separate digits instead of a mitten.
  "shape-grab": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 11.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 5.2 8.9 C 6.2 8.0 7.5 8.3 8.1 9.3 L 9.2 7.5 C 9.6 6.3 10.0 5.6 10.8 5.5 C 11.6 5.4 12.0 6.4 12.0 7.8 C 12.1 6.4 12.4 5.0 13.3 4.9 C 14.1 4.8 14.6 5.8 14.6 7.3 C 14.7 6.1 15.1 5.1 15.9 5.2 C 16.7 5.3 17.1 6.4 17.0 7.8 C 17.5 7.5 18.1 7.9 18.2 8.6 C 18.5 9.7 18.5 11.0 18.5 12.4 L 18.5 18.2 C 18.5 20.1 17.0 21.5 15.2 21.5 L 10.4 21.5 C 8.6 21.5 7.1 20.1 7.1 18.2 L 7.1 13.8 C 6.4 12.9 5.5 12.1 5.0 10.9 C 4.6 10.0 4.7 9.3 5.2 8.9 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" stroke-linecap="round" />
      <path d="M 12.0 7.9 C 11.9 8.9 11.8 9.9 11.8 10.8" fill="none" stroke="{stroke}" stroke-width="1.3" stroke-linecap="round" stroke-opacity="0.85" />
      <path d="M 14.6 7.4 C 14.5 8.4 14.5 9.4 14.5 10.4" fill="none" stroke="{stroke}" stroke-width="1.3" stroke-linecap="round" stroke-opacity="0.85" />
      <path d="M 17.0 7.9 C 17.0 8.9 17.1 9.9 17.1 10.8" fill="none" stroke="{stroke}" stroke-width="1.3" stroke-linecap="round" stroke-opacity="0.85" />
      <path d="M 8.3 10.0 C 7.9 11.0 7.7 12.0 7.8 13.0" fill="none" stroke="{stroke}" stroke-width="1.3" stroke-linecap="round" stroke-opacity="0.85" />
    </g>`,
  },
  // Closed "grabbing" fist: same rounded palm but knuckles only (fingers
  // curled), thumb folded over the left edge. Crease lines separate the
  // knuckles and mark where the thumb wraps across.
  "shape-grabbing": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 11.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 7.2 14.2 C 6.3 13.3 6.2 12.0 7.0 11.2 C 8.0 10.0 9.4 10.1 10.0 11.0 C 10.1 9.7 10.5 8.7 11.5 8.6 C 12.4 8.5 12.8 9.3 12.8 10.1 C 13.0 9.1 13.5 8.3 14.4 8.4 C 15.3 8.5 15.7 9.3 15.6 10.2 C 16.0 9.5 16.7 9.1 17.4 9.5 C 18.2 9.9 18.5 10.9 18.5 11.9 L 18.5 17.5 C 18.5 19.7 17.0 21.2 14.9 21.2 L 10.8 21.2 C 8.9 21.2 7.4 19.7 7.4 17.5 L 7.4 15.8 C 6.9 15.3 6.8 14.7 7.2 14.2 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" stroke-linecap="round" />
      <path d="M 12.8 10.3 C 12.7 11.1 12.6 11.9 12.7 12.7" fill="none" stroke="{stroke}" stroke-width="1.3" stroke-linecap="round" stroke-opacity="0.85" />
      <path d="M 15.6 10.4 C 15.5 11.2 15.5 12.0 15.6 12.8" fill="none" stroke="{stroke}" stroke-width="1.3" stroke-linecap="round" stroke-opacity="0.85" />
      <path d="M 9.8 11.4 C 9.0 12.3 8.6 13.3 8.7 14.3" fill="none" stroke="{stroke}" stroke-width="1.3" stroke-linecap="round" stroke-opacity="0.85" />
    </g>`,
  },
  "shape-zoom-in": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 10.5,
    hotspotY: 10.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <circle cx="10" cy="10" r="6.5" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" />
      <line x1="14.8" y1="14.8" x2="20.5" y2="20.5" stroke="{stroke}" stroke-width="{Math.max(2, strokeWidth)}" stroke-opacity="{strokeOpacity}" stroke-linecap="round" />
      <line x1="7.5" y1="10" x2="12.5" y2="10" stroke="{stroke}" stroke-width="1.5" stroke-linecap="round" />
      <line x1="10" y1="7.5" x2="10" y2="12.5" stroke="{stroke}" stroke-width="1.5" stroke-linecap="round" />
    </g>`,
  },
  "shape-zoom-out": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 10.5,
    hotspotY: 10.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <circle cx="10" cy="10" r="6.5" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" />
      <line x1="14.8" y1="14.8" x2="20.5" y2="20.5" stroke="{stroke}" stroke-width="{Math.max(2, strokeWidth)}" stroke-opacity="{strokeOpacity}" stroke-linecap="round" />
      <line x1="7.5" y1="10" x2="12.5" y2="10" stroke="{stroke}" stroke-width="1.5" stroke-linecap="round" />
    </g>`,
  },
  "shape-copy": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 3.5,
    hotspotY: 3.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 3 3 L 3 16.5 L 6.8 13.5 L 9.5 19 L 12 17.8 L 9.3 12.4 L 14.5 12.4 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" stroke-linecap="round" />
      <rect x="12" y="12" width="9" height="9" rx="2" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" />
      <line x1="14" y1="16.5" x2="19" y2="16.5" stroke="{stroke}" stroke-width="1.5" stroke-linecap="round" />
      <line x1="16.5" y1="14" x2="16.5" y2="19" stroke="{stroke}" stroke-width="1.5" stroke-linecap="round" />
    </g>`,
  },
  "shape-progress": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 3.5,
    hotspotY: 3.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 3 3 L 3 16.5 L 6.8 13.5 L 9.5 19 L 12 17.8 L 9.3 12.4 L 14.5 12.4 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" stroke-linecap="round" />
      <circle cx="16.5" cy="16.5" r="4.5" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" />
      <line x1="16.5" y1="13.5" x2="16.5" y2="16.5" stroke="{stroke}" stroke-width="1.2" stroke-linecap="round" />
      <line x1="16.5" y1="16.5" x2="19" y2="16.5" stroke="{stroke}" stroke-width="1.2" stroke-linecap="round" />
    </g>`,
  },
  "shape-cell": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 9.5 3.5 L 14.5 3.5 L 14.5 9.5 L 20.5 9.5 L 20.5 14.5 L 14.5 14.5 L 14.5 20.5 L 9.5 20.5 L 9.5 14.5 L 3.5 14.5 L 3.5 9.5 L 9.5 9.5 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
    </g>`,
  },
  "shape-col-resize": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <line x1="10" y1="3" x2="10" y2="21" stroke="{stroke}" stroke-width="1.8" stroke-linecap="round" stroke-opacity="{strokeOpacity}" />
      <line x1="14" y1="3" x2="14" y2="21" stroke="{stroke}" stroke-width="1.8" stroke-linecap="round" stroke-opacity="{strokeOpacity}" />
      <path d="M 6.5 8.5 L 2 12 L 6.5 15.5 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
      <path d="M 17.5 8.5 L 22 12 L 17.5 15.5 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
    </g>`,
  },
  "shape-row-resize": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <line x1="3" y1="10" x2="21" y2="10" stroke="{stroke}" stroke-width="1.8" stroke-linecap="round" stroke-opacity="{strokeOpacity}" />
      <line x1="3" y1="14" x2="21" y2="14" stroke="{stroke}" stroke-width="1.8" stroke-linecap="round" stroke-opacity="{strokeOpacity}" />
      <path d="M 8.5 6.5 L 12 2 L 15.5 6.5 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
      <path d="M 8.5 17.5 L 12 22 L 15.5 17.5 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
    </g>`,
  },
  // Single-direction edge resizers (macOS / Wayland emit these distinctly from
  // the double-headed axes): a centered arrowhead on a stem, one per side.
  "shape-resize-n": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 12 3.2 L 17.2 10.4 L 13.9 10.4 L 13.9 20.8 L 10.1 20.8 L 10.1 10.4 L 6.8 10.4 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" stroke-linecap="round" />
    </g>`,
  },
  "shape-resize-e": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 20.8 12 L 13.6 17.2 L 13.6 13.9 L 3.2 13.9 L 3.2 10.1 L 13.6 10.1 L 13.6 6.8 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" stroke-linecap="round" />
    </g>`,
  },
  "shape-resize-s": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 12 20.8 L 6.8 13.6 L 10.1 13.6 L 10.1 3.2 L 13.9 3.2 L 13.9 13.6 L 17.2 13.6 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" stroke-linecap="round" />
    </g>`,
  },
  "shape-resize-w": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 3.2 12 L 10.4 6.8 L 10.4 10.1 L 20.8 10.1 L 20.8 13.9 L 10.4 13.9 L 10.4 17.2 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" stroke-linecap="round" />
    </g>`,
  },
  // Vertical-layout text caret: the I-beam rotated 90° so the serifs sit at the
  // horizontal ends (matches macOS IBeamCursorForVerticalLayout).
  "shape-vertical-text": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <g transform="rotate(90 12 12)">
        <path d="M 8.1 4.2 L 15.9 4.2 L 15.9 5.9 L 12.9 7.2 L 12.9 16.8 L 15.9 18.1 L 15.9 19.8 L 8.1 19.8 L 8.1 18.1 L 11.1 16.8 L 11.1 7.2 L 8.1 5.9 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" stroke-linecap="round" />
      </g>
    </g>`,
  },
  // Context-menu: pointer arrow plus a small list badge in the lower right
  // (matches the Windows/macOS contextual-menu cursor).
  "shape-context-menu": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 3.5,
    hotspotY: 3.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 3 3 L 3 16.5 L 6.8 13.5 L 9.5 19 L 12 17.8 L 9.3 12.4 L 14.5 12.4 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" stroke-linecap="round" />
      <rect x="12.5" y="13.5" width="9" height="8" rx="1.8" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" />
      <line x1="14.5" y1="16" x2="19.5" y2="16" stroke="{stroke}" stroke-width="1.2" stroke-linecap="round" />
      <line x1="14.5" y1="18" x2="19.5" y2="18" stroke="{stroke}" stroke-width="1.2" stroke-linecap="round" />
      <line x1="14.5" y1="20" x2="19.5" y2="20" stroke="{stroke}" stroke-width="1.2" stroke-linecap="round" />
    </g>`,
  },
  // Alias/shortcut link: pointer arrow plus a circular badge carrying a
  // diagonal jump arrow (the classic "opens elsewhere" glyph).
  "shape-alias": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 3.5,
    hotspotY: 3.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 3 3 L 3 16.5 L 6.8 13.5 L 9.5 19 L 12 17.8 L 9.3 12.4 L 14.5 12.4 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" stroke-linecap="round" />
      <circle cx="16.5" cy="16.5" r="5" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" />
      <path d="M 15.4 14.5 L 18.5 14.5 L 18.5 17.6 M 14.3 18.7 L 18.3 14.7" fill="none" stroke="{stroke}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    </g>`,
  },
}

export const CURSOR_ASSET_MANIFEST: Record<CursorAssetId, CursorAsset> = Object.fromEntries(
  (Object.keys(PRESET_SVGS) as CursorAssetId[]).map((id) => [
    id,
    {
      id,
      label: labelForAssetId(id),
      ...PRESET_SVGS[id],
      width: DEFAULT_CURSOR_SIZE,
      height: DEFAULT_CURSOR_SIZE,
    },
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
    "shape-grab": "Grab",
    "shape-grabbing": "Grabbing",
    "shape-zoom-in": "Zoom In",
    "shape-zoom-out": "Zoom Out",
    "shape-copy": "Copy",
    "shape-progress": "Progress",
    "shape-cell": "Cell",
    "shape-col-resize": "Column Resize",
    "shape-row-resize": "Row Resize",
    "shape-resize-n": "Resize North",
    "shape-resize-e": "Resize East",
    "shape-resize-s": "Resize South",
    "shape-resize-w": "Resize West",
    "shape-vertical-text": "Vertical Text",
    "shape-context-menu": "Context Menu",
    "shape-alias": "Alias / Link",
  }
  return labels[id] ?? id
}

// Map V2 cursor `kind` strings from `capture/cursor_v2.rs` to the generic shape
// asset used when the user selects the Recorded/System preset. Aliases cover
// the CSS cursor names (what Wayland's cursor-shape-v1 reports verbatim) and
// the common X11/Xcursor theme names seen through XFixes.
export const SHAPE_ID_TO_ASSET: Record<string, CursorAssetId> = {
  arrow: "shape-arrow",
  default: "shape-arrow",
  auto: "shape-arrow",
  left_ptr: "shape-arrow",
  top_left_arrow: "shape-arrow",
  right_ptr: "shape-arrow",
  pointer: "shape-hand",
  hand: "shape-hand",
  hand1: "shape-hand",
  hand2: "shape-hand",
  pointing_hand: "shape-hand",
  text: "shape-ibeam",
  ibeam: "shape-ibeam",
  xterm: "shape-ibeam",
  "vertical-text": "shape-vertical-text",
  crosshair: "shape-crosshair",
  cross: "shape-crosshair",
  diamond_cross: "shape-crosshair",
  wait: "shape-wait",
  watch: "shape-wait",
  help: "shape-help",
  question_arrow: "shape-help",
  move: "shape-move",
  "all-scroll": "shape-move",
  fleur: "shape-move",
  size_all: "shape-move",
  "dnd-move": "shape-move",
  "resize-diagonal-1": "shape-resize-diagonal-1",
  "nwse-resize": "shape-resize-diagonal-1",
  "nw-resize": "shape-resize-diagonal-1",
  "se-resize": "shape-resize-diagonal-1",
  top_left_corner: "shape-resize-diagonal-1",
  bottom_right_corner: "shape-resize-diagonal-1",
  size_fdiag: "shape-resize-diagonal-1",
  "resize-diagonal-2": "shape-resize-diagonal-2",
  "nesw-resize": "shape-resize-diagonal-2",
  "ne-resize": "shape-resize-diagonal-2",
  "sw-resize": "shape-resize-diagonal-2",
  top_right_corner: "shape-resize-diagonal-2",
  bottom_left_corner: "shape-resize-diagonal-2",
  size_bdiag: "shape-resize-diagonal-2",
  "resize-horizontal": "shape-resize-horizontal",
  "ew-resize": "shape-resize-horizontal",
  size_hor: "shape-resize-horizontal",
  sb_h_double_arrow: "shape-resize-horizontal",
  "e-resize": "shape-resize-e",
  "w-resize": "shape-resize-w",
  right_side: "shape-resize-e",
  left_side: "shape-resize-w",
  sb_right_arrow: "shape-resize-e",
  sb_left_arrow: "shape-resize-w",
  "col-resize": "shape-col-resize",
  "resize-vertical": "shape-resize-vertical",
  "ns-resize": "shape-resize-vertical",
  size_ver: "shape-resize-vertical",
  sb_v_double_arrow: "shape-resize-vertical",
  "n-resize": "shape-resize-n",
  "s-resize": "shape-resize-s",
  top_side: "shape-resize-n",
  bottom_side: "shape-resize-s",
  sb_up_arrow: "shape-resize-n",
  sb_down_arrow: "shape-resize-s",
  "row-resize": "shape-row-resize",
  unavailable: "shape-unavailable",
  "not-allowed": "shape-unavailable",
  "no-drop": "shape-unavailable",
  "dnd-none": "shape-unavailable",
  "dnd-no-drop": "shape-unavailable",
  circle: "shape-unavailable",
  crossed_circle: "shape-unavailable",
  "context-menu": "shape-context-menu",
  context_menu: "shape-context-menu",
  "dnd-ask": "shape-context-menu",
  alias: "shape-alias",
  "dnd-link": "shape-alias",
  link: "shape-alias",
  grab: "shape-grab",
  openhand: "shape-grab",
  grabbing: "shape-grabbing",
  closedhand: "shape-grabbing",
  "zoom-in": "shape-zoom-in",
  "zoom-out": "shape-zoom-out",
  copy: "shape-copy",
  "dnd-copy": "shape-copy",
  progress: "shape-progress",
  left_ptr_watch: "shape-progress",
  cell: "shape-cell",
  plus: "shape-cell",
  center_ptr: "shape-cell",
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
  const shapeWidth = shape.width > 0 ? shape.width : 24
  const shapeHeight = shape.height > 0 ? shape.height : 24
  const targetHotspotX = (shape.hotspotX * 24) / shapeWidth
  const targetHotspotY = (shape.hotspotY * 24) / shapeHeight
  const offsetX = targetHotspotX - base.hotspotX
  const offsetY = targetHotspotY - base.hotspotY

  // Normalize cursor dimensions to presentation base size (DEFAULT_CURSOR_SIZE = 64)
  // while preserving any custom non-square aspect ratio from the recorded shape.
  const aspect = shapeWidth / shapeHeight
  const width = Math.round(DEFAULT_CURSOR_SIZE * Math.max(1, aspect))
  const height = Math.round(DEFAULT_CURSOR_SIZE / Math.min(1, aspect))

  return {
    ...base,
    id: `${base.id}:${shape.shapeId}`,
    label: `Recorded ${shape.kind}`,
    viewBox: "0 0 24 24",
    width,
    height,
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
