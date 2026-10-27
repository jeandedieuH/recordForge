---
agent: devin-local
session: oceanic-scorpio
created: 2026-10-27T06:40:08Z
---
# Smart Cut: production hardening (export + seamless preview)

Smart Cut's detection and cut command work, but the dense multi-segment timelines they produce break three downstream systems — the export audio graph (quadratic, never finishes), camera overlays (one decoder/overlay per piece), and the preview (one media element per clip plus a seek at every cut). This plan fixes the renderers linearly, makes video frame-exact against audio, and redesigns preview playback around pre-rolled A/B media slots.

## Diagnosis (evidence)

**Real data from `app.db` (read-only):** every export of a Smart-Cut timeline was cancelled while it was stuck; the same recordings exported fine before cutting.

| Recording | Before cut | After Smart Cut | Result |
|---|---|---|---|
| 3bc12e1c (12 min, webcam, 2 audio) | 2 segs → completed | **206 screen segs, 206 camera overlays, 412 audio segs, 60 zooms** | cancelled twice (stuck at 5 % "compositing timeline tracks") |
| 70cfd0f2 (4 min, no webcam) | – | 78 segs, 156 audio segs | cancelled |

### Export killers
1. **Audio graph is O(segments × duration)** (`append_audio_graph`, `exports/mod.rs` ~3633-3773). Every segment gets `adelay=<outputStart>` + `apad=pad_dur=<full duration>`, then *all* segments of *all* tracks go into one `amix=inputs=N`. Each segment becomes a full-length stream. All three render paths use it: chunked audio job, single pass, GPU encode sidecar (`gpu/encode.rs:92`).
   - Measured with the bundled FFmpeg on the real 206-segment mic track: **current graph didn't finish within 150 s** (the real job mixes 412). Plain `concat` with fan-out `atrim`s took 72 s. **`asegment` routing + `concat` took 0.9 s, and its 728.344 s output was the correct length.**
2. **Camera overlays: one per clip piece.** GPU path (`gpu/mod.rs build_cameras`) spawns **one FFmpeg decode process per overlay → 206 processes**. FFmpeg path chains one `overlay` filter per piece. It also gives each piece its own seek input, which overflows `MAX_SEEK_INPUTS=24` and drops to the legacy layout, so every chunk decodes from t=0.
3. **Video drifts against audio.** Each video segment ends with `trim=duration=<ms>/1000`, and that produces `ceil(d·fps)` frames. On the real plan (201 of 206 cuts are off the 60 fps grid), video ends up **+1.32 s** relative to audio, growing steadily through the export. Both renderers share this (`render_composition_window` ~2521, `gpu/decode.rs segment_filter` ~255).
   - Not a culprit: fanning video out to many `trim`s (measured +11 % for 60 segments).

### Preview problems
4. `AudioTrackPreview` mounts **one `<audio preload=auto>` per audio clip** (412). `CameraPreview` mounts **one `<video preload=auto>` per camera clip** (206, hidden with opacity 0). At each cut, a cold element has to seek and then play.
5. Audio is paused whenever the screen video is seeking (`isVideoSeeking`), and the screen seeks at **every** cut (`use-playback-clock.ts` ~317-333). Result: an audio dropout plus a 100-300 ms video stall roughly every 2.5 s.

### Editing-model issues Smart Cut amplifies
6. Splitting a clip in range-delete (`clipSegmentsAfterRange`) or split (`applySplitClip`) copies `fadeInMs`/`fadeOutMs`/`volumeKeyframes` to every piece. A faded audio clip cut 200× would fade in and out 200×.
7. Smart Cut leaves tiny kept islands (the real project starts with an 80 ms clip) and puts cuts at arbitrary ms.

## Design decisions (settled)
- **Export:** keep the per-clip timeline model. Make each renderer linear: per-track audio `asegment→concat`, camera pieces merged into "camera tracks" (Rust-internal, no contract change), frame-grid snapping for video segment lengths, 5 ms declick fades at audio splices.
- **Preview (user chose the seamless A/B redesign):** one *pair* of media elements per source (screen, each camera stream, each audio track). The hidden standby element is pre-seeked to the next segment and swapped in at the cut, so no seek happens at the cut.
- **Detection (user approved):** merge cuts that leave a kept island shorter than 200 ms, and snap cut edges to the canvas frame grid.

## Implementation steps

