use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::{error, info, instrument};

use super::audio::{WasapiCaptureKind, WasapiCaptureOptions, WasapiCaptureSession};
use super::config::{RecordingConfig, RecordingProfile};
use super::disk;
use super::ffmpeg::FfmpegCapture;
use super::manifest::{
    CursorTelemetryAsset, RecorderState, RecordingManifest, RecordingMarker, RecordingStats,
    RecordingWebcamFragment,
};
use super::media;

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
    webcam_segments: Vec<media::WebcamSegmentInput>,
    webcam_segments_started: usize,
    webcam_capture_failed: bool,
    cursor_tracker: Option<super::cursor_v2::CursorTrackerV2>,
    segment_index: u32,
    total_recorded_ms: u64,
    started_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug)]
struct ActiveAudioCapture {
    kind: WasapiCaptureKind,
    session: WasapiCaptureSession,
}

#[derive(Debug)]
struct SegmentCaptures {
    screen: FfmpegCapture,
    audio: Vec<ActiveAudioCapture>,
    webcam: Option<FfmpegCapture>,
    webcam_failed: bool,
}

fn cursor_asset_metadata(
    session_id: &str,
    bounds: super::source::Bounds,
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

    let source_width = capture_bounds.width;
    let source_height = capture_bounds.height;
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
const MAX_VIDEO_STARTUP_GAP_MS: u64 = 5_000;

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

/// Compute the alignment math from the measured clocks. Pure so the clamping
/// rules stay testable: a missing probe keeps the legacy wall-clock behavior,
/// and an implausible gap is rejected rather than applied.
fn compute_segment_timeline(
    wall_span_ms: u64,
    fallback_wall_ms: u64,
    probed_video_ms: Option<u64>,
) -> SegmentTimeline {
    let Some(video_ms) = probed_video_ms.filter(|value| *value > 0) else {
        return SegmentTimeline {
            head_trim: Duration::ZERO,
            duration: Duration::from_millis(fallback_wall_ms),
        };
    };
    let head_trim_ms = wall_span_ms.saturating_sub(video_ms);
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
        }
    }

    /// Encoder ids that passed the startup probe. Shared with the export and
    /// proxy media jobs so they reuse the same detection instead of re-probing.
    pub fn available_encoders(&self) -> &[String] {
        &self.available_encoders
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
            m.set_state(RecorderState::Countdown);
            m.write()?;
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
            webcam_segments: Vec::new(),
            webcam_segments_started: 0,
            webcam_capture_failed: false,
            cursor_tracker: None,
            segment_index: 0,
            total_recorded_ms: 0,
            started_at: None,
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
        ) {
            Ok(captures) => captures,
            Err(error) => {
                if let Ok(mut manifest) = session.manifest.lock() {
                    manifest.set_state(RecorderState::Failed);
                    if let Err(write_error) = manifest.write() {
                        tracing::error!(error = ?write_error, "failed to persist failed recording state");
                    }
                }
                return Err(error);
            }
        };

        let timeline_origin = captures.screen.started_at();
        session.screen_capture = Some(captures.screen);
        session.audio_captures = captures.audio;
        if captures.webcam.is_some() {
            session.webcam_segments_started += 1;
        }
        session.webcam_capture = captures.webcam;
        session.webcam_capture_failed |= captures.webcam_failed;
        let bounds = session.config.source.bounds;
        let capture_bounds = super::cursor::CursorCaptureBounds {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width.max(1) as u32,
            height: bounds.height.max(1) as u32,
        };
        session.cursor_tracker = Some(super::cursor_v2::CursorTrackerV2::start(
            session.session_id.clone(),
            session.work_dir.clone(),
            capture_bounds,
            capture_bounds.width,
            capture_bounds.height,
            timeline_origin,
            0,
            super::cursor_v2::CursorCaptureMode::Full,
        ));
        session.started_at = Some(chrono::Utc::now());
        {
            let mut manifest = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            manifest.set_cursor_telemetry(cursor_asset_metadata(&session.session_id, bounds)?);
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

    fn start_segment(
        &self,
        index: u32,
        work_dir: &std::path::Path,
        config: &RecordingConfig,
        profile: &RecordingProfile,
        manifest: Arc<Mutex<RecordingManifest>>,
    ) -> crate::errors::Result<SegmentCaptures> {
        let ffmpeg = self.ffmpeg_path.to_string_lossy();
        let screen_output = work_dir.join(format!("seg_{:03}.mp4", index));
        let encoder = super::encoder::select_best_encoder(
            &self.available_encoders,
            &profile.encoder_priority,
        );
        info!(
            %encoder,
            profile = %profile.id,
            "selected video encoder for recording segment"
        );
        let screen = FfmpegCapture::start(
            &ffmpeg,
            config,
            profile,
            &encoder,
            &screen_output.to_string_lossy(),
            index,
            Some(manifest),
            self.ddagrab_available,
        )?;

        // Every audio worker writes against the screen capture's monotonic
        // origin, so startup latency is represented as leading silence rather
        // than a second independent FFmpeg offset.
        let timeline_origin = screen.started_at();
        let mut audio = Vec::new();
        if config.capture_microphone {
            let device_id = config.microphone_device_id.clone().ok_or_else(|| {
                crate::errors::InternalError::Capture("microphone device is missing".into())
            })?;
            let output_path = work_dir.join(format!("mic_{:03}.wav", index));
            let options = WasapiCaptureOptions::microphone(Some(device_id), output_path)
                .with_timeline_origin(timeline_origin);
            let session = WasapiCaptureSession::start(options).map_err(|error| {
                crate::errors::InternalError::Capture(format!("start microphone capture: {error}"))
            })?;
            audio.push(ActiveAudioCapture {
                kind: WasapiCaptureKind::Microphone,
                session,
            });
        }

        if config.capture_system_audio {
            let device_id = config.system_audio_device_id.clone().ok_or_else(|| {
                crate::errors::InternalError::Capture("system audio device is missing".into())
            })?;
            let output_path = work_dir.join(format!("sys_{:03}.wav", index));
            let options = WasapiCaptureOptions::system_loopback(Some(device_id), output_path)
                .with_timeline_origin(timeline_origin);
            let session = WasapiCaptureSession::start(options).map_err(|error| {
                crate::errors::InternalError::Capture(format!(
                    "start system audio capture: {error}"
                ))
            })?;
            audio.push(ActiveAudioCapture {
                kind: WasapiCaptureKind::SystemLoopback,
                session,
            });
        }

        let mut webcam = None;
        let mut webcam_failed = false;
        if config.capture_webcam {
            if let Some(device) = config.webcam_device_id.as_ref() {
                const MAX_WEBCAM_ATTEMPTS: usize = 15;
                const WEBCAM_RETRY_DELAY: Duration = Duration::from_millis(100);

                for attempt in 1..=MAX_WEBCAM_ATTEMPTS {
                    match super::webcam::validate_webcam_device(&ffmpeg, device) {
                        Ok(capabilities) if capabilities.available => {
                            let webcam_output = work_dir.join(format!("webcam_{:03}.mp4", index));
                            match FfmpegCapture::start_webcam(
                                &ffmpeg,
                                device,
                                profile,
                                &encoder,
                                &webcam_output.to_string_lossy(),
                                None,
                            ) {
                                Ok(capture) => {
                                    webcam = Some(capture);
                                    break;
                                }
                                Err(error) => {
                                    if attempt == MAX_WEBCAM_ATTEMPTS {
                                        webcam_failed = true;
                                        tracing::warn!(
                                            error = %error,
                                            device,
                                            "failed to start webcam sidecar; continuing without camera"
                                        );
                                    } else {
                                        tracing::debug!(
                                            error = %error,
                                            device,
                                            attempt,
                                            "webcam sidecar start failed, retrying"
                                        );
                                    }
                                }
                            }
                        }
                        Ok(_) => {
                            if attempt == MAX_WEBCAM_ATTEMPTS {
                                webcam_failed = true;
                                tracing::warn!(
                                    device,
                                    "selected webcam is not available; continuing without camera"
                                );
                            } else {
                                tracing::debug!(device, attempt, "webcam device is busy, retrying");
                            }
                        }
                        Err(error) => {
                            if attempt == MAX_WEBCAM_ATTEMPTS {
                                webcam_failed = true;
                                tracing::warn!(
                                    error = %error,
                                    device,
                                    "failed to validate webcam device; continuing without camera"
                                );
                            } else {
                                tracing::debug!(
                                    error = %error,
                                    device,
                                    attempt,
                                    "webcam validation failed, retrying"
                                );
                            }
                        }
                    }

                    if webcam.is_none() && attempt < MAX_WEBCAM_ATTEMPTS {
                        std::thread::sleep(WEBCAM_RETRY_DELAY);
                    }
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
            webcam_failed,
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
            let path = audio_capture.session.output_path().to_path_buf();
            if let Err(error) = audio_capture.session.stop() {
                tracing::warn!(
                    error = ?error,
                    path = %path.display(),
                    "WASAPI track stopped with an error"
                );
                continue;
            }

            let bytes_written = match audio_capture
                .session
                .align_to_timeline(timeline.head_trim, timeline.duration)
            {
                Ok(bytes_written) => bytes_written,
                Err(error) => {
                    tracing::warn!(
                        error = ?error,
                        path = %path.display(),
                        "failed to align WASAPI track to video"
                    );
                    continue;
                }
            };
            if bytes_written <= 44 {
                tracing::warn!(path = %path.display(), "WASAPI track contained no audio frames");
                continue;
            }

            let title = match audio_capture.kind {
                WasapiCaptureKind::Microphone => "Microphone",
                WasapiCaptureKind::SystemLoopback => "System Audio",
            };
            tracks.push(media::AudioTrackInput {
                path,
                title,
                kind: match audio_capture.kind {
                    WasapiCaptureKind::Microphone => media::AudioTrackKind::Microphone,
                    WasapiCaptureKind::SystemLoopback => media::AudioTrackKind::System,
                },
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
        screen: &FfmpegCapture,
        timeline: SegmentTimeline,
    ) {
        let Some(mut webcam) = session.webcam_capture.take() else {
            return;
        };
        let path = webcam.output_path().to_path_buf();
        // The webcam's wall-clock offset is relative to the screen process
        // spawn; shift it onto the video timeline like every other track.
        let offset_ms = signed_start_offset_ms(webcam.started_at(), screen.started_at())
            .saturating_sub(timeline.head_trim_ms() as i64);
        let index = session.segment_index;
        if let Err(error) = webcam.stop() {
            session.webcam_capture_failed = true;
            error!(%error, "failed to stop webcam sidecar");
            return;
        }

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
            if let Err(error) = audio_capture.session.stop() {
                tracing::warn!(error = ?error, "failed to stop WASAPI track during cleanup");
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
        let mut screen = session.screen_capture.take().ok_or_else(|| {
            crate::errors::InternalError::Capture("recording is not in progress".into())
        })?;
        let stats = match screen.stop() {
            Ok(stats) => stats,
            Err(error) => {
                self.stop_audio_captures(&mut session.audio_captures);
                if let Some(mut webcam) = session.webcam_capture.take() {
                    session.webcam_capture_failed = true;
                    if let Err(error) = webcam.stop() {
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
                return Err(error);
            }
        };

        let timeline = self.segment_timeline(&screen, &stats);
        let mut stats = stats;
        stats.duration_ms = timeline.duration.as_millis().min(u64::MAX as u128) as u64;
        self.stop_webcam_segment(session, &screen, timeline);
        self.finalize_audio_tracks(
            &screen,
            &mut session.audio_captures,
            &session.profile,
            timeline,
        );

        if let Some(mut tracker) = session.cursor_tracker.take() {
            tracker.stop();
            self.shift_cursor_clock(&session.work_dir, timeline.head_trim);
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
        )?;

        let timeline_origin = captures.screen.started_at();
        session.segment_index = next_index;
        session.screen_capture = Some(captures.screen);
        session.audio_captures = captures.audio;
        if captures.webcam.is_some() {
            session.webcam_segments_started += 1;
        }
        session.webcam_capture = captures.webcam;
        session.webcam_capture_failed |= captures.webcam_failed;
        let bounds = session.config.source.bounds;
        let capture_bounds = super::cursor::CursorCaptureBounds {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width.max(1) as u32,
            height: bounds.height.max(1) as u32,
        };
        session.cursor_tracker = Some(super::cursor_v2::CursorTrackerV2::start(
            session.session_id.clone(),
            session.work_dir.clone(),
            capture_bounds,
            capture_bounds.width,
            capture_bounds.height,
            timeline_origin,
            session.total_recorded_ms,
            super::cursor_v2::CursorCaptureMode::Full,
        ));
        {
            let mut manifest = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            manifest.set_cursor_telemetry(cursor_asset_metadata(&session.session_id, bounds)?);
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
        let mut guard = self
            .current
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("recorder mutex poisoned".into()))?;
        let session = guard
            .as_mut()
            .ok_or_else(|| crate::errors::InternalError::Capture("no active recording".into()))?;

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

        let work_dir = session.work_dir.clone();
        guard.take();
        drop(guard);

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
        let mut guard = self
            .current
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("recorder mutex poisoned".into()))?;
        let session = guard
            .as_mut()
            .ok_or_else(|| crate::errors::InternalError::Capture("no active recording".into()))?;

        let mut timeline = SegmentTimeline {
            head_trim: Duration::ZERO,
            duration: Duration::ZERO,
        };
        let final_stats = if let Some(mut screen) = session.screen_capture.take() {
            let stats = match screen.stop() {
                Ok(stats) => stats,
                Err(error) => {
                    self.stop_audio_captures(&mut session.audio_captures);
                    if let Some(mut webcam) = session.webcam_capture.take() {
                        session.webcam_capture_failed = true;
                        if let Err(error) = webcam.stop() {
                            tracing::warn!(error = %error, "failed to stop webcam sidecar during stop error");
                        }
                    }
                    if let Ok(mut manifest) = session.manifest.lock() {
                        manifest.set_state(RecorderState::Failed);
                        if let Err(write_error) = manifest.write() {
                            tracing::error!(error = ?write_error, "failed to persist failed recording state");
                        }
                    }
                    return Err(error);
                }
            };
            timeline = self.segment_timeline(&screen, &stats);
            let mut stats = stats;
            stats.duration_ms = timeline.duration.as_millis().min(u64::MAX as u128) as u64;
            self.stop_webcam_segment(session, &screen, timeline);
            self.finalize_audio_tracks(
                &screen,
                &mut session.audio_captures,
                &session.profile,
                timeline,
            );
            stats
        } else {
            self.stop_audio_captures(&mut session.audio_captures);
            if let Some(mut webcam) = session.webcam_capture.take() {
                session.webcam_capture_failed = true;
                if let Err(error) = webcam.stop() {
                    tracing::warn!(error = %error, "failed to stop webcam sidecar during stop cleanup");
                }
            }
            RecordingStats::default()
        };

        if let Some(mut tracker) = session.cursor_tracker.take() {
            tracker.stop();
            self.shift_cursor_clock(&session.work_dir, timeline.head_trim);
        }

        session.total_recorded_ms += final_stats.duration_ms;
        match self.finalize_session(session, final_stats) {
            Ok(stats) => {
                guard.take();
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
                guard.take();
                Err(error)
            }
        }
    }

    /// Concatenate validated segments, publish the output, and register the
    /// recording in the library. On success the manifest is marked Completed.
    fn finalize_session(
        &self,
        session: &mut ActiveSession,
        mut final_stats: RecordingStats,
    ) -> crate::errors::Result<RecordingStats> {
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

        let segment_files = self.validated_segments(session)?;
        if segment_files.is_empty() {
            return Err(crate::errors::InternalError::Capture(
                "no valid recording segments".into(),
            )
            .into());
        }

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

    /// Probe the fragment's real video stream length. The probed value is the
    /// authority for timeline alignment; the wall clock is only a fallback.
    fn probe_video_duration_ms(&self, path: &Path) -> Option<u64> {
        crate::media::probe::probe_media(
            &self.ffprobe_path.to_string_lossy(),
            path,
            "capture-alignment",
        )
        .ok()
        .and_then(|metadata| {
            metadata
                .streams
                .iter()
                .find(|stream| stream.kind == "video")
                .and_then(|stream| stream.duration_ms)
        })
    }

    fn segment_timeline(&self, screen: &FfmpegCapture, stats: &RecordingStats) -> SegmentTimeline {
        // Prefer the quit-instant span: process exit trails the last captured
        // frame by the encoder flush, which would inflate the startup gap.
        let wall_span_ms = if stats.quit_span_ms > 0 {
            stats.quit_span_ms
        } else {
            stats.duration_ms
        };
        let probed = self.probe_video_duration_ms(screen.output_path());
        let timeline = compute_segment_timeline(wall_span_ms, stats.duration_ms, probed);
        info!(
            wall_span_ms,
            probed_video_ms = probed.unwrap_or(0),
            head_trim_ms = timeline.head_trim_ms(),
            duration_ms = timeline.duration.as_millis() as u64,
            "aligned segment tracks to video timeline"
        );
        timeline
    }

    fn shift_cursor_clock(&self, work_dir: &Path, head_trim: Duration) {
        let head_trim_ms = head_trim.as_millis().min(u64::MAX as u128) as u64;
        if head_trim_ms == 0 {
            return;
        }
        if let Err(error) = super::cursor_v2::shift_telemetry_clock(work_dir, head_trim_ms) {
            tracing::warn!(%error, "failed to align cursor telemetry to video timeline");
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

        let marker = RecordingMarker {
            id: uuid::Uuid::new_v4().to_string(),
            label,
            timestamp_ms,
            created_at: chrono::Utc::now().to_rfc3339(),
        };

        {
            let mut m = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            m.add_marker(marker.clone());
            m.write()?;
        }

        Ok(marker)
    }

    /// Runtime status for the React UI.
    pub fn status(&self) -> crate::errors::Result<RecordingStatus> {
        let guard = self
            .current
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("recorder mutex poisoned".into()))?;

        if let Some(session) = guard.as_ref() {
            self.status_from_session(session)
        } else {
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
                error: None,
            })
        }
    }

    fn status_from_session(
        &self,
        session: &ActiveSession,
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

        Ok(RecordingStatus {
            session_id: session.session_id.clone(),
            state: m.state,
            started_at: session.started_at.map(|started_at| started_at.to_rfc3339()),
            stopped_at: None,
            duration_ms: wall_ms,
            recorded_ms,
            source_kind: session.config.source.kind.clone(),
            source_name: session.config.source.name.clone(),
            microphone_active: session.config.capture_microphone,
            system_audio_active: session.config.capture_system_audio,
            webcam_active: session.config.capture_webcam,
            error: None,
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
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::devices::enumerate_video_devices;
    use crate::capture::source::{Bounds, CaptureSource};
    use std::time::Duration;

    #[test]
    fn segment_timeline_trims_the_video_startup_gap() {
        let timeline = compute_segment_timeline(265_040, 265_061, Some(264_550));
        assert_eq!(timeline.head_trim_ms(), 490);
        assert_eq!(timeline.duration, Duration::from_millis(264_550));
    }

    #[test]
    fn segment_timeline_falls_back_to_wall_clock_without_a_probe() {
        let timeline = compute_segment_timeline(265_040, 265_061, None);
        assert_eq!(timeline.head_trim_ms(), 0);
        assert_eq!(timeline.duration, Duration::from_millis(265_061));

        let zero_probe = compute_segment_timeline(265_040, 265_061, Some(0));
        assert_eq!(zero_probe.head_trim_ms(), 0);
        assert_eq!(zero_probe.duration, Duration::from_millis(265_061));
    }

    #[test]
    fn segment_timeline_rejects_implausible_gaps_and_negative_trims() {
        // A probe far shorter than any plausible startup window is a clock or
        // probe anomaly; the wall clock must win instead of a giant trim.
        let implausible = compute_segment_timeline(265_040, 265_061, Some(1_000));
        assert_eq!(implausible.head_trim_ms(), 0);
        assert_eq!(implausible.duration, Duration::from_millis(265_061));

        // CFR frame duplication can make the probed video slightly longer than
        // the wall span; the trim clamps to zero and the video length wins.
        let longer_video = compute_segment_timeline(265_040, 265_061, Some(265_100));
        assert_eq!(longer_video.head_trim_ms(), 0);
        assert_eq!(longer_video.duration, Duration::from_millis(265_100));
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
        };

        let session_id = recorder.prepare(config.clone()).expect("prepare session");
        assert!(temp_dir.path().join(&session_id).exists());

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
