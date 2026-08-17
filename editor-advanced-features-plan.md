# recordForge Editor Advanced Features — Architecture & Implementation Plan

## 1. Purpose

This plan defines the architecture, domain model, module seams, interaction design, rendering/export parity strategy, and implementation roadmap for the next generation of recordForge editor overlays:

- **Annotations** — rectangles, rounded-rects, circles, arrows, lines, callouts, spotlights, and badges.
- **Titles / text presets** — categorized, searchable, customizable title and lower-third presets.
- **External media overlays and tracks** — imported audio, images/graphics, and (later) video b-roll that persist in the project, appear in the timeline, preview correctly, and export reliably.

The current implementation is functional but unstable, laggy, and diverges between React preview and Rust export. This plan replaces the ad-hoc overlay stack with a single canonical evaluation engine, a transactional interaction model, a durable asset importer, and a modern, discoverable preset UI.

## 2. Source of Truth and Precedence

- `AGENTS.md` (repo root) and `apps/desktop/AGENTS.md` — stack, boundaries, and security rules.
- `packages/contracts/src/timeline.ts` — canonical clip, track, render plan, and export schemas.
- `packages/contracts/src/project.ts` and `packages/contracts/src/media.ts` — project asset and media job schemas.
- `packages/editor-core/src/annotation-presets.ts`, `text-presets.ts`, `commands.ts`, `command-records.ts`, `interaction-transaction.ts`, `preview-composition.ts` — current logic.
- `apps/desktop/src/features/editor/canvas/annotation-canvas-overlay.tsx`, `text-canvas-overlay.tsx`, `image-canvas-overlay.tsx` — current overlay UI and gesture handling.
- `apps/desktop/src/features/editor/panels/annotations-panel.tsx`, `titles-panel.tsx`, `external-media-panel.tsx` — current panel UX.
- `apps/desktop/src/features/editor/timeline/use-timeline-interaction.ts` and `apps/desktop/src/features/editor/timeline/timeline-view.tsx` — current interaction transaction and overlay wiring.
- `packages/cursor-engine/` and `packages/cursor-core/` — the existing Rust/WASM engine pattern we are extending.
- `apps/desktop/src-tauri/src/exports/annotations.rs` and `mod.rs` — current Rust export overlay rendering.
- `packages/media-core/src/render-plan.ts` — render plan construction.

## 3. Executive Decisions

1. **Single canonical overlay evaluator.** Create a new `packages/overlay-engine` Rust crate (native + WASM) modeled on `packages/cursor-engine`. It is the only place that turns a set of overlay clips into a display list or rendered frame.
2. **React preview uses WASM overlay engine.** The preview canvas is a single HTML5 Canvas rendered by the WASM engine. React only draws the selection/handle UI on top and never recomposes the whole overlay DOM on every playhead tick.
3. **Export uses the same Rust code.** Native export calls the same scene evaluator and renders into a `tiny-skia` pixmap that is streamed into the FFmpeg graph, replacing per-frame SVG parsing.
4. **Transactional overlay interactions.** All drag, resize, rotate, and arrow-end gestures go through `InteractionTransaction` (draft → validate → commit/cancel). No command is committed until the gesture ends.
5. **External media is a first-class project asset.** Imported audio/image/video files are copied or referenced into the project directory, registered in the project asset list, probed by FFprobe, deduplicated by hash, and tracked with derivatives (thumbnails, waveforms, proxies).
6. **Media `kind` and timeline `role` are separated.** `kind` describes the file format (audio/image/video/cursor/caption). `role` describes how the clip behaves on the timeline (music/sound_effect/voiceover/graphic/b_roll/audio_track).
7. **Presets move from code to a registry.** Annotation shape presets and title style presets live in versioned JSON files, support categories/search/favorites, and allow users to save custom presets.
8. **Font parity is explicit.** A small vendored font bundle (sans, serif, mono, heading) is shipped with the app and used by both the preview and the exporter.

## 4. Current State Problems

### 4.1 Performance

- `AnnotationCanvasOverlay`, `TextCanvasOverlay`, and `ImageCanvasOverlay` all receive `playheadMs` as a prop and re-render on every frame.
- Overlays are rebuilt as DOM/SVG on every render. There is no retained scene.
- Pointer gestures commit `createUpdate*ClipCommand` on every `pointermove` (see `timeline-view.tsx:1274-1331`).
- `getCanvasCoords()` and percentage conversions are not memoized.
- No virtualization for long preset or asset lists.
- Inspector sliders are not debounced.

### 4.2 UX

- No rotation support for any overlay clip; text clips have no rotation field.
- Text clips only support a single SE resize handle. Annotations have partial 8-way support.
- Drag threshold is effectively sub-pixel, causing accidental commits.
- Clips can be dragged partially off-canvas.
- Preset browsing is a single linear scroll, not categorized or visually rich.
- External media panel stores files as `URL.createObjectURL` and hardcodes metadata (`durationMs: 30000`, `width: 400`, `height: 300`); nothing persists.

### 4.3 Architectural / parity

