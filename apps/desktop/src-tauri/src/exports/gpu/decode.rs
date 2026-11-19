//! Decode sidecar for the GPU compositor.
//!
//! The compatibility renderer builds one FFmpeg `filter_complex` that trims,
//! retimes, fits and pads every segment and then hands the composed canvas to
//! the encoder. The GPU path keeps the *decode* half of that graph and drops the
//! composite half: FFmpeg still produces the frame-exact canvas-sized stream
//! (same `trim`/`setpts`/`fps`/`tpad`/`scale`/`pad` chain, so seams and
//! timestamps match), but it emits raw NV12 on stdout instead of encoding.
//! wgpu then owns zoom, colour and the final NV12 pack.

use std::collections::HashMap;
use std::io::{BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, ChildStdout, Stdio};
use std::sync::{mpsc, Arc, Mutex};

use crate::errors::{InternalError, Result};
use tracing::warn;

use super::super::{
    collect_input_assets, corrected_source_in_s, fmt_secs, plan_segment_inputs,
    resolve_video_stream_specifier, validate_segment_known, window_frame_span, CameraTrack,
    CompositionShared, CompositionWindow, RenderPlan, RenderPlanOverlay, RenderSegment, SegmentJob,
    SourceRequest, SEEK_PREROLL_S, SEEK_TAIL_MARGIN_S,
};
use super::gpu_error;

/// Highest `filter_complex` length passed on the command line. The compatibility
/// graph goes through a temp script; a GPU pass stays inline so no temp file can
/// outlive an aborted render. Plans past this limit stay on FFmpeg.
pub(super) const MAX_INLINE_FILTER_LEN: usize = 16_000;

/// One FFmpeg input of the decode pass.
pub(super) struct DecodeInput {
    pub path: PathBuf,
    pub seek_s: Option<f64>,
    pub duration_s: Option<f64>,
    pub hwaccel: bool,
}

/// A fully planned decode pass: inputs, the `filter_complex` that produces the
/// canvas-sized stream, and the output geometry to read back.
pub(super) struct DecodePlan {
    pub inputs: Vec<DecodeInput>,
    pub filter: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub frame_count: u64,
}