### Phase A — Export (Rust, `apps/desktop/src-tauri/src/exports/`)
**A1. Linear audio graph** in `append_audio_graph` (one function, so all three paths get the fix):
- Per non-muted track, sort segments by `output_start_ms`. Normalize every piece with `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo`.
- **Routing:** if the track's segments on one (input, stream) are strictly increasing and non-overlapping in source time, feed them from one `asegment=timestamps=…` (timestamps rebased by `source_seek_s`, the same rule `atrim` uses today). Drop the unused pieces with `anullsink`.
- **Fallback:** otherwise (reordered clips), use today's per-segment `atrim`.
- Each kept piece runs `asetpts=PTS-STARTPTS` → `atempo` (if speed≠1) → the existing volume/fade filter.
- **Gaps:** fill with `anullsrc` + `atrim=duration`. Join with `concat=n=K:v=0:a=1`, then `apad,atrim=duration=D`.
- **Tracks:** mix with `amix=inputs=<tracks>:normalize=0` (or a single `atrim` when there is only one track).
- **Overlap:** if segments overlap in output time within a track, keep the old per-segment `adelay`/`amix` for that track only.
- **A4 declick:** at a boundary where the source is discontinuous (different asset/stream, or `prev.source_out_ms != next.source_in_ms`), add `afade` in/out of `min(5 ms, piece/4)` on that side.

**A2. Frame-grid snapping** (shared helper used by the FFmpeg segment loop ~2447-2541, gap fills, and `gpu/decode.rs`):
- `frame_of(ms) = round(ms·fps/1000)`. Segment frames = `frame_of(clamped_end) − frame_of(clamped_start)`; duration = frames/fps.
- Skip segments with 0 frames. Compute gaps and `filled_ms` in the same frame space, so the counts add up exactly to `window.frame_count`. Apply the same snapping to camera chain durations.

**A3. Camera tracks:**
- `coalesce_camera_overlays(&[RenderPlanOverlay]) -> Vec<CameraTrack>`: consecutive visible overlays with the same `asset_id`/`stream_index`, identical visual props (rect, crop, opacity, shape, border*, shadow*, preset), and contiguous output (`prev.end == next.start`) merge into one track with `pieces`.
- **FFmpeg path:** one seek input per track (pieces clamped to the window via `camera_window_clamp`), per-piece trim/setpts/fps/snapped length → `concat` → shared geometry/mask/border/shadow → **one** `overlay` per track. `camera_jobs` count tracks, not pieces, before the `MAX_SEEK_INPUTS` check.
- **GPU path:** `build_cameras` spawns **one** `DecodeProcess` per track (concat graph inside `decode::plan_camera`). `compositor_spec` iterates the same coalesced list so camera indices stay aligned.

### Phase B — Editor core (`packages/editor-core`)
**B1. `smart-cut.ts`:**
- After padding, merge neighbouring ranges whose kept island is under `MIN_KEPT_ISLAND_MS = 200` (applies in both `analyzeSilenceRanges` and `mapSourceRangesToTimeline`).
- Add optional `fps` to `SmartCutOptions` and snap range edges to `round(round(ms·fps/1000)·1000/fps)`. Pass `timeline.canvas.fps` from `use-smart-cut-analysis.ts`.

**B2. Audio envelope partition:** shared helper used by `clipSegmentsAfterRange` and `applySplitClip`, for audio clips only:
- The left piece keeps `fadeInMs` (clamped to its length) with `fadeOutMs = 0`. The right piece keeps `fadeOutMs` with `fadeInMs = 0`. A middle piece (cut on both sides) gets zero for both.
- `volumeKeyframes` are filtered to each piece, rebased by `(pieceStart − clip.startMs)·speed`, and get interpolated edge keyframes so the gain stays continuous.

**B3. New pure module `preview-segments.ts`:**
```ts
export interface PreviewSegment { startMs: number; endMs: number; sourceInMs: number; sourceOutMs: number; speed: number; sourceKey: string; clipIds: string[] }
export function buildPreviewSegments(clips: TimelineClip[], sourceKeyOf: (c) => string): PreviewSegment[] // sorted; fuses output-contiguous + source-continuous + same speed/source
export function previewSegmentAt(segments, timelineMs): number   // index or -1
export function nextPreviewSegment(segments, timelineMs): number // first segment starting at/after the active one's end (or after timelineMs in a gap), -1 if none
```

### Phase C — Seamless preview (`apps/desktop/src/features/editor/`)
**C1. `timeline/playback/use-dual-media-slots.ts`:** follower controller for one source.
- **Inputs:** `segments`, `playheadMs`, `isPlaying`, `playbackRate`, `frameMs`, `enabled`, two element refs.
- **Swap:** when the active segment changes, if the standby slot was pre-rolled to it (`readyState ≥ 2`, `|currentTime − sourceIn| ≤ frameMs`), play the standby, pause the old one, and swap. Otherwise fall back to a seek.
- **Drift:** correction reuses the `computePreviewMediaSync` thresholds.
- **Pre-roll:** the standby always pre-rolls `nextPreviewSegment` (paused, muted). It changes `src` only when `sourceKey` differs.
- **Output:** `activeSlot`, so the caller can show the active element.

