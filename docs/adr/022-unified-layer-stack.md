# ADR 022: Unified Visual Layer Stack

## Status

Accepted — 2026-11-15. Extends ADR 018 (GPU compositor) and ADR 020 (GPU-first
effects and downgrade reporting).

## Context

Before M3 the render plan carried exactly one video overlay list — `overlays`,
which the exporters treated as "camera bubbles" — and drew it after the screen
but before the generated overlay plate. There was no way to express:

- a video b-roll clip on its own track (#13),
- a custom media track holding video, images and audio (#14),
- a camera that changes layout mid-timeline (#5),
- a timeline hole that still has layers above it (F2).

Adding one bespoke path per feature would have multiplied decoder/plate
machinery in both renderers. The reporting order (screen → camera → overlay
items → cursor → captions) was also hard-coded, so importing a video above the
camera was impossible.

## Decision

1. **One video-layer record.** `RenderPlanOverlay` becomes the shared video
   layer: camera bubbles and b-roll/media-track video are the same shape
   (`assetId`, source window, canvas rect, crop, fit, radius, opacity, border,
   shadow) plus an optional animated pose track (`keyframes`) and a `role`
   (`camera` / `video`). Both renderers already coalesced contiguous, visually
   identical overlays into one decode stream; that machinery now serves every
   video layer without a second code path.
2. **Layers decode at their maximum rect.** A camera layer that grows from a PiP
   bubble to fullscreen decodes at the largest rect its layout keyframes reach
   (capped at source size) and the compositor scales it down per frame. The
   quad's `dest_rect` is rewritten per frame instead of being baked at setup.
3. **The camera layout lane is an effect lane.** `TimelineState.cameraLayouts`
   mirrors `zoomSegments`: outside every segment the clip transform is the base
   layout, and a segment animates rect, radius and opacity between layouts. The
   editor resolves it once (`resolveCameraLayoutAt`) for the preview and
   samples it into `RenderPlanCameraLayout` keyframes for export, so the two
   cannot diverge. The timeline anchors the lane on a clip-less
   `kind: "camera-layouts"` track that is created on load, stripped on save
   (§2.2.2 of the project-format spec) and cannot be deleted, so the row
   virtualizes and locks like every other lane without adding an enum value old
   readers would reject.
4. **Draw order is explicit.** `RenderPlan.layerOrder` records the middle band
   (camera bubbles and video layers) in track order. The screen is pinned to the
   bottom and cursor/captions/keystrokes to the top; only the middle band
   reorders. Plans without media tracks produce the pre-M3 order exactly.
5. **Gaps render on the compositor (F2).** The decode pass splices a black
   source for every mid-timeline gap and the composite pass paints the canvas
   background for those frames (`detail.w = 0`). A trailing gap remains a
   freeze-frame tail (`tpad=clone`). B-roll and custom-track timelines no longer
   fall back to FFmpeg for having a hole.
6. **Compatibility renderer.** Video layers and camera layouts render on the
   FFmpeg graph at their static geometry; animated keyframes (fade/scale/slide
   and layout transitions) are reported as `video-layer-animation` and
   `camera-layouts` downgrades per ADR 020.

## Consequences

- One decode/composite path serves camera, b-roll and media-track video, so new
  video surfaces are a plan change, not a renderer change.
- A camera layout that reaches fullscreen decodes the camera at canvas size for
  the whole track; the cost is bounded by the source resolution and only paid
  when such a segment exists.
- Generated border/shadow plates keep their baked geometry and are skipped while
  a layer's pose is animating; the video quad itself is always correct.
- Project files stay backward compatible: `cameraLayouts`, the video clip kind
  and media tracks are optional additions to project v1.
