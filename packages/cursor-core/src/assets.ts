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
    </g>`,
  },
  "shape-ibeam": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 12.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 8.5 4 C 10.5 4 11 5 11 6.5 L 11 17.5 C 11 19 10.5 20 8.5 20 L 15.5 20 C 13.5 20 13 19 13 17.5 L 13 6.5 C 13 5 13.5 4 15.5 4 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" stroke-linecap="round" />
      <line x1="12" y1="5.5" x2="12" y2="18.5" stroke="{stroke}" stroke-width="1.2" stroke-linecap="round" stroke-opacity="0.9" />
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
  "shape-grab": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 11.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 8 11 L 8 5 C 8 4.2 8.7 3.5 9.5 3.5 C 10.3 3.5 11 4.2 11 5 L 11 10.5 C 11 10.5 11.2 3.5 12.2 3.5 C 13.2 3.5 13.8 4.2 13.8 5 L 13.8 10.5 C 13.8 10.5 14.1 4.2 15.1 4.2 C 16.1 4.2 16.6 4.9 16.6 5.7 L 16.6 11.5 C 16.6 11.5 17 6.8 18 6.8 C 19 6.8 19.5 7.5 19.5 8.3 L 19.5 13.5 C 19.5 17.5 17 21 13 21 C 9.5 21 7.2 18 6.8 15.5 L 5.3 12.8 C 4.7 11.7 5.1 10.3 6.2 9.7 C 7.3 9.1 8.7 9.7 9.1 10.8 L 9.5 12 L 9.5 11" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" stroke-linecap="round" />
    </g>`,
  },
  "shape-grabbing": {
    viewBox: "0 0 24 24",
    width: DEFAULT_CURSOR_SIZE,
    height: DEFAULT_CURSOR_SIZE,
    hotspotX: 12.5,
    hotspotY: 11.5,
    isCenterHotspot: false,
    svg: `<g transform="translate(0.5, 0.5)">
      <path d="M 7.5 10 C 7.5 8.6 8.6 7.5 10 7.5 C 10.5 7.5 11 7.7 11.4 8 C 11.8 7.4 12.5 7 13.2 7 C 13.8 7 14.3 7.2 14.7 7.6 C 15.1 7.2 15.7 7 16.3 7 C 17.7 7 18.8 8.1 18.8 9.5 L 18.8 13.5 C 18.8 17.5 16.5 20.5 13 20.5 C 9.5 20.5 7.5 17.5 7.5 14 L 7.5 10 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" stroke-linecap="round" />
      <path d="M 5 12 C 4.5 11 4.8 9.8 5.8 9.2 C 6.8 8.6 8.2 9 8.8 10 L 10.5 12.5 L 9.2 14 C 8.2 15.2 6.5 14.5 5.8 13.5 Z" fill="{fill}" fill-opacity="{fillOpacity}" stroke="{stroke}" stroke-width="{strokeWidth}" stroke-opacity="{strokeOpacity}" stroke-linejoin="round" />
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
  }
  return labels[id] ?? id
}

// Map V2 cursor `kind` strings from `capture/cursor_v2.rs` to the generic shape
// asset used when the user selects the Recorded/System preset.
export const SHAPE_ID_TO_ASSET: Record<string, CursorAssetId> = {
  arrow: "shape-arrow",
  default: "shape-arrow",
  pointer: "shape-hand",
  hand: "shape-hand",
  text: "shape-ibeam",
  ibeam: "shape-ibeam",
  crosshair: "shape-crosshair",
  cross: "shape-crosshair",
  wait: "shape-wait",
  help: "shape-help",
  move: "shape-move",
  "all-scroll": "shape-move",
  "resize-diagonal-1": "shape-resize-diagonal-1",
  "nwse-resize": "shape-resize-diagonal-1",
  "resize-diagonal-2": "shape-resize-diagonal-2",
  "nesw-resize": "shape-resize-diagonal-2",
  "resize-horizontal": "shape-resize-horizontal",
  "ew-resize": "shape-resize-horizontal",
  "col-resize": "shape-col-resize",
  "resize-vertical": "shape-resize-vertical",
  "ns-resize": "shape-resize-vertical",
  "row-resize": "shape-row-resize",
  unavailable: "shape-unavailable",
  "not-allowed": "shape-unavailable",
  "no-drop": "shape-unavailable",
  grab: "shape-grab",
  grabbing: "shape-grabbing",
  "zoom-in": "shape-zoom-in",
  "zoom-out": "shape-zoom-out",
  copy: "shape-copy",
  progress: "shape-progress",
  cell: "shape-cell",
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