**C2. Audio:** `audio-track-preview.tsx` renders 2 `<audio>` per **track** through C1, with volume from the active clip's envelope. Gate on `isVideoSeeking` only for user scrubs (C3 makes cut swaps non-seeking).

**C3. Camera:** `camera-preview.tsx` renders one overlay per **camera stream group** with 2 `<video>` slots through C1. Position, shape, crop, and border come from the active clip's transform; select/drag/resize/context actions target the active clip id. Hidden when no clip is active.

**C4. Screen (master):**
- `timeline-view.tsx` renders two screen `<video>` slots inside one wrapper `screenSurfaceRef`. `videoRef` always points at the active slot, and an `activeScreenVideo` state goes to `MaskPreview`.
- Events (`playbackVideoProps`, `onError`/proxy fallback, `onLoaded*`) ignore events from the standby slot. The standby is always muted.
- `use-playback-clock.ts`:
  - Boundary handling (~297-393) uses `PreviewSegment`s and swaps to the pre-rolled standby. It falls back to the current seek only if the standby isn't ready.
  - Re-pre-roll after every swap, seek, pause, and timeline change.
  - `isSeeking` reflects only active-slot seeks.
- `canvas/playback-overlays.tsx` applies the zoom transform to `screenSurfaceRef` (the wrapper) instead of the `<video>`.

## Files to modify
- `apps/desktop/src-tauri/src/exports/mod.rs`: A1, A2, A3 (FFmpeg path) + tests.
- `apps/desktop/src-tauri/src/exports/gpu/mod.rs`, `gpu/decode.rs`: A2, A3 (GPU path) + tests.
- `packages/editor-core/src/smart-cut.ts` (+ test), `commands.ts` (+ `ripple-delete-lanes.test.ts`, split tests), new `preview-segments.ts` (+ test), `index.ts` export.
- `apps/desktop/src/features/editor/panels/smart-cut/use-smart-cut-analysis.ts` (pass fps).
- `apps/desktop/src/features/editor/timeline/{use-playback-clock.ts, audio-track-preview.tsx, camera-preview.tsx, timeline-view.tsx, mask-preview.tsx}`, `canvas/playback-overlays.tsx`, new `timeline/playback/use-dual-media-slots.ts` (+ tests).

## Verification
- [ ] **Rust unit tests** (`cargo test -j 1 exports`):
  - Audio graph shape: no per-segment `adelay`/`apad`; `asegment` present; `amix` inputs = track count.
  - Fallback used for reordered or overlapping segments.
  - Frame-snap telescoping: the sum of segment and gap frames equals `frame_count` for off-grid cuts (single pass and chunk windows).
  - Coalescing merges identical contiguous pieces and splits on any transform difference.
- [ ] **FFmpeg-backed e2e test:** ~40 off-grid segments, 2 audio tracks, camera overlay pieces. Must complete; `nb_read_frames == ceil(duration·fps)`; audio duration within 1 frame; ≤ ½ frame A/V offset, checked with a click-track fixture aligned to frame counters.
- [ ] **Harness, real project:** `tooling/gen-export-spec.ts` on session `42ecfefe…` (206 segments, read-only source, output to scratch). `export_harness` with `renderer: compatibility` and `gpu`, both completing in a time comparable to the uncut export.
- [ ] **Parity gate** (`parity.ts --profile renderer`) on the synthetic matrix: no regression for single-segment plans.
- [ ] **TS:** `bun run --cwd packages/editor-core test`, `bun run --cwd apps/desktop test`, `bun run typecheck`, `bun run --cwd apps/desktop lint`, `cargo fmt --check`, `cargo clippy`.
- [ ] **Manual (needs you, in `tauri:dev`):** play the 206-cut project across cuts (no stall/dropout, camera follows), scrub, toggle proxy quality, then export with Auto/GPU and Compatibility.

## Risks / considerations
- **Frame snapping** changes output frames for multi-segment plans (by design). Single-segment and on-grid plans stay byte-identical, which the parity gate checks.
- **A/B preview** doubles decoders per source (2× screen, 2× per camera stream, 2× per audio track). That is still far below today's 600+ elements. If the standby isn't ready (very short segments), the cut falls back to today's seek.
- **`asegment`** needs monotonic source order. Reordered timelines keep the old per-segment path, which is correct but slower.
- **Not in scope (observed):** a stale `running` export row (`de671459`) left after app exit, and older 2026-10-13 "Filter not found" failures unrelated to Smart Cut. Both are follow-ups.
