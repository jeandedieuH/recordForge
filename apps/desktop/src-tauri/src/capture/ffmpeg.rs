use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tracing::{info, instrument};

use super::camera_plan::{CameraCapturePlan, CameraFit};
use super::config::{RecordingConfig, RecordingProfile};
use super::disk;
use super::manifest::{RecordingFragment, RecordingManifest, RecordingStats};
use super::metrics::{CaptureDiagnostics, CaptureProgress, CaptureProgressState};
use super::source::{Bounds, CaptureSource};
use super::traits::TimelineAnchor;
use super::webcam::CameraMode;

/// Everything FFmpeg needs to describe a PipeWire-driven `rawvideo` input.
/// Produced by `linux_pipewire::LinuxPipeWireCapture`; defined here (instead of
/// in the Linux-only module) so `build_screen_command` stays platform-neutral.
/// Populated only on Linux Wayland sessions.
#[derive(Debug, Clone)]
pub struct PipeWireVideoInput {
    /// FFmpeg `-pixel_format` argument for the negotiated stream.
    pub pixel_format: &'static str,
    pub width: u32,
    pub height: u32,
    /// Stream-native frame rate — feeds `-framerate`; the filter chain
    /// resamples to the profile's target fps afterwards.
    pub framerate_num: u32,
    pub framerate_den: u32,
    /// Region crop in stream-local coordinates (Wayland region capture crops a
    /// monitor stream); `None` captures the whole frame.
    pub crop: Option<Bounds>,
    /// Read end of the frame pipe; the ffmpeg child gets it dup'd onto fd 3.
    pub read_fd: i32,
}

