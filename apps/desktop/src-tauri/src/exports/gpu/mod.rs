//! Native GPU export compositor (Phase 5, ADR 018).
//!
//! FFmpeg keeps decode and encode; wgpu composites the frames that used to be
//! blended by the `filter_complex` graph. This module owns renderer selection,
//! the feature gate that keeps unsupported plans on the compatibility path, and
//! the decode → compose → encode pipeline itself.
//!
//! Milestone state: G0 (passthrough + zoom) is implemented. G1–G3 features
//! (canvas frame/background, cursor, items, camera, masks, keystrokes, captions)
//! are listed in [`plan_limitations`] and keep those plans on the FFmpeg
//! renderer, which stays the authoritative output for every feature.

mod compositor;
mod decode;
mod encode;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Instant;

use crate::errors::{InternalError, Result};
use tracing::{info, warn};

use super::camera::{self, ZoomTransformState};
use super::encoding::ExportEncoder;
use super::{
    common_screen_source, video_screen_rect, CompositionShared, CompositionWindow, ExportSettings,
    RenderOutcome, RenderPlan,
};

/// Which compositor renders an export.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExportRenderer {
    /// The FFmpeg `filter_complex` graph — every feature, every platform.
    Compatibility,
    /// The native wgpu compositor.
    Gpu,
}

impl ExportRenderer {
    pub(crate) fn label(self) -> &'static str {
        match self {
            ExportRenderer::Compatibility => "compatibility (FFmpeg)",
            ExportRenderer::Gpu => "gpu (wgpu)",
        }
    }
}

/// Renderer decision plus the reason a request was downgraded, for logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RendererChoice {
    pub renderer: ExportRenderer,
    pub reason: Option<String>,
}

impl RendererChoice {
    fn compatibility(reason: impl Into<String>) -> Self {
        Self {
            renderer: ExportRenderer::Compatibility,
            reason: Some(reason.into()),
        }
    }
}

/// G5 flips this once the parity and failure-rate gates hold. Until then `auto`
/// keeps every user export on the compatibility renderer; `gpu` still asks for
/// the new path explicitly, and `RECORDFORGE_EXPORT_GPU=1` opts `auto` in for
/// A/B benchmarks.
const GPU_ENABLED_BY_DEFAULT: bool = false;

/// Resolve the renderer for one export. Never fails: an unusable GPU request
/// degrades to the compatibility renderer with a logged reason, because failing
/// an export over a renderer preference would be worse than rendering it on the
/// path that already works.
pub(crate) fn resolve_renderer(
    preference: &str,
    plan: &RenderPlan,
    settings: &ExportSettings,
    shared: &CompositionShared,
    asset_paths: &HashMap<String, PathBuf>,
) -> RendererChoice {
    if preference == "compatibility" {
        return RendererChoice {
            renderer: ExportRenderer::Compatibility,
            reason: None,
        };
    }
    let auto_enabled = GPU_ENABLED_BY_DEFAULT
        || std::env::var("RECORDFORGE_EXPORT_GPU")
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
    if preference != "gpu" && !auto_enabled {
        return RendererChoice::compatibility(
            "auto keeps the compatibility renderer until the GPU parity gate (G5) holds",
        );
    }
    let limitations = plan_limitations(plan, settings, shared, asset_paths);
    if !limitations.is_empty() {
        return RendererChoice::compatibility(format!(
            "plan needs features the GPU compositor does not support yet: {}",
            limitations.join("; ")
        ));
    }
    RendererChoice {
        renderer: ExportRenderer::Gpu,
        reason: None,
    }
}