- React renders text with HTML/CSS fonts; Rust export renders text with `resvg`/SVG. Fonts, line wrapping, and text shaping diverge.
- `exports/annotations.rs` builds and parses SVG for every annotation on every export frame.
- The `images` array in the render plan is produced but not consumed by the export.
- Z-order is fixed in Rust but uses CSS `z-index` in React.
- No shared animation/easing definition between preview and export.

## 5. Target Domain Model

### 5.1 Overlay clip model

All overlay clip kinds (`annotation`, `text`, `image`, and future `video`) share a common transform and animation base. The existing per-kind fields are preserved. Additions are optional with safe defaults so v1 project files keep loading.

```ts
// packages/contracts/src/timeline.ts
export const overlayTransformSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  width: z.number().min(0).default(100),
  height: z.number().min(0).default(100),
  rotation: z.number().default(0),            // degrees, 0 = no rotation
  anchorX: z.number().min(0).max(1).default(0.5), // transform origin
  anchorY: z.number().min(0).max(1).default(0.5),
  zIndex: z.number().int().default(0),        // global layer order
  opacity: z.number().min(0).max(1).default(1),
})

export const overlayAnimationSchema = z.object({
  inType: z.enum(["none", "fade", "scale-up", "scale-down", "slide-up", "slide-down", "draw", "typewriter"]).default("fade"),
  outType: z.enum(["none", "fade", "scale-up", "scale-down", "slide-up", "slide-down"]).default("fade"),
  inDurationMs: z.number().int().min(0).default(350),
  outDurationMs: z.number().int().min(0).default(350),
  easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out", "expo-out"]).default("expo-out"),
})
```

The existing `annotationClipSchema`, `textClipSchema`, and `imageClipSchema` are extended with these fields (either merged from `overlayTransformSchema` or added as individual optional fields to keep the current flat structure).

- `rotation` and `zIndex` are the two most important additions.
- `overlayAnimationSchema` replaces the ad-hoc `animationIn`/`animationOut` string fields and adds explicit duration/easing.
- Existing `animationIn`/`animationOut` values map to `inType`/`outType` during load.

### 5.2 Track and layer ordering

The canonical visual layer order is:

1. Canvas background / screen
2. Camera overlays
3. Zoom/mask effects (applied via the screen/camera graph)
4. Graphics/images (new `overlay` track or existing `graphics` track)
5. Annotations
6. Titles/text
7. Captions
8. Cursor
9. Selection UI (preview only, never exported)

Within each group, `zIndex` resolves tie-breaks. `zIndex` is a signed integer; higher values render on top. The default `zIndex` for a clip is computed from its track insertion order plus a group offset so that the default order matches the canonical stack.

### 5.3 Project asset v2 (additive)

The `projectAssetSchema` is extended with optional fields. No project file version bump is required if the loader tolerates them.

```ts
// packages/contracts/src/project.ts
export const projectAssetSchema = projectAssetSchema.extend({
  kind: mediaKindSchema.optional(),           // audio | image | video | cursor | caption
  role: projectAssetRoleSchema,                // semantic role, kept mandatory
  contentHash: z.string().optional(),          // SHA-256 of the source file
  importStrategy: z.enum(["copy", "reference"]).optional(),
  originalPath: z.string().optional(),         // for reference imports
  svgSafe: z.boolean().optional(),             // for SVG graphics
  derivativeVersion: z.number().int().min(0).default(1),
  derivatives: z.record(z.string(), z.string()).optional(), // kind -> project-relative path
})
```

On load, if `kind` is missing it is inferred from `role`. If `importStrategy` is missing it is treated as `copy` when the path is inside the project dir, otherwise `reference`.

### 5.4 Render plan additions

`packages/media-core/src/render-plan.ts` already produces `annotations`, `texts`, and `images`. The plan requires these additions:

- `rotation`, `zIndex`, `opacity`, and explicit `inDurationMs`/`outDurationMs`/`easing` in each overlay render plan item.
- A unified `overlayRenderPlan` produced by the existing `buildRenderPlan` but consumed as a single ordered list by both WASM preview and Rust export.
- `RenderPlanImage` gains `assetId` resolution and `fit` (contain/cover/fill).
- `RenderPlanText` gains shaped-glyph metadata or, for preview, a `text layout` object so the engine can shape consistently.

### 5.5 Preset definitions

Annotation shape presets and title presets are externalized from TypeScript arrays into JSON files.

```ts
// packages/editor-core/src/presets/preset-registry.ts
export interface PresetCatalog<T> {
  version: number
  categories: string[]
  presets: PresetDefinition<T>[]
}

export interface PresetDefinition<T> {
  id: string
  name: string
  description: string
  category: string
  tags: string[]
  preview?: string          // project-relative or asset URL to a rendered thumbnail
  definition: T             // the shape/text settings that create the clip
}
```

- `packages/editor-core/src/presets/annotation-presets.json`
- `packages/editor-core/src/presets/text-presets.json`
- User custom presets are stored in `~/.recordforge/presets/` (or the OS app-data dir) and merged at runtime.