/// Plan the decode pass for one full-timeline window.
///
/// `content` is the fitted screen rect on the canvas: every segment is scaled
/// into it and padded out to the canvas at its origin, exactly like the
/// compatibility graph's `scale`→`pad` chain, so the compositor receives a
/// canvas-sized frame with the picture already in place.
#[allow(clippy::too_many_arguments)]
pub(super) fn plan(
    plan: &RenderPlan,
    project_id: &str,
    asset_paths: &HashMap<String, PathBuf>,
    shared: &CompositionShared,
    window: &CompositionWindow,
    width: u32,
    height: u32,
    content: (f64, f64, f64, f64),
    fps: u32,
    hwaccel: bool,
) -> Result<DecodePlan> {
    let win_start_ms = window.start_ms();
    let win_end_ms = window.end_ms();

    // Same per-pass source planning as `render_composition_window`: each
    // intersecting segment becomes a `SourceRequest` cut to the window, then
    // forward-adjacent requests on one asset coalesce into a single seeked
    // input.
    let mut segment_jobs: Vec<SegmentJob> = Vec::new();
    let mut segment_requests: Vec<SourceRequest> = Vec::new();
    for (index, segment) in plan.segments.iter().enumerate() {
        let segment_start = segment.output_start_ms as f64;
        let segment_end = segment.output_end_ms as f64;
        let clamped_start = segment_start.clamp(win_start_ms, win_end_ms);
        let clamped_end = segment_end.clamp(win_start_ms, win_end_ms);
        if clamped_end <= clamped_start {
            continue;
        }
        let cut_in_s = (clamped_start - segment_start) / 1000.0;
        let video_delay_s = asset_paths
            .get(&segment.asset_id)
            .map(|path| shared.probe.video_start_delay_s(path, &segment.asset_id))
            .unwrap_or(0.0);
        let source_in_s =
            corrected_source_in_s(segment.source_in_ms, cut_in_s, segment.speed, video_delay_s);
        let base_s = segment.source_in_ms as f64 / 1000.0;
        let delay_s = (video_delay_s - base_s).max(0.0);
        let source_out_s = (base_s
            + delay_s
            + (cut_in_s + (clamped_end - clamped_start) / 1000.0) * segment.speed
            + 1.0 / (fps.max(1) as f64))
            .min(segment.source_out_ms as f64 / 1000.0);
        segment_jobs.push(SegmentJob {
            segment_index: index,
            request_index: segment_requests.len(),
            clamped_start,
            clamped_end,
            cut_in_s,
        });
        segment_requests.push(SourceRequest {
            asset_id: segment.asset_id.clone(),
            stream_index: segment.stream_index,
            source_in_s,
            source_out_s,
        });
    }

    let seek_plan = plan_segment_inputs(&segment_requests);
    let mut inputs: Vec<DecodeInput> = Vec::new();
    // Segment request index → (ffmpeg input index, input seek seconds).
    let mut segment_inputs: Vec<(usize, f64)> = Vec::with_capacity(segment_requests.len());

    match &seek_plan {
        Some(planned) => {
            for source in &planned.inputs {
                let path = asset_paths.get(&source.asset_id).cloned().ok_or_else(|| {
                    InternalError::Media("render plan references an unknown asset".into())
                })?;
                inputs.push(DecodeInput {
                    path,
                    seek_s: Some(source.seek_s),
                    duration_s: Some(source.end_s - source.seek_s + SEEK_TAIL_MARGIN_S),
                    hwaccel,
                });
            }
            for window_index in &planned.assignment {
                segment_inputs.push((*window_index, planned.inputs[*window_index].seek_s));
            }
        }
        None => {
            // Legacy layout: one whole-asset input per asset, no seek.
            let mut asset_indices: HashMap<String, usize> = HashMap::new();
            for (asset_id, path) in collect_input_assets(plan, asset_paths)? {
                if asset_indices.contains_key(&asset_id) {
                    continue;
                }
                asset_indices.insert(asset_id, inputs.len());
                inputs.push(DecodeInput {
                    path,
                    seek_s: None,
                    duration_s: None,
                    hwaccel,
                });
            }
            for request in &segment_requests {
                let index = *asset_indices.get(&request.asset_id).ok_or_else(|| {
                    InternalError::Media("render plan references an unknown asset".into())
                })?;
                segment_inputs.push((index, 0.0));
            }
        }
    }

    let mut filters: Vec<String> = Vec::new();
    // Screen pieces in decode order: (first frame, last frame, filter label,
    // is_gap). Sorted before the concat so a mid-timeline gap lands between the
    // right segments.
    let mut pieces: Vec<(u64, u64, String, bool)> = Vec::new();
    for job in &segment_jobs {
        // Same frame-grid snapping as the compatibility renderer, so both
        // paths emit the identical number of frames per segment.
        let Some((start_frame, end_frame)) =
            window_frame_span(window, fps as f64, job.clamped_start, job.clamped_end)
        else {
            continue;
        };
        let frames = end_frame - start_frame;
        if frames == 0 {
            continue;
        }
        let segment = &plan.segments[job.segment_index];
        validate_segment_known(segment, project_id, asset_paths)?;
        let (input_index, seek_s) = segment_inputs[job.request_index];
        let asset_path = asset_paths.get(&segment.asset_id).ok_or_else(|| {
            InternalError::Media("render plan references an unknown asset".into())
        })?;
        let input = resolve_video_stream_specifier(
            &shared.probe,
            asset_path,
            &segment.asset_id,
            input_index,
            segment.stream_index,
        )?;
        let label = format!("screen{}", job.segment_index);
        filters.push(segment_filter(
            &input,
            segment,
            &segment_requests[job.request_index],
            seek_s,
            job.cut_in_s,
            width,
            height,
            content,
            fps,
            frames,
            &label,
        ));
        pieces.push((start_frame, end_frame, format!("[{label}]"), false));
    }

    // Timeline gaps (F2): every uncovered span becomes a solid black source, so
    // a b-roll / custom-track plan keeps the GPU path instead of falling back to
    // FFmpeg. The compositor reports these frames as `has_screen = 0` and paints
    // only the background plate.
    let push_black = |filters: &mut Vec<String>,
                      pieces: &mut Vec<(u64, u64, String, bool)>,
                      start_frame: u64,
                      end_frame: u64,
                      label: String| {
        let frames = end_frame - start_frame;
        if frames == 0 {
            return;
        }
        filters.push(format!(
            "color=c=black:s={width}x{height}:r={fps}:d={},format=nv12,trim=end_frame={frames},setpts=PTS-STARTPTS[{label}]",
            // One spare frame of headroom so float rounding in `d` can never
            // produce a short block; the trim pins the exact count.
            fmt_secs((frames + 1) as f64 / fps.max(1) as f64),
        ));
        pieces.push((start_frame, end_frame, format!("[{label}]"), true));
    };
    for (gap_index, gap) in plan.gaps.iter().enumerate() {
        // A trailing gap is the freeze-frame overlay tail, not a hole: the
        // `tpad=clone` hold below repeats the last screen frame across it.
        if gap.end_ms >= plan.duration_ms {
            continue;
        }
        let gap_start = (gap.start_ms as f64).clamp(win_start_ms, win_end_ms);
        let gap_end = (gap.end_ms as f64).clamp(win_start_ms, win_end_ms);
        if gap_end <= gap_start {
            continue;
        }
        if let Some((start_frame, end_frame)) =
            window_frame_span(window, fps as f64, gap_start, gap_end)
        {
            push_black(
                &mut filters,
                &mut pieces,
                start_frame,
                end_frame,
                format!("gap{gap_index}"),
            );
        }
    }

    if pieces.is_empty() {
        return Err(InternalError::Media(
            "GPU decode window covers no screen frames or gaps".into(),
        )
        .into());
    }
    pieces.sort_by_key(|(start_frame, _, _, _)| *start_frame);
    let labels: Vec<String> = pieces.into_iter().map(|(_, _, label, _)| label).collect();

    let video_input = if labels.len() == 1 {
        labels[0].clone()
    } else {
        filters.push(format!(
            "{}concat=n={}:v=1:a=0[screen_concat]",
            labels.join(""),
            labels.len()
        ));
        "[screen_concat]".to_string()
    };

    // Pin the stream to the exact frame count, then normalise to NV12 for the
    // compositor. `trim=end_frame` is what keeps a GPU pass and the FFmpeg
    // graph frame-for-frame equal. When an overlay-only tail follows the last
    // screen segment, clone the final frame across it before the trim; a pure
    // trailing gap is admitted by the GPU gate only for this case.
    let screen_end_ms = plan
        .segments
        .iter()
        .map(|segment| segment.output_end_ms)
        .max()
        .unwrap_or(0);
    let hold = if window.end_ms() > screen_end_ms as f64 {
        format!(
            "tpad=stop_mode=clone:stop_duration={},",
            fmt_secs(window.frame_count as f64 / fps.max(1) as f64)
        )
    } else {
        String::new()
    };
    filters.push(format!(
        "{video_input}{hold}trim=end_frame={},setsar=1,format=nv12[vout]",
        window.frame_count
    ));

    Ok(DecodePlan {
        inputs,
        filter: filters.join(";\n"),
        width,
        height,
        fps,
        frame_count: window.frame_count,
    })
}

