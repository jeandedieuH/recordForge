use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::{error, info, instrument};

use super::audio::AudioCaptureKind;
use super::config::{RecordingConfig, RecordingProfile};
use super::disk;
use super::ffmpeg::FfmpegCapture;
use super::manifest::{
    CursorTelemetryAsset, RecorderState, RecordingManifest, RecordingMarker, RecordingSmartZoom,
    RecordingStats, RecordingWebcamFragment,
};
use super::media;
use super::traits::AudioTrack;

/// Shared recorder state. Only one recording session can be active at a time.
#[derive(Debug)]
pub struct Recorder {
    ffmpeg_path: PathBuf,
    ffprobe_path: PathBuf,
    sessions_dir: PathBuf,
    db: Arc<Mutex<rusqlite::Connection>>,
    // Whether this FFmpeg build supports the ddagrab (Desktop Duplication API)
    // filter. Probed once at construction so display capture can fall back to
    // gdigrab on builds without D3D11 capture support.
    ddagrab_available: bool,
    available_encoders: Vec<String>,
    current: Mutex<Option<ActiveSession>>,
    finalizing: Mutex<Option<RecordingStatus>>,
    last_manifest: Mutex<Option<Arc<Mutex<RecordingManifest>>>>,
    /// Shared admission gate that serializes capture against media jobs. The
    /// session holds its permit through countdown, recording, pause, and
    /// finalization; queued jobs wait for the permit instead of competing.
    resource_gate: Arc<crate::state::CaptureWorkGate>,
}

#[derive(Debug)]
struct ActiveSession {
    session_id: String,
    work_dir: PathBuf,
    config: RecordingConfig,
    profile: RecordingProfile,
    manifest: Arc<Mutex<RecordingManifest>>,
    screen_capture: Option<FfmpegCapture>,
    audio_captures: Vec<ActiveAudioCapture>,
    webcam_capture: Option<FfmpegCapture>,
    webcam_preview_server: Option<super::preview_server::WebcamPreviewServer>,
    webcam_segments: Vec<media::WebcamSegmentInput>,
    webcam_segments_started: usize,
    webcam_capture_failed: bool,
    cursor_tracker: Option<super::cursor_v2::CursorTrackerV2>,
    /// First timestamp owned by the active cursor segment. Keeping this boundary
    /// prevents startup alignment for a resumed segment from shifting history.
    cursor_segment_start_ms: u64,
    segment_index: u32,
    total_recorded_ms: u64,
    started_at: Option<chrono::DateTime<chrono::Utc>>,
    // Media-work admission permit. Declared last so it drops after every
    // capture field above — workers are always stopped before the gate frees.
    resource_permit: Option<crate::state::CaptureWorkPermit>,
}

#[derive(Debug)]
struct ActiveAudioCapture {
    kind: AudioCaptureKind,
    track: Box<dyn AudioTrack>,
}

#[derive(Debug)]
struct SegmentCaptures {
    screen: FfmpegCapture,
    audio: Vec<ActiveAudioCapture>,
    webcam: Option<FfmpegCapture>,
    webcam_preview_server: Option<super::preview_server::WebcamPreviewServer>,
    webcam_failed: bool,
    cursor_tracker: super::cursor_v2::CursorTrackerV2,
}

/// Build the manifest cursor descriptor in encoded-frame coordinates. The
/// capture bounds can be larger than the selected output profile, so the
/// profile dimensions—not the desktop rectangle—are the stable source space.
fn cursor_asset_metadata(
    session_id: &str,
    bounds: super::source::Bounds,
    source_width: u32,
    source_height: u32,
) -> crate::errors::Result<CursorTelemetryAsset> {
    let capture_bounds = super::cursor::CursorCaptureBounds {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width.max(1) as u32,
        height: bounds.height.max(1) as u32,
    };

    let topology = super::cursor_v2::probe_cursor_topology(bounds.x, bounds.y)
        .or_else(|| super::cursor_v2::probe_cursor_topology(0, 0));
    let health = topology.as_ref().map_or(
        super::cursor_v2::CursorTelemetryHealth::TopologyUnavailable,
        |_| super::cursor_v2::CursorTelemetryHealth::Healthy,
    );

    let dpi_scale = topology.as_ref().map_or(
        super::cursor::CursorDpiScale { x: 1.0, y: 1.0 },
        |topology| super::cursor::CursorDpiScale {
            x: topology.dpi_x / 96.0,
            y: topology.dpi_y / 96.0,
        },
    );

    let source_width = source_width.max(1);
    let source_height = source_height.max(1);
    let coordinate_transform = super::cursor_v2::CursorCoordinateTransform::from_bounds(
        &capture_bounds,
        source_width,
        source_height,
        &super::cursor_v2::CursorDpiScale {
            x: dpi_scale.x,
            y: dpi_scale.y,
        },
    );

    Ok(CursorTelemetryAsset {
        asset_id: format!("cursor-events:{session_id}"),
        path: "cursor_telemetry.json".into(),
        schema_version: 2,
        source_width,
        source_height,
        capture_bounds,
        dpi_scale,
        timebase: super::cursor::CursorTelemetryTimebase {
            unit: "ms".into(),
            ticks_per_second: 1_000,
        },
        coordinate_transform: Some(coordinate_transform),
        topology,
        shapes: Vec::new(),
        event_file: Some("cursor_events.bin".into()),
        health: Some(health),
    })
}

/// Signed difference between two capture start instants, rounded to milliseconds.
/// Positive when `a` is later than `b` (so the camera needs a leading gap).
fn signed_start_offset_ms(a: std::time::Instant, b: std::time::Instant) -> i64 {
    if a >= b {
        a.duration_since(b).as_millis().min(i64::MAX as u128) as i64
    } else {
        -(b.duration_since(a).as_millis().min(i64::MAX as u128) as i64)
    }
}

/// Compute the webcam segment start offset relative to the master screen timeline.
///
/// Master timeline starts at `screen_spawn + screen_head_trim`.
/// The webcam's first frame was captured at `webcam_spawn + webcam_head_trim`.
/// The offset on the master timeline is:
/// `(webcam_spawn - screen_spawn) + webcam_head_trim - screen_head_trim`.
///
/// Positive offset: webcam started after master timeline (needs leading padding).
/// Negative offset: webcam started before master timeline (needs head trimming).
fn compute_webcam_start_offset_ms(
    spawn_offset_ms: i64,
    webcam_head_trim_ms: u64,
    screen_head_trim_ms: u64,
) -> i64 {
    spawn_offset_ms
        .saturating_add(webcam_head_trim_ms as i64)
        .saturating_sub(screen_head_trim_ms as i64)
}

/// Resolve the webcam segment start offset on the master screen timeline.
///
/// `measured_camera_start_ms` is the camera file's own first-frame origin
/// relative to the process spawn instant, correlated from DirectShow
/// sample/graph timestamps. When it is absent (non-Windows backends, missing
/// or implausible telemetry) the duration-derived `fallback_camera_head_trim_ms`
/// keeps the legacy behavior.
fn resolve_webcam_start_offset_ms(
    spawn_offset_ms: i64,
    measured_camera_start_ms: Option<u64>,
    fallback_camera_head_trim_ms: u64,
    screen_head_trim_ms: u64,
) -> i64 {
    compute_webcam_start_offset_ms(
        spawn_offset_ms,
        measured_camera_start_ms.unwrap_or(fallback_camera_head_trim_ms),
        screen_head_trim_ms,
    )
}

/// The segment's rendered video timeline. FFmpeg only starts producing frames
/// several hundred milliseconds after spawn (input and encoder init), while
/// the audio workers and cursor tracker clock against the spawn instant. Every
/// wall-clock stream is therefore aligned to the video at finalize time:
/// `head_trim` is dropped from the front of each track and the timeline length
/// becomes the video stream's actual duration.
#[derive(Debug, Clone, Copy)]
struct SegmentTimeline {
    head_trim: Duration,
    duration: Duration,
}

impl SegmentTimeline {
    fn head_trim_ms(&self) -> u64 {
        self.head_trim.as_millis().min(u64::MAX as u128) as u64
    }
}

/// Largest plausible startup gap between process spawn and the first captured
/// frame. Larger deltas indicate a probe or clock anomaly; alignment falls
/// back to the wall clock instead of shifting tracks by a bogus amount.
/// Shared with crash recovery, which applies the same rejection rule to its
/// WAV-derived startup-gap estimate.
pub(crate) const MAX_VIDEO_STARTUP_GAP_MS: u64 = 5_000;

/// Re-read a window source's current bounds from its HWND and update the
/// session config when the window moved since it was enumerated. No-op for
/// display/region sources and when the window no longer exists (in which case
/// the last known bounds keep recording the original rectangle).
fn refresh_window_source_bounds(session: &mut ActiveSession) {
    if let Some(bounds) = super::source::refresh_window_bounds(&session.config.source) {
        if bounds != session.config.source.bounds {
            tracing::info!(
                old = ?session.config.source.bounds,
                new = ?bounds,
                "window capture target moved; using refreshed frame bounds"
            );
            session.config.source.bounds = bounds;
        }
    }
}

/// Ordered backend attempts for one encoder candidate: the DDA backend first
/// (when the FFmpeg build has the filter), then the GDI-compatible path.
/// Pure so the attempt order stays testable without spawning capture.
fn screen_backend_attempts(ddagrab_available: bool) -> Vec<bool> {
    if ddagrab_available {
        vec![true, false]
    } else {
        vec![false]
    }
}

/// Compute the alignment math from the measured clocks. Pure so the clamping
/// rules stay testable: a missing probe keeps the legacy wall-clock behavior,
/// and an implausible gap is rejected rather than applied.
fn compute_segment_timeline(
    wall_span_ms: u64,
    fallback_wall_ms: u64,
    probed_video_ms: Option<u64>,
    probed_start_ms: Option<u64>,
) -> SegmentTimeline {
    let Some(video_ms) = probed_video_ms.filter(|value| *value > 0) else {
        return SegmentTimeline {
            head_trim: Duration::ZERO,
            duration: Duration::from_millis(fallback_wall_ms),
        };
    };
    let wall_head_trim_ms = wall_span_ms.saturating_sub(video_ms);
    let head_trim_ms = probed_start_ms
        .filter(|start| *start > 0 && *start <= MAX_VIDEO_STARTUP_GAP_MS)
        .unwrap_or(0)
        .max(wall_head_trim_ms);

    if head_trim_ms > MAX_VIDEO_STARTUP_GAP_MS {
        return SegmentTimeline {
            head_trim: Duration::ZERO,
            duration: Duration::from_millis(fallback_wall_ms),
        };
    }
    SegmentTimeline {
        head_trim: Duration::from_millis(head_trim_ms),
        duration: Duration::from_millis(video_ms),
    }
}