## 6. Module Seams

### 6.1 `packages/overlay-engine` (Rust)

A new crate with the same `cdylib + rlib` crate-type pattern as `packages/cursor-engine`.

```rust
// packages/overlay-engine/src/lib.rs
pub struct OverlayEngine {
    scene: Scene,
}

impl OverlayEngine {
    pub fn from_render_plan(plan: OverlayRenderPlan) -> Result<Self, OverlayError>;
    pub fn evaluate(&self, time_ms: u64) -> DisplayList;
    pub fn render_to_pixmap(&self, time_ms: u64, pixmap: &mut Pixmap) -> Result<(), OverlayError>;
}

#[derive(Debug, Clone)]
pub enum DisplayItem {
    Path { id: String, transform: Transform, path: String, fill: FillRule, stroke: Stroke },
    Text { id: String, transform: Transform, glyphs: Vec<ShapedGlyph>, style: TextStyle },
    Image { id: String, transform: Transform, bitmap: BitmapHandle, fit: ImageFit },
    VideoFrame { id: String, transform: Transform, source_ms: f64, path: PathBuf },
}
```

- `Scene` is built once when the project/render plan changes.
- `evaluate()` is a pure function of `time_ms` and returns a `DisplayList`.
- `DisplayList` is sorted by `zIndex`.
- `render_to_pixmap()` is native-only and uses `tiny-skia`/`resvg`.

### 6.2 `packages/overlay-core` (TypeScript)

The TS wrapper, build script, and generated `wasm-pack` artifacts, analogous to `packages/cursor-core`.

```ts
// packages/overlay-core/src/wasm-engine.ts
export async function createOverlayWasmEngine(plan: OverlayRenderPlan): Promise<OverlayEngine> {
  await ensureInit()
  const planJson = JSON.stringify(plan)
  const wasm = new WasmOverlayEngine(planJson)
  return {
    evaluate: (timeMs: number) => JSON.parse(wasm.evaluate(timeMs)) as DisplayList,
    renderToCanvas: (timeMs: number, canvas: HTMLCanvasElement) => {
      wasm.renderToCanvas(timeMs, canvas)
    },
  }
}
```

WASM build command: `bun run --cwd packages/overlay-core build:wasm`.

### 6.3 `packages/editor-core/src/overlay-transaction.ts`

A pure transaction builder for overlay gestures. It is used by the React UI but lives in `editor-core` so it is testable without React.

```ts
export interface OverlayGestureDraft {
  kind: "move" | "resize" | "rotate" | "arrow-start" | "arrow-end" | "text-edit"
  clipId: string
  transform: OverlayTransform
  // kind-specific extras
}

export function createOverlayTransaction(
  buildCommand: (draft, base: TimelineState) => CommandResult<BuildCommandResult>,
): InteractionTransaction<OverlayGestureDraft>
```

### 6.4 `apps/desktop/src/features/editor/canvas/use-overlay-interaction.ts`

React hook that converts pointer events into `OverlayGestureDraft` updates and routes them through `InteractionTransaction`. It reuses the same draft/validate/commit/cancel pattern as `use-timeline-interaction.ts`.

### 6.5 `apps/desktop/src-tauri/src/commands/assets.rs` (new)

Tauri commands for external media:

- `import_assets(request: AssetImportRequest) -> AssetImportResult`
- `delete_asset(request: AssetDeleteRequest)`
- `relink_asset(request: AssetRelinkRequest) -> ProjectAsset`
- `probe_asset(request: AssetProbeRequest) -> MediaMetadata`
- `start_derivative_job(request: DerivativeJobRequest) -> MediaJob`

### 6.6 `apps/desktop/src/features/editor/panels/project-assets-panel.tsx`

Replacement for `external-media-panel.tsx`. It displays the project asset bin, supports filtering by `kind` and `role`, shows derivative status, and allows drag-to-timeline.

### 6.7 `apps/desktop/src/features/editor/panels/preset-browser.tsx`

Reusable preset browser for both annotations and titles. Supports category tabs, search, favorites, and a "save as preset" action in the inspector.

## 7. Interaction Architecture

### 7.1 Transactional gestures

Every overlay gesture follows `InteractionTransaction` semantics (`packages/editor-core/src/interaction-transaction.ts`):

1. **Begin** — capture the base state and the initial draft.
2. **Update** — apply the draft to a throwaway copy of the state, validate, and produce a preview. The UI renders the preview via `setDraftTimeline()`.
3. **Commit** — build the final command, validate it against the latest base state, and call `execute()` once.
4. **Cancel / pointer-capture loss / Escape** — discard the draft and restore the base state.

This directly fixes P0-8 "pointer gestures commit on every pointer move".

### 7.2 Gesture state machine

A single pointer handler on the canvas computes the following state:

```ts
interface OverlayPointerState {
  clipId: string
  handle: "body" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rotate" | "arrow-start" | "arrow-end"
  startClient: { x: number; y: number }
  startTransform: OverlayTransform
  startArrow?: { endX: number; endY: number }
  mode: "idle" | "drag-threshold" | "active"
}
```

