# RecordForge — Modern Creator Feature Program (14 features)

A phased, evidence-grounded plan to add motion blur, Glass Loupe, sharp zoom, camera AI and colour, animated camera layouts, filler-word cuts, 720p/24-30-60 fps, ProRes, clip speed UI, Titles v2, borders, Look presets, video b-roll and custom media tracks. Unused features cost nothing at export, and the compositor work keeps the current export speed.

## Decisions locked with you

| Topic | Decision |
|---|---|
| Renderer policy | **GPU-first + documented approximation.** Full quality on the wgpu compositor. The FFmpeg (compat) renderer renders a cheaper version, and the export reports every downgraded effect. ADR 018's "compat renders everything identically" rule is amended by a new ADR 020. |
| ML runtime | **`ort` with `load-dynamic`.** The ONNX Runtime dylib and models are downloaded on demand and pinned by SHA-256, mirroring `whisper.rs`. DirectML on Windows, CoreML on macOS, CPU fallback. Inference runs **only as an offline derivative job**, never during export. |
| Pro gating | Pro: Camera AI (cutout, face tracking, hide-during-silence), filler-word removal, custom saved Looks, Glass Loupe, ProRes, motion blur. Free: built-in Looks, 720p, 24/30/60 fps, borders, clip speed, b-roll, custom tracks. Enforced in Rust `licensing/entitlements.rs` and mirrored in `editor-core/pro-features.ts`. |
| Titles | **Auto-migrate v1 → v2 on load.** v1 templates map to the closest v2 template. Golden frames are refreshed after visual review. |

## Evidence: what the code does today

