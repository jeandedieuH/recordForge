//! Native GPU export compositor (Phase 5, ADR 018).
//!
//! FFmpeg keeps decode and encode; wgpu composites the frames that used to be
//! blended by the `filter_complex` graph. This module owns renderer selection,
//! the feature gate that keeps unsupported plans on the compatibility path, and
//! the decode → compose → encode pipeline itself.
//!
//! Milestone state: G0–G5 are complete. The GPU pass owns canvas framing,
//! zoom, cursor/overlay items, camera and side-by-side layout, redact/pixelate
//! privacy masks and keystroke badges; the encode sidecar owns burned-in
//! captions (libass), chapters, HEVC tagging and the license output cap.
//! [`plan_limitations`] keeps structurally unsupported plans on the FFmpeg
//! renderer, which stays the authoritative output and the fallback for every
//! feature.

mod compositor;
mod decode;
mod encode;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Instant;

use crate::errors::{InternalError, Result};
use tracing::{info, warn};

use super::camera::{self, ZoomTransformState};
use super::encoding::ExportEncoder;
use super::{
    common_screen_source, CompositionShared, CompositionWindow, ExportSettings, RenderOutcome,
    RenderPlan,
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

/// G5: `auto` selects the GPU compositor. `RECORDFORGE_EXPORT_GPU=0` opts out
/// (support/troubleshooting), and a process-level failure gate drops back to
/// the FFmpeg renderer after repeated runtime failures.
const GPU_ENABLED_BY_DEFAULT: bool = true;

/// Runtime GPU failures tolerated back-to-back before `auto` stops trying for
/// the rest of the process. A render that succeeds resets the count; one that
/// keeps failing (device loss loop, driver bug, broken sidecar) should not cost
/// every following export a failed attempt and its wgpu setup time.
const GPU_FAILURE_GATE_THRESHOLD: u32 = 3;

/// Consecutive GPU render failures in this process. Only touched from the
/// export worker, and only for diagnostics and the `auto` gate.
static GPU_CONSECUTIVE_FAILURES: AtomicU32 = AtomicU32::new(0);

/// Whether `auto` may use the GPU compositor. `RECORDFORGE_EXPORT_GPU` accepts
/// `1/true/on` and `0/false/off`; unset follows [`GPU_ENABLED_BY_DEFAULT`].
fn auto_gpu_enabled(env_value: Option<&str>) -> bool {
    match env_value.map(str::trim) {
        Some("0") | Some("false") | Some("off") => false,
        Some(_) => true,
        None => GPU_ENABLED_BY_DEFAULT,
    }
}

/// True when repeated runtime failures have tripped the process-level gate.
fn failure_gate_tripped(consecutive_failures: u32) -> bool {
    consecutive_failures >= GPU_FAILURE_GATE_THRESHOLD
}

/// Why `auto` must stay on the compatibility renderer, if it must.
fn auto_gpu_blocked(env_value: Option<&str>, consecutive_failures: u32) -> Option<&'static str> {
    if !auto_gpu_enabled(env_value) {
        return Some("auto GPU compositing is disabled by RECORDFORGE_EXPORT_GPU");
    }
    if failure_gate_tripped(consecutive_failures) {
        return Some("auto fell back to the compatibility renderer after repeated GPU failures");
    }
    None
}

/// Reset the failure gate after a GPU render finished and validated.
pub(crate) fn note_gpu_success() {
    GPU_CONSECUTIVE_FAILURES.store(0, Ordering::Relaxed);
}

