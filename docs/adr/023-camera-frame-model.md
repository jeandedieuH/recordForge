# ADR 023: Camera Frame Model

## Status

Accepted — 2026-11-17. Extends ADR 018 (GPU compositor) and ADR 022 (unified layer
stack). Supersedes the pixel-based camera `ClipTransform` + preset rebuild path.

## Context

The camera bubble was configured in four overlapping places that disagreed:

- **Corner radius** had four values: 0.08 × short side in the layout lane
  (`camera-layouts.ts`), 0.12 × short side in the preview border ring and both
  export renderers, CSS `12%` (elliptical) on the preview surface, and a 0.12
  fallback in Rust's mask generation.
- **Side-by-side** was implemented four times: the domain preset (76/24), the
  layout lane (50/50), a hard-coded `0.76` in `timeline-view.tsx`, and Rust's
  `overlay_is_side_by_side`, which matched the camera x against magic numbers.
- **Geometry was stored in absolute canvas pixels.** An aspect-ratio switch
  rebuilt the camera from a preset (discarding manual placement), and a
  resolution-tier change left pixel geometry untouched. Border width, shadow blur
  and camera size did not scale with resolution.
- The preview consumed only the camera rect of a layout-lane pose; the lane's
  screen pose (side-by-side shrinks the screen) reached export but not the preview.

## Decision

### 1. One resolution-independent spec on the camera clip

`CameraClip.frame` (optional, additive; project v1 stays valid) holds a
`CameraFrame`:

```ts
placement: {
  mode: "overlay" | "split" | "full"
  align: { x: 0..1, y: 0..1 }    // position inside the free area; (1,1) = bottom-right
  size: number                    // frame HEIGHT as a fraction of the canvas SHORT edge
  margin: number                  // inset from the anchor area, fraction of short edge
  anchorTo: "content" | "canvas"  // padded content rect vs full canvas
  split: { side: "left"|"right"|"top"|"bottom", ratio, gap, fit: "frame"|"column" }
  origin: "auto" | "pinned"
}
shape: "rectangle" | "rounded" | "circle"
aspect: "source" | "1:1" | "4:3" | "3:4" | "5:7" | "16:9" | "9:16" | number (w/h)
cornerRadius: number              // fraction of the frame's short side; default 0.12
style: { opacity, borderWidth, borderColor, borderOpacity, borderStyle,
         borderGradient, shadowEnabled, shadowColor, shadowBlur,
         shadowOffsetX, shadowOffsetY }   // lengths in DESIGN UNITS (1080 base)
framing: { focusX: 0..1, focusY: 0..1, zoom: >= 1 }
preset?: CameraPlacementPreset    // names the auto policy while origin === "auto"
visible?: boolean
```

- Effective aspect is 1:1 for `circle`; `full` mode covers the canvas.
- `size`, `margin`, `align` and `cornerRadius` are fractions, so ratio and
  resolution changes need no rewrite. Style lengths are multiplied by
  `shortEdge / 1080` at resolve time.
- **One radius constant**: `CAMERA_CORNER_RADIUS_FRACTION = 0.12`
  (canonical export value). Every surface consumes the px radius the resolver
  emits; nothing re-derives it.
- `origin: "auto"` frames are rebuilt by the smart-default policy on an aspect
  ratio change (16:9 → split, other ratios → circle; the per-ratio circle table
  is preserved as fractions). `origin: "pinned"` frames keep their fractions and
  are clamped into the new area by construction.

### 2. One resolver, one split function

`resolveCameraFrame` (editor-core) is a pure function returning the camera rect,
screen slot rect, px radius, opacity, shape, source crop and px style. The
preview and the render-plan builder both call it. A single `computeSplit`
produces the screen slot and camera column for both the clip-level `split`
placement (ratio 0.76, gap 0.02, `fit: "frame"`, `anchorTo: "content"`) and the
layout-lane `side-by-side` kind (ratio 0.5, gap 0, `fit: "column"`,
`anchorTo: "canvas"`). The slot matches Rust's `video_screen_rect(.., true)`
inputs: width `round(contentWidth × ratio)`, height scaled by the canvas aspect,
vertically centred in the content rect.