impl Recorder {
    pub fn new(
        ffmpeg_path: PathBuf,
        ffprobe_path: PathBuf,
        sessions_dir: PathBuf,
        db: Arc<Mutex<rusqlite::Connection>>,
    ) -> Self {
        // Probe ddagrab support once so display capture can transparently fall
        // back to gdigrab on FFmpeg builds that lack the Desktop Duplication
        // filter (a common cause of instant capture failures on Windows).
        let ddagrab_available =
            super::media::ffmpeg_has_filter(&ffmpeg_path.to_string_lossy(), "ddagrab");
        let available_encoders = super::encoder::detect_encoders(&ffmpeg_path.to_string_lossy())
            .map(|list| {
                list.into_iter()
                    .filter(|e| e.available)
                    .map(|e| e.id)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|_| vec!["libx264".into()]);
        info!(
            ddagrab_available,
            ?available_encoders,
            "recorder initialized"
        );
        Self {
            ffmpeg_path,
            ffprobe_path,
            sessions_dir,
            db,
            ddagrab_available,
            available_encoders,
            current: Mutex::new(None),
            finalizing: Mutex::new(None),
            last_manifest: Mutex::new(None),
            resource_gate: Arc::new(crate::state::CaptureWorkGate::default()),
        }
    }

    /// Encoder ids that passed the startup probe. Shared with the export and
    /// proxy media jobs so they reuse the same detection instead of re-probing.
    pub fn available_encoders(&self) -> &[String] {
        &self.available_encoders
    }

    /// The shared media-work admission gate. Media jobs wait on this instead
    /// of competing with an active capture or finalization.
    pub fn resource_gate(&self) -> Arc<crate::state::CaptureWorkGate> {
        Arc::clone(&self.resource_gate)
    }

    /// Discover or verify the FFmpeg binary path.
    ///
    /// Prefer calling `media::resolve_executable_with_resource_dir` directly
    /// from Tauri setup where the resource dir is available. This zero-arg
    /// overload is kept for contexts where no `AppHandle` is at hand.
    pub fn resolve_ffmpeg() -> crate::errors::Result<PathBuf> {
        crate::media::resolve_executable("ffmpeg")
    }

    #[instrument(skip(self))]
    pub fn prepare(&self, config: RecordingConfig) -> crate::errors::Result<String> {
        config.validate()?;
        let mut guard = self
            .current
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("recorder mutex poisoned".into()))?;

        if let Some(active) = guard.as_mut() {
            let state = active
                .manifest
                .lock()
                .map_err(|_| {
                    crate::errors::InternalError::Capture("manifest mutex poisoned".into())
                })?
                .state;
            let screen_running = active
                .screen_capture
                .as_mut()
                .map(|capture| capture.is_running())
                .unwrap_or(false);
            if screen_running
                || matches!(
                    state,
                    RecorderState::Countdown
                        | RecorderState::Recording
                        | RecorderState::Paused
                        | RecorderState::Finalizing
                )
            {
                return Err(crate::errors::InternalError::Capture(
                    "a recording is already active".into(),
                )
                .into());
            }

            info!("clearing inactive failed recording session before start");
            *guard = None;
        }

        // Admit the session before any directory or manifest work so a media
        // job holding the gate can never race capture startup. The local
        // permit releases through RAII if preparation fails below.
        let resource_permit = self.resource_gate.try_acquire()?;

        let profile = config.resolve_profile().ok_or_else(|| {
            crate::errors::InternalError::Capture(format!("unknown profile: {}", config.profile))
        })?;
        let session_id = uuid::Uuid::new_v4().to_string();
        let work_dir = self.sessions_dir.join(&session_id);
        std::fs::create_dir_all(&work_dir).map_err(|e| {
            crate::errors::InternalError::Storage(format!("create session dir: {e}"))
        })?;

        let output = work_dir.join("output.mp4");
        let manifest = Arc::new(Mutex::new(RecordingManifest::new(
            &session_id,
            work_dir.to_string_lossy(),
            config.source.clone(),
            &profile.id,
        )));
        {
            let mut m = manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            m.set_output_path(output.to_string_lossy());
            m.set_smart_zoom(RecordingSmartZoom {
                enabled: config.smart_zoom_enabled,
                preset: config.smart_zoom_preset.clone(),
            });
            m.set_state(RecorderState::Countdown);
            m.write()?;
        }

        if let Ok(mut latest) = self.last_manifest.lock() {
            *latest = Some(Arc::clone(&manifest));
        }
        *guard = Some(ActiveSession {
            session_id: session_id.clone(),
            work_dir,
            config,
            profile,
            manifest,
            screen_capture: None,
            audio_captures: Vec::new(),
            webcam_capture: None,
            webcam_preview_server: None,
            webcam_segments: Vec::new(),
            webcam_segments_started: 0,
            webcam_capture_failed: false,
            cursor_tracker: None,
            cursor_segment_start_ms: 0,
            segment_index: 0,
            total_recorded_ms: 0,
            started_at: None,
            resource_permit: Some(resource_permit),
        });

        Ok(session_id)
    }

    #[instrument(skip(self))]
    pub fn start_prepared(&self, session_id: &str) -> crate::errors::Result<()> {
        let mut guard = self
            .current
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("recorder mutex poisoned".into()))?;
        let session = guard
            .as_mut()
            .ok_or_else(|| crate::errors::InternalError::Capture("no prepared recording".into()))?;