/// Record a runtime GPU failure (device loss, sidecar error, shader validation)
/// so `auto` can stop retrying after [`GPU_FAILURE_GATE_THRESHOLD`] in a row.
pub(crate) fn note_gpu_failure() {
    let failures = GPU_CONSECUTIVE_FAILURES.fetch_add(1, Ordering::Relaxed) + 1;
    if failures == GPU_FAILURE_GATE_THRESHOLD {
        warn!(
            failures,
            "gpu export: failure gate tripped; auto will use the compatibility renderer until the process restarts"
        );
    }
}

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
    if preference != "gpu" {
        let env = std::env::var("RECORDFORGE_EXPORT_GPU").ok();
        let failures = GPU_CONSECUTIVE_FAILURES.load(Ordering::Relaxed);
        if let Some(reason) = auto_gpu_blocked(env.as_deref(), failures) {
            return RendererChoice::compatibility(reason);
        }
        // Nothing to composite: the compatibility renderer then wins outright
        // (one in-process FFmpeg pipeline versus decode sidecar → Rust copy →
        // encode sidecar), so `auto` keeps those exports on FFmpeg.
        if plan_is_passthrough_only(plan, settings) {
            return RendererChoice::compatibility(
                "auto keeps passthrough-only exports on the in-process FFmpeg pipeline",
            );
        }
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

/// True when every frame of the plan would take the compositor's bypass path:
/// identity zoom on a plain full-canvas fit with no layer, mask or keystroke
/// work. Captions and chapters do not count — they run in the encode sidecar
/// after the (bypassed) raster.
///
/// `auto` then keeps the export on the compatibility renderer: a cross-process
/// decode → copy → encode pipeline is measurably slower (~2 s on a 30 s 1080p30
/// clip) than FFmpeg's single in-process pass, and the GPU has nothing to add.
fn plan_is_passthrough_only(plan: &RenderPlan, settings: &ExportSettings) -> bool {
    let Some(canvas) = plan.canvas.as_ref() else {
        return false;
    };
    let keystrokes = settings
        .keystroke_overlay
        .as_ref()
        .is_some_and(|overlay| overlay.enabled)
        && !plan.keystrokes.is_empty();
    plan.zoom_segments.is_empty()
        && !keystrokes
        && plan.masks.iter().all(|mask| !mask.enabled)
        && plan
            .cursor_effects
            .iter()
            .all(|effect| !effect.enabled || effect.end_ms <= effect.start_ms)
        && plan.texts.is_empty()
        && plan.annotations.is_empty()
        && plan.images.is_empty()
        && plan.overlay_render_plan.is_none()
        // Any visible camera/overlay also decides the side-by-side layout.
        && plan
            .overlays
            .iter()
            .all(|overlay| !overlay.visible || overlay.output_end_ms <= overlay.output_start_ms)
        && canvas.padding == 0
        && canvas.border_radius == 0
        && !canvas.shadow
}

/// Every reason this plan cannot render on the GPU compositor. An empty list
/// means G5-compatible: canvas framing, zoom, cursor, overlay items, camera and
/// side-by-side layout, redact/pixelate privacy masks, keystroke badges,
/// burned-in captions, chapters, HEVC and the license output cap all render on
/// the GPU path.
///
/// The remaining exclusions are structural: animated containers (GIF/WebP),
/// timeline gaps/coverage holes the decode pass cannot synthesise, mixed source
/// dimensions, non-NV12 canvases, blur privacy masks (the shader approximation
/// of FFmpeg's scaled avgblur is below the parity floor), and the one ordering
/// pair the hybrid pipeline cannot express (keystrokes must sit above captions,
/// but captions run in the encode sidecar after the GPU raster).
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

    // Delivery format: the encode sidecar muxes MP4 and tags `hvc1`. Animated
    // containers stay on FFmpeg by design (ADR 018).
    if settings.container != "mp4" {
        reasons.push(format!("container {} is not mp4", settings.container));
    }
    if !matches!(settings.codec.as_str(), "h264" | "hevc") {
        reasons.push(format!("codec {} is not h264/hevc", settings.codec));
    }
    if canvas.width % 4 != 0 || canvas.height % 2 != 0 {
        reasons.push(format!(
            "canvas {}x{} is not a 4x2 NV12 grid",
            canvas.width, canvas.height
        ));
    }

    // Keystroke badges are composited by the GPU before the encode sidecar's
    // libass pass, but the compatibility graph draws them *above* captions.
    // Keep the pair on the authoritative renderer rather than silently
    // reordering layers.
    let keystrokes_enabled = settings
        .keystroke_overlay
        .as_ref()
        .is_some_and(|overlay| overlay.enabled);
    if keystrokes_enabled
        && !plan.keystrokes.is_empty()
        && !plan.captions.is_empty()
        && plan.caption_mode == "burn-in"
    {
        reasons.push("keystroke overlay with burned-in captions".into());
    }

    // Blur masks emulate FFmpeg's `scale → avgblur(3×3) → scale` chain in the
    // mask shader. Measured on the G4 matrix the approximation is 18.6 dB on the
    // worst frame (33 dB inside the rect) versus the 28 dB floor: swscale's
    // widened bilinear downscale is a different kernel, not a rounding detail.
    // Redact and pixelate are exact, so only blur keeps the FFmpeg renderer
    // until the shader reproduces swscale's kernel.
    if plan
        .masks
        .iter()
        .any(|mask| mask.enabled && mask.mode == "blur")
    {
        reasons.push("blur privacy masks".into());
    }

    // Timeline coverage: a gap needs a solid-fill source, which the decode
    // pass does not synthesise yet.
    if !plan.gaps.is_empty() {
        reasons.push("timeline gaps".into());
    }
    if !segments_cover_timeline(plan) {
        reasons.push("segments do not cover the full timeline".into());
    }

    // The decode pass scales every segment into one content rect, so mixed or
    // unknown source dimensions cannot be fitted.
    if common_screen_source(&plan.segments, asset_paths, &shared.probe).is_none() {
        reasons.push("segments have mixed or unknown source dimensions".into());
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

/// Plate-producer threads. The compatibility renderer spreads the same CPU work
/// (tiny-skia raster + full-canvas YUVA conversion) over `producer_worker_count`
/// threads, but the GPU pipeline also competes for CPU with the compose/readback
/// loop and the two FFmpeg sidecars, so the target is capped at four.
/// `RECORDFORGE_EXPORT_GPU_PLATE_WORKERS` overrides it for measurement.
fn plate_worker_target() -> usize {
    if let Some(value) = std::env::var("RECORDFORGE_EXPORT_GPU_PLATE_WORKERS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (1..=16).contains(value))
    {
        return value;
    }
    super::producer_worker_count().clamp(1, 4)
}

/// Identity frames never reach the compositor, so its crop argument is unused.
const FULL_FRAME: compositor::Crop = compositor::Crop {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
};

/// A content rect covering the whole canvas, for tests that render without
/// canvas framing.
#[cfg(test)]
const FULL_CANVAS: (f64, f64, f64, f64) = (0.0, 0.0, 1920.0, 1080.0);

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
    resource_dir: Option<&Path>,
    shared: &CompositionShared,
    output_cap: Option<super::ExportOutputCap>,
) -> Result<RenderOutcome> {
    let canvas = plan
        .canvas
        .as_ref()
        .ok_or_else(|| gpu_error("GPU export needs a render canvas"))?;
    let width = canvas.width;
    let height = canvas.height;
    let fps = canvas.fps.max(1);
    let (out_width, out_height) = super::capped_output_dimensions(width, height, output_cap);
    let window = CompositionWindow::full(plan);

    // Same input validation the compatibility renderer performs; catching a
    // malformed camera/mask/caption here keeps a broken plan from producing a
    // device-lost fallback instead of a precise error.
    super::captions::validate_captions(&plan.captions)?;
    for overlay in plan.overlays.iter().filter(|overlay| overlay.visible) {
        super::validate_overlay(overlay, project_id, asset_paths, canvas)?;
    }
    for mask in plan.masks.iter().filter(|mask| mask.enabled) {
        super::validate_mask(mask, project_id, asset_paths, canvas)?;
    }

    let started = Instant::now();
    let frame = canvas_frame(plan, canvas, asset_paths, resource_dir, shared)?;
    let plate_runtimes = build_overlay_runtime(
        plan,
        project_id,
        asset_paths,
        settings,
        canvas,
        &frame,
        shared,
    )?
    .unwrap_or_default();
    let (spec, mask_schedules) = compositor_spec(plan, canvas, plate_runtimes.first())?;
    let decode_plan = decode::plan(
        plan,
        project_id,
        asset_paths,
        shared,
        &window,
        width,
        height,
        frame.rect,
        fps,
        decode_hwaccel(),
    )?;
    let plan_ms = started.elapsed().as_millis() as u64;
    if decode_plan.filter.len() > decode::MAX_INLINE_FILTER_LEN {
        return Err(gpu_error(
            "GPU decode graph exceeds the inline filter limit; use the compatibility renderer",
        ));
    }

    let mut compositor = compositor::Compositor::new(width, height, &frame, &spec)?;
    let compositor_ready_ms = started.elapsed().as_millis() as u64;
    let compositor_ms = compositor_ready_ms - plan_ms;

    // Burned-in captions stay in the encode sidecar's libass pass after the GPU
    // raster, which is exactly the compatibility renderer's ordering.
    let caption_dir = if plan.caption_mode == "burn-in" && !plan.captions.is_empty() {
        let dir = std::env::temp_dir().join(format!(
            "rf-gpu-captions-{}-{}",
            project_id,
            uuid::Uuid::new_v4()
        ));
        let script = super::captions::write_burn_in_assets(&dir, &plan.captions, width, height)?;
        Some((dir, script))
    } else {
        None
    };
    let _caption_guard = caption_dir
        .as_ref()
        .map(|(dir, _)| super::TempExportDir(dir.clone()));
    let caption_script = caption_dir.as_ref().map(|(_, script)| script.as_path());

    let mut cameras = build_cameras(
        ffmpeg_path,
        plan,
        project_id,
        asset_paths,
        shared,
        canvas,
        fps,
    )?;
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
        out_width,
        out_height,
        fps,
        caption_script,
    )?;
    let has_audio = encode_process.has_audio();
    let mut decoder = decode::DecodeProcess::spawn(ffmpeg_path, &decode_plan)?;

    info!(
        adapter = compositor.adapter_label(),
        width,
        height,
        out_width,
        out_height,
        fps,
        plan_ms,
        compositor_ms,
        cameras = cameras.len(),
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
    // Generated plates are canvas-sized pixmaps (items/keys) or a union cursor
    // tile, rasterized and converted on the CPU. Measured on the G4 matrix that
    // is the dominant cost for cursor/item plans (~18 ms/frame for the cursor
    // tile alone), so `build_overlay_runtime` prepared one worker per producer
    // thread; frame `i` is owned by worker `i % n` and each feeds a bounded
    // queue so the compose loop never serializes against tiny-skia.
    let mut plate_senders = Vec::with_capacity(plate_runtimes.len());
    let mut plate_receivers = Vec::with_capacity(plate_runtimes.len());
    for _ in 0..plate_runtimes.len() {
        // Two frames per worker: enough to overlap raster with compose, small
        // enough that N workers × 2 planes stays bounded.
        let (sender, receiver) = mpsc::sync_channel::<PlateFrames>(queue_frames(
            "RECORDFORGE_EXPORT_GPU_PLATE_QUEUE",
            2,
        ));
        plate_senders.push(sender);
        plate_receivers.push(receiver);
    }
    let plate_count = plate_runtimes.len();

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

        // One plate frame per output frame, in timeline order. Frame `i` is
        // produced by worker `i % plate_count`, so the consumer round-robins
        // its receivers and never reorders.
        let mut plate_handles = Vec::with_capacity(plate_count);
        for (worker_index, runtime) in plate_runtimes.into_iter().enumerate() {
            let sender = plate_senders[worker_index].clone();
            let cancel = Arc::clone(&cancel);
            let count = plate_count as u64;
            plate_handles.push(scope.spawn(move || -> Result<()> {
                let mut runtime = runtime;
                let cursor_rect = runtime.cursor_rect;
                let items_rect = runtime.items_rect;
                let keys_rect = runtime.keys_rect;
                let cursor_origins = Arc::clone(&runtime.cursor_origins);
                let mut index = worker_index as u64;
                while index < total_frames {
                    if cancel.load(Ordering::Relaxed) {
                        return Ok(());
                    }
                    let (planes, _) = runtime
                        .worker
                        .render_planes(index, fps)
                        .map_err(|error| gpu_error(&error))?;
                    let cursor = planes.cursor.and_then(|data| {
                        plane_frame(
                            cursor_rect,
                            &cursor_origins,
                            super::PlatePlane::Cursor,
                            Arc::new(data),
                            index,
                        )
                    });
                    let items = planes.items.and_then(|data| {
                        plane_frame(
                            items_rect,
                            &cursor_origins,
                            super::PlatePlane::Items,
                            data,
                            index,
                        )
                    });
                    let keys = planes.keys.and_then(|data| {
                        plane_frame(
                            keys_rect,
                            &cursor_origins,
                            super::PlatePlane::Keys,
                            Arc::new(data),
                            index,
                        )
                    });
                    if sender
                        .send(PlateFrames {
                            cursor,
                            items,
                            keys,
                        })
                        .is_err()
                    {
                        // Compose loop finished or failed.
                        return Ok(());
                    }
                    index += count;
                }
                Ok(())
            }));
        }
        drop(plate_senders);

        let mut main_result: Result<()> = Ok(());
        let mut emitted = 0u64;
        let mut sent_frames = 0u64;
        while emitted < total_frames {
            if cancel.load(Ordering::Relaxed) {
                main_result = Err(InternalError::Media("export cancelled".into()).into());
                break;
            }
            let wait_started = Instant::now();
            let decoded = match decode_rx.recv() {
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

            // Generated plates: cursor tile, overlay items, keystroke badges,
            // rendered by the plate workers ahead of this frame.
            let planes = if plate_count > 0 {
                let worker = emitted as usize % plate_count;
                match plate_receivers[worker].recv() {
                    Ok(planes) => planes,
                    Err(_) => {
                        main_result = Err(gpu_error("GPU overlay plate producer stopped"));
                        break;
                    }
                }
            } else {
                PlateFrames::default()
            };
            let planes = (planes.cursor, planes.items, planes.keys);

            let mut camera_frames = Vec::new();
            for camera in &mut cameras {
                if camera.done {
                    continue;
                }
                if output_ms >= camera.end_ms as f64 {
                    camera.process.kill();
                    camera.done = true;
                    continue;
                }
                if output_ms >= camera.start_ms as f64 {
                    match camera.process.read_frame() {
                        Ok(Some(data)) => camera_frames.push(compositor::CameraFrame {
                            index: camera.index,
                            data,
                        }),
                        Ok(None) => camera.done = true,
                        Err(error) => {
                            main_result = Err(error);
                            break;
                        }
                    }
                }
            }
            if main_result.is_err() {
                break;
            }

            // FFmpeg's `between(t,start,end)` is inclusive at both ends, so a
            // mask whose span ends exactly on a frame timestamp still applies
            // there. Match it: the gate's parity check caught the off-by-one
            // frame at a mask end boundary.
            let masks: Vec<usize> = mask_schedules
                .iter()
                .enumerate()
                .filter(|(_, (start, end))| output_ms >= *start as f64 && output_ms <= *end as f64)
                .map(|(index, _)| index)
                .collect();

            let dest = frame.dest_rect(output_ms);
            let side_by_side = frame.side_by_side_at(output_ms);
            let has_layers = planes.0.is_some()
                || planes.1.is_some()
                || planes.2.is_some()
                || !camera_frames.is_empty();
            // Identity-zoom frames never reach a shader unless a layer, mask or
            // canvas treatment needs one.
            let bypass = camera::zoom_transform_is_identity(&state, width, height)
                && frame.is_plain(width, height)
                && !has_layers
                && masks.is_empty()
                && dest == frame.rect;

            let compose_started = Instant::now();
            let screen = if bypass {
                passthrough_frames += 1;
                compositor::Frame::Pass(decoded)
            } else {
                composed_frames += 1;
                compositor::Frame::Compose(compositor::Nv12Frame { data: decoded })
            };
            let request = compositor::FrameRequest {
                crop: if bypass {
                    FULL_FRAME
                } else {
                    zoom_crop(&state, width, height, frame.rect)
                },
                dest,
                radius: frame.radius,
                side_by_side,
                cursor: planes.0,
                items: planes.1,
                keys: planes.2,
                cameras: camera_frames,
                masks,
            };
            let ready = compositor.submit(screen, request);
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
        for camera in &mut cameras {
            camera.process.kill();
        }
        drop(encode_tx);
        drop(decode_rx);
        drop(plate_receivers);
        pipeline_wall = started.elapsed();

        let mut plates: Result<()> = Ok(());
        for handle in plate_handles {
            let result = match handle.join() {
                Ok(result) => result,
                Err(_) => Err(gpu_error("GPU overlay plate producer panicked")),
            };
            if plates.is_ok() {
                plates = result;
            }
        }

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
        main_result.and(read).and(write).and(plates)
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

/// Generated plates for one output frame, produced by a plate worker.
#[derive(Default)]
struct PlateFrames {
    cursor: Option<compositor::PlaneFrame>,
    items: Option<compositor::PlaneFrame>,
    keys: Option<compositor::PlaneFrame>,
}

/// One generated-plate worker: per-frame raster state plus the immutable rects
/// it draws into. `CursorFramePlan` is `!Sync` (the keystroke renderer owns a
/// `RefCell`), so every worker gets its own clone rather than sharing the plan
/// — the same split the compatibility renderer's producer pool uses.
struct OverlayRuntime {
    worker: super::OverlayWorkerState,
    cursor_rect: Option<(u32, u32, u32, u32)>,
    items_rect: Option<(u32, u32, u32, u32)>,
    keys_rect: Option<(u32, u32, u32, u32)>,
    cursor_origins: Arc<Vec<(i32, i32)>>,
}

impl OverlayRuntime {
    /// Build one worker's state from the prepared plan.
    fn from_plan(frame_plan: &super::CursorFramePlan) -> Result<Self> {
        let cursor_rect = frame_plan.plane_rect(super::PlatePlane::Cursor);
        let items_rect = frame_plan.plane_rect(super::PlatePlane::Items);
        let keys_rect = frame_plan.plane_rect(super::PlatePlane::Keys);
        let worker = super::OverlayWorkerState::new(
            frame_plan.renderers.clone(),
            frame_plan.overlay_engine.clone(),
            frame_plan.keystroke_renderer.clone(),
            frame_plan.canvas_width,
            frame_plan.canvas_height,
            Arc::clone(&frame_plan.cursor_origins),
            frame_plan.first_frame_index,
            cursor_rect,
            items_rect,
            keys_rect,
        )
        .map_err(|error| gpu_error(&error))?;
        Ok(Self {
            worker,
            cursor_rect,
            items_rect,
            keys_rect,
            cursor_origins: Arc::clone(&frame_plan.cursor_origins),
        })
    }

    fn plane_rect(&self, kind: super::PlatePlane) -> Option<(u32, u32, u32, u32)> {
        match kind {
            super::PlatePlane::Cursor => self.cursor_rect,
            super::PlatePlane::Items => self.items_rect,
            super::PlatePlane::Keys => self.keys_rect,
        }
    }
}

/// One camera overlay's decode process and absolute display window.
struct CameraRuntime {
    index: usize,
    start_ms: u64,
    end_ms: u64,
    process: decode::DecodeProcess,
    done: bool,
}

impl Drop for CameraRuntime {
    fn drop(&mut self) {
        // Any early return (cancel, sidecar failure, a later setup error) must
        // reap the camera decoder instead of leaving it blocked on its pipe.
        self.process.kill();
    }
}

fn build_overlay_runtime(
    plan: &RenderPlan,
    project_id: &str,
    asset_paths: &HashMap<String, PathBuf>,
    settings: &ExportSettings,
    canvas: &super::cursor::RenderCanvas,
    frame: &compositor::CanvasFrame,
    shared: &CompositionShared,
) -> Result<Option<Vec<OverlayRuntime>>> {
    let has_cursor = plan
        .cursor_effects
        .iter()
        .any(|effect| effect.enabled && effect.end_ms > effect.start_ms);
    let has_items = plan.overlay_render_plan.is_some()
        || !plan.annotations.is_empty()
        || !plan.texts.is_empty()
        || !plan.images.is_empty();
    let has_keys = settings
        .keystroke_overlay
        .as_ref()
        .is_some_and(|overlay| overlay.enabled)
        && !plan.keystrokes.is_empty();
    if !has_cursor && !has_items && !has_keys {
        return Ok(None);
    }
    let screen_windows = side_by_side_screen_windows(plan, frame);
    let renderers = super::build_cursor_renderers(
        plan,
        project_id,
        asset_paths,
        canvas,
        frame.rect,
        screen_windows,
        shared,
    )?;
    let frame_count = plan
        .duration_ms
        .saturating_mul(canvas.fps.max(1) as u64)
        .saturating_add(999)
        .checked_div(1000)
        .unwrap_or(1)
        .max(1);
    let frame_plan = super::prepare_cursor_frame_plan(
        canvas,
        renderers,
        plan,
        settings,
        asset_paths,
        frame.rect,
        shared,
        0,
        frame_count,
    )?;
    let workers = plate_worker_target().min(frame_count as usize).max(1);
    let mut runtimes = Vec::with_capacity(workers);
    for _ in 0..workers {
        runtimes.push(OverlayRuntime::from_plan(&frame_plan)?);
    }
    Ok(Some(runtimes))
}

/// Screen-rect windows the cursor renderer maps through when the side-by-side
/// layout changes mid-timeline. `None` when the slot is constant (or absent).
fn side_by_side_screen_windows(
    plan: &RenderPlan,
    frame: &compositor::CanvasFrame,
) -> Option<Vec<super::cursor::ScreenRectWindow>> {
    let sbs = frame.sbs_rect?;
    let full = frame.rect;
    let mut windows = Vec::new();
    let mut cursor = 0u64;
    for &(start, end) in &frame.sbs_windows {
        if start > cursor {
            windows.push(super::cursor::ScreenRectWindow {
                start_ms: cursor,
                end_ms: start,
                rect: full,
            });
        }
        windows.push(super::cursor::ScreenRectWindow {
            start_ms: start,
            end_ms: end,
            rect: sbs,
        });
        cursor = end;
    }
    if cursor < plan.duration_ms {
        windows.push(super::cursor::ScreenRectWindow {
            start_ms: cursor,
            end_ms: plan.duration_ms,
            rect: full,
        });
    }
    Some(windows)
}

fn plane_frame(
    rect: Option<(u32, u32, u32, u32)>,
    cursor_origins: &[(i32, i32)],
    kind: super::PlatePlane,
    data: Arc<Vec<u8>>,
    emitted: u64,
) -> Option<compositor::PlaneFrame> {
    let (x, y, _, _) = rect?;
    let (dest_x, dest_y) = if kind == super::PlatePlane::Cursor {
        cursor_origins
            .get(emitted as usize)
            .copied()
            .unwrap_or((x as i32, y as i32))
    } else {
        (x as i32, y as i32)
    };
    Some(compositor::PlaneFrame {
        data,
        dest: (dest_x.max(0) as u32, dest_y.max(0) as u32),
    })
}

fn build_cameras(
    ffmpeg_path: &str,
    plan: &RenderPlan,
    project_id: &str,
    asset_paths: &HashMap<String, PathBuf>,
    shared: &CompositionShared,
    canvas: &super::cursor::RenderCanvas,
    fps: u32,
) -> Result<Vec<CameraRuntime>> {
    let mut cameras = Vec::new();
    for overlay in plan.overlays.iter().filter(|overlay| {
        overlay.visible
            && overlay.output_end_ms > overlay.output_start_ms
            && overlay.output_start_ms < plan.duration_ms
            && overlay.output_end_ms > 0
    }) {
        if !overlay.speed.is_finite() || overlay.speed <= 0.0 {
            return Err(InternalError::Media("camera overlay speed is invalid".into()).into());
        }
        let video_delay_s = asset_paths
            .get(&overlay.asset_id)
            .map(|path| shared.probe.video_start_delay_s(path, &overlay.asset_id))
            .unwrap_or(0.0);
        let Some(clamp) = super::camera_window_clamp(
            overlay.output_start_ms,
            overlay.output_end_ms,
            overlay.source_in_ms,
            overlay.source_out_ms,
            overlay.speed,
            canvas.fps as f64,
            0.0,
            plan.duration_ms as f64,
            video_delay_s,
        ) else {
            continue;
        };
        let width = ((overlay.width.round() as u32) / 2 * 2).max(2);
        let height = ((overlay.height.round() as u32) / 2 * 2).max(2);
        let camera_plan = decode::plan_camera(
            project_id,
            overlay,
            asset_paths,
            shared,
            &clamp,
            width,
            height,
            fps,
        )?;
        let process = decode::DecodeProcess::spawn_camera(ffmpeg_path, &camera_plan)?;
        // Index the compositor's camera inventory, not the plan overlay list:
        // hidden/zero-length overlays never reach either.
        cameras.push(CameraRuntime {
            index: cameras.len(),
            start_ms: overlay.output_start_ms,
            end_ms: overlay.output_end_ms,
            process,
            done: false,
        });
    }
    Ok(cameras)
}

/// Where the screen sits on the canvas, the side-by-side slot, how round its
/// corners are, and the background behind it. Mirrors the compatibility
/// renderer's canvas framing so the two paths frame a padded/rounded/shadowed
/// canvas identically.
fn canvas_frame(
    plan: &RenderPlan,
    canvas: &super::cursor::RenderCanvas,
    asset_paths: &HashMap<String, PathBuf>,
    resource_dir: Option<&Path>,
    shared: &CompositionShared,
) -> Result<compositor::CanvasFrame> {
    let source = common_screen_source(&plan.segments, asset_paths, &shared.probe)
        .ok_or_else(|| gpu_error("segments have mixed or unknown source dimensions"))?;
    let sbs_windows = super::merge_ms_windows(
        plan.overlays
            .iter()
            .filter(|overlay| super::overlay_is_side_by_side(overlay, canvas))
            .map(|overlay| (overlay.output_start_ms, overlay.output_end_ms))
            .collect(),
    );
    let uniform_sbs =
        sbs_windows.len() == 1 && sbs_windows[0].0 == 0 && sbs_windows[0].1 >= plan.duration_ms;
    let layout_varies = !sbs_windows.is_empty() && !uniform_sbs;
    // A uniform side-by-side layout decodes straight into the smaller slot —
    // one resample, exactly like the compatibility graph. A varying layout
    // decodes into the full rect and the compositor draws the slot per frame.
    let (rect, sbs_rect, sbs_windows) = if uniform_sbs {
        (
            super::video_screen_rect(canvas, Some(source), true),
            None,
            Vec::new(),
        )
    } else if layout_varies {
        (
            super::video_screen_rect(canvas, Some(source), false),
            Some(super::video_screen_rect(canvas, Some(source), true)),
            sbs_windows,
        )
    } else {
        (
            super::video_screen_rect(canvas, Some(source), false),
            None,
            Vec::new(),
        )
    };
    let varying = sbs_rect.is_some();
    // Same rule as the FFmpeg path: skip the plate when nothing behind the
    // screen can ever be visible.
    let plate = if super::background_plate_unneeded(plan, canvas, rect, uniform_sbs, varying) {
        None
    } else {
        let key = format!(
            "gpu_bg:{}x{}:{}:{}:{}:{}:{}:{}",
            canvas.width,
            canvas.height,
            rect.0.round() as i64,
            rect.1.round() as i64,
            rect.2.round() as i64,
            rect.3.round() as i64,
            canvas.border_radius,
            canvas.background
        );
        shared.plates.get_or_create(&key, || {
            Ok(
                super::prepare_canvas_background_plate(canvas, rect, asset_paths, resource_dir)
                    .map(|path| (path, true)),
            )
        })?
    };
    // A second plate pins the canvas shadow to the smaller slot inside the
    // side-by-side windows (the background art itself is canvas-wide).
    let sbs_plate = match (varying, sbs_rect, canvas.shadow) {
        (true, Some(rect), true) => {
            let key = format!(
                "gpu_bg_sbs:{}x{}:{}:{}:{}:{}",
                canvas.width,
                canvas.height,
                rect.0.round() as i64,
                rect.1.round() as i64,
                rect.2.round() as i64,
                rect.3.round() as i64
            );
            shared.plates.get_or_create(&key, || {
                Ok(
                    super::prepare_canvas_background_plate(canvas, rect, asset_paths, resource_dir)
                        .map(|path| (path, true)),
                )
            })?
        }
        _ => None,
    };
    Ok(compositor::CanvasFrame {
        rect,
        sbs_rect,
        sbs_windows,
        radius: canvas.border_radius,
        background: solid_background(&canvas.background),
        plate,
        sbs_plate,
    })
}

/// Per-export GPU layer inventory plus the absolute windows each privacy mask
/// is active in.
fn compositor_spec(
    plan: &RenderPlan,
    canvas: &super::cursor::RenderCanvas,
    overlay: Option<&OverlayRuntime>,
) -> Result<(compositor::CompositorSpec, Vec<(u64, u64)>)> {
    let mut spec = compositor::CompositorSpec::default();
    if let Some(runtime) = overlay {
        spec.cursor = runtime
            .plane_rect(super::PlatePlane::Cursor)
            .map(|rect| compositor::PlaneInfo { rect });
        spec.items = runtime
            .plane_rect(super::PlatePlane::Items)
            .map(|rect| compositor::PlaneInfo { rect });
        spec.keys = runtime
            .plane_rect(super::PlatePlane::Keys)
            .map(|rect| compositor::PlaneInfo { rect });
    }

    for overlay in plan.overlays.iter().filter(|overlay| {
        overlay.visible
            && overlay.output_end_ms > overlay.output_start_ms
            && overlay.output_start_ms < plan.duration_ms
            && overlay.output_end_ms > 0
    }) {
        let width = ((overlay.width.round() as u32) / 2 * 2).max(2);
        let height = ((overlay.height.round() as u32) / 2 * 2).max(2);
        let x = (overlay.x.round() as i32) / 2 * 2;
        let y = (overlay.y.round() as i32) / 2 * 2;
        let shape = match overlay.shape.as_str() {
            "circle" => compositor::Shape::Circle,
            "rounded" => compositor::Shape::Rounded(
                (overlay.width.min(overlay.height) * 0.12).max(4.0) as f32,
            ),
            _ => compositor::Shape::Rect,
        };
        let border = overlay
            .border_width
            .filter(|value| *value > 0.0)
            .map(|border_width| {
                super::generate_camera_border_png(
                    width,
                    height,
                    &overlay.shape,
                    border_width,
                    overlay.border_color.as_deref(),
                    overlay.border_opacity,
                )
                .map_err(InternalError::Media)
            })
            .transpose()?;
        let shadow = if overlay.shadow_enabled.unwrap_or(false) {
            super::generate_camera_shadow_plate_png(
                canvas.width,
                canvas.height,
                x as f64,
                y as f64,
                width as f64,
                height as f64,
                &overlay.shape,
                overlay.shadow_color.as_deref(),
                overlay.shadow_blur,
                overlay.shadow_offset_x,
                overlay.shadow_offset_y,
            )
            .map(
                |(path, origin_x, origin_y)| -> Result<(Vec<u8>, u32, u32)> {
                    let bytes = std::fs::read(&path).map_err(|error| {
                        InternalError::Storage(format!("read camera shadow: {error}"))
                    })?;
                    let _ = std::fs::remove_file(&path);
                    Ok((bytes, origin_x, origin_y))
                },
            )
            .transpose()?
        } else {
            None
        };
        spec.cameras.push(compositor::CameraConfig {
            size: (width, height),
            dest: (x.max(0) as u32, y.max(0) as u32),
            shape,
            opacity: overlay.opacity.clamp(0.0, 1.0) as f32,
            border,
            shadow,
        });
    }

    let mut mask_schedules = Vec::new();
    for mask in plan.masks.iter().filter(|mask| mask.enabled) {
        if mask.end_ms <= mask.start_ms {
            continue;
        }
        let config = mask_config(mask, canvas)?;
        info!(
            id = %mask.id,
            mode = %mask.mode,
            rect = ?config.rect,
            effect = ?config.mode,
            "gpu export: privacy mask"
        );
        spec.masks.push(config);
        mask_schedules.push((mask.start_ms, mask.end_ms));
    }
    Ok((spec, mask_schedules))
}

/// Even-snapped mask rect and mode, mirroring the compatibility graph's
/// drawbox/blur/pixelate construction.
fn mask_config(
    mask: &super::RenderPlanMask,
    canvas: &super::cursor::RenderCanvas,
) -> Result<compositor::MaskConfig> {
    let x_raw = mask
        .rect
        .x
        .round()
        .clamp(0.0, canvas.width.saturating_sub(1) as f64) as u32;
    let y_raw = mask
        .rect
        .y
        .round()
        .clamp(0.0, canvas.height.saturating_sub(1) as f64) as u32;
    let right_raw = (mask.rect.x + mask.rect.width)
        .round()
        .clamp(1.0, canvas.width as f64) as u32;
    let bottom_raw = (mask.rect.y + mask.rect.height)
        .round()
        .clamp(1.0, canvas.height as f64) as u32;
    let x = (x_raw / 2 * 2).min(canvas.width.saturating_sub(2));
    let y = (y_raw / 2 * 2).min(canvas.height.saturating_sub(2));
    let right = (right_raw.div_ceil(2) * 2).min(canvas.width);
    let bottom = (bottom_raw.div_ceil(2) * 2).min(canvas.height);
    let width = right.saturating_sub(x).max(2);
    let height = bottom.saturating_sub(y).max(2);
    let mode = match mask.mode.as_str() {
        "redact" => compositor::MaskMode::Redact(solid_background(&mask.redact_color)),
        "blur" => {
            let radius = mask.blur_radius.clamp(1.0, 128.0);
            // Radius > 3 takes the compatibility graph's multi-scale branch
            // (downscale → avgblur(3×3) → upscale); smaller radii run avgblur
            // directly on the region.
            if radius > 3.0 {
                compositor::MaskMode::Blur {
                    factor: (radius / 4.0).round().clamp(2.0, 16.0) as f32,
                    multi_scale: true,
                }
            } else {
                compositor::MaskMode::Blur {
                    factor: (radius.round() as u32).max(1) as f32,
                    multi_scale: false,
                }
            }
        }
        "pixelate" => compositor::MaskMode::Pixelate(mask.pixel_size.clamp(2, 128) as f32),
        _ => return Err(InternalError::Media("mask mode is unsupported".into()).into()),
    };
    Ok(compositor::MaskConfig {
        rect: (x, y, width, height),
        mode,
    })
}

/// Parse the canvas background into sRGB floats. Gradients and images arrive
/// through the plate, so this only has to handle the solid forms the plate
/// generator short-circuits on (`#rgb`, `#rrggbb`, `rgb()`, `rgba()`).
fn solid_background(value: &str) -> [f32; 3] {
    let trimmed = value.trim();
    if trimmed.starts_with("rgb") {
        if let Some(start) = trimmed.find('(') {
            if let Some(end) = trimmed[start..].find(')') {
                let parts: Vec<f32> = trimmed[start + 1..start + end]
                    .split(',')
                    .filter_map(|part| part.trim().parse::<f32>().ok())
                    .collect();
                if parts.len() >= 3 {
                    return [
                        (parts[0] / 255.0).clamp(0.0, 1.0),
                        (parts[1] / 255.0).clamp(0.0, 1.0),
                        (parts[2] / 255.0).clamp(0.0, 1.0),
                    ];
                }
            }
        }
    }
    let color = super::parse_color_hex(&super::safe_filter_color(trimmed), 1.0);
    [color.red(), color.green(), color.blue()]
}

/// Integer source rect the GPU samples for one frame. Uses the same
/// `zoompan_integer_crop` math the piecewise-zoom path builds filters from, so
/// cursor registration and the sampled region stay consistent between
/// renderers; widths/heights are snapped to the NV12 chroma grid.
///
/// `content` is the decoded screen rect: the decode pass fits the screen into
/// that rect, and the compatibility graph zooms the *fitted* stream (scale to
/// `screen_w`×`screen_h`, then `zoompan`), so the crop space is that rect.
fn zoom_crop(
    state: &ZoomTransformState,
    width: u32,
    height: u32,
    content: (f64, f64, f64, f64),
) -> compositor::Crop {
    let content_w = content.2.max(2.0);
    let content_h = content.3.max(2.0);
    let (x, y, w, h) = camera::zoompan_integer_crop(
        (state.crop_x, state.crop_y, state.crop_w, state.crop_h),
        content_w,
        content_h,
        width as f64,
        height as f64,
        1,
        1,
    );
    let w = (w.min(content_w as u32).max(2)) & !1u32;
    let h = (h.min(content_h as u32).max(2)) & !1u32;
    compositor::Crop {
        x: x.min((content_w as u32).saturating_sub(w)),
        y: y.min((content_h as u32).saturating_sub(h)),
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
    fn canvas_framing_is_gpu_compatible() {
        // G1: padding, corner radius, shadow and background treatments are
        // composited by the shader, so they no longer force the FFmpeg path.
        let mut canvas = gated_canvas();
        canvas.padding = 48;
        assert!(limitations(&plan_with_canvas(canvas)).is_empty());

        let mut canvas = gated_canvas();
        canvas.border_radius = 24;
        assert!(limitations(&plan_with_canvas(canvas)).is_empty());

        let mut canvas = gated_canvas();
        canvas.shadow = true;
        canvas.background_blur = Some(20.0);
        canvas.background_dim = Some(0.4);
        assert!(limitations(&plan_with_canvas(canvas)).is_empty());
    }

    #[test]
    fn g2_layers_are_gpu_compatible() {
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
        plan.masks.push(crate::exports::RenderPlanMask {
            id: "mask".into(),
            asset_id: None,
            start_ms: 0,
            end_ms: 1_000,
            mode: "pixelate".into(),
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
        plan.overlays.push(
            serde_json::from_value(serde_json::json!({
                "assetId": "webcam",
                "sourceInMs": 0,
                "sourceOutMs": 3_000,
                "outputStartMs": 0,
                "outputEndMs": 3_000,
                "x": 1_400.0,
                "y": 700.0,
                "width": 400.0,
                "height": 300.0,
                "shape": "rounded",
                "visible": true,
            }))
            .expect("camera overlay"),
        );
        plan.keystrokes
            .push(crate::capture::keystrokes::KeystrokeEvent {
                t_ms: 500,
                key: "a".into(),
                modifiers: Vec::new(),
            });
        assert!(limitations(&plan).is_empty(), "{:?}", limitations(&plan));
    }

    #[test]
    fn g3_captions_chapters_and_hevc_are_gpu_compatible() {
        let mut plan = plan_with_canvas(gated_canvas());
        plan.captions.push(crate::exports::RenderPlanCaption {
            id: "caption".into(),
            text: "Hello".into(),
            start_ms: 0,
            end_ms: 1_000,
            style: "default".into(),
            placement: "bottom".into(),
            safe_area_margin: 48,
            layout: None,
        });
        plan.chapters.push(crate::exports::RenderPlanChapter {
            id: "chapter".into(),
            title: "Intro".into(),
            start_ms: 0,
            end_ms: 1_000,
        });
        let mut export = settings();
        export.codec = "hevc".into();
        let shared = CompositionShared::new(None);
        let assets: HashMap<String, PathBuf> = HashMap::new();
        let reasons = plan_limitations(&plan, &export, &shared, &assets);
        assert!(reasons.is_empty(), "{reasons:?}");
    }

    #[test]
    fn keystrokes_with_captions_stay_on_the_ffmpeg_renderer() {
        // The compatibility graph draws badges above captions; the hybrid GPU
        // pipeline only composites them below the encode-side libass pass.
        let mut plan = plan_with_canvas(gated_canvas());
        plan.captions.push(crate::exports::RenderPlanCaption {
            id: "caption".into(),
            text: "Hello".into(),
            start_ms: 0,
            end_ms: 1_000,
            style: "default".into(),
            placement: "bottom".into(),
            safe_area_margin: 48,
            layout: None,
        });
        plan.keystrokes
            .push(crate::capture::keystrokes::KeystrokeEvent {
                t_ms: 500,
                key: "a".into(),
                modifiers: Vec::new(),
            });
        let mut export = settings();
        export.keystroke_overlay = Some(
            serde_json::from_value(serde_json::json!({
                "enabled": true,
            }))
            .expect("keystroke overlay"),
        );
        let reasons = plan_limitations(
            &plan,
            &export,
            &CompositionShared::new(None),
            &HashMap::new(),
        );
        assert!(
            reasons.iter().any(|reason| reason.contains("keystroke")),
            "{reasons:?}"
        );
    }

    #[test]
    fn blur_privacy_masks_stay_on_the_ffmpeg_renderer() {
        // Redact and pixelate are shader-exact; the scaled-average blur is an
        // approximation that measured below the parity floor (G4).
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
            blur_radius: 24.0,
            pixel_size: 8,
            redact_color: "#000000".into(),
            enabled: true,
        });
        let reasons = limitations(&plan);
        assert!(
            reasons.iter().any(|reason| reason.contains("blur")),
            "{reasons:?}"
        );

        // A disabled blur mask is not a limitation.
        plan.masks[0].enabled = false;
        assert!(limitations(&plan).is_empty());
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
    fn a_letterboxed_screenshot_is_fitted_into_the_canvas() {
        // A 16:9 source on a square canvas is centred by the shader instead of
        // falling back to FFmpeg.
        let mut canvas = gated_canvas();
        canvas.width = 1080;
        canvas.height = 1080;
        assert!(limitations(&plan_with_canvas(canvas)).is_empty());

        let canvas = super::super::cursor::RenderCanvas {
            padding: 48,
            ..{
                let mut canvas = gated_canvas();
                canvas.width = 1080;
                canvas.height = 1080;
                canvas
            }
        };
        let plan = plan_with_canvas(canvas.clone());
        let shared = CompositionShared::new(None);
        let assets: HashMap<String, PathBuf> = HashMap::new();
        let frame = canvas_frame(&plan, &canvas, &assets, None, &shared).expect("canvas frame");
        // Content is 16:9 inside a 1080 - 2*48 square, vertically centred.
        assert!((frame.rect.2 - 984.0).abs() < 2.0, "{:?}", frame.rect);
        assert!((frame.rect.3 - 553.5).abs() < 2.0, "{:?}", frame.rect);
        assert!((frame.rect.0 - 48.0).abs() < 1.0, "{:?}", frame.rect);
        assert!(frame.rect.1 > 48.0, "{:?}", frame.rect);
        assert!(!frame.is_plain(canvas.width, canvas.height));
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
    fn g5_auto_uses_the_gpu_renderer_by_default() {
        // The default must be on now that the G4 parity matrix passed; the env
        // var is a plain opt-out for support and A/B runs.
        assert!(auto_gpu_enabled(None));
        for value in ["1", "true", "on", "yes", "TRUE"] {
            assert!(auto_gpu_enabled(Some(value)), "{value}");
        }
        for value in ["0", "false", "off", "0 "] {
            assert!(!auto_gpu_enabled(Some(value)), "{value}");
        }
    }

    #[test]
    fn auto_keeps_passthrough_only_exports_on_ffmpeg() {
        // A plain full-canvas plan has nothing to composite, so the GPU adds
        // only the cross-process copy. Any layer/zoom/canvas treatment flips it.
        let plan = plan_with_canvas(gated_canvas());
        assert!(plan_is_passthrough_only(&plan, &settings()));

        let mut zoomed = plan.clone();
        zoomed.zoom_segments.push(
            serde_json::from_value(serde_json::json!({
                "id": "zoom",
                "startMs": 0,
                "endMs": 1_000,
                "target": { "x": 0.0, "y": 0.0, "width": 960.0, "height": 540.0 },
                "scale": 1.5
            }))
            .expect("zoom segment"),
        );
        assert!(!plan_is_passthrough_only(&zoomed, &settings()));

        let mut padded = plan.clone();
        padded.canvas.as_mut().expect("canvas").padding = 24;
        assert!(!plan_is_passthrough_only(&padded, &settings()));

        let mut masked = plan;
        masked.masks.push(crate::exports::RenderPlanMask {
            id: "mask".into(),
            asset_id: None,
            start_ms: 0,
            end_ms: 1_000,
            mode: "redact".into(),
            rect: crate::exports::RenderCropFloat {
                x: 0.0,
                y: 0.0,
                width: 32.0,
                height: 32.0,
            },
            blur_radius: 8.0,
            pixel_size: 8,
            redact_color: "#000000".into(),
            enabled: true,
        });
        assert!(!plan_is_passthrough_only(&masked, &settings()));
    }

    #[test]
    fn auto_falls_back_to_compatibility_after_repeated_gpu_failures() {
        assert!(auto_gpu_blocked(None, 0).is_none());
        assert!(auto_gpu_blocked(None, GPU_FAILURE_GATE_THRESHOLD - 1).is_none());
        let reason = auto_gpu_blocked(None, GPU_FAILURE_GATE_THRESHOLD)
            .expect("gate reason at the threshold");
        assert!(reason.contains("repeated GPU failures"), "{reason}");
        // The env override still wins with a clear reason.
        let reason = auto_gpu_blocked(Some("0"), 0).expect("env opt-out reason");
        assert!(reason.contains("RECORDFORGE_EXPORT_GPU"), "{reason}");
    }

    #[test]
    fn the_failure_gate_counts_consecutive_failures_and_resets_on_success() {
        note_gpu_success();
        for _ in 0..GPU_FAILURE_GATE_THRESHOLD - 1 {
            note_gpu_failure();
        }
        assert!(!failure_gate_tripped(
            GPU_CONSECUTIVE_FAILURES.load(Ordering::Relaxed)
        ));
        // A success in between must clear the count.
        note_gpu_success();
        note_gpu_failure();
        assert!(!failure_gate_tripped(
            GPU_CONSECUTIVE_FAILURES.load(Ordering::Relaxed)
        ));
        note_gpu_failure();
        note_gpu_failure();
        assert!(failure_gate_tripped(
            GPU_CONSECUTIVE_FAILURES.load(Ordering::Relaxed)
        ));
        note_gpu_success();
        assert!(!failure_gate_tripped(
            GPU_CONSECUTIVE_FAILURES.load(Ordering::Relaxed)
        ));
    }

    #[test]
    fn explicit_gpu_degrades_with_a_reason_when_the_plan_is_out_of_scope() {
        let mut plan = plan_with_canvas(gated_canvas());
        plan.gaps.push(crate::exports::RenderPlanGap {
            start_ms: 1_000,
            end_ms: 2_000,
        });
        let choice = resolve_renderer(
            "gpu",
            &plan,
            &settings(),
            &CompositionShared::new(None),
            &HashMap::new(),
        );
        assert_eq!(choice.renderer, ExportRenderer::Compatibility);
        assert!(choice.reason.unwrap_or_default().contains("gap"));
    }

    #[test]
    fn a_selected_range_plan_is_gpu_compatible() {
        // Selected-range exports arrive as a zero-based plan with source
        // offsets; the GPU pass renders that plan like any other.
        let mut plan = plan_with_canvas(gated_canvas());
        plan.duration_ms = 3_000;
        plan.segments[0].source_in_ms = 10_000;
        plan.segments[0].source_out_ms = 13_000;
        assert!(limitations(&plan).is_empty());
    }

    #[test]
    fn g2_g3_end_to_end_render_composites_camera_masks_and_captions() {
        let Ok(ffmpeg) = crate::media::resolve_executable("ffmpeg") else {
            return;
        };
        let Ok(ffprobe) = crate::media::resolve_executable("ffprobe") else {
            return;
        };
        let ffmpeg = ffmpeg.to_string_lossy().to_string();
        let shared = CompositionShared::new(Some(&ffprobe));
        let dir = std::env::temp_dir().join(format!("rf-gpu-g2g3-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let screen = dir.join("screen.mp4");
        let camera = dir.join("camera.mp4");
        let audio = dir.join("audio.m4a");
        for (path, color) in [(&screen, "blue"), (&camera, "red")] {
            let status = crate::process::create_command(&ffmpeg)
                .args([
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    &format!("color=c={color}:s=320x240:r=10"),
                    "-t",
                    "1",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-an",
                ])
                .arg(path)
                .status()
                .expect("generate fixture");
            assert!(status.success(), "fixture generation failed");
        }
        let status = crate::process::create_command(&ffmpeg)
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                "-c:a",
                "aac",
            ])
            .arg(&audio)
            .output()
            .expect("generate audio fixture");
        assert!(status.status.success(), "audio fixture generation failed");

        let mut canvas = gated_canvas();
        canvas.width = 320;
        canvas.height = 240;
        canvas.fps = 10;
        let mut plan = plan_with_canvas(canvas);
        plan.duration_ms = 1_000;
        plan.segments[0].asset_id = "screen".into();
        plan.segments[0].source_out_ms = 1_000;
        plan.segments[0].output_end_ms = 1_000;
        plan.segments[0].source_width = Some(320);
        plan.segments[0].source_height = Some(240);
        plan.overlays.push(
            serde_json::from_value(serde_json::json!({
                "assetId": "camera",
                "sourceInMs": 0,
                "sourceOutMs": 1_000,
                "outputStartMs": 0,
                "outputEndMs": 1_000,
                "x": 160.0,
                "y": 120.0,
                "width": 160.0,
                "height": 120.0,
                "shape": "rounded",
                "visible": true,
                "preset": "side-by-side",
                "borderWidth": 4.0,
                "borderColor": "#ffffff",
                "borderOpacity": 1.0,
                "shadowEnabled": true,
                "shadowBlur": 12.0
            }))
            .expect("camera overlay"),
        );
        plan.masks.push(crate::exports::RenderPlanMask {
            id: "mask".into(),
            asset_id: None,
            start_ms: 0,
            end_ms: 1_000,
            mode: "redact".into(),
            rect: crate::exports::RenderCropFloat {
                x: 0.0,
                y: 0.0,
                width: 64.0,
                height: 48.0,
            },
            blur_radius: 12.0,
            pixel_size: 8,
            redact_color: "#000000".into(),
            enabled: true,
        });
        plan.captions.push(crate::exports::RenderPlanCaption {
            id: "caption".into(),
            text: "Hello".into(),
            start_ms: 0,
            end_ms: 1_000,
            style: "default".into(),
            placement: "bottom".into(),
            safe_area_margin: 12,
            layout: None,
        });
        plan.chapters.push(crate::exports::RenderPlanChapter {
            id: "chapter".into(),
            title: "Intro".into(),
            start_ms: 0,
            end_ms: 1_000,
        });
        plan.audio = Some(crate::exports::RenderPlanAudio {
            asset_id: "audio".into(),
            stream_index: Some(0),
            role: None,
            muted: false,
            volume: 1.0,
            segments: vec![crate::exports::RenderSegment {
                asset_id: "audio".into(),
                stream_index: Some(0),
                volume: None,
                fade_in_ms: None,
                fade_out_ms: None,
                volume_keyframes: None,
                audio_filter: None,
                speed: 1.0,
                source_in_ms: 0,
                source_out_ms: 1_000,
                output_start_ms: 0,
                output_end_ms: 1_000,
                source_width: None,
                source_height: None,
            }],
        });

        let mut asset_paths = HashMap::new();
        asset_paths.insert("screen".to_string(), screen);
        asset_paths.insert("camera".to_string(), camera);
        asset_paths.insert("audio".to_string(), audio);

        let mut export = settings();
        export.codec = "h264".into();
        export.caption_mode = "burn-in".into();
        export.chapter_mode = "embed".into();
        let choice = resolve_renderer("gpu", &plan, &export, &shared, &asset_paths);
        assert_eq!(choice.renderer, ExportRenderer::Gpu, "{:?}", choice.reason);

        let output = dir.join("out.mp4");
        let result = render_timeline_on_gpu(
            &ffmpeg,
            &output,
            &plan,
            "gpu-g2g3",
            &asset_paths,
            &export,
            ExportEncoder::Software,
            Arc::new(AtomicBool::new(false)),
            &|_| {},
            None,
            &shared,
            None,
        );
        match result {
            Ok(outcome) => {
                assert!(outcome.has_audio);
                super::super::validate_export_output_with_dims(
                    &ffprobe,
                    &output,
                    &plan,
                    &export,
                    true,
                    Some((320, 240)),
                )
                .expect("validated GPU deliverable");

                // Layer order and the privacy mask, read back from the encode:
                // blue screen, red camera bubble on top, black redact rect.
                let frame = crate::process::create_command(&ffmpeg)
                    .args(["-loglevel", "error", "-ss", "0.5", "-i"])
                    .arg(&output)
                    .args([
                        "-frames:v",
                        "1",
                        "-f",
                        "rawvideo",
                        "-pix_fmt",
                        "rgb24",
                        "pipe:1",
                    ])
                    .output()
                    .expect("decode one output frame");
                assert!(frame.status.success(), "frame readback failed");
                assert_eq!(frame.stdout.len(), 320 * 240 * 3);
                let pixel = |x: usize, y: usize| {
                    let offset = (y * 320 + x) * 3;
                    (
                        frame.stdout[offset],
                        frame.stdout[offset + 1],
                        frame.stdout[offset + 2],
                    )
                };
                let (r, g, b) = pixel(200, 100);
                assert!(b > 120 && b > r + 40, "screen pixel {r},{g},{b}");
                let (r, g, b) = pixel(240, 180);
                assert!(r > 120 && r > b + 40, "camera pixel {r},{g},{b}");
                let (r, g, b) = pixel(16, 16);
                assert!(r < 40 && g < 40 && b < 40, "mask pixel {r},{g},{b}");

                // Burned-in captions are the encode sidecar's libass pass;
                // white glyph pixels must exist in the lower third.
                let white = (160..240)
                    .flat_map(|y| (0..320).map(move |x| (x, y)))
                    .filter(|(x, y)| {
                        let (r, g, b) = pixel(*x, *y);
                        r > 200 && g > 200 && b > 200
                    })
                    .count();
                assert!(white > 10, "no caption glyph pixels ({white})");

                // Chapters are embedded by the encode sidecar's ffmetadata
                // input, not dropped on the floor.
                let chapters = crate::process::create_command(&ffprobe)
                    .args(["-v", "error", "-show_chapters", "-of", "csv=p=0"])
                    .arg(&output)
                    .output()
                    .expect("ffprobe chapters");
                assert!(
                    String::from_utf8_lossy(&chapters.stdout).contains("Intro"),
                    "chapter missing: {}",
                    String::from_utf8_lossy(&chapters.stdout)
                );

                // HEVC and the license output cap ride the same pipeline.
                let mut hevc = export.clone();
                hevc.codec = "hevc".into();
                let hevc_out = dir.join("out_hevc.mp4");
                render_timeline_on_gpu(
                    &ffmpeg,
                    &hevc_out,
                    &plan,
                    "gpu-g2g3",
                    &asset_paths,
                    &hevc,
                    ExportEncoder::Software,
                    Arc::new(AtomicBool::new(false)),
                    &|_| {},
                    None,
                    &shared,
                    None,
                )
                .expect("HEVC GPU render");
                super::super::validate_export_output_with_dims(
                    &ffprobe,
                    &hevc_out,
                    &plan,
                    &hevc,
                    true,
                    Some((320, 240)),
                )
                .expect("validated HEVC deliverable");

                let capped_out = dir.join("out_capped.mp4");
                render_timeline_on_gpu(
                    &ffmpeg,
                    &capped_out,
                    &plan,
                    "gpu-g2g3",
                    &asset_paths,
                    &export,
                    ExportEncoder::Software,
                    Arc::new(AtomicBool::new(false)),
                    &|_| {},
                    None,
                    &shared,
                    Some(super::super::ExportOutputCap {
                        max_width: 160,
                        max_height: 120,
                    }),
                )
                .expect("capped GPU render");
                super::super::validate_export_output_with_dims(
                    &ffprobe,
                    &capped_out,
                    &plan,
                    &export,
                    true,
                    Some((160, 120)),
                )
                .expect("validated capped deliverable");
            }
            Err(error) => {
                let text = error.to_string();
                if text.contains("no GPU adapter") || text.contains("software rasterizer") {
                    // CI/headless machines skip the hardware leg.
                    return;
                }
                panic!("GPU render failed: {error}");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn g2_varying_side_by_side_windows_switch_the_screen_rect() {
        let Ok(ffmpeg) = crate::media::resolve_executable("ffmpeg") else {
            return;
        };
        let Ok(ffprobe) = crate::media::resolve_executable("ffprobe") else {
            return;
        };
        let ffmpeg = ffmpeg.to_string_lossy().to_string();
        let shared = CompositionShared::new(Some(&ffprobe));
        let dir = std::env::temp_dir().join(format!("rf-gpu-sbs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let screen = dir.join("screen.mp4");
        let camera = dir.join("camera.mp4");
        for (path, color) in [(&screen, "blue"), (&camera, "red")] {
            let status = crate::process::create_command(&ffmpeg)
                .args([
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    &format!("color=c={color}:s=320x240:r=10"),
                    "-t",
                    "1",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-an",
                ])
                .arg(path)
                .status()
                .expect("generate fixture");
            assert!(status.success(), "fixture generation failed");
        }

        let mut canvas = gated_canvas();
        canvas.width = 320;
        canvas.height = 240;
        canvas.fps = 10;
        let mut plan = plan_with_canvas(canvas);
        plan.duration_ms = 1_000;
        plan.segments[0].asset_id = "screen".into();
        plan.segments[0].source_out_ms = 1_000;
        plan.segments[0].output_end_ms = 1_000;
        plan.segments[0].source_width = Some(320);
        plan.segments[0].source_height = Some(240);
        // The camera slot starts halfway through: before it the screen fills
        // the canvas, after it the screen shrinks to the side-by-side rect.
        plan.overlays.push(
            serde_json::from_value(serde_json::json!({
                "assetId": "camera",
                "sourceInMs": 500,
                "sourceOutMs": 1_000,
                "outputStartMs": 500,
                "outputEndMs": 1_000,
                "x": 0.0,
                "y": 120.0,
                "width": 160.0,
                "height": 120.0,
                "shape": "rectangle",
                "visible": true,
                "preset": "side-by-side"
            }))
            .expect("camera overlay"),
        );
        let mut asset_paths = HashMap::new();
        asset_paths.insert("screen".to_string(), screen);
        asset_paths.insert("camera".to_string(), camera);
        let export = settings();
        assert_eq!(
            resolve_renderer("gpu", &plan, &export, &shared, &asset_paths).renderer,
            ExportRenderer::Gpu
        );

        let output = dir.join("out.mp4");
        let result = render_timeline_on_gpu(
            &ffmpeg,
            &output,
            &plan,
            "gpu-sbs",
            &asset_paths,
            &export,
            ExportEncoder::Software,
            Arc::new(AtomicBool::new(false)),
            &|_| {},
            None,
            &shared,
            None,
        );
        let Err(error) = result else {
            let frame_at = |seconds: &str| {
                let output = crate::process::create_command(&ffmpeg)
                    .args(["-loglevel", "error", "-ss", seconds, "-i"])
                    .arg(&output)
                    .args([
                        "-frames:v",
                        "1",
                        "-f",
                        "rawvideo",
                        "-pix_fmt",
                        "rgb24",
                        "pipe:1",
                    ])
                    .output()
                    .expect("decode frame");
                assert!(output.status.success());
                output.stdout
            };
            let pixel = |data: &[u8], x: usize, y: usize| {
                let offset = (y * 320 + x) * 3;
                (data[offset], data[offset + 1], data[offset + 2])
            };
            let early = frame_at("0.2");
            let (r, g, b) = pixel(&early, 300, 20);
            assert!(b > 120 && b > r + 40, "full-screen pixel {r},{g},{b}");
            let late = frame_at("0.8");
            let (r, g, b) = pixel(&late, 200, 100);
            assert!(b > 120 && b > r + 40, "slot pixel {r},{g},{b}");
            let (r, g, b) = pixel(&late, 300, 20);
            assert!(r < 40 && g < 40 && b < 40, "outside-slot pixel {r},{g},{b}");
            let (r, g, b) = pixel(&late, 80, 180);
            assert!(r > 120 && r > b + 40, "camera pixel {r},{g},{b}");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        };
        let text = error.to_string();
        if !text.contains("no GPU adapter") && !text.contains("software rasterizer") {
            panic!("GPU render failed: {error}");
        }
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
        let crop = zoom_crop(&state, 1920, 1080, FULL_CANVAS);
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
        let crop = zoom_crop(&state, 1920, 1080, FULL_CANVAS);
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
                zoom_crop(&state, 1920, 1080, FULL_CANVAS),
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