/// Every reason this plan cannot render on the GPU compositor yet. An empty list
/// means "G0-compatible": a full-canvas screen plane, optional zoom, and nothing
/// that needs a shader milestone.
pub(crate) fn plan_limitations(
    plan: &RenderPlan,
    settings: &ExportSettings,
    shared: &CompositionShared,
    asset_paths: &HashMap<String, PathBuf>,
) -> Vec<String> {
    let mut reasons: Vec<String> = Vec::new();
    let Some(canvas) = plan.canvas.as_ref() else {
        return vec!["plan has no render canvas".into()];
    };

    // Delivery format: NV12 into FFmpeg, so animated containers and HEVC
    // tagging land in later milestones.
    if settings.container != "mp4" {
        reasons.push(format!("container {} is not mp4", settings.container));
    }
    if settings.codec != "h264" {
        reasons.push(format!("codec {} is not h264", settings.codec));
    }
    if canvas.width % 4 != 0 || canvas.height % 2 != 0 {
        reasons.push(format!(
            "canvas {}x{} is not a 4x2 NV12 grid",
            canvas.width, canvas.height
        ));
    }

    // Canvas framing (G1): a padded, rounded, shadowed or dimmed frame needs the
    // background plate and SDF corners.
    if canvas.padding != 0 {
        reasons.push("canvas padding".into());
    }
    if canvas.border_radius != 0 {
        reasons.push("canvas corner radius".into());
    }
    if canvas.shadow {
        reasons.push("canvas shadow".into());
    }
    if canvas.background_blur.unwrap_or(0.0) > 0.0 || canvas.background_dim.unwrap_or(0.0) > 0.0 {
        reasons.push("canvas background treatment".into());
    }

    // Overlay layers (G1/G2).
    if !plan.cursor_effects.is_empty() {
        reasons.push("cursor overlay".into());
    }
    if !plan.texts.is_empty() || !plan.annotations.is_empty() || !plan.images.is_empty() {
        reasons.push("overlay items".into());
    }
    if plan.overlay_render_plan.is_some() {
        reasons.push("overlay display list".into());
    }
    if !plan.overlays.is_empty() {
        reasons.push("camera overlay / side-by-side layout".into());
    }
    if !plan.masks.is_empty() {
        reasons.push("privacy masks".into());
    }
    if !plan.keystrokes.is_empty() {
        reasons.push("keystroke overlay".into());
    }
    if !plan.captions.is_empty() && plan.caption_mode == "burn-in" {
        reasons.push("burned-in captions".into());
    }

    // Timeline coverage: a gap needs a solid-fill source, which the decode
    // pass does not synthesise yet.
    if !plan.gaps.is_empty() {
        reasons.push("timeline gaps".into());
    }
    if !segments_cover_timeline(plan) {
        reasons.push("segments do not cover the full timeline".into());
    }

    // The G0 compositor samples the screen straight onto the canvas: the fitted
    // rect must fill it exactly, otherwise the background plate (G1) is needed.
    match common_screen_source(&plan.segments, asset_paths, &shared.probe) {
        Some(source) => {
            let (x, y, width, height) = video_screen_rect(canvas, Some(source), false);
            if x.abs() > 0.5
                || y.abs() > 0.5
                || width < canvas.width as f64 - 0.5
                || height < canvas.height as f64 - 0.5
            {
                reasons.push("screen does not fill the canvas".into());
            }
        }
        None => reasons.push("segments have mixed or unknown source dimensions".into()),
    }

    // Non-finite zoom/overlay values are rejected upstream; a malformed canvas
    // is still worth catching before a device is created.
    if plan.segments.is_empty() {
        reasons.push("timeline has no video segments".into());
    }

    reasons
}

/// True when the segments tile `[0, plan.duration_ms]` with no hole: the decode
/// pass relies on that, because it never synthesises a black gap.
fn segments_cover_timeline(plan: &RenderPlan) -> bool {
    let mut spans: Vec<(u64, u64)> = plan
        .segments
        .iter()
        .filter(|segment| segment.output_end_ms > segment.output_start_ms)
        .map(|segment| (segment.output_start_ms, segment.output_end_ms))
        .collect();
    if spans.is_empty() {
        return false;
    }
    spans.sort_unstable();
    if spans[0].0 != 0 {
        return false;
    }
    let mut cursor = 0u64;
    for (start, end) in spans {
        if start > cursor {
            return false;
        }
        cursor = cursor.max(end);
    }
    cursor >= plan.duration_ms
}