/// One segment's decode chain. Mirrors `render_composition_window`'s per-segment
/// filter string one-for-one; the only difference is the trailing `format=nv12`
/// which the decode pass applies once, after the concat.
#[allow(clippy::too_many_arguments)]
fn segment_filter(
    input: &str,
    segment: &RenderSegment,
    request: &SourceRequest,
    seek_s: f64,
    cut_in_s: f64,
    width: u32,
    height: u32,
    content: (f64, f64, f64, f64),
    fps: u32,
    frames: u64,
    label: &str,
) -> String {
    let speed = segment.speed;
    let source_in_s = request.source_in_s - seek_s;
    let source_out_s = request.source_out_s - seek_s;
    let phase = if cut_in_s > 1e-9 {
        format!("+{:.6}/TB", cut_in_s * speed)
    } else {
        String::new()
    };
    let mut filter = format!(
        "{input}trim=start={}:end={},setpts=PTS-STARTPTS{phase}",
        fmt_secs(source_in_s),
        fmt_secs(source_out_s),
    );
    if (speed - 1.0).abs() > f64::EPSILON {
        filter.push_str(&format!(",setpts=PTS/{:.6}", speed));
    }
    let segment_duration = fmt_secs(frames as f64 / fps.max(1) as f64);
    // Scale into the fitted content rect, then pad out to the canvas at that
    // rect's origin: the frame handed to the compositor is canvas-sized with the
    // picture already framed, which is what the background/radius composite
    // expects.
    let (content_x, content_y, content_w, content_h) = content;
    // Centre the aspect-fitted picture inside the content rect when even-pixel
    // rounding makes `iw < content_w` or `ih < content_h` (no-op when exact).
    filter.push_str(&format!(
        ",scale={content_w:.0}:{content_h:.0}:force_original_aspect_ratio=decrease:force_divisible_by=2:threads=auto,\
pad={width}:{height}:{content_x:.0}+({content_w:.0}-iw)/2:{content_y:.0}+({content_h:.0}-ih)/2:color=black,fps={fps},setsar=1,\
tpad=stop_mode=clone:stop_duration={segment_duration},\
tpad=stop_mode=add:stop_duration={segment_duration}:color=black,\
trim=end_frame={frames},setpts=PTS-STARTPTS[{label}]"
    ));
    filter
}

/// A camera track's decode pass: one FFmpeg process emitting overlay-sized NV12
/// frames for every piece of the (coalesced) track, in output order.
pub(super) struct CameraPlan {
    pub inputs: Vec<DecodeInput>,
    pub filter: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// Output frames are `yuva420p` (cutout matte) instead of `nv12`.
    pub alpha: bool,
}