        if session.session_id != session_id {
            return Err(crate::errors::InternalError::Capture(
                "prepared recording session does not match".into(),
            )
            .into());
        }
        let state = session
            .manifest
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("manifest mutex poisoned".into()))?
            .state;
        if state != RecorderState::Countdown {
            return Err(crate::errors::InternalError::Capture(
                "recording is not waiting to start".into(),
            )
            .into());
        }

        // Window targets are re-acquired at segment start so a window that
        // moved since enumeration is captured at its current position.
        refresh_window_source_bounds(session);
        let captures = match self.start_segment(
            0,
            &session.work_dir,
            &session.config,
            &session.profile,
            Arc::clone(&session.manifest),
            &session.session_id,
            0,
        ) {
            Ok(captures) => captures,
            Err(error) => {
                if let Ok(mut manifest) = session.manifest.lock() {
                    manifest.set_state(RecorderState::Failed);
                    if let Err(write_error) = manifest.write() {
                        tracing::error!(error = ?write_error, "failed to persist failed recording state");
                    }
                }
                // start_segment drops any partially started workers on its
                // error path, so no captures survive here — release the gate.
                session.resource_permit.take();
                return Err(error);
            }
        };

        session.screen_capture = Some(captures.screen);
        session.audio_captures = captures.audio;
        if captures.webcam.is_some() {
            session.webcam_segments_started += 1;
        }
        session.webcam_capture = captures.webcam;
        session.webcam_preview_server = captures.webcam_preview_server;
        session.webcam_capture_failed |= captures.webcam_failed;
        session.cursor_tracker = Some(captures.cursor_tracker);
        let bounds = session.config.source.bounds;
        session.started_at = Some(chrono::Utc::now());
        {
            let mut manifest = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            manifest.set_cursor_telemetry(cursor_asset_metadata(
                &session.session_id,
                bounds,
                session.profile.width.max(1) as u32,
                session.profile.height.max(1) as u32,
            )?);
            manifest.set_state(RecorderState::Recording);
            manifest.write()?;
        }

        info!(%session_id, "recording capture started");
        Ok(())
    }

    #[instrument(skip(self))]
    pub fn cancel_prepared(&self, session_id: &str) -> crate::errors::Result<()> {
        let mut guard = self
            .current
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("recorder mutex poisoned".into()))?;
        let session = guard
            .as_ref()
            .ok_or_else(|| crate::errors::InternalError::Capture("no prepared recording".into()))?;
        let state = session
            .manifest
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("manifest mutex poisoned".into()))?
            .state;
        if session.session_id != session_id || state != RecorderState::Countdown {
            return Err(crate::errors::InternalError::Capture(
                "recording cannot be cancelled in its current state".into(),
            )
            .into());
        }

        let session = guard.take().ok_or_else(|| {
            crate::errors::InternalError::Capture("prepared recording disappeared".into())
        })?;
        drop(guard);
        std::fs::remove_dir_all(&session.work_dir).map_err(|e| {
            crate::errors::InternalError::Storage(format!("remove cancelled session: {e}"))
        })?;
        Ok(())
    }

    #[instrument(skip(self))]
    pub fn start(&self, config: RecordingConfig) -> crate::errors::Result<String> {
        let session_id = self.prepare(config)?;
        self.start_prepared(&session_id)?;
        Ok(session_id)
    }

    #[allow(clippy::too_many_arguments)]
    fn start_segment(
        &self,
        index: u32,
        work_dir: &std::path::Path,
        config: &RecordingConfig,
        profile: &RecordingProfile,
        manifest: Arc<Mutex<RecordingManifest>>,
        recording_id: &str,
        cursor_time_offset_ms: u64,
    ) -> crate::errors::Result<SegmentCaptures> {
        let ffmpeg = self.ffmpeg_path.to_string_lossy();
        let screen_output = work_dir.join(format!("seg_{:03}.mp4", index));
        // Ordered fallback chain: for each detected encoder try the DDA
        // backend first (when the build has the filter), then the GDI path.
        // FfmpegCapture::start itself downgrades a failing GPU-resident
        // pipeline to CPU processing before surfacing an error; libx264 is
        // always the last candidate.
        let encoder_candidates = super::encoder::recording_encoder_candidates(
            &self.available_encoders,
            &profile.encoder_priority,
        );
        info!(
            candidates = ?encoder_candidates,
            profile = %profile.id,
            "screen capture encoder candidates"
        );

        // Negotiate the camera mode BEFORE starting the screen process: the
        // dshow `-list_options` probe can take up to a few seconds and must not
        // delay the screen capture's timeline origin. Probed once per segment;
        // on probe failure (or non-Windows) the list is empty and the device
        // defaults are used as the only attempt.
        let camera = super::webcam::camera_profile(profile);
        let probed_modes = match (config.capture_webcam, config.webcam_device_id.as_ref()) {
            (true, Some(device)) => {
                super::webcam::probe_camera_modes(&ffmpeg, device, camera.fps as f64)
            }
            _ => Vec::new(),
        };
        let mut mode_attempts: Vec<Option<super::webcam::CameraMode>> =
            super::webcam::ordered_camera_modes(
                &probed_modes,
                camera.width.max(1) as u32,
                camera.height.max(1) as u32,
            )
            .into_iter()
            .map(Some)
            .collect();
        // The trailing `None` is the device-defaults compatibility attempt —
        // recorded as `mode=None` in diagnostics, never mistaken for an
        // advertised mode.
        mode_attempts.push(None);

        let mut last_error = None;
        let mut screen = None;
        let mut screen_encoder_index = 0usize;
        let mut screen_backend_fallback = false;
        'encoders: for (encoder_index, encoder) in encoder_candidates.iter().enumerate() {
            for use_ddagrab in screen_backend_attempts(self.ddagrab_available) {
                match FfmpegCapture::start(
                    &ffmpeg,
                    config,
                    profile,
                    encoder,
                    &screen_output.to_string_lossy(),
                    index,
                    Some(Arc::clone(&manifest)),
                    use_ddagrab,
                ) {
                    Ok(capture) => {
                        screen = Some(capture);
                        screen_encoder_index = encoder_index;
                        screen_backend_fallback = !use_ddagrab && self.ddagrab_available;
                        break 'encoders;
                    }
                    Err(error) => {
                        tracing::warn!(
                            %error,
                            encoder,
                            use_ddagrab,
                            "screen capture attempt failed; trying next candidate"
                        );
                        last_error = Some(error);
                    }
                }
            }
        }
        let mut screen = match screen {
            Some(screen) => screen,
            None => {
                return Err(last_error.unwrap_or_else(|| {
                    crate::errors::InternalError::Capture("screen capture could not start".into())
                        .into()
                }));
            }
        };
        // Record why a non-primary encoder/backend won — the same generic
        // codes the webcam chain reports, combined with any GPU-pipeline
        // downgrade FfmpegCapture::start already recorded.
        let mut reasons: Vec<String> = screen.diagnostics().fallback_reason.into_iter().collect();
        if screen_encoder_index > 0 {
            reasons.push("encoder-fallback".into());
        }
        if screen_backend_fallback {
            reasons.push("backend-fallback".into());
        }
        if !reasons.is_empty() {
            screen.set_fallback_reason(Some(reasons.join("+")));
        }

        // Every auxiliary capture and the cursor tracker share the screen
        // process origin. Starting the tracker before webcam initialization
        // prevents a slow camera from creating a telemetry blind spot.
        let timeline_origin = screen.timeline_anchor();
        let bounds = config.source.bounds;
        let capture_bounds = super::cursor::CursorCaptureBounds {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width.max(1) as u32,
            height: bounds.height.max(1) as u32,
        };
        let cursor_tracker = super::cursor_v2::CursorTrackerV2::start(
            recording_id.to_string(),
            work_dir.to_path_buf(),
            capture_bounds,
            profile.width.max(1) as u32,
            profile.height.max(1) as u32,
            timeline_origin.instant,
            cursor_time_offset_ms,
            super::cursor_v2::CursorCaptureMode::Full,
        );

        let mut audio = Vec::new();
        if config.capture_microphone {
            let output_path = work_dir.join(format!("mic_{:03}.wav", index));
            match super::audio::start_audio_track(
                AudioCaptureKind::Microphone,
                config.microphone_device_id.clone(),
                output_path,
                timeline_origin,
            ) {
                Ok(track) => {
                    audio.push(ActiveAudioCapture {
                        kind: AudioCaptureKind::Microphone,
                        track,
                    });
                }
                Err(error) => {
                    tracing::warn!(
                        %error,
                        "failed to start microphone capture; continuing recording without microphone"
                    );
                }
            }
        }

        if config.capture_system_audio {
            let output_path = work_dir.join(format!("sys_{:03}.wav", index));
            match super::audio::start_audio_track(
                AudioCaptureKind::SystemLoopback,
                config.system_audio_device_id.clone(),
                output_path,
                timeline_origin,
            ) {
                Ok(track) => {
                    audio.push(ActiveAudioCapture {
                        kind: AudioCaptureKind::SystemLoopback,
                        track,
                    });
                }
                Err(error) => {
                    tracing::warn!(
                        %error,
                        "failed to start system audio capture; continuing recording without system audio"
                    );
                }
            }
        }

        let mut webcam = None;
        let mut webcam_failed = false;
        let mut webcam_preview_server = None;
        if config.capture_webcam {
            if let Some(device) = config.webcam_device_id.as_ref() {
                // The camera runs at its own <=30fps rate/resolution budget —
                // decoupled from the (possibly 60fps) screen profile. Modes
                // were already negotiated before the screen process started.
                let preview_fps = config.webcam_preview_mode.fps();
                // A preview server is only spun up when the user asked for a
                // preview; "off" produces no MJPEG output and no listener.
                let preview_server = if preview_fps.is_some() {
                    super::preview_server::WebcamPreviewServer::start().ok()
                } else {
                    None
                };
                let broadcaster = preview_server.as_ref().map(|s| s.broadcaster());
                let preview_fps = preview_server.as_ref().and(preview_fps);
                let startup_deadline = std::time::Instant::now() + Duration::from_secs(20);

                // Walk detected encoders in preference order — libx264 is
                // always present as the last candidate.
                let encoder_candidates = super::encoder::recording_encoder_candidates(
                    &self.available_encoders,
                    &profile.encoder_priority,
                );
                let first_encoder = encoder_candidates.first().cloned();
                let webcam_output = work_dir.join(format!("webcam_{:03}.mp4", index));

                'modes: for (mode_index, mode) in mode_attempts.into_iter().enumerate() {
                    for encoder in &encoder_candidates {
                        // One extra same-combination attempt is allowed only
                        // for a device that reported busy/in-use — the only
                        // transient startup failure worth retrying. Failed
                        // attempts are killed/reaped inside start_webcam, so
                        // the same output path can be reused: a failed start
                        // never delivered a first output frame.
                        let mut busy_retried = false;
                        loop {
                            let remaining = startup_deadline
                                .saturating_duration_since(std::time::Instant::now());
                            if remaining.is_zero() {
                                break 'modes;
                            }
                            match FfmpegCapture::start_webcam(
                                &ffmpeg,
                                device,
                                &camera,
                                encoder,
                                &webcam_output.to_string_lossy(),
                                None,
                                broadcaster.clone(),
                                mode.as_ref(),
                                preview_fps,
                                remaining.min(Duration::from_secs(8)),
                            ) {
                                Ok(mut capture) => {
                                    // Record why a non-primary combination
                                    // won. Codes are generic — never stderr
                                    // text or device paths.
                                    let mut reasons = Vec::new();
                                    if mode.is_none() {
                                        reasons.push("device-default-mode");
                                    } else if mode_index > 0 {
                                        reasons.push("mode-fallback");
                                    }
                                    if first_encoder.as_deref() != Some(encoder.as_str()) {
                                        reasons.push("encoder-fallback");
                                    }
                                    if !reasons.is_empty() {
                                        capture.set_fallback_reason(Some(reasons.join("+")));
                                    }
                                    capture.attach_diagnostics(Arc::clone(&manifest), index, true);
                                    webcam = Some(capture);
                                    webcam_preview_server = preview_server;
                                    break 'modes;
                                }
                                Err(error) => {
                                    if !busy_retried
                                        && super::webcam::is_device_busy_error(&error.to_string())
                                    {
                                        busy_retried = true;
                                        std::thread::sleep(Duration::from_millis(100));
                                        continue;
                                    }
                                    tracing::debug!(
                                        error = %error,
                                        encoder,
                                        "webcam sidecar start failed; trying next candidate"
                                    );
                                    break;
                                }
                            }
                        }
                    }
                }

                if webcam.is_none() {
                    webcam_failed = true;
                    tracing::warn!("failed to start webcam sidecar; continuing without camera");
                }
            } else {
                // `RecordingConfig::validate` should already enforce this, but
                // guard against the camera becoming detached between config
                // validation and start.
                webcam_failed = true;
                tracing::warn!(
                    "webcam capture requested but device id missing; continuing without camera"
                );
            }
        }

        Ok(SegmentCaptures {
            screen,
            audio,
            webcam,
            webcam_preview_server,
            webcam_failed,
            cursor_tracker,
        })
    }

    fn finalize_audio_tracks(
        &self,
        screen: &FfmpegCapture,
        audio_captures: &mut Vec<ActiveAudioCapture>,
        profile: &RecordingProfile,
        timeline: SegmentTimeline,
    ) {
        if audio_captures.is_empty() {
            return;
        }

        let screen_path = screen.output_path().to_path_buf();
        let mut tracks = Vec::new();
        for mut audio_capture in audio_captures.drain(..) {
            let path = audio_capture.track.output_path().to_path_buf();
            let stopped_bytes = match audio_capture.track.stop() {
                Ok(bytes_written) => bytes_written,
                Err(error) => {
                    tracing::warn!(
                        error = ?error,
                        path = %path.display(),
                        "audio track stopped with an error; keeping whatever was captured"
                    );
                    // A worker that dies mid-capture still leaves its WAV on
                    // disk: the worker finalizes the header before reporting
                    // an error, and a torn file is rebuilt from its length.
                    // The alignment pass below then re-reads the file for the
                    // real payload size. Only a truly unusable file is dropped.
                    if let Err(repair_error) = super::audio::wav::repair_wav_header_if_needed(&path)
                    {
                        tracing::warn!(
                            error = ?repair_error,
                            path = %path.display(),
                            "audio track could not be salvaged"
                        );
                        continue;
                    }
                    0
                }
            };

            let timing = audio_capture.track.timing();
            let alignment = if audio_capture.kind == AudioCaptureKind::Microphone {
                timing.and_then(|timing| {
                    super::audio::wav::compute_audio_timeline_alignment(
                        timing,
                        timeline.head_trim,
                        timeline.duration,
                    )
                })
            } else {
                None
            };
            let bytes_written = if let Some(alignment) = alignment {
                info!(
                    start_offset_ms = alignment.start_offset.as_millis() as u64,
                    source_duration_ms = alignment.source_duration.as_millis() as u64,
                    wall_duration_ms = alignment.wall_duration.as_millis() as u64,
                    drift_ms = alignment.drift_ms,
                    correction_ppm = ((alignment.pts_scale - 1.0) * 1_000_000.0).round() as i64,
                    "aligned microphone capture clock to the video timeline"
                );
                stopped_bytes
            } else {
                if let Some(timing) = timing {
                    tracing::warn!(
                        captured_frames = timing.captured_frames,
                        timestamp_errors = timing.timestamp_errors,
                        discontinuities = timing.discontinuities,
                        "microphone timing was not safe to correct; using duration alignment"
                    );
                }
                match audio_capture
                    .track
                    .align_to_timeline(timeline.head_trim, timeline.duration)
                {
                    Ok(bytes_written) => bytes_written,
                    Err(error) => {
                        tracing::warn!(
                            error = ?error,
                            path = %path.display(),
                            "failed to align audio track to video"
                        );
                        continue;
                    }
                }
            };
            if bytes_written <= 44 {
                tracing::warn!(path = %path.display(), "audio track contained no audio frames");
                continue;
            }

            let title = match audio_capture.kind {
                AudioCaptureKind::Microphone => "Microphone",
                AudioCaptureKind::SystemLoopback => "System Audio",
            };
            tracks.push(media::AudioTrackInput {
                path,
                title,
                kind: match audio_capture.kind {
                    AudioCaptureKind::Microphone => media::AudioTrackKind::Microphone,
                    AudioCaptureKind::SystemLoopback => media::AudioTrackKind::System,
                },
                alignment,
            });
        }

        if tracks.is_empty() {
            return;
        }

        let stem = screen_path
            .file_stem()
            .map(|value| value.to_string_lossy())
            .unwrap_or_else(|| "segment".into());
        let muxed_path = screen_path.with_file_name(format!("audio_mux_{stem}.mp4"));
        if let Err(error) = media::mux_audio_tracks(
            &self.ffmpeg_path.to_string_lossy(),
            &screen_path,
            &tracks,
            &muxed_path,
            &profile.audio_codec,
            profile.audio_bitrate_kbps,
            timeline.duration,
        ) {
            tracing::warn!(error = ?error, "failed to mux native WASAPI tracks; keeping video fragment");
            return;
        }

        match disk::atomic_replace(&muxed_path, &screen_path) {
            Ok(()) => {
                // The screen fragment is durable after its independent audio
                // streams are added. Webcam sidecars are intentionally left
                // untouched and finalized as a separate asset later.
                for track in &tracks {
                    if let Err(error) = std::fs::remove_file(&track.path) {
                        tracing::warn!(
                            error = ?error,
                            path = %track.path.display(),
                            "failed to remove temporary WASAPI WAV"
                        );
                    }
                }
            }
            Err(error) => {
                tracing::warn!(error = ?error, "failed to publish audio-muxed screen fragment");
            }
        }
    }

    fn stop_webcam_segment(
        &self,
        session: &mut ActiveSession,
        webcam: Option<FfmpegCapture>,
        webcam_quit: Option<std::time::Instant>,
        timeline: SegmentTimeline,
        screen_started_at: std::time::Instant,
    ) {
        let Some(mut webcam) = webcam.or_else(|| session.webcam_capture.take()) else {
            if let Some(mut server) = session.webcam_preview_server.take() {
                server.stop();
            }
            return;
        };
        if let Some(mut server) = session.webcam_preview_server.take() {
            server.stop();
        }
        let path = webcam.output_path().to_path_buf();
        let index = session.segment_index;
        let stats = match webcam_quit {
            Some(quit_at) => webcam.wait_for_stop(quit_at),
            None => webcam.stop(),
        };
        let stats = match stats {
            Ok(stats) => stats,
            Err(error) => {
                session.webcam_capture_failed = true;
                error!(%error, "failed to stop webcam sidecar");
                return;
            }
        };

        // Align the webcam stream to the master screen/audio timeline. The
        // camera file's own first-frame origin is preferred when available:
        // on Windows the capture correlated DirectShow sample/graph
        // timestamps back to the process spawn instant. The duration-derived
        // head trim remains the fallback for missing telemetry and
        // non-Windows backends — it is an estimate (it can fold delivery and
        // encoder-flush tail delay into the offset), not an exact origin.
        let wall_span_ms = if stats.quit_span_ms > 0 {
            stats.quit_span_ms
        } else {
            stats.duration_ms
        };
        let (probed_start_ms, probed_webcam) = self.probe_video_timing_ms(&path);
        let webcam_timeline = compute_segment_timeline(
            wall_span_ms,
            stats.duration_ms,
            probed_webcam,
            probed_start_ms,
        );

        let spawn_offset_ms = signed_start_offset_ms(webcam.started_at(), screen_started_at);
        let measured_camera_start_ms = webcam.camera_first_frame_offset_ms();
        let offset_ms = resolve_webcam_start_offset_ms(
            spawn_offset_ms,
            measured_camera_start_ms,
            webcam_timeline.head_trim_ms(),
            timeline.head_trim_ms(),
        );

        info!(
            segment_index = index,
            spawn_offset_ms,
            webcam_wall_span_ms = wall_span_ms,
            probed_webcam_ms = probed_webcam.unwrap_or(0),
            probed_start_ms = probed_start_ms.unwrap_or(0),
            webcam_head_trim_ms = webcam_timeline.head_trim_ms(),
            screen_head_trim_ms = timeline.head_trim_ms(),
            measured_camera_start_ms = ?measured_camera_start_ms,
            timing_source = if measured_camera_start_ms.is_some() {
                "dshow-sample-clock"
            } else {
                "duration-fallback"
            },
            final_offset_ms = offset_ms,
            "aligned webcam segment to screen timeline"
        );

        let Some(file_name) = path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
        else {
            session.webcam_capture_failed = true;
            error!("webcam sidecar path has no file name");
            return;
        };
        session.webcam_segments.push(media::WebcamSegmentInput {
            path: path.clone(),
            duration: timeline.duration,
            offset_ms,
        });

        if let Ok(mut manifest) = session.manifest.lock() {
            manifest.add_webcam_fragment(RecordingWebcamFragment {
                index,
                file_name,
                duration_ms: timeline.duration.as_millis().min(u64::MAX as u128) as u64,
                offset_ms,
                validated: true,
            });
            if let Err(write_error) = manifest.write() {
                tracing::warn!(error = ?write_error, "failed to persist webcam fragment metadata");
            }
        } else {
            session.webcam_capture_failed = true;
            error!("webcam manifest mutex poisoned");
        }
    }

    fn finalize_webcam_asset(&self, session: &ActiveSession) -> Option<PathBuf> {
        if !session.config.capture_webcam
            || session.webcam_capture_failed
            || session.webcam_segments.is_empty()
            || session.webcam_segments.len() != session.webcam_segments_started
        {
            if session.config.capture_webcam {
                tracing::warn!(
                    expected = session.webcam_segments_started,
                    finalized = session.webcam_segments.len(),
                    failed = session.webcam_capture_failed,
                    "standalone webcam asset was not published"
                );
            }
            return None;
        }

        let output = session.work_dir.join("webcam.mp4");
        let partial = session.work_dir.join("webcam.partial.mp4");
        if partial.exists() {
            let _ = std::fs::remove_file(&partial);
        }
        if let Err(error) = media::concatenate_webcam_segments(
            &self.ffmpeg_path.to_string_lossy(),
            &session.webcam_segments,
            &partial,
            &session.profile,
            &self.available_encoders,
        ) {
            tracing::warn!(error = ?error, "failed to publish standalone webcam asset");
            return None;
        }
        if let Err(error) = disk::atomic_replace(&partial, &output) {
            tracing::warn!(error = ?error, "failed to publish standalone webcam asset");
            return None;
        }
        Some(output)
    }

    fn stop_audio_captures(&self, audio_captures: &mut Vec<ActiveAudioCapture>) {
        for mut audio_capture in audio_captures.drain(..) {
            if let Err(error) = audio_capture.track.stop() {
                tracing::warn!(error = ?error, "failed to stop audio track during cleanup");
            }
        }
    }

    #[instrument(skip(self))]
    pub fn pause(&self) -> crate::errors::Result<RecordingStatus> {
        let mut guard = self
            .current
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("recorder mutex poisoned".into()))?;
        let session = guard
            .as_mut()
            .ok_or_else(|| crate::errors::InternalError::Capture("no active recording".into()))?;

        // Broadcast stop signal concurrently to all active capture workers at the exact same instant
        let mut screen_capture = session.screen_capture.take();
        let screen_quit = screen_capture.as_mut().map(|s| s.request_stop());
        let mut webcam_capture = session.webcam_capture.take();
        let webcam_quit = webcam_capture.as_mut().map(|w| w.request_stop());
        for audio in &session.audio_captures {
            audio.track.request_stop();
        }

        let mut screen = screen_capture.ok_or_else(|| {
            crate::errors::InternalError::Capture("recording is not in progress".into())
        })?;
        let screen_started_at = screen.started_at();
        let stats = match screen.wait_for_stop(screen_quit.unwrap_or_else(std::time::Instant::now))
        {
            Ok(stats) => stats,
            Err(error) => {
                self.stop_audio_captures(&mut session.audio_captures);
                if let Some(mut webcam) = webcam_capture {
                    session.webcam_capture_failed = true;
                    if let Err(error) =
                        webcam.wait_for_stop(webcam_quit.unwrap_or_else(std::time::Instant::now))
                    {
                        tracing::warn!(error = %error, "failed to stop webcam sidecar during pause error");
                    }
                }
                if let Some(mut tracker) = session.cursor_tracker.take() {
                    tracker.stop();
                }
                if let Ok(mut manifest) = session.manifest.lock() {
                    manifest.set_state(RecorderState::Failed);
                    if let Err(write_error) = manifest.write() {
                        tracing::error!(error = ?write_error, "failed to persist failed recording state");
                    }
                }
                // Every native worker above has been stopped; the dead
                // session must not keep blocking queued media work.
                session.resource_permit.take();
                return Err(error);
            }
        };

        let timeline = self.segment_timeline(&screen, &stats);
        let mut stats = stats;
        stats.duration_ms = timeline.duration.as_millis().min(u64::MAX as u128) as u64;
        self.stop_webcam_segment(
            session,
            webcam_capture,
            webcam_quit,
            timeline,
            screen_started_at,
        );
        self.finalize_audio_tracks(
            &screen,
            &mut session.audio_captures,
            &session.profile,
            timeline,
        );

        if let Some(mut tracker) = session.cursor_tracker.take() {
            tracker.stop();
            self.align_cursor_segment(&session.work_dir, session.cursor_segment_start_ms, timeline);
        }

        let total = session.total_recorded_ms + stats.duration_ms;
        session.total_recorded_ms = total;
        // The segment is already stopped and finalized on disk; validation and
        // manifest persistence from here on must not fail the pause. Returning
        // an error now would leave the session marked Recording with no live
        // capture, which neither pause nor resume could recover from.
        if let Err(error) = self.validated_segments(session) {
            tracing::warn!(error = ?error, "failed to validate segments while pausing");
        }
        {
            let Ok(mut manifest) = session.manifest.lock() else {
                // Mutex poisoning means a thread panicked while holding the
                // manifest; the session can no longer be trusted.
                return Err(crate::errors::InternalError::Capture(
                    "manifest mutex poisoned".into(),
                )
                .into());
            };
            manifest.set_total_recorded_ms(total);
            manifest.set_state(RecorderState::Paused);
            manifest.set_stats(stats);
            if let Err(error) = manifest.write() {
                tracing::error!(error = ?error, "failed to persist paused recording state");
            }
        }

        self.status_from_session(session)
    }

    #[instrument(skip(self))]
    pub fn resume(&self) -> crate::errors::Result<RecordingStatus> {
        let mut guard = self
            .current
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("recorder mutex poisoned".into()))?;
        let session = guard
            .as_mut()
            .ok_or_else(|| crate::errors::InternalError::Capture("no active recording".into()))?;

        if session.screen_capture.is_some() {
            return Err(crate::errors::InternalError::Capture(
                "recording is already in progress".into(),
            )
            .into());
        }

        let state = session
            .manifest
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("manifest mutex poisoned".into()))?
            .state;
        if state != RecorderState::Paused {
            return Err(
                crate::errors::InternalError::Capture("session is not paused".into()).into(),
            );
        }

        let next_index = session.segment_index + 1;
        // Same re-acquisition as the initial start: follow a window that was
        // moved or resized while the recording was paused.
        refresh_window_source_bounds(session);
        let captures = self.start_segment(
            next_index,
            &session.work_dir,
            &session.config,
            &session.profile,
            Arc::clone(&session.manifest),
            &session.session_id,
            session.total_recorded_ms,
        )?;

        session.segment_index = next_index;
        session.screen_capture = Some(captures.screen);
        session.audio_captures = captures.audio;
        if captures.webcam.is_some() {
            session.webcam_segments_started += 1;
        }
        session.webcam_capture = captures.webcam;
        session.webcam_preview_server = captures.webcam_preview_server;
        session.webcam_capture_failed |= captures.webcam_failed;
        let bounds = session.config.source.bounds;
        session.cursor_segment_start_ms = session.total_recorded_ms.saturating_add(1);
        session.cursor_tracker = Some(captures.cursor_tracker);
        {
            let mut manifest = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            manifest.set_cursor_telemetry(cursor_asset_metadata(
                &session.session_id,
                bounds,
                session.profile.width.max(1) as u32,
                session.profile.height.max(1) as u32,
            )?);
            manifest.set_state(RecorderState::Recording);
            manifest.write()?;
        }

        self.status_from_session(session)
    }

    /// Abort the active recording without saving anything and delete the whole
    /// session working directory (fragments, audio, webcam, cursor telemetry).
    ///
    /// Unlike `stop`, no finalization happens: captures are torn down, the
    /// recorder returns to Idle, and the session leaves no recovery trace.
    /// Fails only when the working directory could not be removed; the recorder
    /// is still cleared in that case so it cannot wedge.
    #[instrument(skip(self))]
    pub fn discard(&self) -> crate::errors::Result<()> {
        let (mut session, work_dir) = {
            let mut guard = self.current.lock().map_err(|_| {
                crate::errors::InternalError::Capture("recorder mutex poisoned".into())
            })?;
            let session = guard.take().ok_or_else(|| {
                crate::errors::InternalError::Capture("no active recording".into())
            })?;
            let work_dir = session.work_dir.clone();
            (session, work_dir)
        };

        // Teardown mirrors the error paths of stop(): every worker is told to
        // quit, but results are only logged — we are deleting the outputs.
        if let Some(mut screen) = session.screen_capture.take() {
            if let Err(error) = screen.stop() {
                tracing::debug!(error = %error, "screen capture stop reported an error during discard");
            }
        }
        self.stop_audio_captures(&mut session.audio_captures);
        if let Some(mut webcam) = session.webcam_capture.take() {
            if let Err(error) = webcam.stop() {
                tracing::debug!(error = %error, "webcam stop reported an error during discard");
            }
        }
        if let Some(mut tracker) = session.cursor_tracker.take() {
            tracker.stop();
        }

        match std::fs::remove_dir_all(&work_dir) {
            Ok(()) => {
                info!(work_dir = %work_dir.display(), "discarded recording session");
                Ok(())
            }
            Err(error) => Err(crate::errors::InternalError::Storage(format!(
                "delete discarded session data: {error}"
            ))
            .into()),
        }
    }

    #[instrument(skip(self))]
    pub fn stop(&self) -> crate::errors::Result<RecordingStats> {
        self.stop_with_progress(|_| {})
    }

    #[instrument(skip(self, progress))]
    pub fn stop_with_progress<F>(&self, progress: F) -> crate::errors::Result<RecordingStats>
    where
        F: Fn(FinalizationProgress) + Send + Sync,
    {
        // Take the session out of self.current and record the finalizing status.
        // This releases self.current IMMEDIATELY so that status polls and other
        // commands never block on heavy media finalization.
        let (mut session, session_id) = {
            let mut guard = self.current.lock().map_err(|_| {
                crate::errors::InternalError::Capture("recorder mutex poisoned".into())
            })?;
            let mut session = guard.take().ok_or_else(|| {
                crate::errors::InternalError::Capture("no active recording".into())
            })?;
            let session_id = session.session_id.clone();
            let mut finalizing_status = match self.status_from_session(&mut session) {
                Ok(s) => s,
                Err(_) => RecordingStatus {
                    session_id: session_id.clone(),
                    state: RecorderState::Finalizing,
                    started_at: None,
                    stopped_at: None,
                    duration_ms: session.total_recorded_ms,
                    recorded_ms: session.total_recorded_ms,
                    source_kind: String::new(),
                    source_name: String::new(),
                    microphone_active: false,
                    system_audio_active: false,
                    webcam_active: false,
                    webcam_device_id: None,
                    webcam_device_name: None,
                    webcam_preview_url: None,
                    screen_diagnostics: None,
                    camera_diagnostics: None,
                    error: None,
                },
            };
            finalizing_status.state = RecorderState::Finalizing;
            if let Ok(mut finalizing_guard) = self.finalizing.lock() {
                *finalizing_guard = Some(finalizing_status);
            }
            (session, session_id)
        };

        progress(FinalizationProgress {
            session_id: session_id.clone(),
            step: "stopping_captures".into(),
            stage_label: "Stopping capture processes...".into(),
            percent: 15,
        });

        // Broadcast stop signal concurrently to all active capture workers at the exact same instant
        let mut screen_capture = session.screen_capture.take();
        let screen_quit = screen_capture.as_mut().map(|s| s.request_stop());
        let mut webcam_capture = session.webcam_capture.take();
        let webcam_quit = webcam_capture.as_mut().map(|w| w.request_stop());
        for audio in &session.audio_captures {
            audio.track.request_stop();
        }

        let mut timeline = SegmentTimeline {
            head_trim: Duration::ZERO,
            duration: Duration::ZERO,
        };
        let final_stats = if let Some(mut screen) = screen_capture {
            let screen_started_at = screen.started_at();
            let stats = match screen
                .wait_for_stop(screen_quit.unwrap_or_else(std::time::Instant::now))
            {
                Ok(stats) => stats,
                Err(error) => {
                    self.stop_audio_captures(&mut session.audio_captures);
                    if let Some(mut webcam) = webcam_capture {
                        session.webcam_capture_failed = true;
                        if let Err(error) = webcam
                            .wait_for_stop(webcam_quit.unwrap_or_else(std::time::Instant::now))
                        {
                            tracing::warn!(error = %error, "failed to stop webcam sidecar during stop error");
                        }
                    }
                    if let Ok(mut manifest) = session.manifest.lock() {
                        manifest.set_state(RecorderState::Failed);
                        if let Err(write_error) = manifest.write() {
                            tracing::error!(error = ?write_error, "failed to persist failed recording state");
                        }
                    }
                    if let Ok(mut finalizing_guard) = self.finalizing.lock() {
                        *finalizing_guard = None;
                    }
                    return Err(error);
                }
            };
            timeline = self.segment_timeline(&screen, &stats);
            let mut stats = stats;
            stats.duration_ms = timeline.duration.as_millis().min(u64::MAX as u128) as u64;
            self.stop_webcam_segment(
                &mut session,
                webcam_capture,
                webcam_quit,
                timeline,
                screen_started_at,
            );
            self.finalize_audio_tracks(
                &screen,
                &mut session.audio_captures,
                &session.profile,
                timeline,
            );
            stats
        } else {
            self.stop_audio_captures(&mut session.audio_captures);
            if let Some(mut webcam) = webcam_capture {
                session.webcam_capture_failed = true;
                if let Err(error) =
                    webcam.wait_for_stop(webcam_quit.unwrap_or_else(std::time::Instant::now))
                {
                    tracing::warn!(error = %error, "failed to stop webcam sidecar during stop cleanup");
                }
            }
            RecordingStats::default()
        };

        if let Some(mut tracker) = session.cursor_tracker.take() {
            tracker.stop();
            self.align_cursor_segment(&session.work_dir, session.cursor_segment_start_ms, timeline);
        }

        session.total_recorded_ms += final_stats.duration_ms;
        let finalize_result = self.finalize_session(&mut session, final_stats, &progress);

        if let Ok(mut finalizing_guard) = self.finalizing.lock() {
            *finalizing_guard = None;
        }

        match finalize_result {
            Ok(stats) => {
                progress(FinalizationProgress {
                    session_id: session_id.clone(),
                    step: "completed".into(),
                    stage_label: "Recording finalized".into(),
                    percent: 100,
                });
                Ok(stats)
            }
            Err(error) => {
                // Finalization failed (disk full, corrupt fragment, probe
                // failure, …). The fragments and manifest stay on disk so the
                // recovery flow can salvage them, but the live recorder must
                // not stay wedged holding a dead session.
                tracing::error!(error = ?error, "recording finalization failed");
                if let Ok(mut manifest) = session.manifest.lock() {
                    manifest.set_state(RecorderState::Failed);
                    if let Err(write_error) = manifest.write() {
                        tracing::error!(error = ?write_error, "failed to persist failed state");
                    }
                }
                Err(error)
            }
        }
    }

    /// Concatenate validated segments, publish the output, and register the
    /// recording in the library. On success the manifest is marked Completed.
    fn finalize_session<F>(
        &self,
        session: &mut ActiveSession,
        mut final_stats: RecordingStats,
        progress: &F,
    ) -> crate::errors::Result<RecordingStats>
    where
        F: Fn(FinalizationProgress) + Send + Sync,
    {
        let session_id = session.session_id.clone();
        let total = session.total_recorded_ms;
        let webcam_output = self.finalize_webcam_asset(session);
        {
            let mut manifest = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            manifest.set_total_recorded_ms(total);
            if let Some(path) = webcam_output.as_ref() {
                manifest.set_webcam_path(path.to_string_lossy());
            }
            manifest.set_state(RecorderState::Finalizing);
            manifest.write()?;
        }

        progress(FinalizationProgress {
            session_id: session_id.clone(),
            step: "validating_segments".into(),
            stage_label: "Validating video segments...".into(),
            percent: 30,
        });

        let segment_files = self.validated_segments(session)?;
        if segment_files.is_empty() {
            return Err(crate::errors::InternalError::Capture(
                "no valid recording segments".into(),
            )
            .into());
        }

        progress(FinalizationProgress {
            session_id: session_id.clone(),
            step: "assembling_video".into(),
            stage_label: "Assembling video...".into(),
            percent: 50,
        });

        let output = session.work_dir.join("output.mp4");
        let partial_output = session.work_dir.join("output.partial.mp4");
        if partial_output.exists() {
            std::fs::remove_file(&partial_output).map_err(|error| {
                crate::errors::InternalError::Storage(format!("remove partial output: {error}"))
            })?;
        }
        media::concatenate_segments(
            &self.ffmpeg_path.to_string_lossy(),
            &session.work_dir,
            &segment_files,
            &partial_output,
        )?;
        disk::atomic_replace(&partial_output, &output)?;

        let output_size = std::fs::metadata(&output)
            .map(|metadata| metadata.len())
            .map_err(|error| {
                crate::errors::InternalError::Storage(format!("output metadata: {error}"))
            })?;
        if output_size <= 1024 {
            return Err(crate::errors::InternalError::Media(
                "final recording output is empty".into(),
            )
            .into());
        }
        disk::sync_file(&output)?;

        progress(FinalizationProgress {
            session_id: session_id.clone(),
            step: "generating_poster".into(),
            stage_label: "Generating thumbnail & metadata...".into(),
            percent: 80,
        });

        let mut metadata = crate::media::probe::probe_media(
            &self.ffprobe_path.to_string_lossy(),
            &output,
            "pending-recording",
        )?;
        if !metadata.streams.iter().any(|stream| stream.kind == "video") {
            return Err(crate::errors::InternalError::Media(
                "final recording has no video stream".into(),
            )
            .into());
        }

        final_stats.duration_ms = total.max(metadata.duration_ms);
        final_stats.output_size_bytes = output_size;

        let poster_path = session.work_dir.join("poster.jpg");
        let poster_path_str = if crate::media::thumbnails::generate_poster_frame(
            &self.ffmpeg_path.to_string_lossy(),
            &output,
            &poster_path,
        )
        .is_ok()
        {
            Some(poster_path.to_string_lossy().to_string())
        } else {
            None
        };

        progress(FinalizationProgress {
            session_id: session_id.clone(),
            step: "saving_library".into(),
            stage_label: "Saving to library...".into(),
            percent: 92,
        });

        let manifest_clone = {
            let mut manifest = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            manifest.set_output_path(output.to_string_lossy());
            if let Some(poster) = &poster_path_str {
                manifest.set_thumbnail_path(poster);
            }
            manifest.set_total_recorded_ms(final_stats.duration_ms);
            manifest.set_stats(final_stats.clone());
            manifest.write()?;
            (*manifest).clone()
        };

        let mut db = self
            .db
            .lock()
            .map_err(|_| crate::errors::InternalError::Storage("database mutex poisoned".into()))?;
        let recording =
            crate::database::library::insert_recording(&mut db, &manifest_clone, output_size)?;
        metadata.recording_id = recording.id;
        crate::database::media::upsert_metadata(&db, &metadata)?;
        drop(db);

        {
            let mut manifest = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            manifest.set_state(RecorderState::Completed);
            manifest.write()?;
        }

        Ok(final_stats)
    }

    fn validated_segments(&self, session: &ActiveSession) -> crate::errors::Result<Vec<PathBuf>> {
        let mut manifest = session
            .manifest
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("manifest mutex poisoned".into()))?;
        let session_id = session.session_id.clone();
        let mut paths = Vec::new();

        for fragment in &mut manifest.fragments {
            let file_name = Path::new(&fragment.file_name);
            let is_single_file = file_name.components().count() == 1;
            let path = session.work_dir.join(file_name);
            let size = std::fs::metadata(&path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            let valid = is_single_file
                && fragment.validated
                && size > 1024
                && self.validate_media_file(&path, &session_id);
            fragment.size_bytes = Some(size);
            fragment.validated = valid;
            if valid {
                paths.push(path);
            }
        }

        paths.sort_by_key(|path| {
            path.file_stem()
                .and_then(|stem| {
                    stem.to_string_lossy()
                        .rsplit('_')
                        .next()
                        .map(str::to_string)
                })
                .and_then(|index| index.parse::<u32>().ok())
                .unwrap_or(u32::MAX)
        });
        manifest.touch();
        manifest.write()?;
        Ok(paths)
    }

    fn validate_media_file(&self, path: &Path, recording_id: &str) -> bool {
        crate::media::probe::probe_media(&self.ffprobe_path.to_string_lossy(), path, recording_id)
            .map(|metadata| metadata.streams.iter().any(|stream| stream.kind == "video"))
            .unwrap_or(false)
    }

    /// Probe the fragment's real video stream length and start timestamp. The probed
    /// values are the authority for timeline alignment; the wall clock is only a fallback.
    fn probe_video_timing_ms(&self, path: &Path) -> (Option<u64>, Option<u64>) {
        crate::media::probe::probe_media(
            &self.ffprobe_path.to_string_lossy(),
            path,
            "capture-alignment",
        )
        .ok()
        .map(|metadata| {
            let video_stream = metadata
                .streams
                .iter()
                .find(|stream| stream.kind == "video");
            let start_ms = video_stream.and_then(|stream| stream.start_ms);
            let duration_ms = video_stream
                .and_then(|stream| stream.duration_ms)
                .or(metadata.format.duration_ms)
                .or(if metadata.duration_ms > 0 {
                    Some(metadata.duration_ms)
                } else {
                    None
                });
            (start_ms, duration_ms)
        })
        .unwrap_or((None, None))
    }

    fn segment_timeline(&self, screen: &FfmpegCapture, stats: &RecordingStats) -> SegmentTimeline {
        // Prefer the quit-instant span: process exit trails the last captured
        // frame by the encoder flush, which would inflate the startup gap.
        let wall_span_ms = if stats.quit_span_ms > 0 {
            stats.quit_span_ms
        } else {
            stats.duration_ms
        };
        let (probed_start_ms, probed_duration_ms) =
            self.probe_video_timing_ms(screen.output_path());
        let timeline = compute_segment_timeline(
            wall_span_ms,
            stats.duration_ms,
            probed_duration_ms,
            probed_start_ms,
        );
        info!(
            wall_span_ms,
            probed_video_ms = probed_duration_ms.unwrap_or(0),
            probed_start_ms = probed_start_ms.unwrap_or(0),
            head_trim_ms = timeline.head_trim_ms(),
            duration_ms = timeline.duration.as_millis() as u64,
            "aligned segment tracks to video timeline"
        );
        timeline
    }

    fn align_cursor_segment(
        &self,
        work_dir: &Path,
        segment_start_ms: u64,
        timeline: SegmentTimeline,
    ) {
        let head_trim_ms = timeline.head_trim_ms();
        let duration_ms = timeline.duration.as_millis().min(u64::MAX as u128) as u64;
        if let Err(error) = super::cursor_v2::align_telemetry_segment(
            work_dir,
            segment_start_ms,
            duration_ms,
            head_trim_ms,
        ) {
            tracing::warn!(%error, segment_start_ms, head_trim_ms, duration_ms, "failed to align cursor telemetry to video timeline");
        }
    }

    /// Insert a marker at the current playback position.
    #[instrument(skip(self))]
    pub fn insert_marker(&self, label: String) -> crate::errors::Result<RecordingMarker> {
        let guard = self
            .current
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("recorder mutex poisoned".into()))?;

        let session = guard
            .as_ref()
            .ok_or_else(|| crate::errors::InternalError::Capture("no active recording".into()))?;

        let state = {
            let m = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            m.state
        };

        if state != RecorderState::Recording && state != RecorderState::Paused {
            return Err(crate::errors::InternalError::Capture(
                "cannot insert marker when not recording or paused".into(),
            )
            .into());
        }

        let current_elapsed = session
            .screen_capture
            .as_ref()
            .map(|c| c.elapsed_ms())
            .unwrap_or(0);
        let timestamp_ms = session.total_recorded_ms + current_elapsed;

        let marker = {
            let mut m = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            // All built-in entry points (toolbar button, global shortcut, tray)
            // pass an empty label so markers get a consistent auto-numbered name.
            let resolved_label = if label.trim().is_empty() {
                format!("Marker {}", m.markers.len() + 1)
            } else {
                label
            };
            let marker = RecordingMarker {
                id: uuid::Uuid::new_v4().to_string(),
                label: resolved_label,
                timestamp_ms,
                created_at: chrono::Utc::now().to_rfc3339(),
            };
            m.add_marker(marker.clone());
            m.write()?;
            marker
        };

        Ok(marker)
    }

    pub fn capture_diagnostics(&self) -> Option<super::metrics::SessionCaptureDiagnostics> {
        let current = self.current.lock().ok()?;
        let manifest = current
            .as_ref()
            .map(|session| Arc::clone(&session.manifest))
            .or_else(|| self.last_manifest.lock().ok()?.clone())?;
        let mut snapshot = {
            let manifest = manifest.lock().ok()?;
            super::metrics::SessionCaptureDiagnostics {
                session_id: manifest.session_id.clone(),
                segments: manifest.capture_diagnostics.clone(),
            }
        };
        if let Some(session) = current.as_ref() {
            if let Some(capture) = session.screen_capture.as_ref() {
                super::metrics::upsert_capture_diagnostics(
                    &mut snapshot.segments,
                    session.segment_index,
                    false,
                    capture.diagnostics(),
                );
            }
            if let Some(capture) = session.webcam_capture.as_ref() {
                super::metrics::upsert_capture_diagnostics(
                    &mut snapshot.segments,
                    session.segment_index,
                    true,
                    capture.diagnostics(),
                );
            }
        }
        Some(snapshot)
    }

    /// Runtime status for the React UI.
    pub fn status(&self) -> crate::errors::Result<RecordingStatus> {
        if let Ok(mut guard) = self.current.lock() {
            if let Some(session) = guard.as_mut() {
                return self.status_from_session(session);
            }
        }
        if let Ok(guard) = self.finalizing.lock() {
            if let Some(status) = guard.as_ref() {
                return Ok(status.clone());
            }
        }

        Ok(RecordingStatus {
            session_id: "".into(),
            state: RecorderState::Idle,
            started_at: None,
            stopped_at: None,
            duration_ms: 0,
            recorded_ms: 0,
            source_kind: String::new(),
            source_name: String::new(),
            microphone_active: false,
            system_audio_active: false,
            webcam_active: false,
            webcam_device_id: None,
            webcam_device_name: None,
            webcam_preview_url: None,
            screen_diagnostics: None,
            camera_diagnostics: None,
            error: None,
        })
    }

    fn status_from_session(
        &self,
        session: &mut ActiveSession,
    ) -> crate::errors::Result<RecordingStatus> {
        let m = session
            .manifest
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("manifest mutex poisoned".into()))?;

        let current_elapsed = session
            .screen_capture
            .as_ref()
            .map(|capture| capture.elapsed_ms())
            .unwrap_or(0);
        let recorded_ms = session.total_recorded_ms + current_elapsed;
        let wall_ms = session
            .started_at
            .map(|started_at| (chrono::Utc::now() - started_at).num_milliseconds().max(0) as u64)
            .unwrap_or(0);

        // Liveness comes from the child process status itself, not the
        // stderr EOF flag — a stalled process can still hold the device.
        let camera_live = session
            .webcam_capture
            .as_mut()
            .is_some_and(|capture| capture.is_running());
        let screen_live = session
            .screen_capture
            .as_mut()
            .is_some_and(|capture| capture.is_running());
        // Audio liveness comes from tracks that actually started — the config
        // may request a track whose endpoint never produced a worker.
        let microphone_live = session
            .audio_captures
            .iter()
            .any(|capture| capture.kind == AudioCaptureKind::Microphone);
        let system_audio_live = session
            .audio_captures
            .iter()
            .any(|capture| capture.kind == AudioCaptureKind::SystemLoopback);

        Ok(RecordingStatus {
            session_id: session.session_id.clone(),
            state: m.state,
            started_at: session.started_at.map(|started_at| started_at.to_rfc3339()),
            stopped_at: None,
            duration_ms: wall_ms,
            recorded_ms,
            source_kind: session.config.source.kind.clone(),
            source_name: session.config.source.name.clone(),
            microphone_active: microphone_live,
            system_audio_active: system_audio_live,
            // Report the live camera process, not the request: a sidecar that
            // failed every start attempt (or died mid-recording) is not active
            // even when the config asked for one.
            webcam_active: camera_live,
            webcam_device_id: session.config.webcam_device_id.clone(),
            webcam_device_name: session.config.webcam_device_id.clone(),
            webcam_preview_url: session
                .webcam_preview_server
                .as_ref()
                .map(|s| s.preview_url()),
            // Paused segments have no live capture; fall back to the stored
            // snapshot for THIS segment — never a prior segment's camera,
            // which may have belonged to a mode the resumed attempt no longer uses.
            screen_diagnostics: session
                .screen_capture
                .as_ref()
                .map(|capture| capture.diagnostics())
                .or_else(|| {
                    m.capture_diagnostics
                        .iter()
                        .find(|segment| segment.index == session.segment_index)
                        .and_then(|segment| segment.screen.clone())
                }),
            camera_diagnostics: session
                .webcam_capture
                .as_ref()
                .map(|capture| capture.diagnostics())
                .or_else(|| {
                    m.capture_diagnostics
                        .iter()
                        .find(|segment| segment.index == session.segment_index)
                        .and_then(|segment| segment.camera.clone())
                }),
            error: if m.state == RecorderState::Recording {
                // A requested capture that produced no live worker is a
                // degradation the user must see — otherwise a track is lost
                // silently while its toggle still reads "on".
                let mut missing = Vec::new();
                if session.config.capture_microphone && !microphone_live {
                    missing.push("Microphone");
                }
                if session.config.capture_system_audio && !system_audio_live {
                    missing.push("System audio");
                }
                if session.config.capture_webcam && !camera_live {
                    missing.push("Camera");
                }
                if missing.is_empty() {
                    None
                } else {
                    // Only claim the screen survives when a live screen
                    // process is actually observable.
                    Some(format!(
                        "{} capture is unavailable{}.",
                        missing.join(", "),
                        if screen_live {
                            "; screen recording continues"
                        } else {
                            ""
                        }
                    ))
                }
            } else {
                None
            },
        })
    }
}