/// Frame-count override for the decode/encode sidecar queues.
fn queue_frames(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (1..=64).contains(value))
        .unwrap_or(default)
}

/// Identity frames never reach the compositor, so its crop argument is unused.
const FULL_FRAME: compositor::Crop = compositor::Crop {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
};

fn decode_hwaccel() -> bool {
    // Off by default: the decode sidecar downloads every frame to system memory
    // for the compositor and the encoder, so hardware decode only adds a
    // `hwdownload` stage. Measured on the baseline laptop it cost 3.3 s of the
    // 13.2 s plain pass (`docs/benchmarks/phase-5-results.md`). Kept as an
    // opt-in for the future D3D11/Metal interop work.
    matches!(
        std::env::var("RECORDFORGE_EXPORT_GPU_DECODE_HWACCEL").as_deref(),
        Ok("1") | Ok("true")
    )
}

/// Render one full-timeline export through the GPU compositor.
///
/// Errors are recoverable: the caller retries on the compatibility renderer, so
/// every failure here is reported as a plain message rather than aborting the
/// job.
#[allow(clippy::too_many_arguments)]
pub(crate) fn render_timeline_on_gpu(
    ffmpeg_path: &str,
    output_path: &Path,
    plan: &RenderPlan,
    project_id: &str,
    asset_paths: &HashMap<String, PathBuf>,
    settings: &ExportSettings,
    encoder: ExportEncoder,
    cancel: Arc<AtomicBool>,
    on_progress: &(dyn Fn(f64) + Sync),
    shared: &CompositionShared,
) -> Result<RenderOutcome> {
    let canvas = plan
        .canvas
        .as_ref()
        .ok_or_else(|| gpu_error("GPU export needs a render canvas"))?;
    let width = canvas.width;
    let height = canvas.height;
    let fps = canvas.fps.max(1);
    let window = CompositionWindow::full(plan);

    let started = Instant::now();
    let decode_plan = decode::plan(
        plan,
        project_id,
        asset_paths,
        shared,
        &window,
        width,
        height,
        fps,
        decode_hwaccel(),
    )?;
    let plan_ms = started.elapsed().as_millis() as u64;
    if decode_plan.filter.len() > decode::MAX_INLINE_FILTER_LEN {
        return Err(gpu_error(
            "GPU decode graph exceeds the inline filter limit; use the compatibility renderer",
        ));
    }

    let mut compositor = compositor::Compositor::new(width, height)?;
    let compositor_ready_ms = started.elapsed().as_millis() as u64;
    let compositor_ms = compositor_ready_ms - plan_ms;
    let encode_process = encode::spawn(
        ffmpeg_path,
        output_path,
        plan,
        project_id,
        asset_paths,
        settings,
        encoder,
        shared,
        width,
        height,
        fps,
    )?;
    let has_audio = encode_process.has_audio();
    let mut decoder = decode::DecodeProcess::spawn(ffmpeg_path, &decode_plan)?;

    info!(
        adapter = compositor.adapter_label(),
        width,
        height,
        fps,
        plan_ms,
        compositor_ms,
        sidecars_ms = started.elapsed().as_millis() as u64 - compositor_ready_ms,
        "gpu export: starting decode → compose → encode"
    );

    let total_frames = decode_plan.frame_count.max(1);
    // Decode/encode queues are sized in frames. A frame is ~3.1 MB at 1080p, so
    // the defaults hold ~25 MB of decode and ~19 MB of encode in flight —
    // enough to keep the encoder from stalling the compose loop while the next
    // frames are already composed.
    let (decode_tx, decode_rx) =
        mpsc::sync_channel::<Vec<u8>>(queue_frames("RECORDFORGE_EXPORT_GPU_DECODE_QUEUE", 8));
    let (encode_tx, encode_rx) =
        mpsc::sync_channel::<Vec<u8>>(queue_frames("RECORDFORGE_EXPORT_GPU_ENCODE_QUEUE", 6));

    let mut composed_frames = 0u64;
    let mut passthrough_frames = 0u64;
    let mut compose_time = std::time::Duration::ZERO;
    let mut decode_wait = std::time::Duration::ZERO;
    let mut encode_wait = std::time::Duration::ZERO;
    let mut pipeline_wall = std::time::Duration::ZERO;
    let setup_ms = started.elapsed().as_millis() as u64;

    let result = std::thread::scope(|scope| -> Result<()> {
        let reader = scope.spawn(move || -> Result<()> {
            loop {
                match decoder.read_frame() {
                    Ok(Some(frame)) => {
                        if decode_tx.send(frame).is_err() {
                            // The compose loop stopped (cancel or error): kill
                            // the decoder so it never blocks on a full pipe.
                            decoder.kill();
                            return Ok(());
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        decoder.kill();
                        return Err(error);
                    }
                }
            }
            decoder.finish()
        });

        let writer = scope.spawn(move || -> Result<()> {
            let mut encode_process = encode_process;
            for frame in encode_rx {
                if let Err(error) = encode_process.write_frame(&frame) {
                    // The encoder died mid-stream; kill it so `wait` cannot
                    // block on a half-written pipe.
                    encode_process.kill();
                    return Err(error);
                }
            }
            encode_process.finish()
        });

        let mut main_result: Result<()> = Ok(());
        let mut emitted = 0u64;
        let mut sent_frames = 0u64;
        while emitted < total_frames {
            if cancel.load(Ordering::Relaxed) {
                main_result = Err(InternalError::Media("export cancelled".into()).into());
                break;
            }
            let wait_started = Instant::now();
            let frame = match decode_rx.recv() {
                Ok(frame) => frame,
                Err(_) => break,
            };
            decode_wait += wait_started.elapsed();
            let output_ms = emitted as f64 * 1000.0 / fps as f64;
            let state = camera::evaluate_zoom_transform(
                &plan.zoom_segments,
                width,
                height,
                canvas.padding,
                output_ms,
            );
            let compose_started = Instant::now();
            let ready = if camera::zoom_transform_is_identity(&state, width, height) {
                passthrough_frames += 1;
                compositor.submit(compositor::Frame::Pass(frame), FULL_FRAME)
            } else {
                composed_frames += 1;
                let crop = zoom_crop(&state, width, height);
                compositor.submit(
                    compositor::Frame::Compose(compositor::Nv12Frame { data: frame }),
                    crop,
                )
            };
            compose_time += compose_started.elapsed();
            match ready {
                Ok(Some(bytes)) => {
                    let send_started = Instant::now();
                    let sent = encode_tx.send(bytes);
                    encode_wait += send_started.elapsed();
                    if sent.is_err() {
                        main_result = Err(gpu_error("GPU encode pass closed early"));
                        break;
                    }
                    sent_frames += 1;
                }
                Ok(None) => {}
                Err(error) => {
                    main_result = Err(error);
                    break;
                }
            }
            emitted += 1;
            on_progress((emitted as f64 / total_frames as f64).clamp(0.0, 1.0));
        }
        // Flush the readback ring: every frame still in flight is a frame the
        // encoder has not seen yet.
        if main_result.is_ok() {
            match compositor.drain() {
                Ok(frames) => {
                    for bytes in frames {
                        let send_started = Instant::now();
                        let sent = encode_tx.send(bytes);
                        encode_wait += send_started.elapsed();
                        if sent.is_err() {
                            main_result = Err(gpu_error("GPU encode pass closed early"));
                            break;
                        }
                        sent_frames += 1;
                    }
                }
                Err(error) => main_result = Err(error),
            }
        }
        drop(encode_tx);
        drop(decode_rx);
        pipeline_wall = started.elapsed();

        let read = reader
            .join()
            .unwrap_or_else(|_| Err(gpu_error("GPU decode thread panicked")));
        let write = writer
            .join()
            .unwrap_or_else(|_| Err(gpu_error("GPU encode thread panicked")));

        if main_result.is_ok() && emitted < total_frames {
            return Err(gpu_error("GPU decode ended before the timeline did"));
        }
        if main_result.is_ok() && sent_frames != total_frames {
            return Err(gpu_error("GPU compose produced the wrong frame count"));
        }
        main_result.and(read).and(write)
    });

    let elapsed = started.elapsed();
    match &result {
        Ok(()) => info!(
            elapsed_ms = elapsed.as_millis() as u64,
            setup_ms,
            pipeline_ms = pipeline_wall.as_millis() as u64,
            flush_ms = elapsed.saturating_sub(pipeline_wall).as_millis() as u64,
            frames = total_frames,
            composed = composed_frames,
            passthrough = passthrough_frames,
            compose_ms = compose_time.as_millis() as u64,
            decode_wait_ms = decode_wait.as_millis() as u64,
            encode_wait_ms = encode_wait.as_millis() as u64,
            realtime_x = (total_frames as f64 / (fps as f64)) / elapsed.as_secs_f64().max(1e-6),
            "gpu export: finished"
        ),
        Err(error) => warn!(
            elapsed_ms = elapsed.as_millis() as u64,
            error = %error,
            "gpu export: failed; falling back to the compatibility renderer"
        ),
    }
    result?;
    Ok(RenderOutcome { has_audio })
}

/// Integer source rect the GPU samples for one frame. Uses the same
/// `zoompan_integer_crop` math the piecewise-zoom path builds filters from, so
/// cursor registration and the sampled region stay consistent between
/// renderers; widths/heights are snapped to the NV12 chroma grid.
fn zoom_crop(state: &ZoomTransformState, width: u32, height: u32) -> compositor::Crop {
    let (x, y, w, h) = camera::zoompan_integer_crop(
        (state.crop_x, state.crop_y, state.crop_w, state.crop_h),
        width as f64,
        height as f64,
        width as f64,
        height as f64,
        1,
        1,
    );
    let w = (w.min(width).max(2)) & !1u32;
    let h = (h.min(height).max(2)) & !1u32;
    compositor::Crop {
        x: x.min(width.saturating_sub(w)),
        y: y.min(height.saturating_sub(h)),
        width: w,
        height: h,
    }
}

/// Short, path-free error for the GPU path.
pub(crate) fn gpu_error(message: &str) -> crate::errors::AppError {
    InternalError::Media(message.to_string()).into()
}

/// Canvas geometry the compositor guarantees for a gated plan. Kept next to the
/// gate so the unit tests assert the pair stay in sync.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::exports::cursor::RenderCanvas;
    use crate::exports::{RenderPlan, RenderSegment};
    use std::collections::HashMap;

    fn gated_canvas() -> RenderCanvas {
        RenderCanvas {
            width: 1920,
            height: 1080,
            fps: 30,
            ..Default::default()
        }
    }

    fn plan_with_canvas(canvas: RenderCanvas) -> RenderPlan {
        RenderPlan {
            project_id: "project-1".into(),
            duration_ms: 3_000,
            segments: vec![RenderSegment {
                asset_id: "screen".into(),
                stream_index: Some(0),
                volume: None,
                fade_in_ms: None,
                fade_out_ms: None,
                volume_keyframes: None,
                audio_filter: None,
                speed: 1.0,
                source_in_ms: 0,
                source_out_ms: 3_000,
                output_start_ms: 0,
                output_end_ms: 3_000,
                source_width: Some(1920),
                source_height: Some(1080),
            }],
            gaps: Vec::new(),
            overlays: Vec::new(),
            captions: Vec::new(),
            caption_mode: "burn-in".into(),
            chapters: Vec::new(),
            chapter_mode: "embed".into(),
            masks: Vec::new(),
            zoom_segments: Vec::new(),
            cursor_effects: Vec::new(),
            overlay_render_plan: None,
            canvas: Some(canvas),
            audio: None,
            audio_tracks: None,
            annotations: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
            keystrokes: Vec::new(),
            keystroke_platform: "windows".into(),
        }
    }

    fn settings() -> ExportSettings {
        serde_json::from_str::<ExportSettings>("{}").expect("default settings")
    }

    fn limitations(plan: &RenderPlan) -> Vec<String> {
        let shared = CompositionShared::new(None);
        let assets: HashMap<String, PathBuf> = HashMap::new();
        plan_limitations(plan, &settings(), &shared, &assets)
    }

    #[test]
    fn a_plain_full_canvas_plan_is_gpu_compatible() {
        assert!(limitations(&plan_with_canvas(gated_canvas())).is_empty());
    }

    #[test]
    fn canvas_framing_needs_the_background_plate() {
        let mut canvas = gated_canvas();
        canvas.padding = 48;
        assert!(limitations(&plan_with_canvas(canvas))
            .iter()
            .any(|reason| reason.contains("padding")));

        let mut canvas = gated_canvas();
        canvas.border_radius = 24;
        assert!(limitations(&plan_with_canvas(canvas))
            .iter()
            .any(|reason| reason.contains("corner radius")));
    }

    #[test]
    fn overlay_layers_keep_the_ffmpeg_renderer() {
        let mut plan = plan_with_canvas(gated_canvas());
        plan.cursor_effects
            .push(crate::exports::RenderPlanCursorEffect {
                id: "cursor-1".into(),
                asset_id: "cursor".into(),
                start_ms: 0,
                end_ms: 1_000,
                enabled: true,
                preset_id: "recorded-system".into(),
                scale: 1.0,
                smoothing: "strong".into(),
                settings: serde_json::json!({}),
            });
        assert!(limitations(&plan)
            .iter()
            .any(|reason| reason.contains("cursor")));
    }

    #[test]
    fn a_timeline_hole_needs_a_gap_source() {
        let mut plan = plan_with_canvas(gated_canvas());
        plan.segments[0].output_end_ms = 2_000;
        assert!(limitations(&plan)
            .iter()
            .any(|reason| reason.contains("cover the full timeline")));
    }

    #[test]
    fn a_letterboxed_screen_needs_the_fit_plate() {
        // A 16:9 source on a square canvas cannot fill it without a background.
        let mut canvas = gated_canvas();
        canvas.width = 1080;
        canvas.height = 1080;
        assert!(limitations(&plan_with_canvas(canvas))
            .iter()
            .any(|reason| reason.contains("fill the canvas")));
    }

    #[test]
    fn compatibility_preference_never_uses_the_gpu() {
        let plan = plan_with_canvas(gated_canvas());
        let choice = resolve_renderer(
            "compatibility",
            &plan,
            &settings(),
            &CompositionShared::new(None),
            &HashMap::new(),
        );
        assert_eq!(choice.renderer, ExportRenderer::Compatibility);
        assert!(choice.reason.is_none());
    }

    #[test]
    fn auto_stays_on_the_compatibility_renderer_until_g5() {
        // `plan_limitations` is empty for this plan, so a GPU renderer here can
        // only come from the auto default, which must remain off.
        let plan = plan_with_canvas(gated_canvas());
        let choice = resolve_renderer(
            "auto",
            &plan,
            &settings(),
            &CompositionShared::new(None),
            &HashMap::new(),
        );
        assert_eq!(choice.renderer, ExportRenderer::Compatibility);
        assert!(choice.reason.as_deref().unwrap_or_default().contains("G5"));
    }

    #[test]
    fn explicit_gpu_degrades_with_a_reason_when_the_plan_is_out_of_scope() {
        let mut plan = plan_with_canvas(gated_canvas());
        plan.masks.push(crate::exports::RenderPlanMask {
            id: "mask".into(),
            asset_id: None,
            start_ms: 0,
            end_ms: 1_000,
            mode: "blur".into(),
            rect: crate::exports::RenderCropFloat {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            blur_radius: 12.0,
            pixel_size: 8,
            redact_color: "#000000".into(),
            enabled: true,
        });
        let choice = resolve_renderer(
            "gpu",
            &plan,
            &settings(),
            &CompositionShared::new(None),
            &HashMap::new(),
        );
        assert_eq!(choice.renderer, ExportRenderer::Compatibility);
        assert!(choice.reason.unwrap_or_default().contains("masks"));
    }

    #[test]
    fn zoom_crops_snap_to_the_nv12_grid_and_stay_inside_the_canvas() {
        let state = ZoomTransformState {
            progress: 1.0,
            scale: 1.5,
            crop_x: 100.0,
            crop_y: 40.0,
            crop_w: 1280.0,
            crop_h: 720.0,
        };
        let crop = zoom_crop(&state, 1920, 1080);
        assert_eq!(crop.width % 2, 0);
        assert_eq!(crop.height % 2, 0);
        assert_eq!(crop.x % 2, 0);
        assert_eq!(crop.y % 2, 0);
        assert!(crop.x + crop.width <= 1920);
        assert!(crop.y + crop.height <= 1080);
    }

    #[test]
    fn full_frame_zoom_crop_covers_the_canvas() {
        let state = ZoomTransformState {
            progress: 0.0,
            scale: 1.0,
            crop_x: 0.0,
            crop_y: 0.0,
            crop_w: 1920.0,
            crop_h: 1080.0,
        };
        let crop = zoom_crop(&state, 1920, 1080);
        assert_eq!(
            crop,
            compositor::Crop {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080
            }
        );
    }

    /// The transition crop must track `zoompan`'s per-frame integer crop:
    /// `w = (int)(in_w / z)`, `x = (int)dx` snapped to the chroma grid. This
    /// pins the values the GPU samples through the 300 ms transition-in, where
    /// a one-frame progress error is visible as a jump.
    #[test]
    fn zoom_transition_crops_follow_the_zoompan_quantisation() {
        let segments: Vec<crate::exports::RenderPlanZoomSegment> =
            serde_json::from_value(serde_json::json!([{
                "id": "zoom-1",
                "startMs": 4_000,
                "endMs": 9_000,
                "target": { "x": 480.0, "y": 270.0, "width": 960.0, "height": 540.0 },
                "scale": 1.5,
                "mode": "manual",
            }]))
            .expect("zoom segment");
        let crop_at = |ms: f64| {
            let state = camera::evaluate_zoom_transform(&segments, 1920, 1080, 0, ms);
            (
                camera::zoom_transform_is_identity(&state, 1920, 1080),
                zoom_crop(&state, 1920, 1080),
            )
        };
        // Identity before the region starts.
        assert!(crop_at(3_999.0).0);
        // First zoomed frame is already mid-transition, not a hard cut.
        let (identity, first) = crop_at(4_033.333);
        assert!(!identity);
        assert!(first.width > 1900 && first.width < 1920, "{first:?}");
        // The default 400 ms transition-in ends at 4.4 s, where the full 2x
        // crop lands.
        let (_, held) = crop_at(4_400.0);
        assert_eq!(
            held,
            compositor::Crop {
                x: 480,
                y: 270,
                width: 960,
                height: 540
            }
        );
        // Crops shrink monotonically through the transition and stay on the
        // NV12 chroma grid.
        let mut previous = first.width;
        for step in 1..=12 {
            let (_, crop) = crop_at(4_033.333 + step as f64 * 1000.0 / 30.0);
            assert!(crop.width <= previous, "crop grew back: {crop:?}");
            assert_eq!(crop.x % 2, 0);
            assert_eq!(crop.y % 2, 0);
            assert_eq!(crop.width % 2, 0);
            assert_eq!(crop.height % 2, 0);
            previous = crop.width;
        }
    }
}
