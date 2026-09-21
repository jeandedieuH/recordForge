use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tracing::{info, instrument};

use super::config::{RecordingConfig, RecordingProfile};
use super::disk;
use super::manifest::{RecordingFragment, RecordingManifest, RecordingStats};
use super::metrics::{CaptureDiagnostics, CaptureProgress, CaptureProgressState};
use super::source::{Bounds, CaptureSource};
use super::traits::TimelineAnchor;
use super::webcam::CameraMode;

/// Manages a running FFmpeg capture process.
pub struct FfmpegCapture {
    child: Child,
    stdin: Option<std::process::ChildStdin>,
    manifest: Option<Arc<Mutex<RecordingManifest>>>,
    output_path: PathBuf,
    fragment_index: u32,
    timeline_anchor: TimelineAnchor,
    progress: Arc<Mutex<CaptureProgressState>>,
    stderr_reader: Option<thread::JoinHandle<()>>,
    stdout_reader: Option<thread::JoinHandle<()>>,
    diagnostic_target: Option<(Arc<Mutex<RecordingManifest>>, u32, bool)>,
    /// Encoder that actually produced this output — may differ from the
    /// session's preferred encoder after a startup fallback.
    encoder: String,
    /// Concrete input backend the command was built with (e.g. `ddagrab-cpu`,
    /// `dshow-camera`); reported by the builder, never guessed downstream.
    backend: String,
    requested_fps: f64,
    startup_ready_ms: Option<u64>,
    preview_fps: Option<i32>,
    /// Camera mode negotiated for a webcam capture; `None` = device defaults.
    camera_mode: Option<CameraMode>,
    /// Generic reason code when a fallback mode/encoder was used.
    fallback_reason: Option<String>,
}

/// Metadata describing how a capture process was actually launched, recorded
/// on the capture so diagnostics reflect the real command — not intent.
struct CaptureMeta {
    startup_timeout: Duration,
    encoder: String,
    backend: String,
    requested_fps: f64,
    camera_mode: Option<CameraMode>,
    preview_fps: Option<i32>,
}

impl std::fmt::Debug for FfmpegCapture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FfmpegCapture")
            .field(
                "session_id",
                &self
                    .manifest
                    .as_ref()
                    .and_then(|m| m.lock().map(|m| m.session_id.clone()).ok()),
            )
            .field("fragment_index", &self.fragment_index)
            .field("output_path", &self.output_path)
            .finish_non_exhaustive()
    }
}

impl FfmpegCapture {
    /// Build and start the FFmpeg capture command for the given configuration.
    ///
    /// `ddagrab_available` reports whether the FFmpeg build supports the
    /// `ddagrab` (Desktop Duplication API) filter. When false, display capture
    /// falls back to `gdigrab` so recording still works on builds without D3D11
    /// capture support.
    #[allow(clippy::too_many_arguments)]
    #[instrument(skip(ffmpeg_path, config, profile, manifest, output))]
    pub fn start(
        ffmpeg_path: &str,
        config: &RecordingConfig,
        profile: &RecordingProfile,
        encoder: &str,
        output: &str,
        fragment_index: u32,
        manifest: Option<Arc<Mutex<RecordingManifest>>>,
        ddagrab_available: bool,
    ) -> crate::errors::Result<Self> {
        let (command, backend) = build_screen_command(
            ffmpeg_path,
            config,
            profile,
            encoder,
            output,
            ddagrab_available,
        );
        let meta = CaptureMeta {
            startup_timeout: STARTUP_FRAME_TIMEOUT,
            encoder: encoder.to_string(),
            backend: backend.to_string(),
            requested_fps: profile.fps as f64,
            camera_mode: None,
            preview_fps: None,
        };
        match run(
            command,
            output,
            fragment_index,
            manifest.clone(),
            None,
            meta,
        ) {
            Ok(capture) => Ok(capture),
            // The GPU-resident pipeline is an optimization, never a hard
            // requirement: if it fails to reach readiness, retry the same
            // encoder and ddagrab input with CPU processing. `run` already
            // owned and reaped the failed child before returning the error.
            Err(error) if backend == "ddagrab-gpu" => {
                tracing::warn!(%error, "GPU screen pipeline failed; retrying with CPU processing");
                let mut cpu_config = config.clone();
                cpu_config.gpu_screen_capture = false;
                let (command, backend) = build_screen_command(
                    ffmpeg_path,
                    &cpu_config,
                    profile,
                    encoder,
                    output,
                    ddagrab_available,
                );
                let meta = CaptureMeta {
                    startup_timeout: STARTUP_FRAME_TIMEOUT,
                    encoder: encoder.to_string(),
                    backend: backend.to_string(),
                    requested_fps: profile.fps as f64,
                    camera_mode: None,
                    preview_fps: None,
                };
                let mut capture = run(command, output, fragment_index, manifest, None, meta)?;
                capture.set_fallback_reason(Some("gpu-startup-fallback".into()));
                Ok(capture)
            }
            Err(error) => Err(error),
        }
    }