- All coordinates are converted once at the start of the gesture to canvas pixels and stored in the draft.
- Pointer move is throttled to `requestAnimationFrame` (or 16 ms) during update; no `setState` per mouse event.
- The drag threshold is **2 px** in canvas space before the gesture becomes `active`.

### 7.3 Constraints and snapping

- **Canvas bounds** — clips cannot be dragged or resized so that more than 25% of their bounding box leaves the canvas. The bounding box includes rotation.
- **Shift** — constrains resize to the original aspect ratio and drag to horizontal/vertical.
- **Alt/Option** — resizes from the center.
- **Ctrl/Cmd** — disables snapping.
- **Rotation snap** — hold Shift to snap to 15° increments.
- **Arrow endpoints** — snap to the nearest 8 px grid when within 12 px; the body of the arrow/line does not move unless the whole clip is dragged.

### 7.4 Resize, rotate, and arrow handles

Selected overlay clips render a React-only selection layer with:

- 8 resize handles (corners and edges).
- 1 rotation handle above the top edge (for all clips except arrows/lines, which rotate via endpoint drag).
- Arrow/line clips show distinct circular start/end handles with different colors.
- Handles are 8 px touch targets (12 px on touch devices if supported).
- Resize keeps minimum dimensions (annotation 20×20, text 80×40, image 40×40).

### 7.5 Keyboard and accessibility

- `Tab` moves focus between visible overlay clips.
- `Arrow keys` nudge the selected clip 1 px (Shift = 10 px).
- `Ctrl/Cmd + Arrow` resizes 1 px.
- `R` starts rotate mode; `Esc` cancels any active gesture.
- `Delete` removes the selected overlay clip.
- All handles have `aria-label` and visible focus rings.
- The preset browser supports type-ahead search and keyboard selection.

## 8. Rendering and Export Parity

### 8.1 Retained scene and display list

The `OverlayEngine` builds a `Scene` once from the render plan:

```rust
struct Scene {
    canvas: CanvasConfig,
    annotations: Vec<RetainedAnnotation>,
    texts: Vec<RetainedText>,
    images: Vec<RetainedImage>,
    videos: Vec<RetainedVideo>,
    fonts: FontCache,
    images_cache: ImageCache,
}
```

At a given `time_ms` the evaluator produces a `DisplayList`:

```rust
struct DisplayList {
    items: Vec<DisplayItem>,
    background_items: Vec<DisplayItem>, // e.g. spotlight dim overlay
}
```

The display list is the single contract between the engine and the two render adapters (WASM canvas and native pixmap).

### 8.2 WASM preview adapter

- The WASM engine is initialized with the current render plan.
- A dedicated offscreen or on-screen `<canvas>` is drawn via the WASM `renderToCanvas(timeMs, canvas)` method.
- The React preview compositor still computes `screen`, `cameras`, `masks`, `zoom`, and `cursor` layers; the overlay canvas is composited on top.
- Playhead updates reach the overlay canvas through a transient `usePlayhead` hook backed by `useSyncExternalStore` or `Zustand` `subscribe`, not via React props. This eliminates per-frame React re-renders.

### 8.3 Native export adapter

- The export pipeline calls `OverlayEngine::render_to_pixmap(time_ms, pixmap)` for every frame where overlays are active.
- The rendered pixmap is streamed into FFmpeg as a `rawvideo` input and composited with `overlay=shortest=1:format=auto`, matching the cursor layer pattern in `exports/mod.rs:1014-1028`.
- No SVG is constructed per frame. SVG is used only to resolve static assets (e.g. resvg for image decoding or font fallback).

### 8.4 Font bundle and text shaping

A small font bundle is vendored with the app:

| Family | File | Role |
|---|---|---|
| Inter Variable | `Inter-VariableFont_slnt,wght.ttf` | sans, default |
| Source Serif 4 | `SourceSerif4-Regular.ttf` | serif |
| JetBrains Mono | `JetBrainsMono-Regular.ttf` | mono |
| Outfit | `Outfit-VariableFont_wght.ttf` | heading |

- **Preview**: the WASM engine uses the browser's Canvas 2D API with these fonts loaded via CSS `@font-face`. The engine shapes text using browser APIs and caches glyph runs per clip.
- **Export**: the native engine uses `rustybuzz` (HarfBuzz Rust port) with the same font files for shaping and `tiny-skia` for rasterization. Glyph runs are cached in `RetainedText`.
- A golden fixture test compares preview and export text frames pixel-by-pixel.

### 8.5 Image and video assets

- Images are decoded to RGBA on scene build. Large images are downsampled to preview resolution and cached with an LRU cap (100 MB).
- For export, images are decoded to the output resolution once and reused.
- Video b-roll overlays are decoded by FFmpeg and presented to the engine as decoded frames via the existing media job infrastructure. The engine only holds a frame handle, not pixel buffers in React.

### 8.6 Animation and easing