### 3. Layout lane = overrides of the same spec

`CameraLayoutSegment` is unchanged on disk. The resolver maps a segment to a
placement override (`pip` → overlay with corner/size/shape; `fullscreen` → full;
`side-by-side` → split; `hidden` → opacity 0) and keeps the existing transition
windows, easing and keyframe sampling. Lane `pip.sizeFraction` is a fraction of
canvas height; the resolver converts it (`size = f × height / shortEdge`) so
existing lane geometry is unchanged.

### 4. Legacy compatibility

- **Load**: a camera clip without `frame` is migrated from its pixel `transform`
  (`preset` set → `origin: "auto"`, else `pinned`; crop → `framing`; style
  lengths ÷ `shortEdge / 1080`).
- **Save**: `transform` is written in sync, resolved at the current canvas and
  source size, so older app versions still read the camera. `frame` wins when
  both are present.

### 5. Render plan and Rust

`RenderPlanOverlay` carries the resolved px `radius`, resolved style lengths and,
for split placement, an explicit screen slot. Rust stops deriving radius
constants and stops inferring side-by-side from the overlay x coordinate; it reads
the plan. Existing fast paths (uniform side-by-side, per-window screen
keyframes) are fed by explicit plan data.

## Consequences

- Ratio and resolution switches are non-destructive for pinned cameras; auto
  cameras still follow smart defaults.
- Preview and export cannot diverge on shape, radius, split or screen pose: they
  share one resolver, enforced by a shared JSON parity fixture consumed by TS and
  Rust tests.
- Rounded cameras inside lane windows move from 0.08 to the canonical 0.12.
  Border/shadow now scale with resolution, so 2160p projects look proportionally
  correct (they were previously half-scale).
- Old app versions open new projects through the mirrored `transform`.

## Implementation notes (Phases 1–5)

Deviations and decisions taken while landing this ADR:

- **Split screen slot.** The render plan emits `screen` even-rounded
  (`sideBySideScreenSlot`) but keeps the slot origin unrounded to match the
  legacy Rust arithmetic bit-exactly; the preview fits the video into the
  unrounded resolver slot.
- **`CameraFrameCanvas.aspectRatio`** is optional and drives only the
  per-ratio circle-PiP table — geometry itself never depends on the named
  ratio.
- **Lane corner radius** moved from 0.08 to the canonical 0.12
  (`CAMERA_CORNER_RADIUS_FRACTION`); the frame model carries `cornerRadius`
  explicitly and lane windows blend it like other pose fields.
- **Auto rebuild preserves customised style.** On an aspect-ratio switch an
  `auto` frame keeps a user-edited `style` and only adopts the new preset's
  default style when the old style still deep-equals the previous preset's.
  `framing` and `visible` always survive.
- **Gesture patch semantics.** Drag/resize emit `cameraFramePatchFromRect`
  (align + size only; margin/anchorTo are never patched). A shape or corner
  edit preserves or pins `origin` per the merge rule; preview snap guides and
  Alt-to-disable live in the view layer, not the model.
- **Toolbar visibility.** The floating shape/corner toolbar and resize
  handles only appear when the resolved frame is draggable (overlay base or a
  lane `pip` window); full/split frames show selection chrome only.
- **`update-canvas` `cameraSources` removed.** Canvas commands no longer take
  a source map or rewrite camera geometry; `reconcileCameraFramesForCanvas`
  rebuilds `auto` frames and re-mirrors `transform` instead.
- **Lane `pip` drags edit the segment** (`corner: "custom"` + `x`/`y`/
  `sizeFraction`) via `update-camera-layout`; there is intentionally no
  second geometry model for lane windows.