    /// Check if the FFmpeg child process is still actively running.
    pub fn is_running(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(_) => false,
        }
    }

    /// Build and start a sidecar FFmpeg capture for a webcam device.
    ///
    /// `profile` must already be the camera profile (`webcam::camera_profile`)
    /// — the camera runs at its own <=30fps rate, independent of the screen
    /// profile. `mode` is the negotiated dshow input mode (`None` = device
    /// defaults); `preview_fps` selects the MJPEG preview rate (`None` = no
    /// preview output at all).
    #[allow(clippy::too_many_arguments)]
    #[instrument(skip(ffmpeg_path, output, device, profile, manifest, broadcaster, mode))]
    pub fn start_webcam(
        ffmpeg_path: &str,
        device: &str,
        profile: &RecordingProfile,
        encoder: &str,
        output: &str,
        manifest: Option<Arc<Mutex<RecordingManifest>>>,
        broadcaster: Option<super::preview_server::FrameBroadcaster>,
        mode: Option<&CameraMode>,
        preview_fps: Option<i32>,
        startup_timeout: Duration,
    ) -> crate::errors::Result<Self> {
        let preview_fps = broadcaster.as_ref().and(preview_fps);
        let (command, backend) = build_webcam_command(
            ffmpeg_path,
            device,
            profile,
            encoder,
            output,
            mode,
            preview_fps,
        );
        // The output rate actually requested of this process: capped by the
        // camera profile and the negotiated mode's own rate (a 29.97 camera
        // never gets duplicated up to 30).
        let requested_fps = mode
            .map(|m| (profile.fps as f64).min(m.fps))
            .unwrap_or(profile.fps as f64);
        let meta = CaptureMeta {
            startup_timeout,
            encoder: encoder.to_string(),
            backend: backend.to_string(),
            requested_fps,
            camera_mode: mode.cloned(),
            preview_fps,
        };
        run(command, output, 0, manifest, broadcaster, meta)
    }

    /// Elapsed milliseconds since this capture was started.
    pub fn elapsed_ms(&self) -> u64 {
        self.timeline_anchor.instant.elapsed().as_millis() as u64
    }

    pub fn output_path(&self) -> &Path {
        &self.output_path
    }

    pub fn started_at(&self) -> Instant {
        self.timeline_anchor.instant
    }

    pub fn timeline_anchor(&self) -> TimelineAnchor {
        self.timeline_anchor
    }

    /// Snapshot of live process diagnostics. All progress values come from the
    /// last complete `-progress` block FFmpeg emitted on stderr; the age is the
    /// real elapsed time since that block — never a wall-clock estimate.
    pub fn diagnostics(&self) -> CaptureDiagnostics {
        let (progress, progress_age_ms, exited) = match self.progress.lock() {
            Ok(state) => (
                state.published.clone(),
                state
                    .updated_at
                    .map(|at| at.elapsed().as_millis().min(u64::MAX as u128) as u64),
                state.exited,
            ),
            // A poisoned mutex means the reader thread panicked; report an
            // exited process rather than inventing liveness.
            Err(_) => (CaptureProgress::default(), None, true),
        };
        CaptureDiagnostics {
            process_id: self.child.id(),
            encoder: self.encoder.clone(),
            backend: self.backend.clone(),
            requested_fps: self.requested_fps,
            startup_ready_ms: self.startup_ready_ms,
            preview_fps: self.preview_fps,
            requested_camera_mode: self.camera_mode.clone(),
            fallback_reason: self.fallback_reason.clone(),
            progress,
            progress_age_ms,
            exited,
        }
    }

    pub fn attach_diagnostics(
        &mut self,
        manifest: Arc<Mutex<RecordingManifest>>,
        index: u32,
        camera: bool,
    ) {
        self.diagnostic_target = Some((manifest, index, camera));
        self.persist_diagnostics();
    }

    fn persist_diagnostics(&self) {
        let Some((manifest, index, camera)) = &self.diagnostic_target else {
            return;
        };
        let snapshot = self.diagnostics();
        if let Ok(mut manifest) = manifest.lock() {
            super::metrics::upsert_capture_diagnostics(
                &mut manifest.capture_diagnostics,
                *index,
                *camera,
                snapshot,
            );
            if manifest.write().is_err() {
                tracing::warn!("could not save capture diagnostics");
            }
        }
    }

    fn join_readers(&mut self) {
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
        if let Some(reader) = self.stdout_reader.take() {
            let _ = reader.join();
        }
    }

    /// Record why a non-primary mode/encoder combination was used. Called by
    /// the retry loop after a successful start; the value is a generic code,
    /// never stderr text or device paths.
    pub fn set_fallback_reason(&mut self, reason: Option<String>) {
        self.fallback_reason = reason;
        self.persist_diagnostics();
    }

    /// Send the graceful stop signal ("q\n") to FFmpeg immediately and record the
    /// quit instant, without blocking for process termination.
    pub fn request_stop(&mut self) -> Instant {
        let quit_at = Instant::now();
        if let Some(stdin) = self.stdin.as_mut() {
            if let Err(e) = stdin.write_all(b"q\n") {
                // A broken/closed pipe (Windows os error 232) here means FFmpeg
                // already exited on its own — typically a capture failure. That
                // is expected in that case, so we don't log it as an error; the
                // wait loop below collects the real exit status and the stderr
                // reader thread will have logged the underlying cause. Other
                // write failures are unusual enough to warn about.
                let already_exited =
                    matches!(e.kind(), ErrorKind::BrokenPipe) || e.raw_os_error() == Some(232);
                if already_exited {
                    tracing::debug!("ffmpeg quit signal not delivered: process already exited");
                } else {
                    tracing::warn!(%e, "failed to send quit to ffmpeg");
                }
            } else {
                let _ = stdin.flush();
            }
        }

        // Close stdin so FFmpeg sees EOF if it did not react to 'q'.
        self.stdin = None;
        quit_at
    }

    /// Wait up to 10 seconds for FFmpeg to finish flushing and exit after `request_stop()`,
    /// extracting final statistics anchored to the provided `quit_at` timestamp.
    #[instrument(skip(self))]
    pub fn wait_for_stop(&mut self, quit_at: Instant) -> crate::errors::Result<RecordingStats> {
        let start = std::time::Instant::now();
        let status = loop {
            if let Some(status) = self.child.try_wait().map_err(|e| {
                crate::errors::InternalError::Capture(format!("wait for ffmpeg: {e}"))
            })? {
                break status;
            }
            if start.elapsed().as_secs() > 10 {
                let _ = self.child.kill();
                break self.child.wait().map_err(|e| {
                    crate::errors::InternalError::Capture(format!("kill ffmpeg: {e}"))
                })?;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        };

        self.join_readers();
        self.persist_diagnostics();
        let mut stats = extract_final_stats(&self.manifest, status.code())?;

        let duration_ms = self.timeline_anchor.instant.elapsed().as_millis() as u64;
        stats.duration_ms = duration_ms;
        stats.quit_span_ms = quit_at
            .saturating_duration_since(self.timeline_anchor.instant)
            .as_millis() as u64;

        let output_size = std::fs::metadata(&self.output_path)
            .map(|meta| meta.len())
            .unwrap_or(0);
        stats.output_size_bytes = output_size;
        if output_size > 0 {
            disk::sync_file(&self.output_path)?;
        }

        if let Some(manifest) = self.manifest.as_ref() {
            let now = chrono::Utc::now().to_rfc3339();
            let mut m = manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;

            if let Some(frag) = m
                .fragments
                .iter_mut()
                .find(|f| f.index == self.fragment_index)
            {
                frag.stopped_at = Some(now);
                frag.duration_ms = Some(duration_ms);
                frag.size_bytes = Some(output_size);
                frag.validated = status.success() && output_size > 1024;
                m.touch();
            }

            m.set_stats(stats.clone());
            m.write()?;
        }

        if !status.success() {
            return Err(crate::errors::InternalError::Capture(format!(
                "ffmpeg exited with status {}",
                status
            ))
            .into());
        }
        if output_size <= 1024 {
            return Err(crate::errors::InternalError::Capture(
                "ffmpeg produced an empty capture file".into(),
            )
            .into());
        }

        Ok(stats)
    }

    /// Send a graceful stop signal ("q\n") to FFmpeg and wait for it to exit.
    #[instrument(skip(self))]
    pub fn stop(&mut self) -> crate::errors::Result<RecordingStats> {
        let quit_at = self.request_stop();
        self.wait_for_stop(quit_at)
    }
}

impl Drop for FfmpegCapture {
    fn drop(&mut self) {
        // Best-effort cleanup so a capture dropped without an explicit stop()
        // (app crash, abandoned session) does not leave FFmpeg running as an
        // orphan holding the display/audio devices. If stop() already ran, the
        // child has exited and this is a fast no-op (try_wait returns the
        // cached exited status immediately).
        if let Some(stdin) = self.stdin.as_mut() {
            let _ = stdin.write_all(b"q\n");
            let _ = stdin.flush();
        }
        // Close stdin to signal EOF.
        self.stdin = None;

        // Give FFmpeg a short window to flush and exit gracefully, then
        // force-kill if it is still running.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) => {
                    self.join_readers();
                    return;
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.join_readers();
    }
}

/// Add machine-readable progress reporting shared by every capture process.
/// `-progress pipe:2` interleaves `key=value` blocks into stderr (which we
/// already drain), and `-nostats` suppresses the human-readable stats line so
/// the progress stream is the single source of truth.
fn add_progress_reporting(command: &mut Command) {
    command.args(["-nostats", "-stats_period", "1", "-progress", "pipe:2"]);
}

