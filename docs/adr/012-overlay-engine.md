# ADR 012: Canonical Overlay Evaluation Engine (Rust + WASM)

> **Status:** Accepted — Implemented in Phase 8  
> **Date:** 2026-08-17  
> **Scope:** Architecture of the canonical overlay evaluation engine shared across React preview and native video export  
> **Related:** `editor-advanced-features-plan.md`, `packages/overlay-engine/`, `packages/overlay-core/`, `apps/desktop/src-tauri/src/exports/mod.rs`

## Context

recordForge supports a rich set of visual overlays:
- **Vector annotations**: Rectangles, rounded-rectangles, circles, arrows, lines, callouts, spotlights, and badges.
- **Titles and typography**: Categorized title styles and lower-thirds with custom typography, backdrops, and animations.
- **External media**: Imported raster/vector graphics and images.

Prior to this architecture, overlays suffered from significant parity and performance bottlenecks:
1. **Divergent preview and export**: Preview was rendered via dynamic React DOM and SVG components, while export generated ad-hoc SVG strings per frame parsed by `resvg`. Font metrics, line breaks, easing curves, and coordinate spaces drifted.
2. **Performance thrashing**: React re-rendered entire SVG DOM trees on every playhead tick (at 60 fps), producing main-thread latency and high garbage collection pressure.
3. **Export overhead**: Parsing XML SVG strings on every exported video frame incurred substantial CPU penalties during FFmpeg encoding.

## Decision

Implement a **single canonical overlay evaluation crate** in Rust (`packages/overlay-engine`) with dual compilation targets:
1. **WebAssembly (`wasm32-unknown-unknown`)**: Used in the React frontend via `@recordforge/overlay-core`. The engine evaluates time-windowed display lists and paints directly to an HTML5 Canvas, bypassing React component reconciliation during playback.
2. **Native (`x86_64-pc-windows-msvc`)**: Linked directly by the Tauri backend (`apps/desktop/src-tauri`). The engine renders frames into a `tiny-skia` pixmap buffer that is piped as raw video frames to FFmpeg.

### Key Architectural Pillars

- **Unified Overlay Render Plan Contract**: A shared JSON specification (`OverlayRenderPlan`) containing all active annotation, text, and image items, their transforms (`OverlayTransform`), easing animations (`OverlayAnimation`), and visual styles.
- **Retained Scene Graph**: `OverlayEngine::from_render_plan` parses and validates the plan once upon project or clip changes, building an indexed scene with pre-sorted layer groups and font/image caches.
- **Pure Time-Based Evaluation**: `OverlayEngine::evaluate(time_ms)` is a pure, seek-safe function returning a sorted `DisplayList` based on absolute project timestamps.
- **Shared Animation & Easing Table**: Easing curves (`linear`, `ease-in`, `ease-out`, `ease-in-out`, `expo-out`) and transition progress (fade, scale, slide, draw, typewriter) are evaluated mathematically with identical millisecond resolution across preview and export.
- **Zero React DOM Overhead During Playback**: Playhead updates reach the overlay canvas via transient subscriptions (`usePlayheadMs`), keeping React rendering purely transactional (handling selection handles, bounding boxes, and drag gestures).

## Consequences

- **Guaranteed Parity**: Identical geometry, stroke styles, shadows, backdrop blurs, and animation states between desktop canvas preview and final MP4 export.
- **60 FPS Playback**: Frame evaluation takes < 0.3 ms per frame for 30+ simultaneous overlay items.
- **Elimination of Per-Frame XML Parsing**: Native export uses direct rasterization via `tiny-skia`, reducing export overhead.
- **Font & Asset Caching**: Image decoding and SVG rasterization are cached across seek ticks and frames.

## Verification & Parity Testing

- **Rust Unit & Parity Tests**: `packages/overlay-engine/tests/parity_tests.rs` validates pixel-level rendering of all 8 annotation shapes, styled title backdrops, and image graphics against golden project fixtures.
- **TypeScript Integration Tests**: `@recordforge/overlay-core` and `@recordforge/editor-core` verify WASM instantiation, canvas rendering callbacks, and performance budgets.