A single easing table is shared by both WASM and native. Both use the same `overlayAnimationSchema` and evaluate `t` by elapsed time in milliseconds, not frame number:

```rust
fn overlay_opacity(anim: &OverlayAnimation, time_ms: u64, start_ms: u64, end_ms: u64) -> f64 {
    // in
    if time_ms < start_ms + anim.in_duration_ms { ... }
    // hold
    else if time_ms < end_ms - anim.out_duration_ms { 1.0 }
    // out
    else { ... }
}
```

## 9. Preset System

### 9.1 Catalog structure

- Built-in presets ship as JSON files in `packages/editor-core/src/presets/`.
- User custom presets are saved to the OS app-data directory and loaded at startup.
- A `PresetRegistry` class merges built-in + custom + project-local presets and provides search/filter.

### 9.2 Categories and search

- Text presets: `title`, `lower-third`, `callout`, `badge`, `minimal` (existing categories).
- Annotation presets: `highlight`, `pointer`, `frame`, `callout`, `spotlight`, `badge`.
- Search matches `name`, `description`, `tags`, and `category`.
- The UI uses virtualized grids for long lists.

### 9.3 User custom presets

- "Save as Preset" in the inspector captures the current clip's settings (minus `x`/`y`/`startMs`/`durationMs`) and writes a new preset entry.
- User presets are editable (rename, delete) and can be favorited.
- Favorites are stored in app settings, not the project file.

### 9.4 Inspector integration

- The title inspector shows the active preset name and a "Browse Presets" button.
- Clicking a preset while a clip is selected applies the preset to the clip (current behavior in `titles-panel.tsx:66-72`).
- The preset browser is a modal with a live preview thumbnail rendered by the overlay engine.

## 10. External Media Subsystem

### 10.1 Import flow

1. User clicks "Import" in the project-assets panel.
2. React calls `open()` from `@tauri-apps/plugin-dialog` and receives absolute file paths.
3. React calls the `import_assets` Tauri command with the selected paths and a `strategy` (`copy` or `reference`).
4. Rust validates paths, hashes the files, probes with FFprobe, determines `kind`, creates `ProjectAsset` entries, copies if requested, starts derivative jobs, and saves the project atomically.
5. React receives `AssetImportResult` and updates the asset bin; derivative progress arrives via Tauri events.

### 10.2 Copy vs reference

- **Copy (default)** — the file is copied into the project directory. The project is self-contained and safe to move.
- **Reference (opt-in)** — the file stays at the original path. Rust validates that the path is within an allowed directory (user media, project parent, or a configured media library path) using `PathPolicy`.

### 10.3 Deduplication and safety

- Assets are deduplicated by SHA-256 within the project.
- SVG files are validated for scripts, external references, and event handlers; unsafe SVGs are rejected or sanitized.
- Import returns `skipped` (duplicate, unsupported, too large SVG) and `warnings`.

### 10.4 Derivatives

| Kind | Derivative | Recipe |
|---|---|---|
| audio | waveform + audio preview | FFmpeg `showwavespic` / copy to proxy |
| image | thumbnail | `image` crate downsample |
| video | proxy + thumbnails | 540p proxy, 5-sec thumbnail interval |

Derivative jobs are tracked in the existing `media_job` table and surfaced in the asset bin with progress bars.

### 10.5 Relink and delete

- Missing assets show a "Relink" button. A Tauri dialog returns a new path; Rust re-probes, updates metadata, invalidates derivatives, and restarts derivative jobs.
- Delete removes the asset from the project. If the asset is referenced by any clip, deletion is blocked. If the asset was a `copy` and `deleteSource: true`, the source file is removed.

### 10.6 Timeline integration

- Drag an audio asset to an audio track to create an `AudioClip`.
- Drag an image to the `graphics` track to create an `ImageClip`.
- (Future) drag a video to the `overlay` track to create a `VideoClip`.
- Right-click an asset offers "Add at playhead".

## 11. UI/UX Layout and Customization

### 11.1 Workspace hierarchy

The editor workspace follows the target shell defined in `editor-ui-cursor-imrovement-plan.md`:

- **Top bar** — project name, save status, undo/redo, export.
- **Preview stage** — the video preview + overlay canvas + selection layer.
- **Left task rail** — tabs for `Media`, `Annotations`, `Titles`, `Assets`.
- **Right inspector** — contextual properties for the selected clip.
- **Bottom timeline** — tracks, playhead, zoom, playback controls.

### 11.2 Panel layout

- Task rail is 56 px wide with icon buttons and tooltips.
- Active panel is a 280-320 px drawer on the left.
- Inspector is 280-320 px on the right.
- The preview stage remains fixed in the center and is the only surface with direct manipulation.

### 11.3 Preset browser and asset bin

- Both use a **grid + list toggle**.
- Cards show a rendered preview for presets and a thumbnail/derivative for assets.
- Virtualization via `@tanstack/react-virtual` or an in-house virtual list for lists over 50 items.
- Search is pinned at the top; category tabs are the second row.

### 11.4 Inspector