fn build_screen_command(
    ffmpeg_path: &str,
    config: &RecordingConfig,
    profile: &RecordingProfile,
    encoder: &str,
    output: &str,
    ddagrab_available: bool,
) -> (Command, &'static str) {
    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .arg("-y");
    add_progress_reporting(&mut command);

    // ddagrab captures a specific DXGI output, and its offset/video_size are
    // interpreted in that output's own coordinate space. Displays and regions
    // are described in absolute virtual-screen coordinates, so they must be
    // mapped onto the containing output before reaching FFmpeg. When the
    // mapping fails (exotic GPU topology, non-Windows), fall back to gdigrab,
    // which understands absolute desktop coordinates natively.
    let ddagrab_target = if ddagrab_available {
        let target = super::outputs::resolve_output_target(
            &super::outputs::enumerate_dxgi_outputs(),
            config.source.bounds,
        );
        if target.is_none() {
            tracing::warn!(
                bounds = ?config.source.bounds,
                "no DXGI output matched the capture bounds; falling back to gdigrab"
            );
        }
        target
    } else {
        None
    };

    // Audio is captured by native WASAPI workers and muxed after the video
    // fragment is finalized. Keeping this FFmpeg process video-only prevents a
    // DirectShow audio failure from taking down the screen capture.
    let use_ddagrab = ddagrab_target.is_some();
    let cpu_backend = add_screen_video_input(&mut command, &config.source, profile, ddagrab_target);

    // Prefer the GPU-resident pipeline when the whole chain qualifies;
    // otherwise keep the CPU `hwdownload` filter and report that backend.
    let (video_filter, backend) = match gpu_screen_filter(config, profile, encoder, use_ddagrab) {
        Some(filter) => (filter, "ddagrab-gpu"),
        None => (
            build_video_filter(&config.source, profile, use_ddagrab),
            cpu_backend,
        ),
    };
    command
        .args(["-filter_complex", &video_filter])
        .args(["-map", "[vout]"]);

    add_video_encoder_for_frames(
        &mut command,
        profile,
        encoder,
        false,
        profile.fps as f64,
        backend == "ddagrab-gpu",
    );

    command.args([
        "-movflags",
        "+frag_keyframe+empty_moov+default_base_moof",
        "-frag_duration",
        "2000000",
        "-min_frag_duration",
        "2000000",
        output,
    ]);

    info!(encoder, backend, "built screen ffmpeg command");
    (command, backend)
}

fn build_webcam_command(
    ffmpeg_path: &str,
    device: &str,
    profile: &RecordingProfile,
    encoder: &str,
    output: &str,
    mode: Option<&CameraMode>,
    preview_fps: Option<i32>,
) -> (Command, &'static str) {
    let enable_preview = preview_fps.is_some();
    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .stdin(Stdio::piped())
        .stdout(if enable_preview {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::piped())
        .arg("-y");
    add_progress_reporting(&mut command);

    #[cfg(windows)]
    let backend = {
        command.args([
            "-f",
            "dshow",
            "-thread_queue_size",
            "256",
            "-rtbufsize",
            "50M",
        ]);
        // Negotiated mode: pin the input to a size/rate/format the device
        // actually advertised. With no negotiated mode the device defaults are
        // used as-is (compatibility path); nothing is invented.
        if let Some(mode) = mode {
            command.args([
                "-video_size",
                &format!("{}x{}", mode.width, mode.height),
                "-framerate",
                &format!("{}", mode.fps),
            ]);
            if let Some(pixel_format) = mode.pixel_format.as_deref() {
                command.args(["-pixel_format", pixel_format]);
            } else if let Some(codec) = mode.codec.as_deref() {
                command.args(["-vcodec", codec]);
            }
        }
        command.args([
            // DirectShow device timestamps are not guaranteed to share the same
            // clock as WASAPI or the screen capture. Wall-clock timestamps keep the
            // webcam on the same timeline as the other capture sources.
            "-use_video_device_timestamps",
            "0",
            "-fflags",
            "+genpts",
            "-i",
            &format!("video={}", device),
        ]);
        "dshow-camera"
    };

    #[cfg(target_os = "macos")]
    let backend = {
        command.args([
            "-f",
            "avfoundation",
            "-thread_queue_size",
            "256",
            "-framerate",
            &profile.fps.to_string(),
            "-i",
            &format!("{}:none", device),
        ]);
        "avfoundation-camera"
    };

    #[cfg(target_os = "linux")]
    let backend = {
        command.args([
            "-f",
            "v4l2",
            "-thread_queue_size",
            "256",
            "-framerate",
            &profile.fps.to_string(),
            "-i",
            device,
        ]);
        "v4l2-camera"
    };

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    let backend = {
        command.args(["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30"]);
        "lavfi-testsrc"
    };

    // Decouple webcam resolution from screen profile to keep CPU usage low on low-end machines.
    // In RecordForge, camera overlays are rendered as picture-in-picture bubbles (or side-by-side)
    // on the canvas. 720p or 480p provides crisp visual density while using 50-70% less encoder CPU than 1080p.
    // `min(iw,…)` clamps instead of stretching so a lower-resolution negotiated
    // mode is never upscaled.
    let (max_cam_w, max_cam_h) = match profile.id.as_str() {
        "low-impact" => (854, 480),
        "camera-only" => (profile.width, profile.height),
        _ => (1280, 720),
    };

    let scale = format!(
        "scale=w='min(iw,{max_cam_w})':h='min(ih,{max_cam_h})':force_original_aspect_ratio=decrease:force_divisible_by=2"
    );
    let filter = if let Some(preview_fps) = preview_fps {
        format!(
            "[0:v]{scale},split=2[vout][vprev];[vprev]fps={preview_fps},scale=320:-2[vprev_out]"
        )
    } else {
        format!("[0:v]{scale}[vout]")
    };
    command
        .args(["-filter_complex", &filter])
        .args(["-map", "[vout]"]);

    // Output rate is the negotiated mode's rate capped by the camera profile
    // (which is itself capped at <=30fps) — input frames are never duplicated
    // up to the screen profile's 60fps.
    let output_fps = mode
        .map(|m| (profile.fps as f64).min(m.fps))
        .unwrap_or(profile.fps as f64);
    add_video_encoder(&mut command, profile, encoder, true, output_fps);
    command.args([
        "-movflags",
        "+frag_keyframe+empty_moov+default_base_moof",
        "-frag_duration",
        "2000000",
        "-min_frag_duration",
        "2000000",
        output,
    ]);

    if enable_preview {
        command.args([
            "-map",
            "[vprev_out]",
            "-c:v",
            "mjpeg",
            "-q:v",
            "5",
            "-f",
            "image2pipe",
            "-",
        ]);
    }

    info!(encoder, backend, preview_fps, "built webcam ffmpeg command");
    (command, backend)
}

/// Push the platform screen input arguments and return the backend name that
/// was actually used, so diagnostics report the real capture path.
fn add_screen_video_input(
    command: &mut Command,
    source: &CaptureSource,
    profile: &RecordingProfile,
    ddagrab_target: Option<super::outputs::DxgiOutputEntry>,
) -> &'static str {
    let bounds = source.bounds;

    if let Some(target) = ddagrab_target {
        // Desktop Duplication API via the lavfi ddagrab filter, cropped to the
        // capture rect in the output's own coordinate space.
        // draw_mouse=0 keeps raw capture clean so custom overlay cursor renders cleanly.
        // Frames are hwdownload'ed to system memory before encoding, hence the
        // `-cpu` suffix distinguishing this from a full GPU pipeline.
        let (offset_x, offset_y, width, height) =
            super::outputs::output_relative_region(target, bounds);
        let ddagrab = format!(
            "ddagrab=draw_mouse=0:framerate={}:output_idx={}:offset_x={}:offset_y={}:video_size={}x{}",
            profile.fps, target.output_idx, offset_x, offset_y, width, height
        );
        command.args(["-f", "lavfi", "-thread_queue_size", "512", "-i", &ddagrab]);
        "ddagrab-cpu"
    } else if cfg!(windows)
        && (source.kind == "display" || source.kind == "window" || source.kind == "region")
    {
        // GDI captures the selected rectangle directly. The sidecar FFmpeg
        // binary is DPI-unaware, so Windows virtualizes its GDI coordinates by
        // the system DPI: physical desktop pixels must be divided by the system
        // scale before being handed to gdigrab (a no-op at 100% scaling).
        // -draw_mouse 0 hides the native mouse cursor so software custom cursor overlay can be customized post-recording.
        let logical = gdigrab_logical_bounds(bounds, system_dpi());
        command.args([
            "-f",
            "gdigrab",
            "-draw_mouse",
            "0",
            "-thread_queue_size",
            "512",
            "-framerate",
            &profile.fps.to_string(),
            "-video_size",
            &format!("{}x{}", logical.width, logical.height),
            "-offset_x",
            &logical.x.to_string(),
            "-offset_y",
            &logical.y.to_string(),
            "-i",
            "desktop",
        ]);
        "gdigrab"
    } else if cfg!(target_os = "macos")
        && (source.kind == "display" || source.kind == "window" || source.kind == "region")
    {
        // macOS AVFoundation screen input
        command.args([
            "-f",
            "avfoundation",
            "-capture_cursor",
            "0",
            "-thread_queue_size",
            "512",
            "-framerate",
            &profile.fps.to_string(),
            "-i",
            "default:none",
        ]);
        "avfoundation-screen"
    } else if cfg!(target_os = "linux")
        && (source.kind == "display" || source.kind == "window" || source.kind == "region")
    {
        // Linux X11 screen input
        let w = bounds.width.max(2);
        let h = bounds.height.max(2);
        command.args([
            "-f",
            "x11grab",
            "-draw_mouse",
            "0",
            "-thread_queue_size",
            "512",
            "-framerate",
            &profile.fps.to_string(),
            "-video_size",
            &format!("{}x{}", w, h),
            "-i",
            &format!(":0.0+{},{}", bounds.x, bounds.y),
        ]);
        "x11grab"
    } else {
        // Unknown source kinds still get a minimal input so FFmpeg does not
        // fail later in the filter graph with an obscure error.
        let fallback = format!(
            "testsrc=size={}x{}:rate={}",
            profile.width, profile.height, profile.fps
        );
        command.args(["-f", "lavfi", "-i", &fallback]);
        "lavfi-testsrc"
    }
}