/// A pre-negotiated Linux Wayland capture handed to `FfmpegCapture::start`.
/// Platform-neutral on purpose: on non-Linux systems it is always `Default`
/// (`video_input: None`), so `start`'s signature stays uniform.
///
/// The session negotiates the portal BEFORE spawning the cursor/audio
/// auxiliaries so the stream geometry is already published when the cursor
/// tracker reads it (the PipeWire capture sets `wayland_stream_geometry`
/// inside `start_if_wayland`).
#[derive(Default)]
pub struct LinuxCaptureBundle {
    pub video_input: Option<PipeWireVideoInput>,
    #[cfg(target_os = "linux")]
    pub capture: Option<super::linux_pipewire::LinuxPipeWireCapture>,
}

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
    /// DirectShow sample/graph clock correlation, fed by the stderr reader.
    /// Populated only for `dshow-camera` captures; other backends stay empty.
    camera_timing: Arc<Mutex<super::camera_timing::CameraTimingState>>,
    /// Wayland screen capture: the PipeWire consumer feeding fd 3. Held so the
    /// stream's lifetime is bound to the capture's; `request_stop` shuts it
    /// down before 'q' so FFmpeg drains cleanly.
    #[cfg(target_os = "linux")]
    linux_pipewire: Option<super::linux_pipewire::LinuxPipeWireCapture>,
    /// ScreenCaptureKit stream feeding fd 3 — same lifetime contract as the
    /// PipeWire producer above.
    #[cfg(target_os = "macos")]
    macos_sck: Option<super::macos_sck::MacosSckCapture>,
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
    /// Diagnostics slot: `true` records this capture under the segment's
    /// `camera` entry (primary camera-mode recordings), `false` under
    /// `screen`. The webcam sidecar leaves this false — its diagnostics are
    /// attached explicitly by the session with `camera=true`.
    camera: bool,
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
    #[instrument(skip(ffmpeg_path, config, profile, manifest, output, linux_bundle))]
    pub fn start(
        ffmpeg_path: &str,
        config: &RecordingConfig,
        profile: &RecordingProfile,
        encoder: &str,
        output: &str,
        fragment_index: u32,
        manifest: Option<Arc<Mutex<RecordingManifest>>>,
        ddagrab_available: bool,
        linux_bundle: &mut LinuxCaptureBundle,
    ) -> crate::errors::Result<Self> {
        // Wayland: the session negotiated the portal + PipeWire path ahead of
        // the auxiliaries. The capture object stays in the bundle until a
        // child actually spawns — an encoder retry reuses the same producer.
        let external_video_input = linux_bundle.video_input.as_ref();

        // macOS: start the ScreenCaptureKit stream first so its fd-3
        // `rawvideo` input can drive the command build; `None` (pre-13 OS,
        // missing permission, empty shareable content) keeps the
        // avfoundation fallback the branch below already handles.
        #[cfg(target_os = "macos")]
        let macos_capture =
            match super::macos_sck::MacosSckCapture::start_if_available(&config.source, profile) {
                Ok(capture) => capture,
                Err(error) => {
                    tracing::warn!(
                        error = ?error,
                        "ScreenCaptureKit startup failed; falling back to avfoundation"
                    );
                    None
                }
            };
        #[cfg(target_os = "macos")]
        let macos_video_input = macos_capture.as_ref().map(|c| c.video_input());

        let external_video_input = {
            #[cfg(target_os = "macos")]
            {
                external_video_input.or(macos_video_input.as_ref())
            }
            #[cfg(not(target_os = "macos"))]
            {
                external_video_input
            }
        };

        let (command, backend) = build_screen_command(
            ffmpeg_path,
            config,
            profile,
            encoder,
            output,
            ddagrab_available,
            external_video_input,
        );
        let meta = CaptureMeta {
            startup_timeout: STARTUP_FRAME_TIMEOUT,
            encoder: encoder.to_string(),
            backend: backend.to_string(),
            requested_fps: profile.fps as f64,
            camera_mode: None,
            preview_fps: None,
            camera: false,
        };
        match run(
            command,
            output,
            fragment_index,
            manifest.clone(),
            None,
            meta,
        ) {
            Ok(capture) => {
                #[cfg(target_os = "linux")]
                let capture = {
                    let mut capture = capture;
                    capture.linux_pipewire = linux_bundle.capture.take();
                    capture
                };
                #[cfg(target_os = "macos")]
                let capture = {
                    let mut capture = capture;
                    capture.macos_sck = macos_capture;
                    capture
                };
                Ok(capture)
            }
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
                    external_video_input,
                );
                let meta = CaptureMeta {
                    startup_timeout: STARTUP_FRAME_TIMEOUT,
                    encoder: encoder.to_string(),
                    backend: backend.to_string(),
                    requested_fps: profile.fps as f64,
                    camera_mode: None,
                    preview_fps: None,
                    camera: false,
                };
                let mut capture = run(command, output, fragment_index, manifest, None, meta)?;
                #[cfg(target_os = "linux")]
                {
                    capture.linux_pipewire = linux_bundle.capture.take();
                }
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
            camera: false,
        };
        run(command, output, 0, manifest, broadcaster, meta)
    }

    /// Build and start a camera-primary FFmpeg capture (camera-only mode).
    ///
    /// The camera process occupies the PRIMARY capture slot: the fragment is
    /// registered in the manifest at `fragment_index` (the way `seg_NNN.mp4`
    /// is for screen captures) and diagnostics land under the segment's
    /// camera entry via `meta.camera`. `plan.input` is the negotiated mode
    /// (`None` = device defaults); `preview_fps` selects the MJPEG preview
    /// rate (`None` = no preview output at all).
    #[allow(clippy::too_many_arguments)]
    #[instrument(skip(ffmpeg_path, output, device, plan, manifest, broadcaster))]
    pub fn start_camera(
        ffmpeg_path: &str,
        device: &str,
        plan: &CameraCapturePlan,
        encoder: &str,
        output: &str,
        fragment_index: u32,
        manifest: Option<Arc<Mutex<RecordingManifest>>>,
        broadcaster: Option<super::preview_server::FrameBroadcaster>,
        preview_fps: Option<i32>,
        startup_timeout: Duration,
    ) -> crate::errors::Result<Self> {
        let preview_fps = broadcaster.as_ref().and(preview_fps);
        let (command, backend) =
            build_camera_command(ffmpeg_path, device, plan, encoder, output, preview_fps);
        let meta = CaptureMeta {
            startup_timeout,
            encoder: encoder.to_string(),
            backend: backend.to_string(),
            // The plan's output rate IS the requested rate — the lock/planner
            // already folded the negotiated mode's rate into it.
            requested_fps: plan.output_fps,
            camera_mode: plan.input.clone(),
            preview_fps,
            camera: true,
        };
        run(command, output, fragment_index, manifest, broadcaster, meta)
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
            camera_first_frame_offset_ms: self.camera_first_frame_offset_ms(),
            camera_timing_rejection: self.camera_timing_rejection(),
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

    /// Measured camera file origin relative to this process's spawn instant,
    /// correlated from DirectShow sample/graph timestamps observed on stderr.
    /// `None` when the telemetry was missing, malformed, or implausible —
    /// callers must keep the duration-derived fallback in that case.
    pub fn camera_first_frame_offset_ms(&self) -> Option<u64> {
        self.camera_timing
            .lock()
            .ok()?
            .first_frame_offset_ms(STARTUP_FRAME_TIMEOUT)
    }

    /// Stable reason code when the measured camera origin is unavailable —
    /// `None` when the measurement succeeded or this capture never emits
    /// camera timing telemetry (screen captures, non-camera backends).
    /// `unsupported-backend` marks camera backends with no timestamp
    /// correlation path (non-Windows or the lavfi test source).
    fn camera_timing_rejection(&self) -> Option<String> {
        if !self.backend.ends_with("-camera") {
            return None;
        }
        if self.backend != "dshow-camera" {
            return Some("unsupported-backend".to_string());
        }
        self.camera_timing
            .lock()
            .ok()?
            .rejection_reason(STARTUP_FRAME_TIMEOUT)
            .map(str::to_string)
    }

    /// Send the graceful stop signal ("q\n") to FFmpeg immediately and record the
    /// quit instant, without blocking for process termination.
    pub fn request_stop(&mut self) -> Instant {
        let quit_at = Instant::now();
        #[cfg(target_os = "linux")]
        if let Some(mut pipewire) = self.linux_pipewire.take() {
            // Stop producing frames first so FFmpeg can drain its pipeline
            // and write a clean trailer instead of racing new input.
            pipewire.stop();
        }
        #[cfg(target_os = "macos")]
        if let Some(mut sck) = self.macos_sck.take() {
            // Same drain ordering as PipeWire: producer first, then 'q'.
            sck.stop();
        }
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
        #[cfg(target_os = "linux")]
        if let Some(mut pipewire) = self.linux_pipewire.take() {
            pipewire.stop();
        }
        #[cfg(target_os = "macos")]
        if let Some(mut sck) = self.macos_sck.take() {
            sck.stop();
        }
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
/// the progress stream is the single source of truth. A short `-stats_period`
/// bounds the latency of the "first progress block with frames" readiness
/// check in `run()` — and therefore how long the countdown overlay's GO state
/// lingers before the capture is confirmed live.
fn add_progress_reporting(command: &mut Command) {
    command.args(["-nostats", "-stats_period", "0.2", "-progress", "pipe:2"]);
}

#[cfg_attr(not(target_os = "linux"), allow(unused_variables))]
fn build_screen_command(
    ffmpeg_path: &str,
    config: &RecordingConfig,
    profile: &RecordingProfile,
    encoder: &str,
    output: &str,
    ddagrab_available: bool,
    external_video_input: Option<&PipeWireVideoInput>,
) -> (Command, &'static str) {
    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .arg("-y");
    add_progress_reporting(&mut command);
    add_vaapi_device(&mut command, encoder);

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

    // Prefer the GPU-resident pipeline when the whole chain qualifies;
    // otherwise keep the CPU `hwdownload` filter and report that backend.
    let gpu_filter = gpu_screen_filter(config, profile, encoder, use_ddagrab);

    if gpu_filter.is_some() && encoder == "h264_qsv" {
        // Quick Sync frames are derived from the D3D11 capture device, so both
        // devices must be initialised. `-init_hw_device` is a global option and
        // therefore has to precede the input it applies to.
        command.args([
            "-init_hw_device",
            "d3d11va=dx",
            "-init_hw_device",
            "qsv=qs@dx",
        ]);
    }

    let (cpu_backend, screen_crop) = add_screen_video_input(
        &mut command,
        ffmpeg_path,
        &config.source,
        profile,
        ddagrab_target,
        external_video_input,
    );

    let (video_filter, backend) = match gpu_filter {
        Some(filter) => (filter, "ddagrab-gpu"),
        None => (
            build_video_filter(
                &config.source,
                profile,
                encoder,
                use_ddagrab,
                external_video_input,
                screen_crop,
            ),
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
        screen_pix_fmt(encoder, backend),
    );

    command.args([
        "-movflags",
        segment_movflags(encoder),
        "-frag_duration",
        "2000000",
        "-min_frag_duration",
        "2000000",
        output,
    ]);

    info!(encoder, backend, "built screen ffmpeg command");
    (command, backend)
}

/// `-rtbufsize` ceiling for a camera input delivering frames of `input_pixels`.
///
/// DirectShow (and AVFoundation/v4l2 behind `-thread_queue_size`) buffers
/// *input* frames, so the ceiling must be derived from the negotiated input
/// mode — a 4K sensor scaled down to 720p still queues 4K frames. 32/64/256 MB
/// is roughly 8-17 frames depending on the pixel format: enough jitter slack,
/// without letting a slow encoder accumulate hundreds of MB and make the
/// self-view visibly lag.
#[cfg_attr(not(windows), allow(dead_code))]
fn camera_rtbufsize(input_pixels: u64) -> &'static str {
    if input_pixels <= 1280 * 720 {
        "32M"
    } else if input_pixels <= 1920 * 1080 {
        "64M"
    } else {
        "256M"
    }
}

/// `-thread_queue_size` (demuxer packets) for a camera input.
///
/// Each raw packet is a whole frame, so a deep queue is a hidden multi-hundred
/// MB buffer that only shows up when the encoder falls behind. Eight frames
/// (the FFmpeg default) is enough slack on top of `-rtbufsize`; compressed
/// packets (MJPEG/H.264) are small, so a slightly deeper queue is cheap.
fn camera_queue_size(raw_frames: bool) -> &'static str {
    if raw_frames {
        "8"
    } else {
        "16"
    }
}

/// Emit the VAAPI device selection when `encoder` needs it.
///
/// Placed before the input so the encoder is initialised against the same
/// render node the startup probe validated (see
/// `capture::encoder::vaapi_render_node` — multi-GPU machines do not
/// necessarily encode on `renderD128`). Also used by the webcam concat job
/// (`capture::media`), which re-encodes sidecar segments.
pub(crate) fn add_vaapi_device(command: &mut Command, encoder: &str) {
    if super::encoder::is_vaapi_encoder(encoder) {
        command.args(["-vaapi_device", &super::encoder::vaapi_render_node()]);
    }
}

/// Filter chain segment that moves software frames onto the VAAPI device.
///
/// VAAPI encoders only accept `vaapi` hw frames, so the recording branch must
/// end with this stage. It is never applied to preview/JPEG branches — the
/// MJPEG encoder needs system memory.
pub(crate) const VAAPI_UPLOAD: &str = "format=nv12,hwupload";
/// `-thread_queue_size` (demuxer packets) for a screen/desktop input.
///
/// Each raw packet is a whole BGRA frame (~8 MB at 1080p, ~33 MB at 4K), so a
/// flat depth is either uselessly shallow at low resolution or a multi-GB
/// backlog at high resolution — the previous 512 allowed 4 GB+ at 1080p and
/// 16 GB+ at 4K whenever the encoder fell behind. Keep ~96 MiB of frames in
/// flight (the same budget the export plate feed uses, see
/// `exports::stdin_thread_queue_size`) with a 4-frame floor so 4K+ still
/// absorbs encoder jitter instead of emptying the queue on every stall.
fn screen_queue_size(input_pixels: u64) -> usize {
    let frame_bytes = input_pixels.max(1) * 4; // BGRA
    (96 * 1024 * 1024 / frame_bytes).clamp(4, 32) as usize
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
    add_vaapi_device(&mut command, encoder);

    // Windows only: keep source timestamps (-copyts stops the demuxer from
    // re-basing the camera clock) and raise the log level so the DirectShow
    // packet trace reaches stderr for camera clock correlation in Rust.
    #[cfg(windows)]
    command.args(["-copyts", "-loglevel", "verbose"]);

    // Input packets are buffered by the OS capture backend, so the sizing
    // knobs follow the NEGOTIATED INPUT mode, never the output profile: a 4K
    // sensor scaled down to 720p still queues 4K raw frames. Device-defaults
    // mode assumes raw 720p (the sidecar's ceiling).
    let raw_frames = mode.map(|mode| mode.pixel_format.is_some()).unwrap_or(true);
    #[cfg(windows)]
    let input_pixels = mode
        .map(|mode| u64::from(mode.width) * u64::from(mode.height))
        .unwrap_or(1280 * 720);

    #[cfg(windows)]
    let backend = {
        command.args([
            "-f",
            "dshow",
            "-thread_queue_size",
            camera_queue_size(raw_frames),
            "-rtbufsize",
            camera_rtbufsize(input_pixels),
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
            // Keep the driver's sample timestamps so the camera file carries
            // driver sample times; the DirectShow graph clock is correlated
            // back to the capture timeline in Rust from the verbose packet
            // trace (see capture::camera_timing).
            "-use_video_device_timestamps",
            "1",
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
            camera_queue_size(raw_frames),
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
            camera_queue_size(raw_frames),
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
    // Windows only: normalize the file origin to zero BEFORE scale/split so
    // both recording and preview see the same rebased timestamps. The
    // original PTS is preserved for stats (`{ptsi}`) and for `-stats_enc_pre`.
    #[cfg(windows)]
    let scale = format!("setpts=PTS-STARTPTS,{scale}");
    // VAAPI: upload only the recording branch. The self-view stays on the CPU
    // (MJPEG consumes system frames), so the upload sits after the split.
    let vaapi = super::encoder::is_vaapi_encoder(encoder);
    let filter = match (preview_fps, vaapi) {
        (Some(preview_fps), true) => format!(
            "[0:v]{scale},split=2[vrec][vprev];[vrec]{VAAPI_UPLOAD}[vout];[vprev]fps={preview_fps},scale=320:-2[vprev_out]"
        ),
        (Some(preview_fps), false) => format!(
            "[0:v]{scale},split=2[vout][vprev];[vprev]fps={preview_fps},scale=320:-2[vprev_out]"
        ),
        (None, true) => format!("[0:v]{scale},{VAAPI_UPLOAD}[vout]"),
        (None, false) => format!("[0:v]{scale}[vout]"),
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
    // Windows only, camera output only: disable B-frame reordering so the
    // fragmented MP4 origin is normalized consistently, and emit the original
    // input PTS of every encoded frame on stderr for clock correlation.
    // Screen and concat encoders are intentionally unchanged.
    #[cfg(windows)]
    command.args([
        "-bf",
        "0",
        "-stats_enc_pre",
        "pipe:2",
        "-stats_enc_pre_fmt",
        super::camera_timing::CAMERA_FRAME_STATS_FORMAT,
    ]);
    command.args([
        "-movflags",
        segment_movflags(encoder),
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
            // Quality 7 (of 31) is invisible at the 220 px self-view size and
            // keeps the pipe/HTTP/WebView payload well under quality 5.
            "-q:v",
            "7",
            "-f",
            "image2pipe",
            "-",
        ]);
    }

    info!(encoder, backend, preview_fps, "built webcam ffmpeg command");
    (command, backend)
}

/// Build the FFmpeg command for a camera-primary capture (camera-only mode).
///
/// Same dshow/avfoundation/v4l2 input plumbing as `build_webcam_command`, but
/// tuned for the primary recording: realtime input buffering scaled to the
/// frame size (4K raw over USB3 needs far more slack than 720p MJPEG),
/// explicit CFR at the plan's output rate, and the plan's exact output
/// geometry selected by `plan.fit`. The sidecar builder stays untouched —
/// sharing input-args code would churn its byte-identical argv for no
/// benefit.
fn build_camera_command(
    ffmpeg_path: &str,
    device: &str,
    plan: &CameraCapturePlan,
    encoder: &str,
    output: &str,
    preview_fps: Option<i32>,
) -> (Command, &'static str) {
    let enable_preview = preview_fps.is_some();
    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .stdin(Stdio::piped())
        .stdout(if camera_pipes_stdout(enable_preview) {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::piped())
        .arg("-y");
    add_progress_reporting(&mut command);
    add_vaapi_device(&mut command, encoder);

    #[cfg(windows)]
    command.args(["-copyts", "-loglevel", "verbose"]);

    // Input buffering is sized from the negotiated INPUT mode — the output is
    // only the fit ceiling. Device defaults leave the delivered size unknown,
    // so size for at least 1080p raw rather than the (possibly smaller)
    // output budget.
    #[cfg(windows)]
    let rtbufsize = camera_rtbufsize(plan.input.as_ref().map_or_else(
        || {
            let output = u64::from(plan.output_width) * u64::from(plan.output_height);
            output.max(1920 * 1080)
        },
        |mode| u64::from(mode.width) * u64::from(mode.height),
    ));
    let queue_size = camera_queue_size(
        plan.input
            .as_ref()
            .map(|mode| mode.pixel_format.is_some())
            .unwrap_or(false),
    );

    #[cfg(windows)]
    let backend = {
        // DirectShow on Windows — the camera device id is the friendly name
        // used verbatim in `video=<id>`.
        command.args([
            "-f",
            "dshow",
            "-thread_queue_size",
            queue_size,
            "-rtbufsize",
            rtbufsize,
        ]);
        // Negotiated mode pinning — same shape as the sidecar path; with no
        // negotiated mode the device defaults are used as-is.
        if let Some(mode) = plan.input.as_ref() {
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
            "-use_video_device_timestamps",
            "1",
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
            queue_size,
            "-framerate",
            &format!("{}", plan.output_fps),
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
            queue_size,
            "-framerate",
            &format!("{}", plan.output_fps),
            "-i",
            device,
        ]);
        "v4l2-camera"
    };
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    let backend = {
        command.args([
            "-f",
            "lavfi",
            "-i",
            &format!(
                "testsrc=size={}x{}:rate={}",
                plan.output_width, plan.output_height, plan.output_fps
            ),
        ]);
        "lavfi-testsrc"
    };

    // Fit the negotiated input onto the planned output frame. Native needs
    // no scale; Adaptive is the device-defaults attempt where the real input
    // size is unknown until frames arrive (min-clamp, never upscale).
    let fit_filter = match plan.fit {
        CameraFit::Native => None,
        CameraFit::Scale => Some(format!("scale={}:{}", plan.output_width, plan.output_height)),
        CameraFit::Letterbox => Some(format!(
            "scale=w={}:h={}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2:color=black",
            plan.output_width, plan.output_height, plan.output_width, plan.output_height
        )),
        CameraFit::Adaptive => Some(format!(
            "scale=w='min(iw,{})':h='min(ih,{})':force_original_aspect_ratio=decrease:force_divisible_by=2",
            plan.output_width, plan.output_height
        )),
    };
    let mut filters: Vec<String> = Vec::new();
    #[cfg(windows)]
    filters.push("setpts=PTS-STARTPTS".to_string());
    if let Some(fit) = fit_filter {
        filters.push(fit);
    }
    if filters.is_empty() {
        // Keep the filter graph syntactically valid when nothing needs doing
        // (native fit on non-Windows).
        filters.push("null".to_string());
    }
    let chain = filters.join(",");
    // VAAPI: upload only the recording branch; the self-view MJPEG encoder
    // needs system-memory frames, so the upload follows the split.
    let vaapi = super::encoder::is_vaapi_encoder(encoder);
    let filter = match (preview_fps, vaapi) {
        (Some(preview_fps), true) => format!(
            "[0:v]{chain},split=2[vrec][vprev];[vrec]{VAAPI_UPLOAD}[vout];[vprev]fps={preview_fps},scale=480:-2[vprev_out]"
        ),
        (Some(preview_fps), false) => format!(
            "[0:v]{chain},split=2[vout][vprev];[vprev]fps={preview_fps},scale=480:-2[vprev_out]"
        ),
        (None, true) => format!("[0:v]{chain},{VAAPI_UPLOAD}[vout]"),
        (None, false) => format!("[0:v]{chain}[vout]"),
    };
    command
        .args(["-filter_complex", &filter])
        .args(["-map", "[vout]"]);

    // Explicit CFR pins every emitted frame to the plan's cadence —
    // fractional input rates (29.97) stay fractional instead of drifting to
    // whatever vsync defaults would round to.
    command
        .args(["-fps_mode", "cfr"])
        .args(["-r", &format!("{}", plan.output_fps)]);

    super::camera_encode::add_camera_encoder_args(&mut command, plan, encoder);

    #[cfg(windows)]
    command.args([
        // Same rationale as the sidecar: no B-frame reorder buffer, and emit
        // pre-encode frame stats so camera clock correlation still works.
        "-bf",
        "0",
        "-stats_enc_pre",
        "pipe:2",
        "-stats_enc_pre_fmt",
        super::camera_timing::CAMERA_FRAME_STATS_FORMAT,
    ]);

    // Fragmented MP4 — partial chunks stay playable if the process dies.
    command.args([
        "-movflags",
        segment_movflags(encoder),
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
            // Quality 7 (of 31) is invisible at the 220 px self-view size and
            // keeps the pipe/HTTP/WebView payload well under quality 5.
            "-q:v",
            "7",
            "-f",
            "image2pipe",
            "-",
        ]);
    }

    (command, backend)
}

/// Whether the camera command pipes stdout. Only true when a preview output
/// exists — with no MJPEG sink the stdout is a null device so an unread pipe
/// can never stall the encode.
fn camera_pipes_stdout(enable_preview: bool) -> bool {
    enable_preview
}

/// Push the platform screen input arguments and return the backend name that
/// was actually used plus an optional screen-space crop (region/window
/// sources on backends that can only ingest whole displays — macOS today,
/// matching the PipeWire `input.crop` mechanism on Linux).
// `ffmpeg_path` is only consumed by the macOS branch (AVFoundation device
// resolution); on Linux/Windows it's dead weight, so silence the lint there.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
fn add_screen_video_input(
    command: &mut Command,
    ffmpeg_path: &str,
    source: &CaptureSource,
    profile: &RecordingProfile,
    ddagrab_target: Option<super::outputs::DxgiOutputEntry>,
    external_video_input: Option<&PipeWireVideoInput>,
) -> (&'static str, Option<Bounds>) {
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
        let queue = screen_queue_size(u64::from(width.max(2)) * u64::from(height.max(2)));
        command.args([
            "-f",
            "lavfi",
            "-thread_queue_size",
            &queue.to_string(),
            "-i",
            &ddagrab,
        ]);
        ("ddagrab-cpu", None)
    } else if cfg!(windows)
        && (source.kind == "display" || source.kind == "window" || source.kind == "region")
    {
        // GDI captures the selected rectangle directly. The sidecar FFmpeg
        // binary is DPI-unaware, so Windows virtualizes its GDI coordinates by
        // the system DPI: physical desktop pixels must be divided by the system
        // scale before being handed to gdigrab (a no-op at 100% scaling).
        // -draw_mouse 0 hides the native mouse cursor so software custom cursor overlay can be customized post-recording.
        let logical = gdigrab_logical_bounds(bounds, system_dpi());
        let queue = screen_queue_size(
            u64::from(logical.width.max(2) as u32) * u64::from(logical.height.max(2) as u32),
        );
        command.args([
            "-f",
            "gdigrab",
            "-draw_mouse",
            "0",
            "-thread_queue_size",
            &queue.to_string(),
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
        ("gdigrab", None)
    } else if cfg!(target_os = "macos")
        && (source.kind == "display" || source.kind == "window" || source.kind == "region")
    {
        // ScreenCaptureKit: BGRA frames arrive packed on an OS pipe, consumed
        // as `rawvideo` on fd 3 — the same contract as the PipeWire input
        // below, so the rest of the pipeline is identical. The system cursor
        // is excluded at the SCK level (`showsCursor: false`) so the overlay
        // cursor stays the only pointer in the recording.
        #[cfg(target_os = "macos")]
        if let Some(input) = external_video_input {
            use std::os::unix::process::CommandExt;
            command.args([
                "-f",
                "rawvideo",
                "-pixel_format",
                input.pixel_format,
                "-video_size",
                &format!("{}x{}", input.width, input.height),
                "-framerate",
                &format!("{}/{}", input.framerate_num, input.framerate_den),
                "-i",
                "pipe:3",
            ]);
            let read_fd = input.read_fd;
            // SAFETY: dup2 in the child after fork, before exec. fd 3 is free
            // (stdio are 0/1/2) and dup2 clears CLOEXEC on the new fd.
            unsafe {
                command.pre_exec(move || {
                    if libc::dup2(read_fd, 3) == -1 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(())
                    }
                });
            }
            return ("screencapturekit", input.crop);
        }
        // macOS AVFoundation screen input. `Capture screen N` devices follow
        // CG display order — resolve the display that owns the source so
        // multi-monitor setups capture the right screen (the old
        // `default:none` selected the default *camera*). Window/region
        // sources crop the display-sized frame in the video filter, the same
        // shape as the PipeWire path.
        #[cfg(target_os = "macos")]
        let (device_spec, crop, input_pixels) = {
            let input = super::macos_native::resolve_screen_input(ffmpeg_path, source);
            // AVFoundation delivers the whole display; a window/region crop is
            // applied later in the filter graph, so size the queue for the
            // display, not the crop.
            let pixels = input
                .display
                .as_ref()
                .map(|display| {
                    u64::from(display.bounds.width.max(2) as u32)
                        * u64::from(display.bounds.height.max(2) as u32)
                })
                // Enumeration failed → assume 4K so the queue stays shallow.
                .unwrap_or(3840 * 2160);
            (input.device_spec, input.crop, pixels)
        };
        #[cfg(not(target_os = "macos"))]
        let (device_spec, crop, input_pixels) = ("default".to_string(), None, 3840 * 2160);
        let queue = screen_queue_size(input_pixels);
        command.args([
            "-f",
            "avfoundation",
            "-capture_cursor",
            "0",
            "-thread_queue_size",
            &queue.to_string(),
            "-framerate",
            &profile.fps.to_string(),
            "-i",
            &format!("{device_spec}:none"),
        ]);
        ("avfoundation-screen", crop)
    } else if cfg!(target_os = "linux")
        && (source.kind == "display" || source.kind == "window" || source.kind == "region")
    {
        // Wayland: PipeWire frames arrive packed on an OS pipe. The child
        // inherits the read end as fd 3 (`pre_exec` dup2) and reads it as a
        // `rawvideo` input — FFmpeg sees an ordinary file descriptor, no
        // libpipewire dependency inside the encoder process.
        #[cfg(target_os = "linux")]
        if let Some(input) = external_video_input {
            use std::os::unix::process::CommandExt;
            command.args([
                "-f",
                "rawvideo",
                "-pixel_format",
                input.pixel_format,
                "-video_size",
                &format!("{}x{}", input.width, input.height),
                "-framerate",
                &format!("{}/{}", input.framerate_num, input.framerate_den),
                "-i",
                "pipe:3",
            ]);
            let read_fd = input.read_fd;
            // SAFETY: dup2 in the child after fork, before exec. fd 3 is free
            // (stdio are 0/1/2) and dup2 clears CLOEXEC on the new fd.
            unsafe {
                command.pre_exec(move || {
                    if libc::dup2(read_fd, 3) == -1 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(())
                    }
                });
            }
            return ("pipewire-portal", None);
        }
        // Linux X11 screen input. Honour $DISPLAY: hardcoding :0 breaks on
        // non-default X servers (nested sessions, XDMCP, Xwayland-only
        // displays). Wayland sessions never reach this branch — they take the
        // PipeWire input above.
        let w = bounds.width.max(2);
        let h = bounds.height.max(2);
        let queue = screen_queue_size(u64::from(w as u32) * u64::from(h as u32));
        let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".to_string());
        command.args([
            "-f",
            "x11grab",
            "-draw_mouse",
            "0",
            "-thread_queue_size",
            &queue.to_string(),
            "-framerate",
            &profile.fps.to_string(),
            "-video_size",
            &format!("{}x{}", w, h),
            "-i",
            &format!("{display}+{},{}", bounds.x, bounds.y),
        ]);
        ("x11grab", None)
    } else {
        // Unknown source kinds still get a minimal input so FFmpeg does not
        // fail later in the filter graph with an obscure error.
        let fallback = format!(
            "testsrc=size={}x{}:rate={}",
            profile.width, profile.height, profile.fps
        );
        command.args(["-f", "lavfi", "-i", &fallback]);
        ("lavfi-testsrc", None)
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
/// chain supports it: ddagrab D3D11 frames in, a D3D11- or Quick-Sync-capable
/// encoder, matching aspect ratio (scaling must never distort), and even
/// dimensions for NV12. Anything else keeps the CPU `hwdownload` filter path.
/// Returning `None` is the compatibility verdict — the runtime start may still
/// fall back if the GPU graph fails to produce frames.
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
        || !matches!(encoder, "h264_nvenc" | "h264_amf" | "h264_mf" | "h264_qsv")
        || b.width <= 0
        || b.height <= 0
        || profile.width <= 0
        || profile.height <= 0
        || b.width % 2 != 0
        || b.height % 2 != 0
        || profile.width % 2 != 0
        || profile.height % 2 != 0
        || !aspect_fit_within_a_pixel(b, profile.width, profile.height)
    {
        return None;
    }
    Some(match encoder {
        // Quick Sync needs its own device derived from the D3D11 one. The VPP
        // stage also converts the full-range BGRA desktop into limited-range
        // NV12 — `scale_qsv` keeps the full-range tag, which plays back washed
        // out on players that honour it.
        "h264_qsv" => format!(
            "[0:v]hwmap=derive_device=qsv,vpp_qsv=w={}:h={}:format=nv12:out_range=tv[vout]",
            profile.width, profile.height
        ),
        _ => format!(
            "[0:v]scale_d3d11=width={}:height={}:format=nv12[vout]",
            profile.width, profile.height
        ),
    })
}

/// Whether scaling `bounds` straight to `width`×`height` deviates from the
/// fit filter's aspect-preserving result by less than a pixel on each axis.
///
/// The GPU graphs have no pad stage, so they can only be used when the output
/// geometry already matches the source aspect — `RecordingProfile::for_source_bounds`
/// makes that the normal case for window/region captures. Even-rounded output
/// sizes leave at most a fraction of a pixel of residual; anything larger must
/// letterbox (CPU path) rather than distort.
fn aspect_fit_within_a_pixel(bounds: Bounds, width: i32, height: i32) -> bool {
    if bounds.width <= 0 || bounds.height <= 0 || width <= 0 || height <= 0 {
        return false;
    }
    let scale = (f64::from(width) / f64::from(bounds.width))
        .min(f64::from(height) / f64::from(bounds.height));
    let residual = |target: i32, source: i32| f64::from(target) - f64::from(source) * scale;
    let (dw, dh) = (
        residual(width, bounds.width),
        residual(height, bounds.height),
    );
    (-0.5..1.5).contains(&dw) && (-0.5..1.5).contains(&dh)
}

#[cfg_attr(not(target_os = "linux"), allow(unused_variables))]
fn build_video_filter(
    source: &CaptureSource,
    profile: &RecordingProfile,
    encoder: &str,
    use_ddagrab: bool,
    external_video_input: Option<&PipeWireVideoInput>,
    screen_crop: Option<Bounds>,
) -> String {
    // ScreenCaptureKit can deliver NV12 already at the final size: there is
    // nothing left to crop, scale, pad or convert, so the graph is a no-op
    // passthrough instead of a full-frame swscale copy per frame.
    #[cfg(target_os = "macos")]
    if external_video_input.is_some_and(|input| {
        input.pixel_format == "nv12"
            && input.crop.is_none()
            && input.width == profile.width.max(1) as u32
            && input.height == profile.height.max(1) as u32
    }) {
        return "[0:v]null[vout]".to_string();
    }

    let threads = scale_threads(profile);
    let fit_filter =
        source
            .bounds
            .build_aspect_fit_filter_threads(profile.width, profile.height, threads);
    // VAAPI encoders only take hw frames, so the graph's final stage uploads.
    // Other hardware encoders take NV12 natively: ending the graph with an
    // explicit conversion keeps the single RGB→YUV pass inside the graph and
    // saves the encoder wrapper from doing its own.
    let tail = if super::encoder::is_vaapi_encoder(encoder) {
        format!(",{VAAPI_UPLOAD}")
    } else if encoder_prefers_nv12(encoder) {
        ",format=nv12".to_string()
    } else {
        String::new()
    };

    #[cfg(target_os = "linux")]
    if let Some(input) = external_video_input {
        // PipeWire delivers monitor-sized frames at the negotiated stream rate:
        // crop for region captures first, then normalize to a CFR stream.
        let mut chain = String::new();
        if let Some(crop) = input.crop {
            chain.push_str(&format!(
                "crop={}:{}:{}:{},",
                crop.width, crop.height, crop.x, crop.y
            ));
        }
        chain.push_str(&format!("fps={},", profile.fps));
        return format!("[0:v]{chain}{fit_filter}{tail}[vout]");
    }

    // Backends that only ingest whole displays (avfoundation `Capture screen
    // N`) crop to the source rect in the display's pixel space first — the
    // same shape as the PipeWire chain above.
    let crop_filter = screen_crop
        .map(|c| format!("crop={}:{}:{}:{},", c.width, c.height, c.x, c.y))
        .unwrap_or_default();

    if use_ddagrab {
        // ddagrab emits D3D11 hardware frames; download to system memory as
        // bgra before aspect-preserving scale and letterboxing (fixes P0.5).
        format!("[0:v]hwdownload,format=bgra,{fit_filter}{tail}[vout]")
    } else {
        format!("[0:v]{crop_filter}{fit_filter}{tail}[vout]")
    }
}

/// `scale` thread count for the compatibility path, if it should be raised.
///
/// libswscale defaults to one thread, but extra threads did **not** pay off on
/// the baseline machine: 1440p60 and 4K→1080p both stayed flat or regressed
/// (measured, see `docs/benchmarks/phase-4-results.md`) — the stage is
/// memory-bound and the capture source already saturates the memory bus. The
/// knob stays opt-in so other hardware can be measured without changing
/// defaults. `0` lets swscale pick the count.
fn scale_threads(profile: &RecordingProfile) -> Option<usize> {
    let enabled = std::env::var("RECORDFORGE_CAPTURE_SCALE_THREADS")
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "on"))
        .unwrap_or(false);
    (enabled && scale_threads_worth_trying(profile)).then_some(0)
}

/// Output sizes where multithreaded swscale is at least plausible: large
/// frames or high output rates.
fn scale_threads_worth_trying(profile: &RecordingProfile) -> bool {
    profile.width >= 2560 || profile.height >= 1440 || profile.fps >= 60
}

/// Whether `encoder` consumes system-memory NV12 frames natively.
///
/// VAAPI is excluded on purpose: its upload stage already produces NV12 hw
/// frames. Software encoders keep yuv420p.
fn encoder_prefers_nv12(encoder: &str) -> bool {
    matches!(
        encoder,
        "h264_nvenc"
            | "h264_amf"
            | "h264_qsv"
            | "h264_mf"
            | "h264_videotoolbox"
            | "hevc_videotoolbox"
    )
}

/// Fragmented-MP4 mux flags for a live capture segment.
///
/// `+empty_moov` is omitted for `h264_mf`: with `-hw_encoding 1` the hardware
/// MFT reports a "stream format change" and delivers its extradata only after
/// the empty moov is already written — the muxer then emits a corrupt first
/// sample and ffprobe cannot read the file at all (verified on the pinned
/// FFmpeg 9.0.1 sidecar). Without `empty_moov` the muxer waits for the first
/// packet — and the real extradata — before writing the header moov.
/// `+frag_keyframe` alone still flushes self-contained fragments, so a
/// crashed capture remains recoverable. Other encoders keep `+empty_moov`.
fn segment_movflags(encoder: &str) -> &'static str {
    if encoder == "h264_mf" {
        "+frag_keyframe+default_base_moof"
    } else {
        "+frag_keyframe+empty_moov+default_base_moof"
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
    // The webcam graph already ends in a system format it chose, so only Media
    // Foundation's negotiated hardware format is forced here. Screen captures
    // go through `screen_pix_fmt` instead, where the RGB→YUV conversion is part
    // of the graph anyway.
    let pix_fmt = if super::encoder::is_vaapi_encoder(encoder) {
        // VAAPI frames are created by the graph's upload stage.
        None
    } else if encoder == "h264_mf" {
        Some("nv12")
    } else {
        Some("yuv420p")
    };
    add_video_encoder_for_frames(command, profile, encoder, is_webcam, output_fps, pix_fmt);
}

/// `-pix_fmt` for a screen capture, or `None` when the filter graph owns the
/// frame format.
///
/// `backend` is the concrete input backend the graph was built with
/// (`ddagrab-gpu` when the frames never leave the GPU).
fn screen_pix_fmt(encoder: &str, backend: &str) -> Option<&'static str> {
    if backend == "ddagrab-gpu" {
        // The graph hands the encoder D3D11 frames (scale_d3d11) or Quick Sync
        // frames (hwmap/vpp_qsv); forcing a system format would pull them
        // back and undo the zero-copy pipeline.
        return if encoder == "h264_qsv" {
            None
        } else {
            Some("d3d11")
        };
    }
    if super::encoder::is_vaapi_encoder(encoder) {
        // VAAPI frames are created by the graph's upload stage.
        return None;
    }
    Some(if encoder_prefers_nv12(encoder) {
        "nv12"
    } else {
        "yuv420p"
    })
}