- The inspector is split into **Context** (clip type, preset, category) and **Properties**.
- Properties are grouped: `Transform`, `Style`, `Animation`, `Text`, `Asset`.
- Sliders for numeric values are debounced to 150 ms and committed once on pointer up.
- Color pickers use the existing token palette; raw hex input is allowed but validated.

### 11.5 Modern dark cinema theme

- The existing dark theme in `packages/ui/src/styles/theme.css` is the base.
- Overlay UI uses elevated surface colors with 1 px borders and `shadow-e2`.
- Selected overlay clips use a 2 px `ring-warning` ring; locked clips use `ring-muted`.
- Glassmorphism is used only for the preview status badge and modal headers to keep contrast accessible.

### 11.6 Customization model

- Users can set a default preset per category.
- Users can save custom color palettes and text presets.
- Users can choose import strategy per file or globally in settings.
- The UI remembers rail/panel widths in local storage.

### 11.7 Accessibility and performance budgets

| Budget | Target | Measurement |
|---|---|---|
| Preview frame time | <= 16 ms at 60 fps | Chrome DevTools / `performance.now()` |
| Overlay command latency | <= 16 ms from pointer up to history commit | InteractionTransaction timing |
| Preset/ asset list scroll | 60 fps | No layout thrashing, virtualized |
| Project load with overlays | <= 200 ms for 50 overlay clips | Render + WASM init |
| Image cache | <= 100 MB per project | WASM image cache size |
| Text contrast | WCAG AA 4.5:1 | Theme token validation |
| Keyboard | All primary actions reachable | Manual QA checklist |

## 12. Implementation Phases

### Phase 0 — Architecture freeze and fixtures (1 week)

- Finalize `overlay-engine` crate shape and `overlay-core` TS package.
- Add build scripts to `package.json` and `turbo.json`.
- Create test fixtures for a project with annotations, titles, and external images.
- Decide font bundle file set and license.

### Phase 1 — Domain model and migration (1 week)

- Extend `annotationClipSchema`, `textClipSchema`, `imageClipSchema` with `rotation`, `zIndex`, `overlayAnimationSchema`.
- Extend `projectAssetSchema` with `kind`, `contentHash`, `importStrategy`, `derivatives`, `svgSafe`.
- Update `command-records.ts` and `commands.ts` apply/update functions.
- Update `buildRenderPlan` in `packages/media-core/src/render-plan.ts` to emit a unified overlay plan.
- Add loader fallback so v1 project files still open.

### Phase 2 — Overlay engine core (2 weeks)

- Implement `packages/overlay-engine` data model, scene builder, evaluator, and animation/easing table.
- Add `wasm-pack` build and `packages/overlay-core` wrapper.
- Add Rust unit tests for evaluation, z-order, and animation timing.

### Phase 3 — Interaction transaction for overlays (2 weeks)

- Implement `overlay-transaction.ts` and `use-overlay-interaction.ts`.
- Replace direct `execute(createUpdate*ClipCommand)` calls in `timeline-view.tsx` with transactional updates.
- Add 8-way resize, rotation, arrow-end, and constrained drag handles.
- Add keyboard nudge/rotate/delete.

### Phase 4 — Preview integration (2 weeks)

- Replace `AnnotationCanvasOverlay`, `TextCanvasOverlay`, and `ImageCanvasOverlay` with a single `OverlayCanvas` component backed by WASM.
- Add `OverlaySelectionLayer` React component for handles, drawn on top of the canvas.
- Refactor playhead propagation to `useSyncExternalStore`/Zustand `subscribe`.
- Virtualize preset and asset lists; debounce inspector sliders.

### Phase 5 — External media import and asset bin (2 weeks)

- Implement `import_assets`, `delete_asset`, `relink_asset`, `probe_asset` commands in Rust.
- Add SVG validation and `PathPolicy` integration.
- Add derivative recipes and job integration.
- Replace `external-media-panel.tsx` with `project-assets-panel.tsx`.
- Add drag-to-timeline and "add at playhead".

### Phase 6 — Preset system (1.5 weeks)

- Externalize `annotation-presets.ts` and `text-presets.ts` to JSON.
- Implement `PresetRegistry` with categories, search, favorites, and user custom presets.
- Add `PresetBrowser` component and "Save as Preset" in inspectors.
- Add preset thumbnail rendering via the overlay engine.

### Phase 7 — Export integration (2 weeks)

- Update `exports/annotations.rs` to use `overlay-engine` display lists.
- Implement image/video overlay rendering in the export graph.
- Implement font bundle loading and text shaping in `overlay-engine`.
- Add golden fixture parity tests for annotations, text, and image overlays.

### Phase 8 — Performance, accessibility, and hardening (1.5 weeks)

- Performance budget testing on a low-end Windows device.
- Accessibility audit (focus, ARIA, contrast, reduced motion).
- E2E test for import → overlay → export.
- Documentation, ADR for overlay engine and asset importer.

**Total estimated duration: 14–15 weeks.** This can be parallelized: Phase 5 can start after Phase 1, and Phase 6 after Phase 2.