/// Convert physical desktop bounds to the coordinate space a DPI-unaware
/// gdigrab process sees. Pure so the rounding stays testable.
fn gdigrab_logical_bounds(bounds: Bounds, system_dpi: u32) -> Bounds {
    const DEFAULT_DPI: u32 = 96;
    if system_dpi == 0 || system_dpi == DEFAULT_DPI {
        return bounds;
    }
    let scale = system_dpi as f64 / DEFAULT_DPI as f64;
    Bounds {
        x: (bounds.x as f64 / scale).round() as i32,
        y: (bounds.y as f64 / scale).round() as i32,
        width: ((bounds.width as f64 / scale).round() as i32).max(2),
        height: ((bounds.height as f64 / scale).round() as i32).max(2),
    }
}

/// System DPI used to virtualize GDI coordinates for the DPI-unaware FFmpeg
/// sidecar process. Defaults to 96 (100%) when the API is unavailable.
#[cfg(windows)]
fn system_dpi() -> u32 {
    unsafe { windows::Win32::UI::HiDpi::GetDpiForSystem() }
}

#[cfg(not(windows))]
fn system_dpi() -> u32 {
    96
}

/// Offer a fully GPU-resident scale+encode pipeline only when the whole
/// chain supports it: ddagrab D3D11 frames in, a D3D11-capable encoder,
/// matching aspect ratio (scaling must never distort), and even dimensions
/// for NV12. Anything else keeps the CPU `hwdownload` filter path. Returning
/// `None` is the compatibility verdict — the runtime start may still fall
/// back if the GPU graph fails to produce frames.
fn gpu_screen_filter(
    config: &RecordingConfig,
    profile: &RecordingProfile,
    encoder: &str,
    use_ddagrab: bool,
) -> Option<String> {
    let b = config.source.bounds;
    if !cfg!(windows)
        || !config.gpu_screen_capture
        || !use_ddagrab
        || !matches!(encoder, "h264_nvenc" | "h264_amf" | "h264_mf")
        || b.width <= 0
        || b.height <= 0
        || profile.width <= 0
        || profile.height <= 0
        || b.width % 2 != 0
        || b.height % 2 != 0
        || profile.width % 2 != 0
        || profile.height % 2 != 0
        || i64::from(b.width) * i64::from(profile.height)
            != i64::from(b.height) * i64::from(profile.width)
    {
        return None;
    }
    Some(format!(
        "[0:v]scale_d3d11=width={}:height={}:format=nv12[vout]",
        profile.width, profile.height
    ))
}

fn build_video_filter(
    source: &CaptureSource,
    profile: &RecordingProfile,
    use_ddagrab: bool,
) -> String {
    let fit_filter = source
        .bounds
        .build_aspect_fit_filter(profile.width, profile.height);

    if use_ddagrab {
        // ddagrab emits D3D11 hardware frames; download to system memory as
        // bgra before aspect-preserving scale and letterboxing (fixes P0.5).
        format!("[0:v]hwdownload,format=bgra,{fit_filter}[vout]")
    } else {
        format!("[0:v]{fit_filter}[vout]")
    }
}

/// Append encoder selection and rate-control args for the given output.
///
/// `output_fps` is the rate actually requested of the encoder — for a webcam
/// this is the negotiated camera rate (<=30, possibly fractional like 29.97),
/// not the screen profile's rate.
///
/// Shared by the live capture commands and the webcam finalize job so both
/// paths pick identical encoder arguments. `pub(crate)` for that reuse.
pub(crate) fn add_video_encoder(
    command: &mut Command,
    profile: &RecordingProfile,
    encoder: &str,
    is_webcam: bool,
    output_fps: f64,
) {
    add_video_encoder_for_frames(command, profile, encoder, is_webcam, output_fps, false);
}

/// `gpu_frames` marks a D3D11-resident pipeline (ddagrab → scale_d3d11): the
/// encoder consumes `d3d11` frames directly instead of downloaded system
/// memory. Only reached when `gpu_screen_filter` already qualified the chain.
fn add_video_encoder_for_frames(
    command: &mut Command,
    profile: &RecordingProfile,
    encoder: &str,
    is_webcam: bool,
    output_fps: f64,
    gpu_frames: bool,
) {
    command.arg("-c:v").arg(encoder);
    // Media Foundation only exposes hardware encoding when explicitly asked.
    if encoder == "h264_mf" {
        command.args(["-hw_encoding", "1"]);
    }
    // GPU pipelines hand D3D11 frames to the encoder; CPU pipelines feed NV12
    // (MF hardware) or yuv420p (software encoders).
    command.args([
        "-pix_fmt",
        if gpu_frames {
            "d3d11"
        } else if encoder == "h264_mf" {
            "nv12"
        } else {
            "yuv420p"
        },
    ]);
    command.args(["-r", &format!("{output_fps}")]);

    // GOP tracks the real output rate so the keyframe cadence stays ~1 second
    // on fractional rates (29.97 → 30) as well as plain integer rates.
    let gop_size = output_fps.round().max(1.0) as i32;
    command.args([
        "-g",
        &gop_size.to_string(),
        "-keyint_min",
        &(gop_size / 2).max(1).to_string(),
    ]);

    let default_bitrate = if is_webcam {
        if profile.id == "low-impact" {
            1500
        } else {
            2000
        }
    } else {
        profile.video_bitrate_kbps.unwrap_or(4000)
    };

    match encoder {
        "h264_nvenc" => {
            command.args([
                "-preset",
                "p1",
                "-tune",
                "ll",
                "-b:v",
                &format!("{default_bitrate}k"),
            ]);
        }
        "h264_qsv" => {
            command.args([
                "-preset",
                "veryfast",
                "-look_ahead",
                "0",
                "-b:v",
                &format!("{default_bitrate}k"),
            ]);
        }
        "h264_amf" => {
            command.args([
                "-quality",
                "speed",
                "-rc",
                "cbr",
                "-b:v",
                &format!("{default_bitrate}k"),
            ]);
        }
        "h264_mf" => {
            command.args([
                "-rate_control",
                "cbr",
                "-b:v",
                &format!("{default_bitrate}k"),
            ]);
        }
        "h264_videotoolbox" | "hevc_videotoolbox" => {
            command.args([
                "-b:v",
                &format!("{default_bitrate}k"),
                "-allow_sw",
                "1",
                "-realtime",
                "1",
            ]);
        }
        "libx264" | "libx265" => {
            // Allocate 4 threads for 4K / 60fps capture to prevent encoder bottleneck on powerful machines,
            // while keeping 2 threads for standard/webcam captures to prevent thrashing on low-end machines.
            let threads = if !is_webcam && (profile.width >= 3840 || profile.fps >= 60) {
                "4"
            } else {
                "2"
            };
            command.args([
                "-preset",
                "ultrafast",
                "-tune",
                "zerolatency",
                "-threads",
                threads,
            ]);
            if encoder == "libx264" {
                command.args([
                    "-x264-params",
                    "no-scenecut=1:rc-lookahead=0:sync-lookahead=0:bframes=0",
                ]);
            }
            if let Some(crf) = profile.crf {
                let target_crf = if is_webcam && crf < 26 { 26 } else { crf };
                command.args(["-crf", &target_crf.to_string()]);
            } else {
                command.args(["-b:v", &format!("{default_bitrate}k")]);
            }
        }
        _ => {
            if let Some(crf) = profile.crf {
                command.args(["-preset", "ultrafast", "-crf", &crf.to_string()]);
            } else {
                command.args(["-b:v", &format!("{default_bitrate}k")]);
            }
        }
    }
}