/// Plan one camera track's decode chain. Each piece is trimmed, retimed and
/// frame-snapped exactly like the compatibility renderer, then the pieces are
/// concatenated and the shared geometry applied once.
/// Decode plane size shared by the camera decode pass and the compositor's
/// camera inventory, so a frame's buffer always matches the quad it is uploaded
/// into. The plane covers the largest rect the track reaches (layout keyframes
/// can grow a PiP to fullscreen) and is even-snapped for chroma.
pub(super) fn camera_decode_size(
    track: &CameraTrack,
    overlays: &[RenderPlanOverlay],
    max_rect: Option<(f64, f64)>,
) -> (u32, u32) {
    let first = &overlays[track.first_overlay()];
    let mut decode_w = first.width.max(0.0);
    let mut decode_h = first.height.max(0.0);
    for &overlay_index in &track.pieces {
        let overlay = &overlays[overlay_index];
        decode_w = decode_w.max(overlay.width);
        decode_h = decode_h.max(overlay.height);
        for keyframe in &overlay.keyframes {
            decode_w = decode_w.max(keyframe.width);
            decode_h = decode_h.max(keyframe.height);
        }
    }
    if let Some((layout_w, layout_h)) = max_rect {
        decode_w = decode_w.max(layout_w);
        decode_h = decode_h.max(layout_h);
    }
    (
        ((decode_w.round() as u32) / 2 * 2).max(2),
        ((decode_h.round() as u32) / 2 * 2).max(2),
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn plan_camera(
    project_id: &str,
    track: &CameraTrack,
    overlays: &[RenderPlanOverlay],
    asset_paths: &HashMap<String, PathBuf>,
    shared: &CompositionShared,
    duration_ms: u64,
    fps: u32,
    // Largest rect the layer reaches (camera layouts can grow a PiP to
    // fullscreen), so a fullscreen moment is not upscaled from PiP pixels.
    max_rect: Option<(f64, f64)>,
) -> Result<Option<CameraPlan>> {
    let first = &overlays[track.first_overlay()];
    let asset_path = asset_paths
        .get(&first.asset_id)
        .cloned()
        .ok_or_else(|| InternalError::Media("camera overlay references an unknown asset".into()))?;
    let (width, height) = camera_decode_size(track, overlays, max_rect);

    let mut clamps = Vec::new();
    for &overlay_index in &track.pieces {
        let overlay = &overlays[overlay_index];
        if !overlay.speed.is_finite() || overlay.speed <= 0.0 {
            return Err(InternalError::Media("camera overlay speed is invalid".into()).into());
        }
        let video_delay_s = shared
            .probe
            .video_start_delay_s(&asset_path, &overlay.asset_id);
        if let Some(clamp) = super::super::camera_window_clamp(
            overlay.output_start_ms,
            overlay.output_end_ms,
            overlay.source_in_ms,
            overlay.source_out_ms,
            overlay.speed,
            fps as f64,
            0.0,
            duration_ms as f64,
            video_delay_s,
        ) {
            clamps.push((overlay_index, clamp));
        }
    }
    if clamps.is_empty() {
        return Ok(None);
    }

    let src_in_s = clamps
        .iter()
        .map(|(_, clamp)| clamp.src_in_s)
        .fold(f64::INFINITY, f64::min);
    let src_out_s = clamps
        .iter()
        .map(|(_, clamp)| clamp.src_out_s)
        .fold(f64::NEG_INFINITY, f64::max);
    let seek_s = super::super::floor_to_ms(src_in_s - SEEK_PREROLL_S).max(0.0);
    let video_delay_s = shared
        .probe
        .video_start_delay_s(&asset_path, &first.asset_id);
    let matte_seek_s =
        super::super::floor_to_ms(src_in_s - SEEK_PREROLL_S - video_delay_s).max(0.0);
    let input = resolve_video_stream_specifier(
        &shared.probe,
        &asset_path,
        &first.asset_id,
        0,
        first.stream_index,
    )?;

    let mut filters = Vec::new();
    let mut labels = Vec::new();
    let frame_rate = fps.max(1) as f64;
    for (piece_index, (overlay_index, clamp)) in clamps.iter().enumerate() {
        let overlay = &overlays[*overlay_index];
        let frames = ((clamp.chain_dur_s * frame_rate).round().max(0.0) as u64).max(1);
        let duration = fmt_secs(frames as f64 / frame_rate);
        let label = format!("cam{piece_index}");
        filters.push(format!(
            "{input}trim=start={}:end={},setpts=(PTS-STARTPTS+{:.6}/TB)/{:.6},fps={fps},setsar=1,\
tpad=stop_mode=clone:stop_duration={duration},tpad=stop_mode=add:stop_duration={duration}:color=black,\
trim=end_frame={frames},setpts=PTS-STARTPTS[{label}]",
            fmt_secs(clamp.src_in_s - seek_s),
            fmt_secs(clamp.src_out_s - seek_s),
            clamp.cut_out_s * overlay.speed,
            overlay.speed.max(1e-6),
        ));
        labels.push(format!("[{label}]"));
    }
    let joined = if labels.len() == 1 {
        labels.remove(0)
    } else {
        filters.push(format!(
            "{}concat=n={}:v=1:a=0[cam_concat]",
            labels.join(""),
            labels.len()
        ));
        "[cam_concat]".to_string()
    };

    // Geometry is shared by every piece (coalescing requires identical visual
    // props), so it runs once over the joined stream.
    let face_tracked = first.crop_keyframes.len() > 1;
    let mut camera_crop = String::new();
    let mut matte_crop = String::new();
    let mut sendcmd = String::new();
    let mut sendcmd_path: Option<PathBuf> = None;
    if face_tracked {
        let keyframe = &first.crop_keyframes[0];
        let chain_start_ms =
            overlays[track.pieces[0]].output_start_ms as f64 + clamps[0].1.cut_out_s * 1000.0;
        let script = crate::exports::build_camera_crop_sendcmd(
            &first.crop_keyframes,
            chain_start_ms,
            &["camface".to_string(), "cammatte".to_string()],
        );
        if !script.is_empty() {
            let path = std::env::temp_dir().join(format!(
                "rf-sendcmd-{}-{}.txt",
                project_id,
                uuid::Uuid::new_v4()
            ));
            std::fs::write(&path, script.as_bytes())
                .map_err(|error| InternalError::Storage(format!("write crop script: {error}")))?;
            let escaped = super::super::captions::escape_filter_path(&path);
            sendcmd = format!(",sendcmd=f='{escaped}'");
            sendcmd_path = Some(path);
        }
        camera_crop = format!(
            ",crop@camface=w={}:h={}:x={}:y={}",
            keyframe.width, keyframe.height, keyframe.x, keyframe.y
        );
        matte_crop = format!(
            ",crop@cammatte=w={}:h={}:x={}:y={}",
            keyframe.width, keyframe.height, keyframe.x, keyframe.y
        );
    } else if let Some(crop) = &first.crop {
        let ops = format!(",crop={}:{}:{}:{}", crop.width, crop.height, crop.x, crop.y);
        camera_crop = ops.clone();
        matte_crop = ops;
    }
    let fit = if face_tracked || first.crop.is_some() {
        format!(
            ",scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2:threads=auto,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black@0"
        )
    } else {
        match first.fit.as_deref() {
            // B-roll letterboxes inside its rect (transparent where it does not
            // cover, matching the editor preview's `object-fit: contain`).
            Some("contain") => format!(
                ",scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2:threads=auto,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black@0"
            ),
            // `fill` stretches the source across the rect.
            Some("fill") => {
                format!(",scale={width}:{height}:force_divisible_by=2:threads=auto")
            }
            // Camera bubble and `cover` b-roll: fill the plane and crop.
            _ => format!(
                ",scale={width}:{height}:force_original_aspect_ratio=increase:force_divisible_by=2:threads=auto,crop={width}:{height}:(iw-ow)/2:(ih-oh)/2"
            ),
        }
    };
    let mut camera_ops = format!("{camera_crop}{sendcmd}{fit}");

    // Camera colour (#4a): same composed `.cube` as the compat renderer.
    if let Some(color) = first.color.as_ref() {
        if let Some(lut_path) = shared.camera_lut_file(color, asset_paths)? {
            let escaped = super::super::captions::escape_filter_path(&lut_path);
            camera_ops.push_str(&format!(
                ",format=rgb24,lut3d=file='{escaped}':interp=tetrahedral"
            ));
        }
    }

    let mut inputs = vec![DecodeInput {
        path: asset_path.clone(),
        seek_s: Some(seek_s),
        duration_s: Some(src_out_s - seek_s + SEEK_TAIL_MARGIN_S),
        hwaccel: false,
    }];

    // Portrait cutout (#4b): a mirrored matte chain (same trims, fps, crop)
    // alpha-merges the camera before it reaches the compositor.
    let mut cutout_label: Option<String> = None;
    if let Some(cutout) = first.cutout.as_ref() {
        if let Some(matte) = cutout.matte_path.as_deref() {
            let matte_index = inputs.len();
            inputs.push(DecodeInput {
                path: PathBuf::from(matte),
                seek_s: Some(matte_seek_s),
                duration_s: Some(
                    (src_out_s - video_delay_s - matte_seek_s).max(0.0) + SEEK_TAIL_MARGIN_S,
                ),
                hwaccel: false,
            });
            let mut matte_labels = Vec::with_capacity(clamps.len());
            for (piece_index, (overlay_index, clamp)) in clamps.iter().enumerate() {
                let overlay = &overlays[*overlay_index];
                let frames = ((clamp.chain_dur_s * frame_rate).round().max(0.0) as u64).max(1);
                let duration = fmt_secs(frames as f64 / frame_rate);
                let label = format!("matte{piece_index}");
                // Mirror the camera piece's setpts (cut_out offset + speed)
                // so the matte stays on the same output grid.
                filters.push(format!(
                    "[{matte_index}:v]trim=start={}:end={},setpts=(PTS-STARTPTS+{:.6}/TB)/{:.6},fps={fps},setsar=1,\
tpad=stop_mode=clone:stop_duration={duration},tpad=stop_mode=add:stop_duration={duration}:color=black,\
trim=end_frame={frames},setpts=PTS-STARTPTS[{label}]",
                    fmt_secs((clamp.src_in_s - video_delay_s - matte_seek_s).max(0.0)),
                    fmt_secs((clamp.src_out_s - video_delay_s - matte_seek_s).max(0.0)),
                    clamp.cut_out_s * overlay.speed,
                    overlay.speed.max(1e-6),
                ));
                matte_labels.push(format!("[{label}]"));
            }
            let matte_joined = if matte_labels.len() == 1 {
                matte_labels.remove(0)
            } else {
                filters.push(format!(
                    "{}concat=n={}:v=1:a=0[matte_concat]",
                    matte_labels.join(""),
                    matte_labels.len()
                ));
                "[matte_concat]".to_string()
            };
            // The matte is stored at a downscaled working size while crop
            // rects live in source pixels: prescale it to the camera stream's
            // decoded size so shared crop ops land on the same region.
            let matte_prescale = (face_tracked || first.crop.is_some())
                .then(|| {
                    super::super::camera_stream_dimensions(
                        &shared.probe,
                        &asset_path,
                        &first.asset_id,
                        first.stream_index,
                    )
                })
                .flatten()
                .map(|(w, h)| format!("scale={w}:{h}:flags=bilinear,"))
                .unwrap_or_default();
            let mut matte_ops = if face_tracked || first.crop.is_some() {
                // Mirror the camera chain exactly: prescale, crop, sendcmd,
                // then the camera's own fit (cropped overlays letterbox).
                format!(
                    "{matte_prescale}{}{sendcmd}{fit}",
                    matte_crop.trim_start_matches(',')
                )
            } else {
                format!("{matte_crop}{sendcmd}")
            };
            matte_ops.push_str(&format!(
                ",scale={width}:{height}:force_original_aspect_ratio=increase:force_divisible_by=2:threads=auto,crop={width}:{height},format=gray"
            ));
            let softness = cutout.edge_softness;
            if softness > 0.2 {
                matte_ops.push_str(&format!(
                    ",boxblur=lr={:.2}:lp=2",
                    softness.clamp(0.0, 16.0)
                ));
            }
            if cutout.edge_shrink.abs() > 0.2 {
                let shift = (cutout.edge_shrink.clamp(-8.0, 8.0) * 12.0).round();
                matte_ops.push_str(&format!(",lut=y='clip((val-({shift}))*1.04,0,255)'"));
            }
            filters.push(format!(
                "{matte_joined}{}[matte_plane]",
                matte_ops.trim_start_matches(',')
            ));
            cutout_label = Some("matte_plane".to_string());
        }
    }

    let alpha = cutout_label.is_some();
    if let Some(matte_label) = cutout_label.as_deref() {
        let cutout = first.cutout.as_ref().expect("cutout label implies cutout");
        let rgb = "cam_cutout_rgb";
        filters.push(format!(
            "{joined}{},format=rgb24[{rgb}]",
            camera_ops.trim_start_matches(',')
        ));
        let foreground = "cam_cutout_fg";
        let foreground_source = if cutout.background == "blur" {
            filters.push(format!("[{rgb}]split=2[cam_fg_src][cam_blur_src]"));
            "cam_fg_src"
        } else {
            rgb
        };
        filters.push(format!(
            "[{foreground_source}][{matte_label}]alphamerge[{foreground}]"
        ));
        match cutout.background.as_str() {
            "blur" => {
                let radius = cutout.blur_radius.clamp(0.0, 100.0);
                filters.push(format!(
                    "[cam_blur_src]boxblur=lr={radius:.2}:lp=2[cam_bg_blur]"
                ));
                filters.push(format!(
                    "[cam_bg_blur][{foreground}]overlay=0:0:format=auto[cam_cutout]"
                ));
            }
            "color" => {
                let color = super::super::safe_filter_color(&cutout.color);
                filters.push(format!(
                    "color=c={color}:s={width}x{height}:r={fps}[cam_bg_color]"
                ));
                filters.push(format!(
                    "[cam_bg_color][{foreground}]overlay=0:0:format=auto[cam_cutout]"
                ));
            }
            "image" => {
                if let Some(image_id) = cutout.image_asset_id.as_deref() {
                    if let Some(image_path) = asset_paths.get(image_id) {
                        let image_index = inputs.len();
                        inputs.push(DecodeInput {
                            path: image_path.clone(),
                            seek_s: None,
                            duration_s: None,
                            hwaccel: false,
                        });
                        filters.push(format!(
                            "[{image_index}:v]scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},format=rgba[cam_bg_image]"
                        ));
                        filters.push(format!(
                            "[cam_bg_image][{foreground}]overlay=0:0:format=auto[cam_cutout]"
                        ));
                    } else {
                        filters.push(format!("[{foreground}]null[cam_cutout]"));
                    }
                } else {
                    filters.push(format!("[{foreground}]null[cam_cutout]"));
                }
            }
            _ => filters.push(format!("[{foreground}]null[cam_cutout]")),
        }
        filters.push("[cam_cutout]format=yuva420p[vout]".to_string());
    } else {
        filters.push(format!(
            "{joined}{},format=nv12[vout]",
            camera_ops.trim_start_matches(',')
        ));
    }
    let _ = project_id;
    let _ = sendcmd_path;

    Ok(Some(CameraPlan {
        inputs,
        filter: filters.join(";\n"),
        width,
        height,
        fps,
        alpha,
    }))
}

/// A spawned decode pass. Frames are read straight off stdout as raw NV12.
pub(super) struct DecodeProcess {
    child: Child,
    stdout: Option<BufReader<ChildStdout>>,
    stderr: Arc<Mutex<Vec<u8>>>,
    frame_len: usize,
}

/// A bounded read-ahead reader for one camera decoder.
///
/// The compose loop used to call `read_frame` inline, so it blocked on the
/// camera's pipe while the GPU and the screen pipeline sat idle. This thread
/// keeps at most `depth` frames queued and blocks on the pipe by itself; the
/// compose loop only waits for the next frame it actually needs.
pub(super) struct PrefetchReader {
    receiver: Option<mpsc::Receiver<Result<Option<Vec<u8>>>>>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl PrefetchReader {
    /// Block for the next prefetched frame. `Ok(None)` means the camera stream
    /// ended.
    pub(super) fn next_frame(&self) -> Result<Option<Vec<u8>>> {
        match self.receiver.as_ref() {
            Some(receiver) => match receiver.recv() {
                Ok(frame) => frame,
                Err(_) => Ok(None),
            },
            None => Ok(None),
        }
    }

    /// Stop the reader. The child must be killed first so a read blocked on the
    /// pipe can finish; dropping the receiver then unblocks a full queue.
    fn stop(&mut self) {
        drop(self.receiver.take());
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for PrefetchReader {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Read exactly one NV12 frame from `stdout`. `Ok(None)` means EOF.
fn read_frame_from(
    stdout: &mut BufReader<ChildStdout>,
    frame_len: usize,
) -> Result<Option<Vec<u8>>> {
    let mut frame = vec![0u8; frame_len];
    let mut filled = 0usize;
    while filled < frame_len {
        match stdout.read(&mut frame[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                return Err(InternalError::Media(format!("read GPU decode frame: {error}")).into());
            }
        }
    }
    if filled == 0 {
        return Ok(None);
    }
    if filled != frame_len {
        return Err(gpu_error("GPU decode pass ended with a partial frame"));
    }
    Ok(Some(frame))
}

impl DecodeProcess {
    pub(super) fn spawn(ffmpeg_path: &str, plan: &DecodePlan) -> Result<Self> {
        Self::spawn_with(
            ffmpeg_path,
            &plan.inputs,
            &plan.filter,
            plan.width,
            plan.height,
            plan.fps,
            false,
        )
    }

    pub(super) fn spawn_camera(ffmpeg_path: &str, plan: &CameraPlan) -> Result<Self> {
        Self::spawn_with(
            ffmpeg_path,
            &plan.inputs,
            &plan.filter,
            plan.width,
            plan.height,
            plan.fps,
            plan.alpha,
        )
    }

    fn spawn_with(
        ffmpeg_path: &str,
        inputs: &[DecodeInput],
        filter: &str,
        width: u32,
        height: u32,
        fps: u32,
        alpha: bool,
    ) -> Result<Self> {
        let mut command = crate::process::create_command(ffmpeg_path);
        command.args(["-hide_banner", "-loglevel", "error", "-nostdin"]);
        for input in inputs {
            if input.hwaccel {
                // Decode on the GPU and download each frame once; the filter
                // chain stays in system memory so frames match the encoder
                // path bit for bit.
                command.args(["-hwaccel", "auto"]);
            }
            if let Some(seek_s) = input.seek_s {
                command.arg("-ss").arg(format!("{seek_s:.3}"));
            }
            if let Some(duration_s) = input.duration_s {
                command.arg("-t").arg(format!("{duration_s:.3}"));
            }
            command.arg("-i").arg(&input.path);
        }
        command
            .args(["-filter_complex", filter])
            .args(["-map", "[vout]"])
            .args([
                "-an",
                "-f",
                "rawvideo",
                "-pix_fmt",
                if alpha { "yuva420p" } else { "nv12" },
                "-s",
                &format!("{width}x{height}"),
                "-r",
                &fps.to_string(),
                "pipe:1",
            ]);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command
            .spawn()
            .map_err(|error| InternalError::Media(format!("start GPU decode pass: {error}")))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| InternalError::Media("GPU decode stdout unavailable".into()))?;
        let mut stderr_pipe = child
            .stderr
            .take()
            .ok_or_else(|| InternalError::Media("GPU decode stderr unavailable".into()))?;
        let stderr = Arc::new(Mutex::new(Vec::new()));
        {
            let sink = Arc::clone(&stderr);
            std::thread::spawn(move || {
                let mut buffer = [0u8; 8192];
                loop {
                    match stderr_pipe.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(read) => {
                            let mut sink = sink.lock().unwrap_or_else(|p| p.into_inner());
                            if sink.len() < 16 * 1024 {
                                sink.extend_from_slice(&buffer[..read]);
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        Ok(Self {
            child,
            stdout: Some(BufReader::with_capacity(4 << 20, stdout)),
            stderr,
            frame_len: if alpha {
                (width as usize * height as usize * 5 / 2).max(1)
            } else {
                (width as usize * height as usize * 3 / 2).max(1)
            },
        })
    }

    /// Read exactly one NV12 frame. `Ok(None)` means the stream ended early.
    pub(super) fn read_frame(&mut self) -> Result<Option<Vec<u8>>> {
        let stdout = self
            .stdout
            .as_mut()
            .ok_or_else(|| gpu_error("GPU decode stdout was already handed to a prefetcher"))?;
        read_frame_from(stdout, self.frame_len)
    }

    /// Move stdout onto a bounded read-ahead thread. The child (and `kill` /
    /// `finish`) stays with this process, so the compose loop can still reap a
    /// decoder that is blocked on a full pipe.
    pub(super) fn start_prefetch(&mut self, depth: usize) -> Result<PrefetchReader> {
        let stdout = self
            .stdout
            .take()
            .ok_or_else(|| gpu_error("GPU decode prefetch was started twice"))?;
        let frame_len = self.frame_len;
        let (sender, receiver) = mpsc::sync_channel::<Result<Option<Vec<u8>>>>(depth.max(1));
        let handle = std::thread::spawn(move || {
            let mut stdout = stdout;
            loop {
                let frame = read_frame_from(&mut stdout, frame_len);
                let ended = matches!(frame, Ok(None) | Err(_));
                if sender.send(frame).is_err() || ended {
                    break;
                }
            }
        });
        Ok(PrefetchReader {
            receiver: Some(receiver),
            handle: Some(handle),
        })
    }

    /// Wait for the decoder and turn a non-zero exit into a diagnostic.
    pub(super) fn finish(mut self) -> Result<()> {
        let status = self
            .child
            .wait()
            .map_err(|error| InternalError::Media(format!("wait for GPU decode pass: {error}")))?;
        let diagnostic = String::from_utf8_lossy(
            &self
                .stderr
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
        .to_string();
        if status.success() {
            return Ok(());
        }
        let redacted = diagnostic
            .lines()
            .map(super::super::redact_paths)
            .collect::<Vec<_>>()
            .join("\n");
        warn!(
            detail = %redacted.chars().take(400).collect::<String>(),
            "gpu export: decode pass failed"
        );
        Err(gpu_error("GPU decode pass failed"))
    }

    pub(super) fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for DecodeProcess {
    fn drop(&mut self) {
        // A setup error or an early return must not leave FFmpeg blocked on a
        // pipe nobody reads. Reaping an already-finished child is a no-op.
        self.kill();
    }
}