- **Soft zoom (#3), confirmed.** `exports/gpu/decode.rs::segment_filter` scales every source into the content rect (`scale=content_w:content_h…,pad=…`) *before* the compositor. `shaders/composite.wgsl` then samples the zoom crop out of that already-downscaled plane. The compat renderer does the same: `push_zoom_stage` crops the post-scale stream. A 1.5× zoom on a 1440p source in a 1080p canvas therefore magnifies about 1280 px of detail when about 1707 source pixels were available. The preview zooms with a CSS matrix on the native-resolution `<video>` (`zoomTransformToCss`), so **the preview is sharper than the export**.
- **No real 60 fps (#7).** `encoding.rs::append_export_video_args` maps `smooth-60fps`/`ultra-4k-60` to `-r 60` at the encoder. FFmpeg duplicates frames, so motion is not smoother. Output size always equals the canvas (tiers are 1080/1440/2160 only, in `composition.ts`).
- **ProRes (#8).** `exportSettingsSchema.codec` is `h264|hevc|gif|webp` and `container` is `mp4|gif|webp`. `gpu::plan_limitations` rejects any codec other than h264/hevc.
- **Speed (#9).** `timelineClipBaseSchema.speed` is honored by `render-plan.ts` (segments, atempo), `time-mapping.ts` and smart-cut. There is no command in `commands.ts` and no UI.
- **Camera.** There are 4 static presets (`domain/camera-presets.ts`) and a `transform.visible` toggle. The camera decode is an FFmpeg sidecar in *both* renderers (`gpu/decode.rs::plan_camera`, compat filter graph). That makes FFmpeg-side camera effects (LUT, matte, face crop) parity-free.
- **Borders (#11).** The camera has `borderWidth/Color/Opacity`, rasterized by `generate_camera_border_png`. The screen frame has radius and shadow but no border.
- **Titles (#10).** There are 14 templates (`creator-title-presets.ts`, `overlay-engine/src/titles.rs`). Motion is only `designed|subtle|none` with fixed per-role staggers (`TitleLayout::evaluate`). There is no per-word or per-char animation, gradient, stroke or blur, and placement is authored against 1920×1080.
- **Smart cut (#6).** Silence only (`smart-cut.ts`). Whisper runs with `-ojf -sns` and has no disfluency prompt (`whisper.rs::transcribe_args`).
- **B-roll / tracks (#13, #14).** Assets already model `kind: video` and role `b_roll` (ADR 013), but there is no `video` clip kind. `trackAcceptsClipKind` has no generic media track. `gpu::plan_limitations` rejects **mid-timeline gaps** (they force FFmpeg), and b-roll/custom-track timelines will create them often.
- **Presets.** `PresetRegistry` plus `createPresetStorage` (settings-backed) already power text and annotation presets and can be reused for Looks.

## Cross-cutting foundations (do these first; several features depend on them)

### F1. ADR 020: GPU-first effects and downgrade reporting
- `docs/adr/020-gpu-first-effects.md`, amending ADR 018.
- `run_render_plan` returns a `downgrades: Vec<EffectDowngrade { effect, reason }>` list. It is persisted on the job and surfaced in the export UI as a non-blocking notice ("Rendered without motion blur: GPU unavailable").
- One helper, `gpu::effect_support(plan)`, decides per effect, next to `plan_limitations`.

### F2. GPU support for mid-timeline gaps (keeps b-roll and custom-track plans fast)
- The decode pass emits a black frame plus a per-frame `has_screen` bit for gap frames. It knows the frame ranges from `plan.gaps`, so no extra decode is needed.
- The compositor paints only the background plate where `has_screen = 0`.
- Remove `"timeline gaps"` from `plan_limitations`.
- Gate: an identity gapless plan stays bit-identical, and gap plans pass the renderer parity profile.

### F3. Generic **video layers** in the compositor (generalizing "camera tracks")
- Rust-internal `VideoLayer { decode sidecar, per-frame dest rect, radius, opacity, crop, alpha plane? }`, evaluated per frame from keyframes. Camera, b-roll and custom-track video all use it.
- Each layer's decode size is the **max** rect it reaches (capped at source size), so fullscreen moments stay sharp and PiP is scaled down in the shader.
- Optional `yuva420p` alpha plane for the cutout matte.

### F4. Unified visual layer stack (ADR 022)
- Render plan gains `layerOrder: Array<{ kind: "video"|"items"|"camera"…, id }>`, derived from track order for visual tracks. Screen stays at the bottom; captions and keystrokes stay on top.
- Overlay-engine items are grouped into contiguous **bands**: one items plate per run between video layers, usually 1 or 2. Total raster work is unchanged.
- Both renderers and the preview honor the same order. Plans without media tracks produce today's order exactly.

### F5. Timeline time-warp utility (editor-core)
- `applyTimeWarp(state, startMs, endMs, newDurationMs, { ripple })` remaps every timeline-time entity: clips on all tracks, zoom segments, camera-layout segments, markers, cursor ranges, and caption `words` (scaled; `sourceWords` stay untouched so resync still works).
- Used by speed (#9) and reusable by future retiming.

### Schema policy
- Every new field is **optional** on project v1, following the existing pattern.
- Title v2 uses a load-time `z.preprocess` migration.
- Risk: older app versions strip unknown fields when they save. This goes in the release notes.

## Feature designs

### 7. Export 720p and 24/30/60 fps (M1)
- **Contract** (`contracts/timeline.ts` `exportSettingsSchema`): add `resolution: z.enum(["canvas","720p","1080p","1440p","2160p"]).default("canvas")` and `frameRate: z.enum(["project","24","30","60"]).default("project")`. Mirror both in Rust `ExportSettings`. Presets now *prefill* these fields; preset ids stay for compatibility.
- **Resolution:** the output short edge is `min(requested, canvas, licenseCap)`, keeping aspect and even dimensions. It reuses the existing lanczos output-cap stage (`gpu/encode.rs` `scale=…:flags=lanczos` and the compat equivalent). Options above the canvas are hidden.
- **Frame rate (real, not duplicated):** at admission Rust rewrites `plan.canvas.fps = target` before rendering. Every frame grid (decode `fps=`, zoom, cursor, plates) derives from `canvas.fps`. Remove the encoder `-r` hack.
  - Must verify: segment frame counts use **cumulative** rounding (`round(end·fps) − round(start·fps)`). Otherwise a smart-cut plan re-gridded to 24 fps drifts against audio.
- **UI:** `export-view.tsx` gets Resolution and Frame rate selects. Disk estimate and `isPresetSupported` are updated.
- **Speed upside:** a 720p export still composes at canvas size in v1. A follow-up spike renders the GPU target at output size and is measured before it ships.

### 8. ProRes export (M1, Pro)
- **Contract:** `container` gains `mov`, `codec` gains `prores`, plus `proresProfile: z.enum(["proxy","lt","standard","hq"]).default("hq")`.
- **Encoding (`encoding.rs`):** `prores_ks` (`-profile:v 0–3 -vendor apl0 -pix_fmt yuv422p10le`). On macOS, `prores_videotoolbox` is used when the pre-flight passes, falling back to `prores_ks`. Audio is `pcm_s16le`. Muxing uses `-f mov -movflags +faststart+write_colr`, and chapters go through the existing ffmetadata.
- **Keep it fast:**
  - Extend the GPU encode sidecar and `plan_limitations` to accept `mov/prores`, so ProRes stays on the compositor.
  - ProRes is intra-only, so chunked compat concat is exact. Enable chunk parallelism, since `prores_ks` is CPU-bound.
- **Output handling:** disk estimate uses a ProRes bitrate table (HQ is about 220 Mbps at 1080p30); `.mov` save filter; `validate_export_output` accepts `prores`; burned-in captions or an SRT sidecar.
- New Pro key `prores-export`.

### 9. Clip speed command + UI (M1, Free)
- **Command** `set-clip-speed { clipIds, speed (0.1–16), ripple = true }` in `command-records.ts`/`commands.ts`, built on F5.
  - Expands to `groupId` members and to recorded siblings with the same span (screen + camera + mic).
  - New duration is `(sourceOut − sourceIn)/speed`, frame-snapped with `snapRangeEdgeToFrame`.
  - Non-ripple mode rejects overlaps.
- **UI:** a timeline clip context-menu "Speed" submenu (0.25×–8× plus Custom…), a Speed field and slider in `clip-properties-inspector.tsx`, and an "N×" badge on `timeline-clip-item.tsx`.
- **Tests:** ripple, groups, zoom/caption remap, undo/redo, smart cut after speed, and a render-plan segment check.

### 11. Border customizations (M1, Free)
- **Canvas:** `borderWidth?`, `borderColor?`, `borderOpacity?`, `borderStyle?: "solid"|"gradient"|"double"|"glass"`, `borderGradient?` (CSS-gradient subset already parsed by `parse_css_gradient_to_svg`).
- **Camera** (`clipTransformSchema`): `borderStyle?` and `borderGradient?` next to the existing fields.
- **Rendering:**
  - Preview: SVG rounded-rect stroke overlay (gradient via `<linearGradient>`).
  - GPU: an analytic SDF ring in the existing composite and camera passes (no plate; works under animated layouts).
  - Compat: static tiny-skia plates (extend `generate_camera_border_png`; add a screen-frame plate). Zero per-frame cost.
- **UI:** `canvas-inspector.tsx` and `camera-clip-inspector.tsx`.

### 3. Zoom clarity / upscaling (M2, Free; the biggest perceived-quality gain)
- **Detail plane:**
  - Rust plan analysis computes, per zoom window, `m` (zoom scale) and `r = sourceWidth / contentWidth`. A detail plane is needed when `m > 1.02 && r > 1.02`.
  - Detail size is `D = content × min(m_max, r)`, even and ≤ source.
- **GPU path:**
  - A second decode sidecar emits frames **only for non-identity zoom frames**, as frame-indexed trims plus concat at size D.
  - The compositor samples the zoom crop from the detail plane, mapping integer crops from `zoompan_integer_crop` into D space.
  - **Identity frames keep the decoder→encoder bypass**, so plans without zoom are unchanged.
- **Sharpening past native:** when `m > r`, apply an RCAS pass (port of AMD FidelityFX FSR1 RCAS, MIT, license header kept) limited to the screen rect, with strength driven by the remaining upscale.
  - Setting `canvas.zoomSharpening?: "off"|"auto"|"strong"`, default `auto`.
  - Spike: EASU vs Catmull-Rom for the upscale itself, decided by a text-sharpness metric.
- **Compat approximation:** hold pieces crop from a source-resolution `split` branch before the content scale, followed by mild luma `unsharp`. Zoompan transitions stay post-scale. Reported as a downgrade.
- **Loupe (#2)** samples the same detail plane.
- **Bench:** new synth fixture with a 2560×1440 fine-text/checker source and a 1.5× hold.
  - Acceptance: SSIM vs a direct source crop + lanczos reference improves by a target set in the M2 spike.
  - Zoom-free specs: ±2% wall. Zoom-heavy specs: ≤ +10% wall on the GPU path.

### 1. Motion blur (M2, Pro)
- **Settings:** `canvas.motionBlur?: { enabled, cursor: 0–1, zoom: 0–1, pan: 0–1 }`. Each value is a shutter fraction, where 1.0 means a 180° shutter. These are the per-animation sliders, and Looks carry them too.
- **Camera zoom/pan (GPU):**
  - CPU computes the crop rect at `t ± shutter/2`, separating the scale and translation components so the zoom and pan sliders weight them independently.
  - The composite shader takes N bilinear taps along the interpolated crop, with N adaptive = `clamp(ceil(maxDisplacementPx/2), 1, 16)`.
  - Hold and identity frames have N = 1, so there is no cost when nothing moves.
- **Cursor (both renderers):**
  - The cursor engine (`packages/cursor-engine`, which compiles to WASM for the preview) gets `evaluate_motion_samples(t, shutter, n)`.
  - The Rust cursor rasterizer accumulates K sub-frame copies into the cursor tile, and the tile union widens to the swept path. Cursor blur therefore works in compat too.
  - Preview draws K ghost `<use>` copies with the same weights.
- **Preview zoom/pan:** velocity-scaled CSS `filter: blur()` during transitions only, disabled in "power" preview quality. Documented as an approximation.
- **Compat:** no zoom/pan blur (downgrade reported).
- **Budget:** ≤ +8% wall on zoom-heavy specs with blur on; 0% with it off.

### 2. Glass Loupe zoom (M2, Pro)
- **Contract** (`manualZoomSegmentSchema` and the render-plan zoom segment):
  - `style?: "frame"|"loupe"` (default `frame`).
  - `loupe?: { shape: "circle"|"rounded-rect", size, ringWidth, ringColor, ringOpacity, glass: boolean, shadowBlur, shadowOpacity, followCursor, center?, offset? }`. Magnification reuses `scale`.
- **Semantics:**
  - `resolveCameraShots` ignores loupe segments; a new `resolveLoupes` handles them. The frame stays at its current zoom.
  - The lens grows in with the segment's easing and transitions.
  - Follow mode reuses the follow-cursor motion plan. The cursor is drawn above the lens.
- **GPU:** one pass over the lens bounds. It samples the screen (from the detail plane when available) and applies an SDF mask with AA, a glass rim (inner highlight, slight rim refraction), and an SDF soft shadow.
- **Compat:**
  - `crop`+`scale` of the focus area, an `alphamerge` circle mask PNG, and a ring plate.
  - Position comes from `overlay=x/y` expressions, or from `sendcmd` in follow mode.
  - No refraction (downgrade).
- **Preview:** a `LoupeOverlay` `<canvas>` that `drawImage`s the active dual-slot video region each rAF, clipped to a circle, with a CSS ring and shadow. Frames stay in the webview, with no IPC.
- **UI:**
  - The zoom inspector gets a Frame/Loupe toggle and loupe controls.
  - `zoom-canvas-overlay.tsx` gets a lens drag/resize handle.
  - The zoom lane shows a loupe glyph on loupe segments.

### 5. Dynamic camera layouts lane (M3, Free)
- **Model:** `TimelineState.cameraLayouts?: CameraLayoutSegment[]`, a timeline-effect lane like `zoomSegments`:
  - `{ id, startMs, durationMs, layout: "pip"|"fullscreen"|"hidden"|"side-by-side", pip?: { corner: "tl"|"tr"|"bl"|"br"|"custom", sizeFraction, shape, x?, y? }, transitionInMs, easing, source: "manual"|"silence", locked }`.
  - Outside any segment, the clip transform (today's behavior) is the base layout.
- **Resolver:** `resolveCameraLayoutAt(state, t)` in editor-core returns `{ cameraRect, radius, opacity, screenRect, crop }`. Rects, radius and opacity are interpolated, so a circle morphs into a rectangle through the radius. The preview and `render-plan.ts` both use it.
- **Render plan:** `RenderPlanOverlay.layoutKeyframes[]` plus `screenLayoutKeyframes[]`, evaluated per frame in Rust (F3).
  - Compat extends the existing `scale=eval=frame` side-by-side machinery with piecewise expressions.
- **UI:**
  - `camera-layout-track.tsx` lane, modeled on `zoom-track.tsx`: add at playhead with a layout icon picker, drag/resize, transition handle.
  - `camera-layout-inspector.tsx`.
  - The hard visible toggle maps to "hidden" segments, and `transform.visible` is kept for old projects.
- **Commands:** add, update, split, resize, delete, regenerate (silence). Ripple delete and time warp must remap the lane.

### 4. Camera: LUT/colour, cutout, face tracking, hide-during-silence (M4, AI features Pro)
- **4a. Colour and LUT (Free):**
  - Camera clip field `color?: { exposure, contrast, saturation, temperature, tint, lutId?, lutIntensity }`.
  - LUTs are bundled procedural `.cube` looks (Warm, Cool, Film, Teal-Orange, Mono, Vivid, Matte) plus user-imported `.cube` files as project assets, parsed and validated in Rust (size ≤ 65, finite values).
  - **A single source of truth** composes adjustments ∘ LUT ∘ intensity into one 33³ LUT, in a new `overlay-engine/src/color.rs` that also ships in the existing WASM.
  - Export: a single `lut3d=interp=tetrahedral` in the camera decode chain, so both renderers match.
  - Preview: a WebGL2 camera renderer with a 3D LUT texture.
- **4b. Cutout (Pro):**
  - A new derivative job `camera_matte` (media job table, cancellable, progress events). FFmpeg decodes rgb24 at model resolution to stdout.
  - Model: **MediaPipe Selfie Segmenter (Apache-2.0)**, converted to ONNX and self-hosted with a SHA-256 pin. Optional HQ model: MODNet (Apache-2.0). RVM is avoided because its weight licence is unclear.
  - Processing: temporal EMA plus guided-filter upsample. Output is a grayscale H.264 matte at camera fps, plus a **stacked camera+matte preview proxy** so preview sync is free.
  - Clip field `cutout?: { enabled, background: "none"|"blur"|"color"|"image", blurRadius, color, imageAssetId, edgeSoftness, edgeShrink }`.
  - Export: the camera decode chain adds the matte input with identical trim/fps, then `alphamerge`, and the background mode is applied inside the same FFmpeg chain. Output is `yuva420p` into an F3 alpha plane. Silhouette shadow is GPU-only (downgrade in compat).
- **4c. Face tracking (Pro):**
  - The same job runs **YuNet (MIT)** at about 8 Hz and writes a compact face-track JSON derivative.
  - Clip field `faceTracking?: { enabled, framing: "tight"|"medium"|"wide", smoothness, headroom }`.
  - At plan time, One-Euro smoothing produces a fixed-size crop with a moving center, emitted as `cropKeyframes` at ≤ 10 Hz.
  - Export: `crop` x/y driven by `sendcmd` in the camera decode chain (both renderers).
  - Preview: the same pure resolver drives the CSS crop.
- **4d. Hide camera during silence (Pro):** command `generate-camera-silence-layouts { minSilenceMs = 2500, padMs, transitionMs }`. It reuses smart-cut analysis to insert or replace `source:"silence"` hidden segments in the #5 lane.
- **Runtime plumbing (ADR 021):**
  - `src-tauri/src/ml/` holds runtime download/verify (pattern of `whisper.rs::download_engine`), `ort::init_from(path)` with an EP fallback chain, and model specs.
  - No new Tauri capability is expected. This is confirmed in the ADR's security review.

### 13. Video b-roll (M3, Free)
- **New clip kind** `video` in the `timelineClipSchema` union:
  - `x, y, width, height, fit, crop?, opacity, borderRadius, border*, shadow*, animationIn/Out (fade|scale|slide), layoutMode: "overlay"|"fullscreen", volume, audioMuted, fadeInMs, fadeOutMs, enabled, locked`.
  - Embedded audio is rendered from the same asset's audio stream as a render-plan audio segment. "Detach audio" is a follow-up.
- **Import:** extend the existing importer and derivatives (proxy, filmstrip sprite, waveform) to mp4, mov, webm and mkv. Rotation metadata is honored. HDR sources get a warning plus best-effort SDR conversion.
- **Preview:** one dual-slot `<video>` pair per media track (reuse `use-dual-media-slots.ts`), positioned by a resolver shared with the render plan.
- **Export:** `RenderPlanVideoLayer[]` rendered through F3 video layers in F4 stack order. Decode sidecars only run inside their windows.

### 14. Custom timeline tracks (M3, Free)
- **Track kind** `media` accepting `video | image | audio` clips (`trackAcceptsClipKind`). `createAddTrackCommand` already takes a kind.
  - Mute hides visuals and silences audio. Solo, lock and volume reuse existing track controls.
  - `buildAudioTracks` includes audio from media tracks and embedded video audio.
- **Visual stacking** follows track order (F4).
- **UI:**
  - "Add track" menu (Media, Audio).
  - Inline rename and drag reorder (track-reorder logic exists).
  - Drag assets from `external-media-panel.tsx` and `project-assets-panel.tsx` onto tracks.
  - Filmstrip for video clips and waveform for audio.

### 10. Titles v2 redesign (M5; Clean Title stays Free)
- **Schema** `titleDesign` v2 (`contracts/title-design.ts` plus Rust `titles.rs`), with load-time v1→v2 migration:
  - **Typography:** family (bundled Inter, Outfit, Source Serif 4, JetBrains Mono, plus 2–3 OFL display faces; fonts are added to the overlay bundle and `AGENTS.md`), per-element size and weight, `letterSpacing`, `lineHeight`, `textTransform`, alignment.
  - **Fill:** solid or linear gradient. Plus stroke, shadow and glow.
  - **Emphasis styles:** colour, marker highlight, underline, strike, box.
  - **Backdrop:** none, box, pill, glass, bar, brackets, split.
  - **Accent:** bar, dot or number badge.
  - **Placement:** 9-point anchor plus safe margin relative to the canvas safe area, so titles adapt to 9:16 and 1:1.
- **Animation system:**
  - `animation: { in: Spec, out: Spec, emphasis?: LoopSpec }`, where `Spec = { preset, unit: "block"|"line"|"word"|"char", durationMs, staggerMs, easing (linear, cubic/expo/back/elastic/spring), direction }`.
  - In/out presets: fade, rise, drop, slide-L/R, scale-pop, zoom, blur-in, typewriter, mask-wipe, split-reveal (line mask from below), tracking-expand, flip, bounce, highlight-sweep, underline-draw, counter.
  - Emphasis loops: pulse, shimmer, float.
  - Everything is evaluated in `overlay-engine`, the same code for the WASM preview and native export, so parity holds by construction.
  - Blur-in rasterizes in the engine (tiny-skia) because the WKWebView canvas lacks `ctx.filter`. Day-1 spike: tiny-skia blur performance in WASM.
- **Curated catalog** (replaces the current 14; every old id maps to a new one):
  - Hook headline, Clean title, Editorial opener, Chapter card, and Lower thirds ×3 (bar, glass, line).
  - Social handle, Subscribe/Follow CTA (no brand logos), Link CTA, Numbered step, Checklist (2–5 items, staggered), Keyboard shortcut, Terminal command.
  - Callout (note/tip/warning), Quote/testimonial, Stat counter plus before→after, Countdown 3-2-1, Location/date stamp, Announcement banner.
  - Highlight-marker text, Kinetic word-by-word (short-form style), Agenda/progress list, End-screen/outro card, Source credit.
- **Migration map:** clean-text→clean, emphasis→hook-emphasis, editorial→editorial, kinetic-hook→hook, chapter→chapter, speaker-id→lower-third-bar, source-credit→source, step→step, shortcut→shortcut, command-line→terminal, note→callout, pull-quote→quote, metric→stat, call-to-action→cta.
- **UI:** `text-clip-inspector.tsx` gets Content | Style | Animation | Position tabs, animated preset thumbnails (`title-preview.tsx`), and per-element styling. The preset browser gets new categories (Openers, Lower thirds, Social, Tutorial, Data, Outro).

### 12. Whole-look presets (M5; built-ins Free, custom Pro)
- **`LookValues`** (zod, versioned):
  - `canvas` (background, blur, dim, fit, padding, radius, shadow*, border*, videoPositionY, motionBlur, optional aspectRatio behind an "include aspect ratio" toggle).
  - `camera` (layout/PiP corner, sizeFraction, shape, border*, shadow*, colour/LUT by bundled id, cutout background mode).
  - `cursor` (CursorSettings subset).
  - Scope flags.
- **Command** `apply-look { look, scope }` is **one undoable command**. It updates the canvas, every camera clip transform (resolved per camera source size via a generalized `buildCameraPresetTransform`) and the cursor settings.
- **Storage:** `PresetRegistry<LookValues>` plus `createPresetStorage("look")`. Custom image backgrounds are copied into an app-data looks folder and imported into the project with hash dedupe when applied.
- **Built-ins (10):** Clean Studio, Midnight Gradient, Soft Paper, Neon Dev, Glass Light, Bold Creator, Minimal Mono, Presenter Focus, Tutorial Classic, Vertical Social.
- **UI:** a Looks panel with a thumbnail grid (`preset-thumbnail.tsx`), hover-to-preview (transient, not committed), Apply, "Save current look…" (`save-preset-dialog.tsx`) and favorites.

### 6. Filler-word removal in Smart Cut (M2 parallel track, Pro)
- **Transcription:** a "verbatim" mode adds a per-language disfluency `--prompt` to `transcribe_args`. Token confidences are kept.
- **Analysis:** `detectFillerWords(words, lexicon, options)` in `editor-core/smart-cut-fillers.ts`:
  - Strict lexicon per language: en, fr, es, de (um/uh/erm/hmm; euh/ben/bah; eh/este; äh/ähm).
  - Opt-in phrase set: like, you know, I mean, basically; genre, en fait, du coup.
  - Opt-in repeated-word detection.
- **Mapping:** source-time words map to timeline ranges through the existing caption resync coverage mapping. Edges snap to waveform minima within ±60 ms, padding is applied, and ranges merge with adjacent silence. The result goes to the existing `createRippleDeleteRangesCommand` as one undo step.
- **UI:** the Smart Cut panel gets Silence | Filler words tabs. Candidates are listed with context and a checkbox, and clicking one seeks to it. Users can bulk-select by word and see timeline highlights (reuse `silence-preview-layer.tsx`).
- **Risk spike first:** measure Whisper recall on 3 real recordings. If recall < 70%, add an acoustic short-voiced-segment heuristic before shipping.

## Milestones and order

| Milestone | Scope | Why this order |
|---|---|---|
| **M1** | F1 (ADR 020 + downgrade reporting), #7, #8, #9 (+F5), #11 | Small and independent. Fixes the fake-60 fps bug. Low risk. |
| **M2** | #3 → #1 → #2 (shared detail plane and per-frame crop math); #6 in parallel | Biggest perceived-quality jump. All three touch the same composite path. |
| **M3** | F2 gaps, F3 video layers, F4 layer stack → #5, #13, #14 | Shared compositor generalization. Keeps b-roll and custom-track plans on the GPU. |
| **M4** | ADR 021 + `ml/` runtime → #4a–d | Needs F3's alpha plane and #5's lane (hide-during-silence). |
| **M5** | #10 Titles v2, #12 Looks | Looks capture fields from #4, #5 and #11. The titles redesign is self-contained but large. |

Each milestone ships as its own release, with release notes written before the `app-v*` tag.

## Files touched (main ones)
- **Contracts:** `packages/contracts/src/{timeline,title-design,project,overlay,assets,media,license}.ts`
- **Domain / editor-core:** `packages/domain/src/{timeline,camera-presets}.ts`; `packages/editor-core/src/{commands,command-records,time-mapping,camera-shots,composition,preview-composition,smart-cut,pro-features,creator-title-presets,text-presets}.ts`, plus new `camera-layouts.ts`, `smart-cut-fillers.ts`, `looks.ts`, `time-warp.ts`
- **Render plan:** `packages/media-core/src/render-plan.ts`
- **Overlay engine:** `packages/overlay-engine/src/{titles,title_layout,animation,export_adapter,fonts}.rs`, new `color.rs`; `packages/cursor-engine` (motion samples), then WASM rebuilds
- **Rust exports:** `apps/desktop/src-tauri/src/exports/{mod,encoding,camera,cursor}.rs`; `exports/gpu/{mod,decode,encode,compositor}.rs`; `shaders/{composite,layer}.wgsl`, new `rcas.wgsl`, `loupe.wgsl`
- **Rust platform:** `licensing/entitlements.rs`, `whisper.rs`, new `ml/`, `commands/assets.rs`, `media/` derivative jobs
- **UI:** `apps/desktop/src/features/editor/**` (inspectors, timeline lanes, canvas overlays, titles, presets, a new looks panel), `features/export/export-view.tsx`
- **Docs:** ADR 020, 021, 022; `docs/specs/{project-format,media-jobs-render-plan,editor-action-contract,editor-capability-matrix}.md`; `AGENTS.md` (new deps, fonts, commands)

## Performance guardrails (non-negotiable)
1. **Zero cost when unused.** Plan-level detection means no extra sidecar, pass, plate or tap for absent features. Identity and plate-free plans stay **bit-identical (100 dB)**.
2. **Before/after every milestone:** run the existing 14-spec synth matrix with `export_harness` (multiple specs per process, so the device cache counts). Wall time must be within ±2%, with exact frame counts and audio.
3. **New per-feature specs** are added to `export-synth-spec.ts`: zoom-clarity, motion-blur, loupe, camera-layout, cutout, b-roll/gaps. Each has a budget (stated above) and a renderer parity profile (mean ≥ 40 dB, min ≥ 28 dB) wherever the compat path is an exact implementation.
4. **Speed wins in scope:**
   - Real 60 fps (correctness).
   - ProRes chunk parallelism and ProRes on the GPU encode path.
   - GPU gap support (b-roll plans no longer fall back to FFmpeg).
   - ML is precomputed, so export never runs inference.
   - Spike: render 720p outputs at output size on the GPU.

## Verification (per milestone)
- `bun run typecheck`, `bun run test`, `bun run --cwd apps/desktop lint`, `bun run check:versions`
- In `apps/desktop/src-tauri`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test -j 1`
- `packages/overlay-engine`: `cargo test --features native-render`. Rebuild WASM (`bun run build:wasm:overlay`, `bun run --cwd packages/cursor-core build:wasm`) and run the parity tests.
- Export parity: `export-synth-spec.ts --single-pass` vs `--renderer gpu`, then `parity.ts --profile renderer`
- Golden frames: verify, and use `--update` only for intended visual changes (titles v2, borders) after visual review.
- `benchmark:export` timing tables committed to `docs/benchmarks/phase-7-*.md`
- New unit tests listed in each feature. Plus a 206-segment smart-cut plan exported at 24 and 60 fps with video/audio end within one frame.
- Manual checks in `tauri:dev` on Windows, plus macOS/Linux CI builds.

## Risks and open items
- **Whisper filler recall:** Whisper tends to drop disfluencies. The M2 spike settles it before UI work.
- **`ort` is 2.0.0-rc.15.** Widely used but still RC. Pin it exactly (published more than 7 days ago); its loader is a new native trust boundary covered in ADR 021.
- **MediaPipe→ONNX conversion quality and model hosting.** Needs a self-hosted mirror and SHA-256 pins, like whisper.
- **WKWebView lacks Canvas2D `filter`.** Title blur-in runs through the engine raster. The cost needs measuring.
- **Compat approximations** (zoom/pan blur, loupe refraction, transition-time zoom detail, silhouette shadow) are visible differences, reported per export.
- **F4 stack change** touches both renderers' layer order. It is held to the existing parity matrix staying green.
- **Forward compatibility:** older app builds drop new optional fields on save.
- **Scope:** this is five releases of work. Each milestone is independently shippable and gated.