/// Longest we wait for FFmpeg to produce its first recorded output frame.
/// DirectShow device open + encoder init can take a couple of seconds on a
/// slow machine; 8s is generous while still failing a hung start.
const STARTUP_FRAME_TIMEOUT: Duration = Duration::from_secs(8);

fn run(
    mut command: Command,
    output: &str,
    fragment_index: u32,
    manifest: Option<Arc<Mutex<RecordingManifest>>>,
    broadcaster: Option<super::preview_server::FrameBroadcaster>,
    meta: CaptureMeta,
) -> crate::errors::Result<FfmpegCapture> {
    info!(encoder = %meta.encoder, backend = %meta.backend, "starting ffmpeg capture");

    // The timeline origin must be captured before FFmpeg startup probing. The
    // old implementation recorded it only after the startup window,
    // which made the screen and webcam appear to start at different moments.
    let timeline_anchor = TimelineAnchor::now();
    let mut child = command.spawn().map_err(|e| {
        crate::errors::InternalError::Capture(format!("failed to start ffmpeg: {e}"))
    })?;

    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                crate::errors::InternalError::Capture("ffmpeg stdin unavailable".into()).into(),
            );
        }
    };

    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                crate::errors::InternalError::Capture("ffmpeg stderr unavailable".into()).into(),
            );
        }
    };

    // If a preview broadcaster was provided, consume MJPEG frames from child.stdout
    let mut stdout_reader = None;
    if let Some(broadcaster) = broadcaster {
        if let Some(mut stdout) = child.stdout.take() {
            let spawned = thread::Builder::new()
                .name("ffmpeg-mjpeg-reader".into())
                .spawn(move || {
                    use std::io::Read;
                    let mut chunk = [0u8; 8192];
                    let mut buffer = Vec::with_capacity(65536);
                    while let Ok(bytes_read) = stdout.read(&mut chunk) {
                        if bytes_read == 0 {
                            break;
                        }
                        buffer.extend_from_slice(&chunk[..bytes_read]);
                        let frames = super::preview_server::extract_jpeg_frames(&mut buffer);
                        for frame in frames {
                            broadcaster.broadcast(&frame);
                        }
                    }
                });
            match spawned {
                Ok(reader) => stdout_reader = Some(reader),
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(crate::errors::InternalError::Capture(
                        "could not start preview reader".into(),
                    )
                    .into());
                }
            }
        }
    }

    // Spawn a reader thread to tail the FFmpeg log and accumulate `-progress`
    // blocks. It also surfaces FFmpeg's stderr so capture failures (missing
    // filters, bad device names, encoder errors) are visible instead of
    // silently swallowed — progress lines stay at debug; error-looking lines
    // go to warn so they show up at the default log level alongside the
    // quit/exit logs.
    //
    // Lines are also captured into `stderr_buffer` (capped) so that an early
    // FFmpeg exit can embed the real cause directly in the error returned to
    // the UI, rather than only in the terminal log.
    let stderr_buffer: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_buffer_reader = Arc::clone(&stderr_buffer);
    let progress_state = Arc::new(Mutex::new(CaptureProgressState::new()));
    let progress_reader = Arc::clone(&progress_state);
    let manifest_reader = manifest.clone();
    let stderr_reader = thread::Builder::new().name("capture-progress".into()).spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            // Fold the line into the pending progress block. A `progress=`
            // terminator commits the whole block atomically so readers never
            // observe a half-updated snapshot.
            let completed = match progress_reader.lock() {
                Ok(mut state) => {
                    if state.pending.update(&line) {
                        state.published = std::mem::take(&mut state.pending);
                        state.updated_at = Some(Instant::now());
                        Some(state.published.clone())
                    } else {
                        None
                    }
                }
                Err(_) => None,
            };
            if let Some(published) = completed {
                // The manifest stats mirror FFmpeg's own measured output
                // counters — frame/fps/speed of the first (recording) output.
                if let Some(manifest) = manifest_reader.as_ref() {
                    if let Ok(mut m) = manifest.lock() {
                        let stats = m.stats.get_or_insert(RecordingStats::default());
                        stats.frames_processed = published
                            .output_frames
                            .map(|frames| frames.min(i64::MAX as u64) as i64);
                        stats.fps = published.output_fps;
                        stats.speed = published.speed;
                        m.touch();
                    }
                }
            }
            if looks_like_ffmpeg_error(&line) {
                tracing::debug!(target: "recordforge::ffmpeg", "ffmpeg reported a capture warning (details redacted)");
            }
            // Keep the last ~48 lines so a startup failure's cause survives
            // even after FFmpeg prints its banner/config preamble.
            if let Ok(mut buf) = stderr_buffer_reader.lock() {
                if buf.len() >= 48 {
                    buf.remove(0);
                }
                buf.push(line);
            }
        }
        // stderr EOF means the process exited (or at minimum closed its
        // diagnostics channel) — report the capture as no longer live.
        if let Ok(mut state) = progress_reader.lock() {
            state.exited = true;
        }
    });

    let stderr_reader = match stderr_reader {
        Ok(reader) => reader,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            if let Some(reader) = stdout_reader {
                let _ = reader.join();
            }
            return Err(crate::errors::InternalError::Capture(
                "could not start capture diagnostics".into(),
            )
            .into());
        }
    };

    // Construct the capture guard immediately so every error path below —
    // early exit, readiness timeout, manifest failure — drops it and lets
    // `Drop` stop and reap the child instead of leaking a running FFmpeg.
    let mut capture = FfmpegCapture {
        child,
        stdin: Some(stdin),
        manifest,
        output_path: PathBuf::from(output),
        fragment_index,
        timeline_anchor,
        progress: progress_state,
        stderr_reader: Some(stderr_reader),
        stdout_reader,
        diagnostic_target: None,
        encoder: meta.encoder,
        backend: meta.backend,
        requested_fps: meta.requested_fps,
        startup_ready_ms: None,
        preview_fps: meta.preview_fps,
        camera_mode: meta.camera_mode,
        fallback_reason: None,
    };

    // Startup readiness: alive-and-producing-frames, not merely spawned.
    // Waiting for a complete progress block with `frame > 0` catches processes
    // that open but never deliver (e.g. a camera that accepts the handle and
    // stalls), which the old fixed sleep could not distinguish.
    let ready = loop {
        match capture.child.try_wait() {
            Ok(Some(status)) => {
                // Let the stderr reader drain FFmpeg's error output so the
                // cause is captured before we build the error message.
                capture.join_readers();
                let captured = stderr_buffer
                    .lock()
                    .map(|buf| buf.join("\n"))
                    .unwrap_or_default();
                let reason = if super::webcam::is_device_busy_error(&captured) {
                    "Camera is already in use by another application. Close it and retry."
                } else {
                    "Capture could not initialize this input mode or encoder."
                };
                tracing::debug!(exit_code = status.code(), "capture startup failed");
                return Err(crate::errors::InternalError::Capture(reason.into()).into());
            }
            Ok(None) => {}
            Err(e) => {
                return Err(crate::errors::InternalError::Capture(format!(
                    "wait for ffmpeg startup: {e}"
                ))
                .into());
            }
        }
        let producing = capture
            .progress
            .lock()
            .map(|state| state.published.output_frames.unwrap_or(0) > 0)
            .unwrap_or(false);
        if producing {
            capture.startup_ready_ms = Some(
                timeline_anchor
                    .instant
                    .elapsed()
                    .as_millis()
                    .min(u64::MAX as u128) as u64,
            );
            break true;
        }
        if Instant::now() - timeline_anchor.instant >= meta.startup_timeout {
            break false;
        }
        std::thread::sleep(Duration::from_millis(20));
    };

    if !ready {
        // `capture` drops here → Drop sends q, then kills and reaps the child.
        return Err(crate::errors::InternalError::Capture(
            "Capture produced no output frames before the startup deadline.".into(),
        )
        .into());
    }

    // Record the fragment only once the process is actually producing frames,
    // so recovery never treats a stillborn capture as a real segment.
    if let Some(m) = capture.manifest.as_ref() {
        let now = chrono::Utc::now().to_rfc3339();
        let file_name = Path::new(output)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "output.mp4".into());

        let mut m = m
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("manifest mutex poisoned".into()))?;

        // The backend/encoder stored in the manifest are the ones this
        // process was actually built with — after the session's fallback
        // chain, not the originally requested values.
        m.backend = Some(capture.backend.clone());
        m.selected_encoder = Some(capture.encoder.clone());

        m.add_fragment(RecordingFragment {
            index: fragment_index,
            file_name,
            started_at: now,
            stopped_at: None,
            duration_ms: None,
            size_bytes: None,
            validated: false,
        });
        m.write()?;
    }

    if let Some(manifest) = capture.manifest.clone() {
        capture.attach_diagnostics(manifest, fragment_index, false);
    }
    Ok(capture)
}