/// `pix_fmt` marks the frame format the encoder consumes; `None` leaves the
/// format to the graph (hardware frames the encoder reads directly).
fn add_video_encoder_for_frames(
    command: &mut Command,
    profile: &RecordingProfile,
    encoder: &str,
    is_webcam: bool,
    output_fps: f64,
    pix_fmt: Option<&'static str>,
) {
    command.arg("-c:v").arg(encoder);
    // Media Foundation only exposes hardware encoding when explicitly asked.
    if encoder == "h264_mf" {
        command.args(["-hw_encoding", "1"]);
    }
    if let Some(pix_fmt) = pix_fmt {
        command.args(["-pix_fmt", pix_fmt]);
    }
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
        "h264_vaapi" | "hevc_vaapi" => {
            // VAAPI has no CRF mode and no zerolatency tune. The shared
            // realtime paths target an average bitrate, so VBR matches the
            // other hardware encoders — CBR would pad a static screen up to
            // the full target.
            command.args(["-rc_mode", "VBR", "-b:v", &format!("{default_bitrate}k")]);
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
    // Only the DirectShow camera backend emits the verbose packet trace and
    // the per-frame stats consumed by the clock correlator.
    let observe_camera_timing = meta.backend == "dshow-camera";
    let camera_timing: Arc<Mutex<super::camera_timing::CameraTimingState>> = Arc::new(Mutex::new(
        super::camera_timing::CameraTimingState::default(),
    ));
    let camera_timing_reader = Arc::clone(&camera_timing);
    let stderr_reader = thread::Builder::new().name("capture-progress".into()).spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            // Record the observation instant before any lock/progress work:
            // packet lines correlate the graph clock to the spawn instant, so
            // early scheduling latency must stay inside the measurement.
            let observed_at = Instant::now();
            // Camera timing lines carry raw device names and clock values —
            // consume them here so they never reach the stderr buffer, the
            // manifest, or the logs.
            if observe_camera_timing
                && camera_timing_reader
                    .lock()
                    .map(|mut state| {
                        state.observe(
                            &line,
                            observed_at.saturating_duration_since(timeline_anchor.instant),
                        )
                    })
                    .unwrap_or(false)
            {
                continue;
            }
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
        camera_timing,
        #[cfg(target_os = "linux")]
        linux_pipewire: None,
        #[cfg(target_os = "macos")]
        macos_sck: None,
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
                } else if captured.contains("Could not find video device")
                    || captured.contains("Could not enumerate video devices")
                {
                    "The camera could not be found. Check that it is connected."
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
        // Diagnostics slot is per-capture: screen goes to `screen`, a
        // camera-primary capture to `camera`. The webcam sidecar never
        // reaches this line (it runs without a manifest).
        capture.attach_diagnostics(manifest, fragment_index, meta.camera);
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
                camera: false,
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
                camera: false,
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
        add_screen_video_input(
            &mut command,
            "ffmpeg",
            &source,
            &test_profile(),
            Some(output),
            None,
        );
        let debug = format!("{command:?}");

        // The capture rect must be translated into the output's own space.
        assert!(debug.contains("ddagrab=draw_mouse=0:framerate=30:output_idx=2:offset_x=200:offset_y=120:video_size=640x480"));
        // Queue depth follows the grabbed frame size, never the old flat 512.
        // A 640x480 crop sits on the 32-frame ceiling.
        assert!(debug.contains("\"-thread_queue_size\" \"32\""));
        assert!(!debug.contains("\"-thread_queue_size\" \"512\""));
    }

    #[test]
    fn screen_queue_depth_follows_the_grabbed_frame_size() {
        // Each raw packet is a whole BGRA frame, so a flat 512 was >4 GB at
        // 1080p and >16 GB at 4K of potential backlog. The byte budget keeps
        // ~96 MiB in flight with a 4-frame floor for high resolutions.
        assert_eq!(screen_queue_size(640 * 480), 32); // clamped ceiling
        assert_eq!(screen_queue_size(1280 * 720), 27);
        assert_eq!(screen_queue_size(1920 * 1080), 12);
        assert_eq!(screen_queue_size(2560 * 1440), 6);
        assert_eq!(screen_queue_size(3840 * 2160), 4); // floor
        assert_eq!(screen_queue_size(5120 * 2880), 4);
        // Never zero, never unbounded.
        assert_eq!(screen_queue_size(0), 32);
    }

    #[test]
    #[cfg(windows)]
    fn gdigrab_queue_follows_the_grab_size() {
        // A small region: the DPI-virtualized grab size stays far below 1080p
        // on every scaling factor, so the assertion is display-independent.
        let source = region_source(0, 0, 800, 600);
        let mut command = Command::new("ffmpeg");
        add_screen_video_input(&mut command, "ffmpeg", &source, &test_profile(), None, None);
        let debug = format!("{command:?}");
        assert!(debug.contains("\"-f\" \"gdigrab\""));
        // A small grab sits on the 32-frame ceiling regardless of DPI scaling.
        assert!(debug.contains("\"-thread_queue_size\" \"32\""));
        assert!(!debug.contains("\"-thread_queue_size\" \"512\""));
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
        add_screen_video_input(
            &mut command,
            "ffmpeg",
            &source,
            &test_profile(),
            Some(output),
            None,
        );
        let debug = format!("{command:?}");

        assert!(debug.contains("output_idx=2"));
        assert!(debug.contains("offset_x=0:offset_y=0:video_size=2560x1440"));
    }

    #[test]
    #[cfg(windows)]
    fn gdigrab_fallback_uses_dpi_virtualized_coordinates() {
        let source = region_source(100, 200, 800, 600);

        let mut command = Command::new("ffmpeg");
        add_screen_video_input(&mut command, "ffmpeg", &source, &test_profile(), None, None);
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
        let filter = build_video_filter(&source, &test_profile(), "libx264", true, None, None);
        assert!(filter.starts_with("[0:v]hwdownload,format=bgra,"));

        let gdigrab_filter =
            build_video_filter(&source, &test_profile(), "libx264", false, None, None);
        assert!(gdigrab_filter.starts_with("[0:v]scale="));
    }

    #[test]
    fn vaapi_filter_uploads_the_final_stage() {
        let source = region_source(0, 0, 800, 600);
        let filter = build_video_filter(&source, &test_profile(), "h264_vaapi", false, None, None);
        // The upload must be the last stage: h264_vaapi only takes hw frames.
        assert!(
            filter.ends_with(&format!(",{VAAPI_UPLOAD}[vout]")),
            "{filter}"
        );
        // Software encoding is byte-identical to the pre-VAAPI graph.
        let software = build_video_filter(&source, &test_profile(), "libx264", false, None, None);
        assert!(!software.contains("hwupload"));
        assert!(software.ends_with("[vout]"));
        // Hardware encoders take NV12: one conversion, at the end of the graph.
        let nvenc = build_video_filter(&source, &test_profile(), "h264_nvenc", false, None, None);
        assert!(nvenc.ends_with(",format=nv12[vout]"), "{nvenc}");
        assert!(software.ends_with("[vout]"), "{software}");
        assert!(!software.contains("format=nv12"), "{software}");
    }

    #[test]
    fn scale_threads_stay_opt_in_and_only_for_large_outputs() {
        let source = region_source(0, 0, 1280, 720);
        let mut profile = test_profile();
        profile.width = 1920;
        profile.height = 1080;
        profile.fps = 30;
        // The default graph stays single-threaded: measurement showed no win.
        let filter = build_video_filter(&source, &profile, "libx264", false, None, None);
        assert!(!filter.contains(":threads="), "{filter}");

        assert!(!scale_threads_worth_trying(&profile));
        profile.width = 2560;
        profile.height = 1440;
        assert!(scale_threads_worth_trying(&profile));
        profile.width = 1920;
        profile.height = 1080;
        profile.fps = 60;
        assert!(scale_threads_worth_trying(&profile));
    }

    #[test]
    #[cfg(windows)]
    fn webcam_command_preserves_source_clock() {
        let profile = test_profile();
        for preview in [None, Some(10), Some(15)] {
            let (command, backend) = build_webcam_command(
                "ffmpeg",
                "USB Camera",
                &profile,
                "libx264",
                "webcam.mp4",
                None,
                preview,
            );
            assert_eq!(backend, "dshow-camera");
            let args: Vec<String> = command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            let paired = |flag: &str| -> Option<&str> {
                args.iter()
                    .position(|arg| arg == flag)
                    .and_then(|index| args.get(index + 1).map(String::as_str))
            };

            // Driver sample timestamps must reach the file (-copyts stops the
            // demuxer from re-basing them) so the camera keeps its own clock.
            assert_eq!(paired("-use_video_device_timestamps"), Some("1"));
            assert!(args.iter().any(|arg| arg == "-copyts"));

            // PTS normalization runs BEFORE scale/split: the file origin is
            // zeroed while `-stats_enc_pre` still reports the original PTS.
            let filter = paired("-filter_complex").expect("filter graph");
            let setpts_pos = filter.find("setpts=PTS-STARTPTS").unwrap();
            let scale_pos = filter.find("scale=").unwrap();
            assert!(setpts_pos < scale_pos);
            if preview.is_some() {
                let split_pos = filter.find("split").unwrap();
                assert!(setpts_pos < split_pos);
            }

            // Camera-only B-frame disable and per-frame stats must sit in the
            // recording output's option block — before the file output and
            // never on the preview pipe.
            assert_eq!(paired("-bf"), Some("0"));
            assert_eq!(paired("-stats_enc_pre"), Some("pipe:2"));
            assert_eq!(
                paired("-stats_enc_pre_fmt"),
                Some(super::super::camera_timing::CAMERA_FRAME_STATS_FORMAT)
            );
            let output_pos = args.iter().position(|arg| arg == "webcam.mp4").unwrap();
            let stats_pos = args.iter().position(|arg| arg == "-stats_enc_pre").unwrap();
            assert!(stats_pos < output_pos);
            assert!(!args[output_pos..]
                .iter()
                .any(|arg| arg.starts_with("-stats_enc")));
        }

        // The camera-only flags must not leak into the screen pipeline.
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
            capture_keystrokes: false,
        };
        let (screen_command, _) = build_screen_command(
            "ffmpeg", &config, &profile, "libx264", "seg.mp4", false, None,
        );
        let screen_args: Vec<String> = screen_command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(!screen_args.iter().any(|arg| arg == "-bf"));
        assert!(!screen_args.iter().any(|arg| arg.starts_with("-stats_enc")));
        assert!(!screen_args.iter().any(|arg| arg == "-copyts"));
    }

    #[test]
    #[cfg(windows)]
    fn webcam_capture_preserves_device_sample_timestamps() {
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
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let flag = args
            .iter()
            .position(|arg| arg == "-use_video_device_timestamps")
            .expect("dshow timestamp flag present");
        assert_eq!(args[flag + 1], "1");
        assert_eq!(backend, "dshow-camera");
    }

    /// Rebuild a built webcam command with the DirectShow input block swapped
    /// for a synthetic lavfi source. Every other production argument —
    /// `-copyts`, the filter graph, encoder args, stats flags, outputs — is
    /// exercised exactly as `build_webcam_command` emits it.
    #[cfg(windows)]
    fn splice_lavfi_input(command: &Command, source: &str, preview: bool) -> Command {
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let input_start = args
            .windows(2)
            .position(|pair| pair[0] == "-f" && pair[1] == "dshow")
            .expect("dshow input block must exist");
        let input_end = args
            .windows(2)
            .position(|pair| pair[0] == "-i" && pair[1].starts_with("video="))
            .map(|index| index + 2)
            .expect("-i video=... input must exist");
        // `-re` paces the finite source in realtime so the capture reaches
        // readiness (a positive progress block) before natural exit.
        let mut spliced = crate::process::create_command(command.get_program());
        spliced
            .stdin(Stdio::piped())
            .stdout(if preview {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stderr(Stdio::piped())
            .args(&args[..input_start])
            .args(["-re", "-f", "lavfi", "-i", source])
            .args(&args[input_end..]);
        spliced
    }

    #[test]
    #[cfg(windows)]
    fn camera_timestamp_metadata_survives_normalization() {
        let executable = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/ffmpeg-x86_64-pc-windows-msvc.exe");
        let ffprobe = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/ffprobe-x86_64-pc-windows-msvc.exe");
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("webcam.mp4");

        let (command, backend) = build_webcam_command(
            executable.to_str().unwrap(),
            "Synthetic Camera",
            &webcam_profile(),
            "libx264",
            output.to_str().unwrap(),
            None,
            None,
        );
        assert_eq!(backend, "dshow-camera");
        let command = splice_lavfi_input(
            &command,
            "color=c=white:s=64x64:r=10:d=2,setpts=PTS+1000/TB",
            false,
        );

        let mut capture = run(
            command,
            output.to_str().unwrap(),
            0,
            None,
            None,
            CaptureMeta {
                startup_timeout: Duration::from_secs(8),
                encoder: "libx264".into(),
                backend: "dshow-camera".into(),
                requested_fps: 30.0,
                camera_mode: None,
                preview_fps: None,
                camera: false,
            },
        )
        .expect("synthetic camera capture must reach readiness");

        // The input is finite: let it end on its own and be reaped rather
        // than sending 'q' prematurely at readiness.
        capture
            .wait_for_stop(Instant::now())
            .expect("finite synthetic camera stops cleanly");

        // The lavfi source emits no DirectShow packet lines, so the graph
        // clock is bound here by authored fixtures with a constant 600ms
        // delivery delta arriving at 800ms/900ms/1000ms after spawn.
        {
            let mut timing = capture.camera_timing.lock().unwrap();
            for n in 0..3i64 {
                let sample = 10_000_000_000 + n * 1_000_000;
                let graph = sample + 6_000_000;
                assert!(timing.observe(
                    &format!(
                        "[dshow @ 000001] passing through packet of type video size     2048 timestamp {sample} orig timestamp {sample} graph timestamp {graph} diff 6000000 Synthetic Camera"
                    ),
                    Duration::from_millis(800 + n as u64 * 100),
                ));
            }
        }
        // first_input from the REAL stats lines (ptsi == +1000s offset) minus
        // the bound graph origin (1e10 - 9.998e9) must equal 200ms — proving
        // the original absolute PTS survived setpts normalization end-to-end.
        assert_eq!(capture.camera_first_frame_offset_ms(), Some(200));

        let metadata = crate::media::probe::probe_media(
            ffprobe.to_str().unwrap(),
            &output,
            "camera-timing-test",
        )
        .expect("ffprobe reads the recorded camera file");
        let video = metadata
            .streams
            .iter()
            .find(|stream| stream.kind == "video")
            .expect("video stream present");
        assert!(
            video.start_ms.unwrap_or(0) <= 34,
            "first frame must be normalized near zero (<= one 30fps frame), got {:?}ms",
            video.start_ms
        );
        let duration_ms = video
            .duration_ms
            .or(metadata.format.duration_ms)
            .unwrap_or(0);
        assert!(
            (1_500..=3_000).contains(&duration_ms),
            "duration must reflect the ~2s of media, not the +1000s offset: {duration_ms}ms"
        );
    }

    #[test]
    #[cfg(windows)]
    fn webcam_preview_capture_records_without_stdout_blocking() {
        let executable = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/ffmpeg-x86_64-pc-windows-msvc.exe");
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("webcam.mp4");

        let (command, backend) = build_webcam_command(
            executable.to_str().unwrap(),
            "Synthetic Camera",
            &webcam_profile(),
            "libx264",
            output.to_str().unwrap(),
            None,
            Some(10),
        );
        assert_eq!(backend, "dshow-camera");
        let command = splice_lavfi_input(
            &command,
            "color=c=white:s=64x64:r=10:d=2,setpts=PTS+1000/TB",
            true,
        );

        // A live broadcaster drains the MJPEG preview pipe so the capture is
        // never blocked on stdout.
        let server = crate::capture::preview_server::WebcamPreviewServer::start()
            .expect("preview server starts");
        let mut capture = run(
            command,
            output.to_str().unwrap(),
            0,
            None,
            Some(server.broadcaster()),
            CaptureMeta {
                startup_timeout: Duration::from_secs(8),
                encoder: "libx264".into(),
                backend: "dshow-camera".into(),
                requested_fps: 30.0,
                camera_mode: None,
                preview_fps: Some(10),
                camera: false,
            },
        )
        .expect("synthetic camera capture with preview must reach readiness");

        capture
            .wait_for_stop(Instant::now())
            .expect("finite synthetic camera stops cleanly");
        assert!(
            server.broadcaster().latest_frame().is_some(),
            "preview pipe produced at least one MJPEG frame"
        );
        assert!(output.exists());
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
    fn webcam_input_buffers_follow_the_negotiated_mode() {
        let profile = webcam_profile();
        let raw = CameraMode {
            width: 1280,
            height: 720,
            fps: 30.0,
            pixel_format: Some("yuyv422".into()),
            codec: None,
        };
        let (command, _) = build_webcam_command(
            "ffmpeg",
            "USB Camera",
            &profile,
            "libx264",
            "webcam.mp4",
            Some(&raw),
            None,
        );
        let debug = format!("{command:?}");
        // Raw 720p frames are ~1.4-1.8 MB each: a 32 MB ceiling is enough
        // slack, and 8 queued packets cannot balloon into GBs.
        assert!(debug.contains("\"-rtbufsize\" \"32M\""));
        assert!(debug.contains("\"-thread_queue_size\" \"8\""));

        let mjpeg = CameraMode {
            width: 1920,
            height: 1080,
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
            Some(&mjpeg),
            None,
        );
        let debug = format!("{command:?}");
        // Compressed 1080p: bigger frame ceiling, still a shallow queue.
        assert!(debug.contains("\"-rtbufsize\" \"64M\""));
        assert!(debug.contains("\"-thread_queue_size\" \"16\""));

        // No negotiated mode: assume raw 720p (the sidecar ceiling).
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
        assert!(debug.contains("\"-rtbufsize\" \"32M\""));
        assert!(debug.contains("\"-thread_queue_size\" \"8\""));
    }

    #[test]
    #[cfg(windows)]
    fn webcam_vaapi_uploads_only_the_recording_branch() {
        let profile = webcam_profile();
        let mode = CameraMode {
            width: 1280,
            height: 720,
            fps: 30.0,
            pixel_format: Some("nv12".into()),
            codec: None,
        };
        let (command, _) = build_webcam_command(
            "ffmpeg",
            "USB Camera",
            &profile,
            "h264_vaapi",
            "webcam.mp4",
            Some(&mode),
            Some(5),
        );
        let debug = format!("{command:?}");
        assert!(debug.contains("\"-vaapi_device\""));
        // Recording branch uploaded; preview branch stays on system memory for
        // the MJPEG encoder.
        assert!(debug.contains("[vrec]format=nv12,hwupload[vout]"));
        assert!(debug.contains("[vprev]fps=5"));
        assert!(!debug.contains("-pix_fmt"));
        // Software encoding keeps the old graph untouched.
        let (command, _) = build_webcam_command(
            "ffmpeg",
            "USB Camera",
            &profile,
            "libx264",
            "webcam.mp4",
            Some(&mode),
            Some(5),
        );
        let debug = format!("{command:?}");
        assert!(debug.contains("[0:v]setpts=PTS-STARTPTS,scale="));
        assert!(!debug.contains("hwupload"));
        assert!(!debug.contains("-vaapi_device"));
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
            capture_keystrokes: false,
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

    /// Quick Sync derives its device from the D3D11 capture device and scales
    /// through VPP, which also converts the full-range desktop to limited-range
    /// NV12 (`scale_qsv` would keep the full-range tag).
    #[test]
    #[cfg(windows)]
    fn gpu_filter_derives_a_qsv_device_for_qsv_encoders() {
        let config = gpu_screen_test_config(1920, 1080);
        let profile = gpu_screen_test_profile();
        assert_eq!(
            gpu_screen_filter(&config, &profile, "h264_qsv", true).as_deref(),
            Some(
                "[0:v]hwmap=derive_device=qsv,vpp_qsv=w=1280:h=720:format=nv12:out_range=tv[vout]"
            )
        );
    }

    /// A window recorded through `RecordingProfile::for_source_bounds` has an
    /// even-rounded aspect that is within a fraction of a pixel of the source,
    /// which is the case the GPU path must accept instead of letterboxing.
    #[test]
    #[cfg(windows)]
    fn gpu_filter_accepts_even_rounded_source_aspects() {
        let profile = gpu_screen_test_profile();
        // 1366×768 recorded at 1280×720 (the even-rounded fit of the source).
        let config = gpu_screen_test_config(1366, 768);
        assert!(gpu_screen_filter(&config, &profile, "h264_mf", true).is_some());

        let mut profile = profile;
        profile.width = 1280;
        profile.height = 700;
        assert!(
            gpu_screen_filter(&config, &profile, "h264_mf", true).is_none(),
            "an aspect mismatch must stay on the CPU path"
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
        // Software encoders never see the GPU filter; Quick Sync qualifies
        // through its own derived-device graph instead of `scale_d3d11`.
        assert!(gpu_screen_filter(&config, &profile, "libx264", true).is_none());
        #[cfg(not(windows))]
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
        add_video_encoder_for_frames(
            &mut command,
            &profile,
            "h264_mf",
            false,
            30.0,
            screen_pix_fmt("h264_mf", "ddagrab-gpu"),
        );
        let debug = format!("{command:?}");
        assert!(debug.contains("\"-hw_encoding\" \"1\""));
        assert!(debug.contains("\"-pix_fmt\" \"d3d11\""));
        assert!(!debug.contains("nv12"));

        let mut command = Command::new("ffmpeg");
        add_video_encoder_for_frames(
            &mut command,
            &profile,
            "h264_nvenc",
            false,
            30.0,
            screen_pix_fmt("h264_nvenc", "ddagrab-gpu"),
        );
        let debug = format!("{command:?}");
        assert!(debug.contains("\"-pix_fmt\" \"d3d11\""));
        assert!(!debug.contains("-hw_encoding"));

        // Quick Sync reads the derived QSV frames directly: any `-pix_fmt`
        // here would pull the graph back to system memory.
        let mut command = Command::new("ffmpeg");
        add_video_encoder_for_frames(
            &mut command,
            &profile,
            "h264_qsv",
            false,
            30.0,
            screen_pix_fmt("h264_qsv", "ddagrab-gpu"),
        );
        let debug = format!("{command:?}");
        assert!(!debug.contains("-pix_fmt"), "{debug}");
    }

    #[test]
    fn cpu_chains_feed_hardware_encoders_nv12() {
        for encoder in ["h264_nvenc", "h264_amf", "h264_qsv", "h264_videotoolbox"] {
            assert_eq!(
                screen_pix_fmt(encoder, "ddagrab-cpu"),
                Some("nv12"),
                "{encoder}"
            );
        }
        assert_eq!(screen_pix_fmt("libx264", "gdigrab"), Some("yuv420p"));
        // VAAPI frames come from the graph's upload stage.
        assert_eq!(screen_pix_fmt("h264_vaapi", "x11grab"), None);
        assert_eq!(screen_pix_fmt("hevc_vaapi", "x11grab"), None);
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
    fn vaapi_encoder_has_no_system_pix_fmt() {
        let profile = test_profile();
        let mut command = Command::new("ffmpeg");
        add_video_encoder(&mut command, &profile, "h264_vaapi", false, 30.0);
        let debug = format!("{command:?}");

        // The graph's upload stage produces vaapi frames; forcing a system
        // pixel format here would make FFmpeg insert a download/conversion.
        assert!(!debug.contains("-pix_fmt"), "{debug}");
        assert!(debug.contains("\"-rc_mode\" \"VBR\""));
        assert!(debug.contains("\"-b:v\""));
        // No x264-only knobs may leak into the VAAPI path.
        assert!(!debug.contains("zerolatency"));
        assert!(!debug.contains("-x264-params"));
    }

    #[test]
    fn vaapi_device_is_emitted_for_vaapi_only() {
        // The node is process-wide probe state; serialize with the tests that
        // mutate it and start from the fallback.
        let _guard = super::super::encoder::VAAPI_NODE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        super::super::encoder::store_vaapi_node(None);

        let mut command = Command::new("ffmpeg");
        add_vaapi_device(&mut command, "h264_vaapi");
        let debug = format!("{command:?}");
        assert!(debug.contains("\"-vaapi_device\""));
        assert!(debug.contains(super::super::encoder::VAAPI_RENDER_NODE));

        let mut command = Command::new("ffmpeg");
        add_vaapi_device(&mut command, "libx264");
        assert!(!format!("{command:?}").contains("-vaapi_device"));
    }

    #[test]
    fn segment_movflags_drop_empty_moov_for_mediafoundation() {
        // `-hw_encoding 1` + `+empty_moov` writes a corrupt first sample (the
        // hw MFT's format-change extradata arrives after the empty moov —
        // verified on the pinned 9.0.1 sidecar). Every other encoder keeps
        // the streaming-friendly empty moov.
        assert_eq!(
            segment_movflags("h264_mf"),
            "+frag_keyframe+default_base_moof"
        );
        assert_eq!(
            segment_movflags("h264_nvenc"),
            "+frag_keyframe+empty_moov+default_base_moof"
        );
        assert_eq!(
            segment_movflags("libx264"),
            "+frag_keyframe+empty_moov+default_base_moof"
        );
    }

    #[test]
    #[cfg(windows)]
    fn webcam_command_for_h264_mf_omits_empty_moov() {
        let profile = test_profile();
        let (command, _) = build_webcam_command(
            "ffmpeg",
            "USB Camera",
            &profile,
            "h264_mf",
            "cam.mp4",
            None,
            None,
        );
        let debug = format!("{command:?}");
        assert!(debug.contains("\"-hw_encoding\" \"1\""));
        assert!(debug.contains("\"+frag_keyframe+default_base_moof\""));
        assert!(!debug.contains("empty_moov"));

        // A non-MF encoder keeps the empty moov.
        let (command, _) = build_webcam_command(
            "ffmpeg",
            "USB Camera",
            &profile,
            "libx264",
            "cam.mp4",
            None,
            None,
        );
        assert!(format!("{command:?}").contains("\"+frag_keyframe+empty_moov+default_base_moof\""));
    }

    // ---------- camera-primary capture (camera-only mode) ----------

    #[cfg(windows)]
    fn camera_test_plan(
        fit: CameraFit,
        out_w: u32,
        out_h: u32,
        fps: f64,
        input: Option<CameraMode>,
    ) -> CameraCapturePlan {
        let target = (out_w as f64 * out_h as f64 * fps * 0.11 / 1000.0).round() as u32;
        CameraCapturePlan {
            profile_id: "camera-balanced".into(),
            input,
            output_width: out_w,
            output_height: out_h,
            output_fps: fps,
            video_bitrate_kbps: target,
            max_bitrate_kbps: target * 3 / 2,
            buffer_kbps: target * 3 / 2,
            crf: 21,
            limited_by_camera: false,
            encoder_limited: false,
            fit,
        }
    }

    #[cfg(windows)]
    fn camera_mode(
        width: u32,
        height: u32,
        fps: f64,
        pixel_format: Option<&str>,
        codec: Option<&str>,
    ) -> CameraMode {
        CameraMode {
            width,
            height,
            fps,
            pixel_format: pixel_format.map(str::to_string),
            codec: codec.map(str::to_string),
        }
    }

    #[cfg(windows)]
    fn camera_args(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[cfg(windows)]
    fn filter_arg(args: &[String]) -> String {
        args.iter()
            .position(|arg| arg == "-filter_complex")
            .and_then(|index| args.get(index + 1).cloned())
            .expect("filter_complex present")
    }

    #[cfg(windows)]
    fn paired_arg<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter()
            .position(|arg| arg == flag)
            .and_then(|index| args.get(index + 1).map(String::as_str))
    }

    #[test]
    #[cfg(windows)]
    fn camera_command_native_plan_skips_scale() {
        let plan = camera_test_plan(
            CameraFit::Native,
            1920,
            1080,
            30.0,
            Some(camera_mode(1920, 1080, 30.0, Some("nv12"), None)),
        );
        let (command, backend) =
            build_camera_command("ffmpeg", "USB Camera", &plan, "libx264", "cam.mp4", None);
        let args = camera_args(&command);
        assert_eq!(backend, "dshow-camera");
        // Negotiated mode is pinned on the input.
        assert_eq!(paired_arg(&args, "-video_size"), Some("1920x1080"));
        assert_eq!(paired_arg(&args, "-framerate"), Some("30"));
        assert_eq!(paired_arg(&args, "-pixel_format"), Some("nv12"));
        let filter = filter_arg(&args);
        assert_eq!(filter, "[0:v]setpts=PTS-STARTPTS[vout]");
        assert!(!filter.contains("scale"));
    }

    #[test]
    #[cfg(windows)]
    fn camera_command_fit_filters() {
        let scaled = camera_test_plan(
            CameraFit::Scale,
            1440,
            1080,
            30.0,
            Some(camera_mode(1600, 1200, 30.0, Some("yuyv422"), None)),
        );
        let (command, _) =
            build_camera_command("ffmpeg", "USB Camera", &scaled, "libx264", "cam.mp4", None);
        let filter = filter_arg(&camera_args(&command));
        assert_eq!(filter, "[0:v]setpts=PTS-STARTPTS,scale=1440:1080[vout]");

        let letterbox = camera_test_plan(CameraFit::Letterbox, 1440, 1080, 30.0, None);
        let (command, _) = build_camera_command(
            "ffmpeg",
            "USB Camera",
            &letterbox,
            "libx264",
            "cam.mp4",
            None,
        );
        let filter = filter_arg(&camera_args(&command));
        assert!(filter.contains("force_original_aspect_ratio=decrease"));
        assert!(filter.contains("pad=1440:1080:(ow-iw)/2:(oh-ih)/2:color=black"));

        let adaptive = camera_test_plan(CameraFit::Adaptive, 1920, 1080, 30.0, None);
        let (command, _) = build_camera_command(
            "ffmpeg",
            "USB Camera",
            &adaptive,
            "libx264",
            "cam.mp4",
            None,
        );
        let filter = filter_arg(&camera_args(&command));
        // Device-defaults attempt: clamp to the budget, never upscale.
        assert!(filter.contains("min(iw,1920)"));
        assert!(filter.contains("min(ih,1080)"));
        assert!(filter.contains("force_divisible_by=2"));
    }

    #[test]
    #[cfg(windows)]
    fn camera_command_preview_off_skips_split_and_stdout() {
        let plan = camera_test_plan(CameraFit::Adaptive, 1920, 1080, 30.0, None);
        let (command, _) =
            build_camera_command("ffmpeg", "USB Camera", &plan, "libx264", "cam.mp4", None);
        let args = camera_args(&command);
        let filter = filter_arg(&args);
        assert!(!filter.contains("split"));
        assert!(!args.iter().any(|arg| arg == "image2pipe"));
        // No preview output → stdout is a null sink so nothing can block.
        // (std::process::Command cannot be introspected for stdio config;
        // assert on the gate the builder wires in.)
        assert!(!camera_pipes_stdout(false));
    }

    #[test]
    #[cfg(windows)]
    fn camera_command_preview_on_splits_at_480_wide() {
        let plan = camera_test_plan(CameraFit::Adaptive, 1920, 1080, 30.0, None);
        let (command, _) = build_camera_command(
            "ffmpeg",
            "USB Camera",
            &plan,
            "libx264",
            "cam.mp4",
            Some(12),
        );
        let args = camera_args(&command);
        let filter = filter_arg(&args);
        assert!(filter.contains("split=2[vout][vprev]"));
        assert!(filter.contains("[vprev]fps=12,scale=480:-2[vprev_out]"));
        assert!(args.iter().any(|arg| arg == "image2pipe"));
        assert!(args.iter().any(|arg| arg == "mjpeg"));
        assert!(camera_pipes_stdout(true), "preview needs a piped stdout");
    }

    #[test]
    #[cfg(windows)]
    fn camera_command_sizes_input_buffers_from_the_input_mode() {
        // Raw input: buffer + queue follow the negotiated input size, not the
        // output budget (a 4K sensor scaled down to 720p still queues 4K raw
        // frames).
        for (w, h, expected) in [
            (1280, 720, "32M"),
            (1920, 1080, "64M"),
            (3840, 2160, "256M"),
        ] {
            let plan = camera_test_plan(
                CameraFit::Native,
                w,
                h,
                30.0,
                Some(camera_mode(w, h, 30.0, Some("yuyv422"), None)),
            );
            let (command, _) =
                build_camera_command("ffmpeg", "USB Camera", &plan, "libx264", "cam.mp4", None);
            let args = camera_args(&command);
            assert_eq!(paired_arg(&args, "-rtbufsize"), Some(expected), "{w}x{h}");
            assert_eq!(
                paired_arg(&args, "-thread_queue_size"),
                Some("8"),
                "{w}x{h}"
            );
        }

        // 4K input fitted down to a 1080p output still gets the 4K buffer.
        let plan = camera_test_plan(
            CameraFit::Scale,
            1920,
            1080,
            30.0,
            Some(camera_mode(3840, 2160, 30.0, Some("nv12"), None)),
        );
        let (command, _) =
            build_camera_command("ffmpeg", "USB Camera", &plan, "libx264", "cam.mp4", None);
        assert_eq!(
            paired_arg(&camera_args(&command), "-rtbufsize"),
            Some("256M")
        );

        // Compressed input (MJPEG) keeps a deeper packet queue — packets are
        // small, so the depth costs little.
        let plan = camera_test_plan(
            CameraFit::Native,
            1920,
            1080,
            30.0,
            Some(camera_mode(1920, 1080, 30.0, None, Some("mjpeg"))),
        );
        let (command, _) =
            build_camera_command("ffmpeg", "USB Camera", &plan, "libx264", "cam.mp4", None);
        assert_eq!(
            paired_arg(&camera_args(&command), "-thread_queue_size"),
            Some("16")
        );

        // Device-defaults attempts size for at least 1080p raw.
        let plan = camera_test_plan(CameraFit::Adaptive, 1280, 720, 30.0, None);
        let (command, _) =
            build_camera_command("ffmpeg", "USB Camera", &plan, "libx264", "cam.mp4", None);
        assert_eq!(
            paired_arg(&camera_args(&command), "-rtbufsize"),
            Some("64M")
        );
        assert_eq!(
            paired_arg(&camera_args(&command), "-thread_queue_size"),
            Some("16")
        );
    }

    #[test]
    fn camera_buffer_tiers_cover_the_advertised_modes() {
        assert_eq!(camera_rtbufsize(640 * 480), "32M");
        assert_eq!(camera_rtbufsize(1280 * 720), "32M");
        assert_eq!(camera_rtbufsize(1920 * 1080), "64M");
        assert_eq!(camera_rtbufsize(2560 * 1440), "256M");
        assert_eq!(camera_rtbufsize(3840 * 2160), "256M");
        assert_eq!(camera_queue_size(true), "8");
        assert_eq!(camera_queue_size(false), "16");
    }

    #[test]
    #[cfg(windows)]
    fn camera_command_forces_cfr_and_output_rate() {
        let plan = camera_test_plan(
            CameraFit::Native,
            1920,
            1080,
            29.97,
            Some(camera_mode(1920, 1080, 29.97, Some("nv12"), None)),
        );
        let (command, _) =
            build_camera_command("ffmpeg", "USB Camera", &plan, "libx264", "cam.mp4", None);
        let args = camera_args(&command);
        // CFR + the exact fractional rate — never rounded to 30.
        assert_eq!(paired_arg(&args, "-fps_mode"), Some("cfr"));
        assert_eq!(paired_arg(&args, "-r"), Some("29.97"));
        // Windows: no B-frame reorder + pre-encode frame stats for camera
        // clock correlation, same as the sidecar path.
        assert_eq!(paired_arg(&args, "-bf"), Some("0"));
        assert!(args.iter().any(|arg| arg == "-stats_enc_pre"));
        assert!(args.iter().any(|arg| arg.contains("frag_keyframe")));
        assert_eq!(paired_arg(&args, "-frag_duration"), Some("2000000"));
    }

    #[test]
    #[cfg(windows)]
    fn camera_command_encoder_args_drop_sidecar_tuning() {
        let plan = camera_test_plan(
            CameraFit::Adaptive,
            1920,
            1080,
            30.0,
            Some(camera_mode(1920, 1080, 30.0, None, Some("mjpeg"))),
        );
        // MJPEG negotiated mode pins -vcodec, not -pixel_format.
        let (command, _) =
            build_camera_command("ffmpeg", "USB Camera", &plan, "h264_nvenc", "cam.mp4", None);
        let args = camera_args(&command);
        assert_eq!(paired_arg(&args, "-vcodec"), Some("mjpeg"));
        assert_eq!(paired_arg(&args, "-tune"), Some("hq"));
        assert_eq!(paired_arg(&args, "-maxrate"), Some("10264k"));
        assert_eq!(paired_arg(&args, "-bufsize"), Some("10264k"));
        // The sidecar's realtime tuning must never leak into camera-primary.
        assert!(!args.iter().any(|arg| arg == "zerolatency"));

        let (command, _) =
            build_camera_command("ffmpeg", "USB Camera", &plan, "libx264", "cam.mp4", None);
        let args = camera_args(&command);
        assert!(!args.iter().any(|arg| arg == "zerolatency"));
        assert_eq!(paired_arg(&args, "-crf"), Some("21"));
        assert_eq!(paired_arg(&args, "-maxrate"), Some("10264k"));
    }

    #[test]
    #[cfg(windows)]
    fn camera_command_vaapi_uploads_recording_branch_only() {
        let plan = camera_test_plan(
            CameraFit::Native,
            1920,
            1080,
            30.0,
            Some(camera_mode(1920, 1080, 30.0, Some("nv12"), None)),
        );
        let (command, _) = build_camera_command(
            "ffmpeg",
            "USB Camera",
            &plan,
            "h264_vaapi",
            "cam.mp4",
            Some(5),
        );
        let args = camera_args(&command);
        let filter = filter_arg(&args);
        assert!(args.iter().any(|arg| arg == "-vaapi_device"));
        // Self-view keeps software frames; only the recording branch uploads.
        assert!(filter.contains("split=2[vrec][vprev]"));
        assert!(filter.contains("[vrec]format=nv12,hwupload[vout]"));
        assert!(filter.contains("[vprev]fps=5"));
        assert_eq!(paired_arg(&args, "-rc_mode"), Some("VBR"));
        assert_eq!(paired_arg(&args, "-pix_fmt"), None);

        // No preview → the upload is the graph's final stage.
        let (command, _) =
            build_camera_command("ffmpeg", "USB Camera", &plan, "h264_vaapi", "cam.mp4", None);
        let args = camera_args(&command);
        let filter = filter_arg(&args);
        assert!(filter.ends_with("format=nv12,hwupload[vout]"), "{filter}");
    }

    #[test]
    #[cfg(windows)]
    fn synthetic_camera_capture_registers_fragment_and_camera_diagnostics() {
        let executable = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/ffmpeg-x86_64-pc-windows-msvc.exe");
        let ffprobe = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/ffprobe-x86_64-pc-windows-msvc.exe");
        let directory = tempfile::tempdir().unwrap();
        let work_dir = directory.path().join("session-work");
        std::fs::create_dir_all(&work_dir).unwrap();
        let output = work_dir.join("seg_000.mp4");

        // The device-defaults (Adaptive) plan with no negotiated mode — the
        // same shape `start_camera` builds, with the dshow input spliced for
        // a paced lavfi source exactly like the webcam synthetic tests.
        let plan = camera_test_plan(CameraFit::Adaptive, 1920, 1080, 30.0, None);
        let (command, backend) = build_camera_command(
            executable.to_str().unwrap(),
            "Synthetic Camera",
            &plan,
            "libx264",
            output.to_str().unwrap(),
            None,
        );
        assert_eq!(backend, "dshow-camera");
        let command = splice_lavfi_input(
            &command,
            "color=c=white:s=64x64:r=10:d=2,setpts=PTS+1000/TB",
            false,
        );

        let manifest = Arc::new(Mutex::new(RecordingManifest::new(
            "session-camera",
            work_dir.to_string_lossy().to_string(),
            CaptureSource {
                kind: "camera".into(),
                id: "camera-test".into(),
                name: "Test".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            },
            "camera-balanced",
        )));

        // Identical to what `start_camera` does after build_camera_command:
        // the camera flag routes diagnostics to the segment's camera slot.
        let mut capture = run(
            command,
            output.to_str().unwrap(),
            0,
            Some(Arc::clone(&manifest)),
            None,
            CaptureMeta {
                startup_timeout: Duration::from_secs(8),
                encoder: "libx264".into(),
                backend: "dshow-camera".into(),
                requested_fps: plan.output_fps,
                camera_mode: plan.input.clone(),
                preview_fps: None,
                camera: true,
            },
        )
        .expect("synthetic camera capture must reach readiness");
        let live = capture.diagnostics();
        capture
            .stop()
            .expect("synthetic camera capture stops cleanly");

        let stored =
            RecordingManifest::read(work_dir.join("session.json")).expect("manifest on disk");
        // Primary-slot registration: the fragment is recorded at the index
        // the session passed in, like seg_NNN.mp4 for screen captures.
        let fragment = stored
            .fragments
            .iter()
            .find(|fragment| fragment.index == 0)
            .expect("camera fragment registered");
        assert_eq!(fragment.file_name, "seg_000.mp4");

        let camera = stored
            .capture_diagnostics
            .iter()
            .find(|segment| segment.index == 0)
            .and_then(|segment| segment.camera.as_ref())
            .expect("camera diagnostics persisted under the camera slot");
        assert_eq!(camera.encoder, "libx264");
        assert_eq!(camera.backend, "dshow-camera");
        assert_eq!(camera.process_id, live.process_id);
        assert_eq!(camera.requested_fps, 30.0);
        assert!(camera.requested_camera_mode.is_none());
        assert!(camera.exited);

        // The primary camera file is a real fragmented MP4.
        let metadata = crate::media::probe::probe_media(
            ffprobe.to_str().unwrap(),
            &output,
            "camera-primary-test",
        )
        .expect("ffprobe reads the camera output");
        let video = metadata
            .streams
            .iter()
            .find(|stream| stream.kind == "video")
            .expect("video stream present");
        assert!(video.duration_ms.unwrap_or(0) > 500);
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
            capture_keystrokes: false,
        };
        let (command, backend) = build_screen_command(
            "ffmpeg",
            &config,
            &test_profile(),
            "libx264",
            "seg.mp4",
            false,
            None,
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