## 13. Migrations

### 13.1 Clip schema migration

New fields (`rotation`, `zIndex`, `overlayAnimationSchema` fields) are optional with defaults. Existing project files load without modification.

### 13.2 Project asset migration

New asset fields are optional. The loader infers `kind` from `role` and treats missing `importStrategy` as `copy` when the path is inside the project directory. No v2 project file is introduced unless `deny_unknown_fields` in the Rust loader cannot be relaxed.

### 13.3 Preset migration

The built-in `ANNOTATION_SHAPES` and `TEXT_PRESETS` TypeScript arrays are converted to JSON files and read by `PresetRegistry`. Existing clip `presetId` values are preserved; the registry loads the same IDs from JSON.

### 13.4 Track migration

Existing image clips on `graphics` tracks and annotation clips on `annotations` tracks remain valid. Newly imported images continue to use `graphics`. Newly imported videos use `overlay` when introduced.

## 14. Tests

### 14.1 Unit tests

- `packages/overlay-engine/src/evaluator.rs`: time filtering, z-order, animation easing, transform math.
- `packages/editor-core/src/overlay-transaction.test.ts`: gesture command building, validation, cancellation.
- `packages/editor-core/src/presets/preset-registry.test.ts`: search, category filter, custom preset save/load.

### 14.2 Integration tests

- `packages/media-core/src/render-plan.test.ts`: overlay items are present and correctly windowed.
- `apps/desktop/src-tauri/src/commands/assets_tests.rs`: deduplication, SVG safety, delete-while-in-use, relink.

### 14.3 Preview/export parity tests

- Golden fixture: a known project with all overlay types. Compare a React/WASM preview canvas frame with a native export frame.
- Text shaping parity: same text clip in preview and export must produce the same glyph positions within 1 px.

### 14.4 Performance tests

- 60 fps playback test with 25 active overlays on a 1920×1080 canvas.
- Interaction latency test: 100 drag gestures, assert <= 1 history command per gesture.

### 14.5 End-to-end tests

- Import an image and audio asset → add to timeline → adjust overlay → export → verify the output contains the overlay and audio.

## 15. Acceptance Criteria

### 15.1 Annotations

- [ ] All 8 annotation shapes can be drawn or inserted at the playhead.
- [ ] Each shape can be moved, resized (8 handles), rotated, and deleted.
- [ ] Arrows/lines have draggable start and end points.
- [ ] Stroke width, style (solid/dashed/dotted), color, fill, corner radius, shadow, and text are editable.
- [ ] During playback the overlay canvas stays at 60 fps with 20+ active annotations.
- [ ] Exported video matches the preview within 1 px for all annotation shapes.

### 15.2 Titles and presets

- [ ] Presets are browsable by category, searchable, and can be applied to a selected clip.
- [ ] User can create a custom preset from the inspector.
- [ ] Text clips support primary/secondary/tag text, alignment, font family, weight, size, color, backdrop style, padding, blur, radius, shadow, and animation.
- [ ] Text preview and export use the same font metrics and wrapping.

### 15.3 External media

- [x] Audio and image files can be imported via the Tauri dialog and persisted in the project.
- [x] Imported audio appears in the timeline and mixes with existing audio.
- [x] Imported images appear as overlay clips and render in preview and export.
- [x] Missing assets can be relinked; in-use assets cannot be deleted.
- [x] Derivatives (waveform, thumbnail) are generated in the background.

### 15.4 Performance and stability

- [ ] No command is committed until the user completes a drag/resize gesture.
- [ ] Cancel, pointer-capture loss, or Escape restores the pre-gesture state.
- [ ] Preview playback does not cause React re-renders of the overlay canvas.
- [ ] Export completes without per-frame SVG parsing.

## 16. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| WASM bundle size grows with fonts and image decoder | Load time / memory | Ship fonts as external app resources loaded on demand; use `image` crate only in native; WASM uses browser image decoding. |
| Font metrics differ between browser and `rustybuzz` | Preview/export text misalignment | Vendored font bundle + golden fixture tests; fallback to embedded Inter if a font fails to load. |
| Project asset schema additions break Rust loader | Data loss on load | Keep fields optional; remove `deny_unknown_fields` for the asset array or bump project version with a migration. |
| Pointer transaction feels laggy on low-end Windows | UX | Throttle to 16 ms; skip validation during move; validate only on commit; show draft preview. |
| External video overlay is too complex for v1 | Scope creep | Implement image/audio first; design `overlay-engine` with `VideoFrame` display item but gate video clip support behind a feature flag. |
| Tauri fs/dialog capabilities missing | Import fails | Add narrowly scoped `dialog:allow-open` (already present) and `fs:allow-read` scoped to project dir via capability review. |

## 17. File and Module Impact Map

### New files