/// Heuristic: does this FFmpeg stderr line look like an error or warning?
///
/// FFmpeg prints its banner, configuration, and progress lines to stderr too;
/// we only want to elevate genuine problems to `warn` so they're visible at the
/// default log level without drowning the log in routine output. The matched
/// substrings cover the common FFmpeg failure phrasings ("No such filter",
/// "Could not open", "Unknown encoder", "Invalid ...", etc.).
fn looks_like_ffmpeg_error(line: &str) -> bool {
    let l = line.to_ascii_lowercase();
    l.contains("error")
        || l.contains("no such")
        || l.contains("not found")
        || l.contains("cannot")
        || l.contains("could not")
        || l.contains("failed")
        || l.contains("unknown")
        || l.contains("unrecognized")
        || l.contains("invalid")
        || l.contains("abort")
}

fn extract_final_stats(
    manifest: &Option<Arc<Mutex<RecordingManifest>>>,
    exit_code: Option<i32>,
) -> crate::errors::Result<RecordingStats> {
    if let Some(manifest) = manifest.as_ref() {
        let mut m = manifest
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("manifest mutex poisoned".into()))?;

        let mut stats = m.stats.take().unwrap_or_default();
        stats.exit_code = exit_code;
        m.set_stats(stats.clone());
        Ok(stats)
    } else {
        Ok(RecordingStats {
            exit_code,
            ..RecordingStats::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::outputs::DxgiOutputEntry;
    use crate::capture::source::{Bounds, CaptureSource};

    #[test]
    #[cfg(windows)]
    fn synthetic_capture_reports_progress_and_reaps_readers() {
        let executable = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/ffmpeg-x86_64-pc-windows-msvc.exe");
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("capture.mp4");
        let mut command = crate::process::create_command(executable);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        add_progress_reporting(&mut command);
        command.args([
            "-hide_banner",
            "-y",
            "-re",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=64x64:r=10",
            "-t",
            "4",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+frag_keyframe+empty_moov",
        ]);
        command.arg(&output);
        let mut capture = run(
            command,
            output.to_str().unwrap(),
            0,
            None,
            None,
            CaptureMeta {
                startup_timeout: Duration::from_secs(8),
                encoder: "libx264".into(),
                backend: "lavfi-testsrc".into(),
                requested_fps: 10.0,
                camera_mode: None,
                preview_fps: None,
            },
        )
        .expect("synthetic capture must produce an output frame");
        let diagnostics = capture.diagnostics();
        assert!(diagnostics.progress.output_frames.unwrap_or(0) > 0);
        assert!(diagnostics.startup_ready_ms.is_some());
        assert_eq!(diagnostics.backend, "lavfi-testsrc");
        assert_eq!(diagnostics.encoder, "libx264");
        assert_eq!(diagnostics.requested_fps, 10.0);
        assert_eq!(diagnostics.preview_fps, None);
        capture.stop().expect("synthetic capture stops cleanly");
        assert!(!capture.is_running());
        assert!(capture.diagnostics().exited);
        assert!(capture.stderr_reader.is_none());
    }

    #[test]
    #[cfg(windows)]
    fn synthetic_capture_persists_diagnostics_in_manifest() {
        let executable = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/ffmpeg-x86_64-pc-windows-msvc.exe");
        let directory = tempfile::tempdir().unwrap();
        let work_dir = directory.path().join("session-work");
        std::fs::create_dir_all(&work_dir).unwrap();
        let output = work_dir.join("capture.mp4");
        let mut command = crate::process::create_command(executable);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        add_progress_reporting(&mut command);
        command.args([
            "-hide_banner",
            "-y",
            "-re",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=64x64:r=10",
            "-t",
            "4",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+frag_keyframe+empty_moov",
        ]);
        command.arg(&output);

        let manifest = Arc::new(Mutex::new(RecordingManifest::new(
            "session-diag",
            work_dir.to_string_lossy().to_string(),
            CaptureSource {
                kind: "region".into(),
                id: "region-test".into(),
                name: "Test".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 64,
                    height: 64,
                },
            },
            "balanced",
        )));

        let mut capture = run(
            command,
            output.to_str().unwrap(),
            0,
            Some(Arc::clone(&manifest)),
            None,
            CaptureMeta {
                startup_timeout: Duration::from_secs(8),
                encoder: "libx264".into(),
                backend: "lavfi-testsrc".into(),
                requested_fps: 10.0,
                camera_mode: None,
                preview_fps: None,
            },
        )
        .expect("synthetic capture must produce an output frame");
        let live = capture.diagnostics();
        capture.stop().expect("synthetic capture stops cleanly");

        // The manifest snapshot written at stop is the authoritative record:
        // same process identity, encoder/backend, counters, and exit state —
        // snapshots at startup/stop, not continuously persisted live metrics.
        let stored =
            RecordingManifest::read(work_dir.join("session.json")).expect("manifest on disk");
        let screen = stored
            .capture_diagnostics
            .iter()
            .find(|segment| segment.index == 0)
            .and_then(|segment| segment.screen.as_ref())
            .expect("screen diagnostics persisted for segment 0");
        assert_eq!(screen.encoder, "libx264");
        assert_eq!(screen.backend, "lavfi-testsrc");
        assert_eq!(screen.process_id, live.process_id);
        assert!(screen.progress.output_frames.unwrap_or(0) > 0);
        assert!(screen.exited);

        // The persisted JSON round-trips the camelCase diagnostics intact.
        let json = serde_json::to_string(&stored).expect("serialize manifest");
        let back: RecordingManifest = serde_json::from_str(&json).expect("manifest roundtrip");
        let screen = back
            .capture_diagnostics
            .iter()
            .find(|segment| segment.index == 0)
            .and_then(|segment| segment.screen.as_ref())
            .expect("diagnostics survive serde roundtrip");
        assert_eq!(screen.process_id, live.process_id);
        assert!(screen.exited);
    }

    fn test_profile() -> RecordingProfile {
        RecordingProfile {
            id: "balanced".into(),
            label: "Balanced".into(),
            width: 1920,
            height: 1080,
            fps: 30,
            video_bitrate_kbps: None,
            crf: Some(23),
            encoder_priority: vec!["libx264".into()],
            audio_codec: "aac".into(),
            audio_bitrate_kbps: 128,
        }
    }

    fn region_source(x: i32, y: i32, w: i32, h: i32) -> CaptureSource {
        CaptureSource {
            kind: "region".into(),
            id: "region-0".into(),
            name: "Region".into(),
            bounds: Bounds {
                x,
                y,
                width: w,
                height: h,
            },
        }
    }

    fn webcam_profile() -> RecordingProfile {
        RecordingProfile {
            id: "test".into(),
            label: "Test".into(),
            width: 1280,
            height: 720,
            fps: 30,
            video_bitrate_kbps: None,
            crf: Some(23),
            encoder_priority: vec!["libx264".into()],
            audio_codec: "aac".into(),
            audio_bitrate_kbps: 128,
        }
    }

    #[test]
    fn ddagrab_input_uses_output_relative_coordinates() {
        let source = region_source(2120, 120, 640, 480);
        let output = DxgiOutputEntry {
            output_idx: 2,
            bounds: Bounds {
                x: 1920,
                y: 0,
                width: 2560,
                height: 1440,
            },
        };

        let mut command = Command::new("ffmpeg");
        add_screen_video_input(&mut command, &source, &test_profile(), Some(output));
        let debug = format!("{command:?}");

        // The capture rect must be translated into the output's own space.
        assert!(debug.contains("ddagrab=draw_mouse=0:framerate=30:output_idx=2:offset_x=200:offset_y=120:video_size=640x480"));
    }

    #[test]
    fn ddagrab_display_capture_targets_containing_output() {
        let source = CaptureSource {
            kind: "display".into(),
            id: "display-1".into(),
            name: "Display 2".into(),
            bounds: Bounds {
                x: 1920,
                y: 0,
                width: 2560,
                height: 1440,
            },
        };
        let output = DxgiOutputEntry {
            output_idx: 2,
            bounds: Bounds {
                x: 1920,
                y: 0,
                width: 2560,
                height: 1440,
            },
        };

        let mut command = Command::new("ffmpeg");
        add_screen_video_input(&mut command, &source, &test_profile(), Some(output));
        let debug = format!("{command:?}");

        assert!(debug.contains("output_idx=2"));
        assert!(debug.contains("offset_x=0:offset_y=0:video_size=2560x1440"));
    }

    #[test]
    #[cfg(windows)]
    fn gdigrab_fallback_uses_dpi_virtualized_coordinates() {
        let source = region_source(100, 200, 800, 600);

        let mut command = Command::new("ffmpeg");
        add_screen_video_input(&mut command, &source, &test_profile(), None);
        let debug = format!("{command:?}");

        assert!(debug.contains("\"gdigrab\""));
        assert!(debug.contains("\"desktop\""));
    }

    #[test]
    fn gdigrab_logical_bounds_scales_by_system_dpi() {
        let physical = Bounds {
            x: 1500,
            y: -750,
            width: 2400,
            height: 1600,
        };

        // 100% scaling: identity.
        assert_eq!(gdigrab_logical_bounds(physical, 96), physical);

        // 150% scaling (DPI 144): physical pixels shrink to logical.
        let logical = gdigrab_logical_bounds(physical, 144);
        assert_eq!(logical.x, 1000);
        assert_eq!(logical.y, -500);
        assert_eq!(logical.width, 1600);
        assert_eq!(logical.height, 1067);
    }

    #[test]
    fn ddagrab_filter_downloads_hardware_frames() {
        let source = region_source(0, 0, 800, 600);
        let filter = build_video_filter(&source, &test_profile(), true);
        assert!(filter.starts_with("[0:v]hwdownload,format=bgra,"));

        let gdigrab_filter = build_video_filter(&source, &test_profile(), false);
        assert!(gdigrab_filter.starts_with("[0:v]scale="));
    }

    #[test]
    #[cfg(windows)]
    fn webcam_capture_uses_wall_clock_device_timestamps() {
        let profile = webcam_profile();
        let (command, backend) = build_webcam_command(
            "ffmpeg",
            "USB Camera",
            &profile,
            "libx264",
            "webcam.mp4",
            None,
            None,
        );
        let debug = format!("{command:?}");

        assert!(debug.contains("-use_video_device_timestamps"));
        assert!(debug.contains("\"0\""));
        assert_eq!(backend, "dshow-camera");
    }

    #[test]
    fn webcam_capture_caps_resolution_for_low_impact() {
        let profile = RecordingProfile {
            id: "low-impact".into(),
            label: "Low Impact".into(),
            width: 1280,
            height: 720,
            fps: 30,
            video_bitrate_kbps: Some(2500),
            crf: Some(28),
            encoder_priority: vec!["libx264".into()],
            audio_codec: "aac".into(),
            audio_bitrate_kbps: 128,
        };
        let (command, _) = build_webcam_command(
            "ffmpeg",
            "USB Camera",
            &profile,
            "libx264",
            "webcam.mp4",
            None,
            None,
        );
        let debug = format!("{command:?}");

        // Scale clamps down to the 480p budget and never upscales a smaller
        // negotiated mode (min(iw,…) / min(ih,…) bounds).
        assert!(debug.contains("min(iw,854)"));
        assert!(debug.contains("min(ih,480)"));
    }

    #[test]
    fn webcam_capture_enables_preview_stream() {
        let profile = webcam_profile();
        let (command, _) = build_webcam_command(
            "ffmpeg",
            "USB Camera",
            &profile,
            "libx264",
            "webcam.mp4",
            None,
            Some(15),
        );
        let debug = format!("{command:?}");

        assert!(debug.contains("split=2"));
        assert!(debug.contains("image2pipe"));
        assert!(debug.contains("mjpeg"));
        assert!(debug.contains("fps=15"));
    }

    #[test]
    fn webcam_preview_off_omits_mjpeg_and_split() {
        let profile = webcam_profile();
        let (command, _) = build_webcam_command(
            "ffmpeg",
            "USB Camera",
            &profile,
            "libx264",
            "webcam.mp4",
            None,
            None,
        );
        let debug = format!("{command:?}");

        // With preview off there is no split/fps/mjpeg output at all — stdout
        // stays Stdio::null so nothing is piped to a preview server.
        assert!(!debug.contains("split=2"));
        assert!(!debug.contains("image2pipe"));
        assert!(!debug.contains("mjpeg"));
        assert!(!debug.contains("vprev"));
    }

    #[test]
    #[cfg(windows)]
    fn webcam_negotiated_mode_sets_input_options() {
        let profile = webcam_profile();
        let mode = CameraMode {
            width: 1280,
            height: 720,
            fps: 25.0,
            pixel_format: Some("nv12".into()),
            codec: None,
        };
        let (command, backend) = build_webcam_command(
            "ffmpeg",
            "USB Camera",
            &profile,
            "libx264",
            "webcam.mp4",
            Some(&mode),
            None,
        );
        let debug = format!("{command:?}");

        assert!(debug.contains("\"-video_size\" \"1280x720\""));
        assert!(debug.contains("\"-framerate\" \"25\""));
        assert!(debug.contains("\"-pixel_format\" \"nv12\""));
        // The negotiated input options must appear before -i.
        let input_pos = debug.find("\"-i\" \"video=").unwrap();
        let size_pos = debug.find("-video_size").unwrap();
        assert!(size_pos < input_pos);
        // Output rate follows the negotiated 25fps, not the 30fps profile.
        assert!(debug.contains("\"-r\" \"25\""));
        assert_eq!(backend, "dshow-camera");
    }

    #[test]
    #[cfg(windows)]
    fn webcam_negotiated_fractional_fps_is_not_duplicated() {
        let profile = webcam_profile(); // 30fps profile
        let mode = CameraMode {
            width: 640,
            height: 480,
            fps: 29.97,
            pixel_format: Some("yuyv422".into()),
            codec: None,
        };
        let (command, _) = build_webcam_command(
            "ffmpeg",
            "USB Camera",
            &profile,
            "libx264",
            "webcam.mp4",
            Some(&mode),
            None,
        );
        let debug = format!("{command:?}");

        // 29.97 input must not be duplicated up to 30.
        assert!(debug.contains("\"-framerate\" \"29.97\""));
        assert!(debug.contains("\"-r\" \"29.97\""));
    }

    #[test]
    #[cfg(windows)]
    fn webcam_negotiated_codec_mode_uses_vcodec() {
        let profile = webcam_profile();
        let mode = CameraMode {
            width: 1280,
            height: 720,
            fps: 30.0,
            pixel_format: None,
            codec: Some("mjpeg".into()),
        };
        let (command, _) = build_webcam_command(
            "ffmpeg",
            "USB Camera",
            &profile,
            "libx264",
            "webcam.mp4",
            Some(&mode),
            None,
        );
        let debug = format!("{command:?}");

        assert!(debug.contains("\"-vcodec\" \"mjpeg\""));
        assert!(!debug.contains("-pixel_format"));
    }

    fn gpu_screen_test_config(width: i32, height: i32) -> RecordingConfig {
        RecordingConfig {
            source: CaptureSource {
                kind: "display".into(),
                id: "display-0".into(),
                name: "Display".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width,
                    height,
                },
            },
            profile: "balanced".into(),
            capture_microphone: false,
            capture_system_audio: false,
            capture_webcam: false,
            webcam_device_id: None,
            microphone_device_id: None,
            system_audio_device_id: None,
            webcam_preview_mode: Default::default(),
            gpu_screen_capture: true,
            smart_zoom_enabled: false,
            smart_zoom_preset: "product-demo".into(),
        }
    }

    fn gpu_screen_test_profile() -> RecordingProfile {
        RecordingProfile {
            id: "balanced".into(),
            label: "Balanced".into(),
            width: 1280,
            height: 720,
            fps: 30,
            video_bitrate_kbps: None,
            crf: Some(23),
            encoder_priority: vec!["libx264".into()],
            audio_codec: "aac".into(),
            audio_bitrate_kbps: 128,
        }
    }

    #[test]
    #[cfg(windows)]
    fn gpu_filter_scales_matching_aspect_for_d3d11_encoder() {
        let config = gpu_screen_test_config(1920, 1080);
        let profile = gpu_screen_test_profile();
        let filter = gpu_screen_filter(&config, &profile, "h264_mf", true)
            .expect("matching even-size capture qualifies");
        assert_eq!(
            filter,
            "[0:v]scale_d3d11=width=1280:height=720:format=nv12[vout]"
        );
        assert_eq!(
            gpu_screen_filter(&config, &profile, "h264_nvenc", true),
            Some(filter.clone())
        );
        assert_eq!(
            gpu_screen_filter(&config, &profile, "h264_amf", true),
            Some(filter)
        );
    }

    #[test]
    #[cfg(not(windows))]
    fn gpu_filter_never_qualifies_off_windows() {
        // The D3D11-resident pipeline is Windows-only by construction —
        // identical otherwise-eligible inputs must yield None elsewhere.
        let config = gpu_screen_test_config(1920, 1080);
        let profile = gpu_screen_test_profile();
        assert!(gpu_screen_filter(&config, &profile, "h264_mf", true).is_none());
        assert!(gpu_screen_filter(&config, &profile, "h264_nvenc", true).is_none());
    }

    #[test]
    fn gpu_filter_rejects_non_qualifying_chains() {
        let config = gpu_screen_test_config(1920, 1080);
        let profile = gpu_screen_test_profile();

        // Mismatched aspect would distort — never allowed on the GPU path.
        assert!(gpu_screen_filter(
            &gpu_screen_test_config(1920, 1200),
            &profile,
            "h264_mf",
            true
        )
        .is_none());
        // Portrait and odd dimensions cannot produce even NV12 output.
        assert!(gpu_screen_filter(
            &gpu_screen_test_config(1080, 1920),
            &profile,
            "h264_mf",
            true
        )
        .is_none());
        assert!(gpu_screen_filter(
            &gpu_screen_test_config(1919, 1080),
            &profile,
            "h264_mf",
            true
        )
        .is_none());
        // Software and non-D3D11 encoders never see the GPU filter.
        assert!(gpu_screen_filter(&config, &profile, "libx264", true).is_none());
        assert!(gpu_screen_filter(&config, &profile, "h264_qsv", true).is_none());
        // The user-facing toggle vetoes the pipeline entirely.
        let mut disabled = gpu_screen_test_config(1920, 1080);
        disabled.gpu_screen_capture = false;
        assert!(gpu_screen_filter(&disabled, &profile, "h264_mf", true).is_none());
        // Without ddagrab input frames there is no GPU residency to exploit.
        assert!(gpu_screen_filter(&config, &profile, "h264_mf", false).is_none());
    }

    #[test]
    fn gpu_frames_encoder_args_use_d3d11() {
        let profile = test_profile();

        let mut command = Command::new("ffmpeg");
        add_video_encoder_for_frames(&mut command, &profile, "h264_mf", false, 30.0, true);
        let debug = format!("{command:?}");
        assert!(debug.contains("\"-hw_encoding\" \"1\""));
        assert!(debug.contains("\"-pix_fmt\" \"d3d11\""));
        assert!(!debug.contains("nv12"));

        let mut command = Command::new("ffmpeg");
        add_video_encoder_for_frames(&mut command, &profile, "h264_nvenc", false, 30.0, true);
        let debug = format!("{command:?}");
        assert!(debug.contains("\"-pix_fmt\" \"d3d11\""));
        assert!(!debug.contains("-hw_encoding"));
    }

    #[test]
    fn mediafoundation_capture_forces_hardware_nv12() {
        let profile = test_profile();
        let mut command = Command::new("ffmpeg");
        add_video_encoder(&mut command, &profile, "h264_mf", false, 30.0);
        let debug = format!("{command:?}");

        assert!(debug.contains("\"-hw_encoding\" \"1\""));
        assert!(debug.contains("\"-pix_fmt\" \"nv12\""));
        assert!(!debug.contains("yuv420p"));
    }

    #[test]
    fn software_encoder_keeps_yuv420p() {
        let profile = test_profile();
        let mut command = Command::new("ffmpeg");
        add_video_encoder(&mut command, &profile, "libx264", false, 30.0);
        let debug = format!("{command:?}");

        assert!(debug.contains("\"-pix_fmt\" \"yuv420p\""));
        assert!(!debug.contains("-hw_encoding"));
    }

    #[test]
    fn screen_command_reports_actual_backend() {
        let config = RecordingConfig {
            source: region_source(0, 0, 800, 600),
            profile: "balanced".into(),
            capture_microphone: false,
            capture_system_audio: false,
            capture_webcam: false,
            webcam_device_id: None,
            microphone_device_id: None,
            system_audio_device_id: None,
            webcam_preview_mode: Default::default(),
            gpu_screen_capture: true,
            smart_zoom_enabled: false,
            smart_zoom_preset: "product-demo".into(),
        };
        let (command, backend) = build_screen_command(
            "ffmpeg",
            &config,
            &test_profile(),
            "libx264",
            "seg.mp4",
            false,
        );
        let debug = format!("{command:?}");

        // Without ddagrab the Windows build must report the gdigrab path.
        if cfg!(windows) {
            assert_eq!(backend, "gdigrab");
        }
        // Every capture process gets machine-readable progress on stderr.
        assert!(debug.contains("-progress"));
        assert!(debug.contains("pipe:2"));
        assert!(debug.contains("-nostats"));
    }
}