/// Compact status payload broadcast from the Rust recorder to the React UI.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub session_id: String,
    pub state: RecorderState,
    pub started_at: Option<String>,
    pub stopped_at: Option<String>,
    pub duration_ms: u64,
    pub recorded_ms: u64,
    /// Human-facing metadata for control surfaces (floating toolbar, tray).
    #[serde(default)]
    pub source_kind: String,
    #[serde(default)]
    pub source_name: String,
    #[serde(default)]
    pub microphone_active: bool,
    #[serde(default)]
    pub system_audio_active: bool,
    #[serde(default)]
    pub webcam_active: bool,
    #[serde(default)]
    pub webcam_device_id: Option<String>,
    #[serde(default)]
    pub webcam_device_name: Option<String>,
    #[serde(default)]
    pub webcam_preview_url: Option<String>,
    #[serde(default)]
    pub screen_diagnostics: Option<super::metrics::CaptureDiagnostics>,
    #[serde(default)]
    pub camera_diagnostics: Option<super::metrics::CaptureDiagnostics>,
    pub error: Option<String>,
}

/// Step and percentage progress emitted during recording session finalization.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizationProgress {
    pub session_id: String,
    pub step: String,
    pub stage_label: String,
    pub percent: u8,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::devices::enumerate_video_devices;
    use crate::capture::source::{Bounds, CaptureSource};
    use std::time::Duration;

    #[test]
    fn segment_timeline_trims_the_video_startup_gap() {
        let timeline = compute_segment_timeline(265_040, 265_061, Some(264_550), None);
        assert_eq!(timeline.head_trim_ms(), 490);
        assert_eq!(timeline.duration, Duration::from_millis(264_550));

        let probed_start_timeline =
            compute_segment_timeline(265_040, 265_061, Some(264_240), Some(800));
        assert_eq!(probed_start_timeline.head_trim_ms(), 800);
        assert_eq!(
            probed_start_timeline.duration,
            Duration::from_millis(264_240)
        );
    }

    #[test]
    fn segment_timeline_falls_back_to_wall_clock_without_a_probe() {
        let timeline = compute_segment_timeline(265_040, 265_061, None, None);
        assert_eq!(timeline.head_trim_ms(), 0);
        assert_eq!(timeline.duration, Duration::from_millis(265_061));

        let zero_probe = compute_segment_timeline(265_040, 265_061, Some(0), None);
        assert_eq!(zero_probe.head_trim_ms(), 0);
        assert_eq!(zero_probe.duration, Duration::from_millis(265_061));
    }

    #[test]
    fn segment_timeline_rejects_implausible_gaps_and_negative_trims() {
        // A probe far shorter than any plausible startup window is a clock or
        // probe anomaly; the wall clock must win instead of a giant trim.
        let implausible = compute_segment_timeline(265_040, 265_061, Some(1_000), None);
        assert_eq!(implausible.head_trim_ms(), 0);
        assert_eq!(implausible.duration, Duration::from_millis(265_061));

        // CFR frame duplication can make the probed video slightly longer than
        // the wall span; the trim clamps to zero and the video length wins.
        let longer_video = compute_segment_timeline(265_040, 265_061, Some(265_100), None);
        assert_eq!(longer_video.head_trim_ms(), 0);
        assert_eq!(longer_video.duration, Duration::from_millis(265_100));
    }

    #[test]
    fn screen_backend_attempts_order_dda_then_gdi() {
        assert_eq!(screen_backend_attempts(true), vec![true, false]);
        assert_eq!(screen_backend_attempts(false), vec![false]);
    }

    #[test]
    fn webcam_start_offset_accounts_for_camera_and_screen_startup_gaps() {
        // Camera spawned 150ms after screen, but camera DirectShow init took 800ms
        // while screen took 500ms. Camera first frame is 150 + 800 - 500 = +450ms
        // relative to master timeline (needs 450ms black padding).
        let offset = compute_webcam_start_offset_ms(150, 800, 500);
        assert_eq!(offset, 450);

        // Camera started faster than screen: screen took 900ms, camera took 200ms
        // with 100ms spawn delay. Offset is 100 + 200 - 900 = -600ms (needs 600ms trim).
        let early_offset = compute_webcam_start_offset_ms(100, 200, 900);
        assert_eq!(early_offset, -600);

        // Equal startup gaps: offset matches process spawn delta.
        let equal_offset = compute_webcam_start_offset_ms(200, 400, 400);
        assert_eq!(equal_offset, 200);

        // Fallback without probes (0ms trims): offset is purely spawn delta.
        let fallback_offset = compute_webcam_start_offset_ms(180, 0, 0);
        assert_eq!(fallback_offset, 180);
    }

    #[test]
    fn webcam_measured_start_ignores_tail_shortfall() {
        // Production seam: the duration-derived head trim bakes encoder
        // flush / delivery tail delay into the camera-only offset. With a
        // measured first-frame origin of 200ms the offset must use 200, not
        // the 800ms fallback trim: 150 + 200 - 100 = 250 (not 850).
        let offset = resolve_webcam_start_offset_ms(150, Some(200), 800, 100);
        assert_eq!(offset, 250);
    }

    #[test]
    fn webcam_measured_start_overrides_fallback_and_stays_honest() {
        // The measured origin wins even when the fallback disagrees wildly.
        assert_eq!(
            resolve_webcam_start_offset_ms(150, Some(200), 1_800, 100),
            250
        );
        // A measured origin of zero is honored, not filtered as "missing".
        assert_eq!(resolve_webcam_start_offset_ms(150, Some(0), 800, 100), 50);
        // A camera that started earlier than the screen still goes negative
        // (needs head trimming in the stitch filter).
        assert_eq!(
            resolve_webcam_start_offset_ms(100, Some(200), 900, 900),
            -600
        );
        // Without telemetry the resolver is exactly the legacy computation.
        assert_eq!(
            resolve_webcam_start_offset_ms(150, None, 800, 100),
            compute_webcam_start_offset_ms(150, 800, 100)
        );
        // Each segment resolves from its own measurement — no shared state.
        assert_eq!(
            resolve_webcam_start_offset_ms(150, Some(800), 1_800, 100),
            850
        );
    }

    #[test]
    fn discard_removes_session_and_returns_recorder_to_idle() {
        let temp_dir = tempfile::tempdir().expect("create temporary sessions directory");
        let db = Arc::new(Mutex::new(
            rusqlite::Connection::open_in_memory().expect("create in-memory database"),
        ));
        let recorder = Recorder::new(
            PathBuf::from("ffmpeg-not-installed"),
            PathBuf::from("ffprobe-not-installed"),
            temp_dir.path().to_path_buf(),
            db,
        );
        let config = RecordingConfig {
            source: CaptureSource {
                kind: "display".into(),
                id: "display-0".into(),
                name: "Display 1".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            },
            profile: "low-impact".into(),
            capture_microphone: false,
            capture_system_audio: false,
            capture_webcam: false,
            webcam_device_id: None,
            microphone_device_id: None,
            system_audio_device_id: None,
            webcam_preview_mode: Default::default(),
            gpu_screen_capture: true,
            smart_zoom_enabled: true,
            smart_zoom_preset: "cinematic".into(),
        };

        let session_id = recorder.prepare(config.clone()).expect("prepare session");
        assert!(temp_dir.path().join(&session_id).exists());
        let manifest =
            RecordingManifest::read(temp_dir.path().join(&session_id).join("session.json"))
                .expect("read prepared manifest");
        assert_eq!(
            manifest
                .smart_zoom
                .as_ref()
                .map(|smart_zoom| smart_zoom.enabled),
            Some(true)
        );
        assert_eq!(
            manifest
                .smart_zoom
                .as_ref()
                .map(|smart_zoom| smart_zoom.preset.as_str()),
            Some("cinematic")
        );

        recorder.discard().expect("discard prepared session");

        let status = recorder.status().expect("read idle status");
        assert_eq!(status.state, RecorderState::Idle);
        assert!(!temp_dir.path().join(&session_id).exists());

        // The recorder must immediately accept a new session after a discard.
        recorder
            .prepare(config)
            .expect("recorder accepts a new session after discard");
    }

    #[test]
    fn discard_without_active_session_fails() {
        let temp_dir = tempfile::tempdir().expect("create temporary sessions directory");
        let db = Arc::new(Mutex::new(
            rusqlite::Connection::open_in_memory().expect("create in-memory database"),
        ));
        let recorder = Recorder::new(
            PathBuf::from("ffmpeg-not-installed"),
            PathBuf::from("ffprobe-not-installed"),
            temp_dir.path().to_path_buf(),
            db,
        );
        assert!(recorder.discard().is_err());
    }

    #[test]
    fn cancel_prepared_session_removes_pending_capture_and_work_dir() {
        let temp_dir = tempfile::tempdir().expect("create temporary sessions directory");
        let db = Arc::new(Mutex::new(
            rusqlite::Connection::open_in_memory().expect("create in-memory database"),
        ));
        let recorder = Recorder::new(
            PathBuf::from("ffmpeg-not-installed"),
            PathBuf::from("ffprobe-not-installed"),
            temp_dir.path().to_path_buf(),
            db,
        );
        let config = RecordingConfig {
            source: CaptureSource {
                kind: "display".into(),
                id: "display-0".into(),
                name: "Display 1".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            },
            profile: "low-impact".into(),
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

        let session_id = recorder.prepare(config).expect("prepare countdown session");
        assert_eq!(
            recorder.status().expect("read pending status").state,
            RecorderState::Countdown
        );
        assert!(temp_dir.path().join(&session_id).exists());

        recorder
            .cancel_prepared(&session_id)
            .expect("cancel countdown session");

        assert_eq!(
            recorder.status().expect("read idle status").state,
            RecorderState::Idle
        );
        assert!(!temp_dir.path().join(session_id).exists());
    }

    fn test_recorder(temp_dir: &std::path::Path) -> Recorder {
        let db = Arc::new(Mutex::new(
            rusqlite::Connection::open_in_memory().expect("create in-memory database"),
        ));
        // Bogus sidecar paths keep every capture attempt local to the
        // process — no screen, camera, or audio device is ever opened.
        Recorder::new(
            PathBuf::from("ffmpeg-not-installed"),
            PathBuf::from("ffprobe-not-installed"),
            temp_dir.to_path_buf(),
            db,
        )
    }

    fn test_config() -> RecordingConfig {
        RecordingConfig {
            source: CaptureSource {
                kind: "display".into(),
                id: "display-0".into(),
                name: "Display 1".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            },
            profile: "low-impact".into(),
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

    fn test_profile() -> RecordingProfile {
        RecordingProfile {
            id: "low-impact".into(),
            label: "Low Impact".into(),
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

    fn test_session(work_dir: &std::path::Path, config: RecordingConfig) -> ActiveSession {
        let manifest = RecordingManifest::new(
            "session-1",
            work_dir.to_string_lossy(),
            config.source.clone(),
            "low-impact",
        );
        ActiveSession {
            session_id: "session-1".into(),
            work_dir: work_dir.to_path_buf(),
            config,
            profile: test_profile(),
            manifest: Arc::new(Mutex::new(manifest)),
            screen_capture: None,
            audio_captures: Vec::new(),
            webcam_capture: None,
            webcam_preview_server: None,
            webcam_segments: Vec::new(),
            webcam_segments_started: 0,
            webcam_capture_failed: false,
            cursor_tracker: None,
            cursor_segment_start_ms: 0,
            segment_index: 0,
            total_recorded_ms: 0,
            started_at: Some(chrono::Utc::now()),
            resource_permit: None,
        }
    }

    #[test]
    fn status_reports_requested_audio_that_never_started() {
        let temp_dir = tempfile::tempdir().expect("create temporary sessions directory");
        let recorder = test_recorder(temp_dir.path());
        let work_dir = temp_dir.path().join("session-1");
        std::fs::create_dir_all(&work_dir).expect("create session work dir");

        let mut config = test_config();
        config.capture_microphone = true;
        config.capture_system_audio = true;
        let mut session = test_session(&work_dir, config);

        // Requested tracks that failed to start must read inactive and surface
        // an error — echoing the config would hide the silent skip.
        let status = recorder
            .status_from_session(&mut session)
            .expect("read status");
        assert!(!status.microphone_active);
        assert!(!status.system_audio_active);
        let error = status
            .error
            .expect("missing captures must surface an error");
        assert!(error.contains("Microphone"), "{error}");
        assert!(error.contains("System audio"), "{error}");

        // A live loopback worker clears the degradation for that track.
        let track = crate::capture::fakes::FakeAudioTrack::new(
            work_dir.join("sys_000.wav"),
            std::time::Instant::now(),
        )
        .expect("create fake audio track");
        session.audio_captures.push(ActiveAudioCapture {
            kind: AudioCaptureKind::SystemLoopback,
            track: Box::new(track),
        });
        let status = recorder
            .status_from_session(&mut session)
            .expect("read status");
        assert!(status.system_audio_active);
        let error = status.error.expect("microphone is still missing");
        assert!(error.contains("Microphone"), "{error}");
        assert!(!error.contains("System audio"), "{error}");
    }

    #[test]
    fn prepare_holds_resource_permit_until_session_leaves() {
        let temp_dir = tempfile::tempdir().expect("create temporary sessions directory");
        let recorder = test_recorder(temp_dir.path());

        let session_id = recorder.prepare(test_config()).expect("prepare session");
        // A queued media job must not start while a session holds the gate.
        assert!(recorder.resource_gate().try_acquire().is_err());

        recorder
            .cancel_prepared(&session_id)
            .expect("cancel countdown session");
        recorder
            .resource_gate()
            .try_acquire()
            .expect("cancel released the permit");
    }

    #[test]
    fn held_job_permit_rejects_new_recording() {
        let temp_dir = tempfile::tempdir().expect("create temporary sessions directory");
        let recorder = test_recorder(temp_dir.path());

        let permit = recorder
            .resource_gate()
            .try_acquire()
            .expect("job acquires free gate");
        let error = recorder
            .prepare(test_config())
            .expect_err("prepare must fail while a job holds the gate");
        assert!(error.to_string().contains("media processing is active"));

        drop(permit);
        recorder
            .prepare(test_config())
            .expect("prepare after release");
        recorder.discard().expect("discard prepared session");
    }

    #[test]
    fn failed_start_releases_resource_permit() {
        let temp_dir = tempfile::tempdir().expect("create temporary sessions directory");
        let recorder = test_recorder(temp_dir.path());

        let session_id = recorder.prepare(test_config()).expect("prepare session");
        // The bogus sidecar cannot spawn, so the segment fails before any
        // real device is touched; the permit must still be released.
        recorder
            .start_prepared(&session_id)
            .expect_err("bogus ffmpeg fails capture startup");

        recorder
            .resource_gate()
            .try_acquire()
            .expect("failed start released the permit");
        recorder.discard().expect("discard failed session");
    }

    #[test]
    fn waiting_job_unblocks_when_session_permit_drops() {
        let temp_dir = tempfile::tempdir().expect("create temporary sessions directory");
        let recorder = test_recorder(temp_dir.path());

        let session_id = recorder.prepare(test_config()).expect("prepare session");
        let gate = recorder.resource_gate();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let waiter = std::thread::spawn(move || gate.wait_for_job(&cancel));
        std::thread::sleep(Duration::from_millis(150));
        assert!(!waiter.is_finished());

        recorder
            .cancel_prepared(&session_id)
            .expect("cancel countdown session");
        let acquired = waiter.join().expect("waiter thread").expect("wait_for_job");
        assert!(acquired.is_some());
    }

    #[test]
    #[ignore = "requires an active desktop display session for gdigrab"]
    fn recording_starts_when_webcam_device_is_unavailable() {
        let temp_dir = tempfile::tempdir().expect("create temporary sessions directory");
        let db = Arc::new(Mutex::new(
            rusqlite::Connection::open_in_memory().expect("create in-memory database"),
        ));
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let ffmpeg = manifest_dir.join("target/debug/ffmpeg.exe");
        let ffprobe = manifest_dir.join("target/debug/ffprobe.exe");
        if !ffmpeg.exists() || !ffprobe.exists() {
            eprintln!("skipping: real FFmpeg sidecar not found");
            return;
        }

        let recorder = Recorder::new(ffmpeg, ffprobe, temp_dir.path().to_path_buf(), db);
        let config = RecordingConfig {
            source: CaptureSource {
                kind: "region".into(),
                id: "region-0".into(),
                name: "Region".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 320,
                    height: 240,
                },
            },
            profile: "low-impact".into(),
            capture_microphone: false,
            capture_system_audio: false,
            capture_webcam: true,
            webcam_device_id: Some("Nonexistent Camera".into()),
            microphone_device_id: None,
            system_audio_device_id: None,
            webcam_preview_mode: Default::default(),
            gpu_screen_capture: true,
            smart_zoom_enabled: false,
            smart_zoom_preset: "product-demo".into(),
        };

        let session_id = recorder.prepare(config).expect("prepare session");

        // The screen should start even though the requested webcam does not exist.
        recorder
            .start_prepared(&session_id)
            .expect("start recording even when webcam is unavailable");

        let status = recorder.status().expect("read recording status");
        assert_eq!(status.state, RecorderState::Recording);
    }

    #[test]
    #[ignore = "requires an active desktop display session for live capture"]
    fn stopped_session_aligns_container_duration_to_video_stream() {
        let temp_dir = tempfile::tempdir().expect("create temporary sessions directory");
        let mut conn = rusqlite::Connection::open_in_memory().expect("create in-memory database");
        crate::database::migrations::run_migrations(&mut conn).expect("run migrations");
        let db = Arc::new(Mutex::new(conn));
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let ffmpeg = manifest_dir.join("binaries/ffmpeg-x86_64-pc-windows-msvc.exe");
        let ffprobe = manifest_dir.join("binaries/ffprobe-x86_64-pc-windows-msvc.exe");
        if !ffmpeg.exists() || !ffprobe.exists() {
            eprintln!("skipping: real FFmpeg sidecar not found");
            return;
        }

        let recorder = Recorder::new(
            ffmpeg.clone(),
            ffprobe.clone(),
            temp_dir.path().to_path_buf(),
            db,
        );
        let config = RecordingConfig {
            source: CaptureSource {
                kind: "region".into(),
                id: "region-0".into(),
                name: "Region".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 320,
                    height: 240,
                },
            },
            profile: "low-impact".into(),
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

        let session_id = recorder.prepare(config).expect("prepare session");
        recorder
            .start_prepared(&session_id)
            .expect("start recording");
        std::thread::sleep(Duration::from_secs(3));
        recorder.stop().expect("stop recording");

        let work_dir = temp_dir.path().join(&session_id);
        let output = work_dir.join("output.mp4");
        assert!(output.exists(), "final output must exist");

        let metadata =
            crate::media::probe::probe_media(&ffprobe.to_string_lossy(), &output, "alignment-test")
                .expect("probe final output");
        let video_ms = metadata
            .streams
            .iter()
            .find(|stream| stream.kind == "video")
            .and_then(|stream| stream.duration_ms)
            .expect("video stream duration");
        // With no audio tracks the container duration equals the video stream;
        // both must match the timeline total recorded in the manifest.
        assert!(metadata.duration_ms.abs_diff(video_ms) <= 20);
        let manifest =
            RecordingManifest::read(work_dir.join("session.json")).expect("load session manifest");
        assert!(
            (manifest.total_recorded_ms as i64 - video_ms as i64).abs() <= 200,
            "totalRecordedMs {} should match the video stream {}",
            manifest.total_recorded_ms,
            video_ms
        );
    }

    #[test]
    #[ignore = "requires a real webcam and will activate it briefly"]
    fn recording_captures_webcam_when_available() {
        let temp_dir = tempfile::tempdir().expect("create temporary sessions directory");
        let mut conn = rusqlite::Connection::open_in_memory().expect("create in-memory database");
        crate::database::migrations::run_migrations(&mut conn).expect("run migrations");
        let db = Arc::new(Mutex::new(conn));
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let ffmpeg = manifest_dir.join("target/debug/ffmpeg.exe");
        let ffprobe = manifest_dir.join("target/debug/ffprobe.exe");
        if !ffmpeg.exists() || !ffprobe.exists() {
            eprintln!("skipping: real FFmpeg sidecar not found");
            return;
        }

        let device = enumerate_video_devices(&ffmpeg.to_string_lossy())
            .ok()
            .and_then(|devices| devices.into_iter().find(|d| d.kind == "webcam"))
            .map(|d| d.name);
        let Some(device) = device else {
            eprintln!("skipping: no real webcam found");
            return;
        };

        let recorder = Recorder::new(ffmpeg, ffprobe, temp_dir.path().to_path_buf(), db);
        let config = RecordingConfig {
            source: CaptureSource {
                kind: "region".into(),
                id: "region-0".into(),
                name: "Region".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 320,
                    height: 240,
                },
            },
            profile: "low-impact".into(),
            capture_microphone: false,
            capture_system_audio: false,
            capture_webcam: true,
            webcam_device_id: Some(device),
            microphone_device_id: None,
            system_audio_device_id: None,
            webcam_preview_mode: Default::default(),
            gpu_screen_capture: true,
            smart_zoom_enabled: false,
            smart_zoom_preset: "product-demo".into(),
        };

        let session_id = recorder.prepare(config).expect("prepare session");
        recorder
            .start_prepared(&session_id)
            .expect("start recording with webcam");

        std::thread::sleep(Duration::from_millis(500));

        recorder.stop().expect("stop recording");

        let session_dir = temp_dir.path().join(&session_id);
        let manifest =
            RecordingManifest::read(session_dir.join("session.json")).expect("read manifest");
        assert_eq!(manifest.state, RecorderState::Completed);
        assert!(
            manifest.webcam_path.is_some(),
            "webcam asset should be produced"
        );
        assert!(PathBuf::from(manifest.webcam_path.unwrap()).exists());
    }
}