- `packages/overlay-engine/Cargo.toml`
- `packages/overlay-engine/src/lib.rs`
- `packages/overlay-engine/src/scene.rs`
- `packages/overlay-engine/src/evaluator.rs`
- `packages/overlay-engine/src/animation.rs`
- `packages/overlay-engine/src/fonts.rs`
- `packages/overlay-engine/src/images.rs`
- `packages/overlay-engine/src/preview_adapter.rs` (WASM)
- `packages/overlay-engine/src/export_adapter.rs` (native)
- `packages/overlay-core/package.json`
- `packages/overlay-core/src/wasm-engine.ts`
- `packages/overlay-core/scripts/build-wasm.ts`
- `packages/editor-core/src/overlay-transaction.ts`
- `packages/editor-core/src/presets/preset-registry.ts`
- `packages/editor-core/src/presets/annotation-presets.json`
- `packages/editor-core/src/presets/text-presets.json`
- `packages/contracts/src/overlay.ts` (new shared overlay DTOs if needed)
- `apps/desktop/src-tauri/src/commands/assets.rs`
- `apps/desktop/src-tauri/src/media/svg.rs`
- `apps/desktop/src-tauri/src/media/derivatives.rs`
- `apps/desktop/src/features/editor/canvas/overlay-canvas.tsx`
- `apps/desktop/src/features/editor/canvas/overlay-selection-layer.tsx`
- `apps/desktop/src/features/editor/canvas/use-overlay-interaction.ts`
- `apps/desktop/src/features/editor/panels/project-assets-panel.tsx`
- `apps/desktop/src/features/editor/panels/preset-browser.tsx`
- `apps/desktop/src/features/editor/inspector/overlay-clip-inspector.tsx`
- `apps/desktop/src/features/editor/hooks/use-playhead-subscription.ts`

### Modified files

- `packages/contracts/src/timeline.ts`
- `packages/contracts/src/project.ts`
- `packages/contracts/src/media.ts`
- `packages/editor-core/src/annotation-presets.ts` (convert to loader)
- `packages/editor-core/src/text-presets.ts` (convert to loader)
- `packages/editor-core/src/commands.ts` (apply + factory functions)
- `packages/editor-core/src/command-records.ts`
- `packages/editor-core/src/preview-composition.ts`
- `packages/media-core/src/render-plan.ts`
- `apps/desktop/src/features/editor/canvas/annotation-canvas-overlay.tsx`
- `apps/desktop/src/features/editor/canvas/text-canvas-overlay.tsx`
- `apps/desktop/src/features/editor/canvas/image-canvas-overlay.tsx`
- `apps/desktop/src/features/editor/panels/annotations-panel.tsx`
- `apps/desktop/src/features/editor/panels/titles-panel.tsx`
- `apps/desktop/src/features/editor/panels/external-media-panel.tsx` (deleted after replacement)
- `apps/desktop/src/features/editor/timeline/timeline-view.tsx`
- `apps/desktop/src/features/editor/timeline/use-timeline-interaction.ts` (optional extension)
- `apps/desktop/src-tauri/src/exports/annotations.rs`
- `apps/desktop/src-tauri/src/exports/mod.rs`
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src-tauri/capabilities/default.json`
- `apps/desktop/package.json`
- `packages/editor-core/src/annotations-and-media.test.ts` (expand)
- `packages/media-core/src/render-plan.test.ts` (expand)

## 18. Rollout and Rollback

- Feature flag `enableOverlayEngine` gates the new preview canvas during Phase 4; the legacy overlays remain as fallback until Phase 7.
- Feature flag `enableExternalMediaImport` gates the new asset importer and project-assets panel.
- Each phase lands behind the main branch; integration tests run in CI.
- Rollback: disable the feature flags; the legacy overlay code remains in place until the final phase.
- If the project file format is bumped, maintain a v1 reader for at least one release.

## 19. Definition of Done

- All acceptance criteria in Section 15 pass.
- `bun run typecheck` and `cargo clippy` are clean.
- `bun run test` and `cargo test` pass.
- New code follows existing naming conventions, no raw hex literals outside theme tokens, no emoji icons.
- ADR documents the overlay engine and asset importer are added to `docs/adr/`.
- Performance budgets in Section 11.7 are measured and met.

## 20. Open Decisions / Approval Required

Before implementation begins, the following decisions need owner approval:

1. **Font bundle composition** — confirm the four vendored fonts and their licenses (Inter, Source Serif 4, JetBrains Mono, Outfit) or propose alternatives.

   ***Answer***: - Yes, we can use these fonts.

2. **Default import strategy** — default `copy` for all external media, or allow `reference` by default for files outside the project dir?

   ***Answer***: - Implement what works best.

3. **Video overlay scope** — include video b-roll overlays in the first release, or keep them as a Phase 8+ feature behind a flag?

   ***Answer***: - Don't consider video overlay, eserve it for the future.

4. **Project asset schema version** — keep additive optional fields in v1, or bump to project v2 with a formal migration?

   ***Answer***: - Implement what works best.

5. **Overlay track naming** — keep `graphics` for images and add `overlay` for video, or merge images and video into a single `overlay` track?

   ***Answer***: - Video is out of scope now, but I want one track for all overlays.
