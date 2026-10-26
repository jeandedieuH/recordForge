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
use std::sync::{Arc, Mutex};

use crate::errors::{InternalError, Result};
use tracing::warn;

use super::super::{
    collect_input_assets, corrected_source_in_s, fmt_secs, plan_segment_inputs,
    resolve_video_stream_specifier, validate_segment_known, CompositionShared, CompositionWindow,
    RenderPlan, RenderSegment, SegmentJob, SourceRequest, SEEK_TAIL_MARGIN_S,
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
    let mut labels: Vec<String> = Vec::new();
    for job in &segment_jobs {
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
            &label,
        ));
        labels.push(format!("[{label}]"));
    }

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
    // graph frame-for-frame equal.
    filters.push(format!(
        "{video_input}trim=end_frame={},setsar=1,format=nv12[vout]",
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
    let segment_duration =
        fmt_secs((request.source_out_s - request.source_in_s).max(0.0) / speed.max(1e-6));
    // Scale into the fitted content rect, then pad out to the canvas at that
    // rect's origin: the frame handed to the compositor is canvas-sized with the
    // picture already framed, which is what the background/radius composite
    // expects.
    let (content_x, content_y, content_w, content_h) = content;
    filter.push_str(&format!(
        ",scale={content_w:.0}:{content_h:.0}:force_original_aspect_ratio=decrease:force_divisible_by=2:threads=auto,\
pad={width}:{height}:{content_x:.0}:{content_y:.0}:color=black,fps={fps},setsar=1,\
tpad=stop_mode=clone:stop_duration={segment_duration},\
tpad=stop_mode=add:stop_duration={segment_duration}:color=black,\
trim=duration={segment_duration},setpts=PTS-STARTPTS[{label}]"
    ));
    filter
}

/// A camera overlay's dedicated decode pass: its own FFmpeg process emitting
/// overlay-sized NV12 frames, one per output frame inside the overlay window.
pub(super) struct CameraPlan {
    pub input: DecodeInput,
    pub filter: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

/// Plan one camera overlay's decode chain. Mirrors the compatibility graph's
/// camera stream (`trim`, speed, cover/contain crop, fps, tpad) so the bubble
/// sees the same frames the FFmpeg renderer composites.
#[allow(clippy::too_many_arguments)]
pub(super) fn plan_camera(
    project_id: &str,
    overlay: &super::super::RenderPlanOverlay,
    asset_paths: &HashMap<String, PathBuf>,
    shared: &CompositionShared,
    clamp: &super::super::CameraClamp,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<CameraPlan> {
    let asset_path = asset_paths
        .get(&overlay.asset_id)
        .cloned()
        .ok_or_else(|| InternalError::Media("camera overlay references an unknown asset".into()))?;
    let seek_s = super::super::floor_to_ms(clamp.src_in_s - super::super::SEEK_PREROLL_S).max(0.0);
    let input = resolve_video_stream_specifier(
        &shared.probe,
        &asset_path,
        &overlay.asset_id,
        0,
        overlay.stream_index,
    )?;
    let geometry = if let Some(crop) = &overlay.crop {
        format!(
            ",crop={}:{}:{}:{},scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2:threads=auto,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black@0",
            crop.width, crop.height, crop.x, crop.y
        )
    } else {
        format!(
            ",scale={width}:{height}:force_original_aspect_ratio=increase:force_divisible_by=2:threads=auto,crop={width}:{height}:(iw-ow)/2:(ih-oh)/2"
        )
    };
    let duration = fmt_secs(clamp.chain_dur_s);
    let filter = format!(
        "{input}trim=start={}:end={},setpts=(PTS-STARTPTS+{:.6}/TB)/{:.6}{geometry},fps={fps},setsar=1,\
tpad=stop_mode=clone:stop_duration={duration},trim=duration={duration},setpts=PTS-STARTPTS,format=nv12[vout]",
        fmt_secs(clamp.src_in_s - seek_s),
        fmt_secs(clamp.src_out_s - seek_s),
        clamp.cut_out_s * overlay.speed,
        overlay.speed.max(1e-6),
    );
    let _ = project_id;
    Ok(CameraPlan {
        input: DecodeInput {
            path: asset_path,
            seek_s: Some(seek_s),
            duration_s: Some(clamp.src_out_s - seek_s + SEEK_TAIL_MARGIN_S),
            hwaccel: false,
        },
        filter,
        width,
        height,
        fps,
    })
}

/// A spawned decode pass. Frames are read straight off stdout as raw NV12.
pub(super) struct DecodeProcess {
    child: Child,
    stdout: BufReader<ChildStdout>,
    stderr: Arc<Mutex<Vec<u8>>>,
    frame_len: usize,
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
        )
    }

    pub(super) fn spawn_camera(ffmpeg_path: &str, plan: &CameraPlan) -> Result<Self> {
        Self::spawn_with(
            ffmpeg_path,
            std::slice::from_ref(&plan.input),
            &plan.filter,
            plan.width,
            plan.height,
            plan.fps,
        )
    }

    fn spawn_with(
        ffmpeg_path: &str,
        inputs: &[DecodeInput],
        filter: &str,
        width: u32,
        height: u32,
        fps: u32,
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
                "nv12",
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
            stdout: BufReader::with_capacity(4 << 20, stdout),
            stderr,
            frame_len: (width as usize * height as usize * 3 / 2).max(1),
        })
    }

    /// Read exactly one NV12 frame. `Ok(None)` means the stream ended early.
    pub(super) fn read_frame(&mut self) -> Result<Option<Vec<u8>>> {
        let mut frame = vec![0u8; self.frame_len];
        let mut filled = 0usize;
        while filled < self.frame_len {
            match self.stdout.read(&mut frame[filled..]) {
                Ok(0) => break,
                Ok(read) => filled += read,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    return Err(
                        InternalError::Media(format!("read GPU decode frame: {error}")).into(),
                    );
                }
            }
        }
        if filled == 0 {
            return Ok(None);
        }
        if filled != self.frame_len {
            return Err(gpu_error("GPU decode pass ended with a partial frame"));
        }
        Ok(Some(frame))
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
