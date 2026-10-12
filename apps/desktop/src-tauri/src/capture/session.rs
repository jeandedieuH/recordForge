use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::{error, info, instrument};

use super::audio::AudioCaptureKind;
use super::camera_plan::{CameraCapturePlan, CameraOutputLock};
use super::config::{RecordingConfig, RecordingProfile};
use super::disk;
use super::ffmpeg::FfmpegCapture;
use super::manifest::{
    CursorTelemetryAsset, RecorderState, RecordingManifest, RecordingMarker, RecordingSmartZoom,
    RecordingStats, RecordingWebcamFragment,
};
use super::media;
use super::traits::{AudioTrack, TimelineAnchor};
use super::webcam::CameraMode;

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
    /// Primary capture: the screen process, or the camera process for camera
    /// sources (the camera occupies the same slot so the segment/finalize
    /// machinery treats it identically).
    screen_capture: Option<FfmpegCapture>,
    audio_captures: Vec<ActiveAudioCapture>,
    webcam_capture: Option<FfmpegCapture>,
    webcam_preview_server: Option<super::preview_server::WebcamPreviewServer>,
    webcam_segments: Vec<media::WebcamSegmentInput>,
    webcam_segments_started: usize,
    webcam_capture_failed: bool,
    cursor_tracker: Option<super::cursor_v2::CursorTrackerV2>,
    /// Camera sessions only: advertised modes probed once before the first
    /// segment's aux threads start (the dshow listing can take a few seconds).
    /// `Some` caches even an empty result so resume never re-probes.
    camera_modes: Option<Vec<CameraMode>>,
    /// Locked output geometry/rate shared by every camera segment so the
    /// fragments stay stream-copy-concat compatible. Derived when the first
    /// segment stops, then applied to all later segments via `plan lock`.
    camera_lock: Option<CameraOutputLock>,
    /// Encoder that produced the previous camera segment; moved to the front
    /// of the candidate list on resume so segment bitstreams stay compatible.
    camera_encoder: Option<String>,
    /// The camera plan that produced the active/most recent segment.
    camera_plan: Option<CameraCapturePlan>,
    /// Session-long keystroke sampler (Pro keystroke overlay). Unlike the
    /// cursor tracker it is NOT restarted per segment — it timestamps against
    /// the first segment's origin for the whole session.
    keystroke_sampler: Option<super::keystrokes::KeystrokeSampler>,
    /// First timestamp owned by the active cursor segment. Keeping this boundary
    /// prevents startup alignment for a resumed segment from shifting history.
    cursor_segment_start_ms: u64,
    /// How far ahead of the screen process spawn the cursor tracker and audio
    /// workers started for the active segment. Their tracks are trimmed by
    /// `head_trim + segment_startup_shift` at finalize so the extra coverage
    /// disappears instead of surfacing as a leading dead zone.
    segment_startup_shift: Duration,
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
    /// Primary capture: the screen process, or the camera process for camera
    /// sources.
    screen: FfmpegCapture,
    audio: Vec<ActiveAudioCapture>,
    webcam: Option<FfmpegCapture>,
    webcam_preview_server: Option<super::preview_server::WebcamPreviewServer>,
    webcam_failed: bool,
    /// `None` for camera sources — camera mode records no cursor telemetry.
    cursor_tracker: Option<super::cursor_v2::CursorTrackerV2>,
    /// Camera sessions only: the plan/encoder combination that produced this
    /// segment, retained so resume can lock geometry and prefer the same
    /// encoder.
    camera_plan: Option<CameraCapturePlan>,
    camera_encoder: Option<String>,
    /// The segment's timeline anchor — the keystroke sampler stamps events
    /// against the first segment's origin so badges land on video time.
    timeline_origin_instant: std::time::Instant,
    /// Gap between the auxiliary captures' start and the screen process spawn.
    /// Added to the tracks' head trim at finalize (see `SegmentTimeline`).
    startup_shift: Duration,
}

/// Cursor and audio workers started together ahead of the screen process.
/// Bundled so the start can run on a scoped thread without borrowing `Recorder`.
#[derive(Debug)]
struct AuxiliaryCaptures {
    /// `None` for camera sources — camera mode records no cursor telemetry.
    cursor_tracker: Option<super::cursor_v2::CursorTrackerV2>,
    audio: Vec<ActiveAudioCapture>,
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

/// Whether this config records camera-only (`source.kind == "camera"`): the
/// camera process is the primary capture and no screen/cursor telemetry runs.
fn is_camera_source(config: &RecordingConfig) -> bool {
    config.source.kind == "camera"
}

/// Move the previous segment's winning encoder to the front of the candidate
/// list so resumed camera segments encode with a compatible bitstream. A
/// `preferred` id that is absent from the candidates leaves the order intact.
/// Pure so the reordering stays unit-testable.
fn prefer_encoder_first(candidates: &[String], preferred: Option<&str>) -> Vec<String> {
    let mut ordered = candidates.to_vec();
    if let Some(preferred) = preferred {
        if let Some(index) = ordered.iter().position(|encoder| encoder == preferred) {
            // Move the winner to the front without reordering the rest —
            // `rotate_left` would scramble the remaining fallback order.
            let winner = ordered.remove(index);
            ordered.insert(0, winner);
        }
    }
    ordered
}

/// Output geometry/rate shared by every camera segment of a session. Prefer
/// the probed stream of the segment that just finished (the file is the
/// truth); fall back to the winning plan's output geometry. `None` when
/// neither is knowable — resume then re-plans from scratch.
fn derive_camera_lock(
    probed: Option<(u32, u32, f64)>,
    plan: Option<&CameraCapturePlan>,
) -> Option<CameraOutputLock> {
    if let Some((width, height, fps)) = probed {
        return Some(CameraOutputLock { width, height, fps });
    }
    plan.map(|plan| CameraOutputLock {
        width: plan.output_width,
        height: plan.output_height,
        fps: plan.output_fps,
    })
}

/// Camera segment timeline anchored to the MEASURED camera file origin.
/// DirectShow sample/graph timestamps correlated back to the process spawn
/// give the first sensor frame's offset; the audio tracks (started at the
/// aux origin) drop that leading window. When the measurement is missing or
/// implausible the duration-derived `base` timeline is kept unchanged.
fn camera_segment_timeline(
    base: SegmentTimeline,
    measured_origin_ms: Option<u64>,
) -> SegmentTimeline {
    match measured_origin_ms {
        Some(origin_ms) if origin_ms <= MAX_VIDEO_STARTUP_GAP_MS => SegmentTimeline {
            head_trim: Duration::from_millis(origin_ms),
            duration: base.duration,
        },
        _ => base,
    }
}

/// Camera recordings refuse to start with less than 1 GiB free on the
/// sessions volume. Screen sessions are intentionally NOT gated here — they
/// keep their established finalize-time failure behavior.
fn ensure_camera_disk_space(free_bytes: Option<u64>) -> crate::errors::Result<()> {
    const MIN_FREE_BYTES: u64 = 1 << 30; // 1 GiB
    if let Some(free) = free_bytes {
        if free < MIN_FREE_BYTES {
            return Err(crate::errors::InternalError::Capture(format!(
                "Not enough free disk space to record ({:.1} GB free). Free up at least 1 GB and try again.",
                free as f64 / (1u64 << 30) as f64
            ))
            .into());
        }
    }
    Ok(())
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
#[derive(Debug, Clone, Copy, PartialEq)]
struct SegmentTimeline {
    head_trim: Duration,
    duration: Duration,
}

impl SegmentTimeline {
    fn head_trim_ms(&self) -> u64 {
        self.head_trim.as_millis().min(u64::MAX as u128) as u64
    }

    /// Timeline variant for the tracks that started `shift` before the screen
    /// process spawn. Their extra leading coverage is removed by extending the
    /// head trim; the video-derived segment duration is unchanged.
    fn with_startup_shift(self, shift: Duration) -> Self {
        Self {
            head_trim: self.head_trim.saturating_add(shift),
            duration: self.duration,
        }
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

/// Best-effort cleanup after a segment start that failed before the screen
/// capture came up: remove the per-segment WAVs the audio workers opened and
/// drop the cursor events the abandoned attempt recorded (events before
/// `start` belong to prior segments and are kept). Must run only after the
/// workers are dropped — Windows cannot delete open files.
fn discard_failed_segment_auxiliaries(work_dir: &Path, index: u32, cursor_time_offset_ms: u64) {
    for file_name in [format!("mic_{index:03}.wav"), format!("sys_{index:03}.wav")] {
        let path = work_dir.join(&file_name);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(
                    %error,
                    path = %path.display(),
                    "failed to remove audio track from a failed segment start"
                );
            }
        }
    }

    let start = if index == 0 {
        0
    } else {
        cursor_time_offset_ms.saturating_add(1)
    };
    if let Err(error) = super::cursor_v2::align_telemetry_segment(work_dir, start, 0, 0) {
        tracing::warn!(%error, "failed to drop cursor events from a failed segment start");
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

        // Camera-only sessions get a minimum-free-space guard: a camera that
        // fills the disk mid-recording would lose the whole take, so refuse
        // early. When free space cannot be read the check is skipped rather
        // than blocking recording on a stat failure.
        if is_camera_source(&config) {
            match crate::media::disk::available_space(&self.sessions_dir) {
                Ok(free) => ensure_camera_disk_space(Some(free))?,
                Err(error) => {
                    tracing::warn!(%error, "could not read free disk space for camera recording check")
                }
            }
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
            camera_modes: None,
            camera_lock: None,
            camera_encoder: None,
            camera_plan: None,
            keystroke_sampler: None,
            cursor_segment_start_ms: 0,
            segment_startup_shift: Duration::ZERO,
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

        // Camera sessions probe the device's advertised modes ONCE, before
        // any auxiliary thread starts — the dshow `-list_options` listing is
        // 3 s bounded and must not run inside the segment's timeline origin.
        // The result is cached (including an empty listing) and reused by
        // every later segment of this session.
        if is_camera_source(&session.config) && session.camera_modes.is_none() {
            let ffmpeg = self.ffmpeg_path.to_string_lossy();
            session.camera_modes = Some(super::webcam::probe_camera_modes(
                &ffmpeg,
                &session.config.source.id,
                session.profile.fps as f64,
            ));
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
            session.camera_lock,
            session.camera_modes.as_deref(),
            session.camera_encoder.as_deref(),
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
        session.cursor_tracker = captures.cursor_tracker;
        session.camera_plan = captures.camera_plan;
        session.camera_encoder = captures.camera_encoder;
        session.segment_startup_shift = captures.startup_shift;
        // Keystroke sampler starts on the first segment only — a resume keeps
        // the running sampler (timestamps stay on the session clock). Camera
        // sessions never capture keystrokes.
        if session.keystroke_sampler.is_none()
            && session.config.capture_keystrokes
            && !is_camera_source(&session.config)
        {
            session.keystroke_sampler = Some(super::keystrokes::KeystrokeSampler::start(
                session.work_dir.clone(),
                captures.timeline_origin_instant,
            ));
        }
        let bounds = session.config.source.bounds;
        session.started_at = Some(chrono::Utc::now());
        {
            let mut manifest = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            // Camera sessions record no cursor telemetry at all — the asset
            // stays absent rather than describing an empty track.
            if !is_camera_source(&session.config) {
                manifest.set_cursor_telemetry(cursor_asset_metadata(
                    &session.session_id,
                    bounds,
                    session.profile.width.max(1) as u32,
                    session.profile.height.max(1) as u32,
                )?);
            }
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
        camera_lock: Option<CameraOutputLock>,
        camera_modes: Option<&[CameraMode]>,
        preferred_camera_encoder: Option<&str>,
    ) -> crate::errors::Result<SegmentCaptures> {
        if is_camera_source(config) {
            return self.start_camera_segment(
                index,
                work_dir,
                config,
                profile,
                manifest,
                recording_id,
                cursor_time_offset_ms,
                camera_lock,
                camera_modes,
                preferred_camera_encoder,
            );
        }
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

        // The cursor tracker and the WASAPI audio workers clock against the
        // segment origin: they must be running before the screen process
        // emits its first frame, or their tracks would show the startup window
        // as leading silence and missing telemetry. They launch on a scoped
        // thread so a slow or hung audio device can never delay the screen
        // spawn below.
        let aux_origin = TimelineAnchor::now();
        let (screen, screen_encoder_index, screen_backend_fallback, last_error, aux_join) =
            std::thread::scope(|scope| {
                let aux_handle = scope.spawn(|| {
                    Self::start_auxiliary_captures(
                        config,
                        profile,
                        work_dir,
                        index,
                        recording_id,
                        cursor_time_offset_ms,
                        aux_origin,
                    )
                });

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
                (
                    screen,
                    screen_encoder_index,
                    screen_backend_fallback,
                    last_error,
                    aux_handle.join(),
                )
            });

        let aux = match aux_join {
            Ok(aux) => aux,
            Err(_) => {
                // A panicked auxiliary startup cannot be aligned; any screen
                // capture that did start is reaped by dropping it.
                drop(screen);
                return Err(crate::errors::InternalError::Capture(
                    "auxiliary capture startup panicked".into(),
                )
                .into());
            }
        };
        let mut screen = match screen {
            Some(screen) => screen,
            None => {
                // The workers must be stopped before their files can be
                // removed — Windows cannot delete open files.
                drop(aux);
                discard_failed_segment_auxiliaries(work_dir, index, cursor_time_offset_ms);
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

        // The timeline anchor stays the screen process spawn (webcam offsets
        // and the keystroke sampler are keyed to it). `startup_shift` measures
        // how far ahead of the spawn the auxiliaries actually started; finalize
        // adds it to their head trim so the early coverage is dropped rather
        // than surfacing as dead air.
        let timeline_origin = screen.timeline_anchor();
        let startup_shift = timeline_origin
            .instant
            .saturating_duration_since(aux_origin.instant);
        info!(
            startup_shift_ms = startup_shift.as_millis().min(u64::MAX as u128) as u64,
            "auxiliary captures started ahead of the screen process"
        );
        // Screen sources always get a tracker — the Option only stays None
        // for camera sessions, which take `start_camera_segment` instead.
        let AuxiliaryCaptures {
            cursor_tracker,
            audio,
        } = aux;
        let cursor_tracker = cursor_tracker.expect("screen auxiliaries include the cursor tracker");

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
            cursor_tracker: Some(cursor_tracker),
            camera_plan: None,
            camera_encoder: None,
            timeline_origin_instant: timeline_origin.instant,
            startup_shift,
        })
    }

    /// Camera-primary segment start: the camera FFmpeg process takes the slot
    /// the screen process has in `SegmentCaptures.screen`. No screen input,
    /// no webcam sidecar, no cursor tracker — only the optional WASAPI audio
    /// workers run ahead of the capture like the screen path arranges.
    ///
    /// `modes` is the session's cached probe result (see `start_prepared`);
    /// `lock` forces every resumed segment to the first segment's geometry so
    /// the concatenated stream stays uniform.
    #[allow(clippy::too_many_arguments)]
    fn start_camera_segment(
        &self,
        index: u32,
        work_dir: &std::path::Path,
        config: &RecordingConfig,
        profile: &RecordingProfile,
        manifest: Arc<Mutex<RecordingManifest>>,
        recording_id: &str,
        cursor_time_offset_ms: u64,
        lock: Option<CameraOutputLock>,
        modes: Option<&[CameraMode]>,
        preferred_encoder: Option<&str>,
    ) -> crate::errors::Result<SegmentCaptures> {
        let ffmpeg = self.ffmpeg_path.to_string_lossy();
        let output = work_dir.join(format!("seg_{:03}.mp4", index));

        // Ordered attempts: the planner's fitted modes first, the device-
        // defaults fallback last. A lock from a previous segment forces
        // identical output geometry/rate on every plan.
        let plans = super::camera_plan::plan_camera_capture(profile, modes.unwrap_or(&[]), lock);
        let encoder_candidates = prefer_encoder_first(
            &super::encoder::recording_encoder_candidates(
                &self.available_encoders,
                &profile.encoder_priority,
            ),
            preferred_encoder,
        );
        info!(
            plan_count = plans.len(),
            candidates = ?encoder_candidates,
            profile = %profile.id,
            "camera capture encoder candidates"
        );

        let preview_fps = config.webcam_preview_mode.fps();
        // A preview server is only spun up when the user asked for a preview;
        // "off" produces no MJPEG output and no listener. Dropped on every
        // failure path below (no server survives a failed start).
        let preview_server = if preview_fps.is_some() {
            super::preview_server::WebcamPreviewServer::start().ok()
        } else {
            None
        };
        let broadcaster = preview_server.as_ref().map(|s| s.broadcaster());
        let preview_fps = preview_server.as_ref().and(preview_fps);

        // Same aux shape as the screen path: the audio workers clock against
        // the segment origin and launch on a scoped thread so a slow device
        // cannot delay the camera spawn. No cursor tracker for camera sources.
        let aux_origin = TimelineAnchor::now();
        let (primary, winner, last_error, saw_busy, aux_join) = std::thread::scope(|scope| {
            let aux_handle = scope.spawn(|| {
                Self::start_auxiliary_captures(
                    config,
                    profile,
                    work_dir,
                    index,
                    recording_id,
                    cursor_time_offset_ms,
                    aux_origin,
                )
            });

            // Same overall startup budget as the webcam sidecar chain. A
            // just-closed WebView2 preview can hold the camera device for a
            // few hundred ms, so a device-busy failure earns extra retries
            // before the next (plan, encoder) combination.
            let startup_deadline = std::time::Instant::now() + Duration::from_secs(20);
            let mut primary = None;
            let mut winner = None;
            let mut last_error = None;
            let mut saw_busy = false;
            'plans: for (plan_index, plan) in plans.iter().enumerate() {
                for encoder in &encoder_candidates {
                    let mut busy_retries = 0u32;
                    loop {
                        let remaining =
                            startup_deadline.saturating_duration_since(std::time::Instant::now());
                        if remaining.is_zero() {
                            break 'plans;
                        }
                        match FfmpegCapture::start_camera(
                            &ffmpeg,
                            &config.source.id,
                            plan,
                            encoder,
                            &output.to_string_lossy(),
                            index,
                            Some(Arc::clone(&manifest)),
                            broadcaster.clone(),
                            preview_fps,
                            remaining.min(Duration::from_secs(8)),
                        ) {
                            Ok(mut capture) => {
                                // Record why a non-primary combination won.
                                // Codes are generic — never stderr text or
                                // device names.
                                let mut reasons = Vec::new();
                                if plan.input.is_none() {
                                    reasons.push("device-default-mode");
                                } else if plan_index > 0 {
                                    reasons.push("mode-fallback");
                                }
                                if encoder_candidates.first() != Some(encoder) {
                                    reasons.push("encoder-fallback");
                                }
                                if !reasons.is_empty() {
                                    capture.set_fallback_reason(Some(reasons.join("+")));
                                }
                                primary = Some(capture);
                                winner = Some((plan.clone(), encoder.clone()));
                                break 'plans;
                            }
                            Err(error) => {
                                if super::webcam::is_device_busy_error(&error.to_string()) {
                                    saw_busy = true;
                                    if busy_retries < 3 {
                                        busy_retries += 1;
                                        std::thread::sleep(Duration::from_millis(300));
                                        continue;
                                    }
                                }
                                tracing::debug!(
                                    error = %error,
                                    encoder,
                                    plan_index,
                                    "camera capture attempt failed; trying next candidate"
                                );
                                last_error = Some(error);
                                break;
                            }
                        }
                    }
                }
            }
            (primary, winner, last_error, saw_busy, aux_handle.join())
        });

        let aux = match aux_join {
            Ok(aux) => aux,
            Err(_) => {
                drop(primary);
                return Err(crate::errors::InternalError::Capture(
                    "auxiliary capture startup panicked".into(),
                )
                .into());
            }
        };
        let Some(primary) = primary else {
            // The workers must be stopped before their files can be removed —
            // Windows cannot delete open files.
            drop(aux);
            discard_failed_segment_auxiliaries(work_dir, index, cursor_time_offset_ms);
            let message = if saw_busy {
                "Camera is already in use by another application. Close it and retry."
            } else {
                "Could not start the camera. Check that it is connected, not used by another app, and that camera access is allowed."
            };
            if let Some(error) = last_error {
                tracing::warn!(%error, "camera capture could not start");
            }
            return Err(crate::errors::InternalError::Capture(message.into()).into());
        };

        let timeline_origin = primary.timeline_anchor();
        let startup_shift = timeline_origin
            .instant
            .saturating_duration_since(aux_origin.instant);
        info!(
            startup_shift_ms = startup_shift.as_millis().min(u64::MAX as u128) as u64,
            "auxiliary captures started ahead of the camera process"
        );
        let AuxiliaryCaptures {
            cursor_tracker: _,
            audio,
        } = aux;

        let (camera_plan, camera_encoder) = match winner {
            Some((plan, encoder)) => (Some(plan), Some(encoder)),
            None => (None, None),
        };
        Ok(SegmentCaptures {
            screen: primary,
            audio,
            webcam: None,
            // The preview server doubles as the camera HUD feed — it lives in
            // the same session slot the webcam sidecar uses.
            webcam_preview_server: preview_server,
            webcam_failed: false,
            cursor_tracker: None,
            camera_plan,
            camera_encoder,
            timeline_origin_instant: timeline_origin.instant,
            startup_shift,
        })
    }

    /// Start the cursor tracker and the requested WASAPI audio workers on a
    /// shared timeline origin. Called on a scoped thread from `start_segment`
    /// so these captures run concurrently with — and therefore ahead of — the
    /// screen process's startup window.
    fn start_auxiliary_captures(
        config: &RecordingConfig,
        profile: &RecordingProfile,
        work_dir: &Path,
        index: u32,
        recording_id: &str,
        cursor_time_offset_ms: u64,
        origin: TimelineAnchor,
    ) -> AuxiliaryCaptures {
        // Camera sources record no cursor telemetry: the bounds describe an
        // output budget, not a screen rectangle.
        let cursor_tracker = if is_camera_source(config) {
            None
        } else {
            let bounds = config.source.bounds;
            let capture_bounds = super::cursor::CursorCaptureBounds {
                x: bounds.x,
                y: bounds.y,
                width: bounds.width.max(1) as u32,
                height: bounds.height.max(1) as u32,
            };
            Some(super::cursor_v2::CursorTrackerV2::start(
                recording_id.to_string(),
                work_dir.to_path_buf(),
                capture_bounds,
                profile.width.max(1) as u32,
                profile.height.max(1) as u32,
                origin.instant,
                cursor_time_offset_ms,
                super::cursor_v2::CursorCaptureMode::Full,
            ))
        };

        let mut audio = Vec::new();
        if config.capture_microphone {
            let output_path = work_dir.join(format!("mic_{:03}.wav", index));
            match super::audio::start_audio_track(
                AudioCaptureKind::Microphone,
                config.microphone_device_id.clone(),
                output_path,
                origin,
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
                origin,
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

        AuxiliaryCaptures {
            cursor_tracker,
            audio,
        }
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
                    leading_silence_ms = alignment.leading_silence().as_millis() as u64,
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
                if let Some(sampler) = session.keystroke_sampler.take() {
                    sampler.stop();
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

        let mut timeline = self.segment_timeline(&screen, &stats);
        if is_camera_source(&session.config) {
            // Camera segments prefer the measured camera file origin (the
            // first DirectShow sample's offset) over the duration-derived
            // head trim — same alignment the webcam sidecar uses.
            timeline = camera_segment_timeline(timeline, screen.camera_first_frame_offset_ms());
            // Once the first segment's real geometry is known it locks every
            // later segment so the concatenated stream stays uniform.
            if session.camera_lock.is_none() {
                session.camera_lock = derive_camera_lock(
                    self.probe_video_geometry(screen.output_path()),
                    session.camera_plan.as_ref(),
                );
            }
        }
        // Audio and cursor tracks ran ahead of the screen process, so their
        // head trim additionally covers that startup shift; the webcam keeps
        // the screen-anchored timeline.
        let track_timeline = timeline.with_startup_shift(session.segment_startup_shift);
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
            track_timeline,
        );

        if let Some(mut tracker) = session.cursor_tracker.take() {
            tracker.stop();
            self.align_cursor_segment(
                &session.work_dir,
                session.cursor_segment_start_ms,
                track_timeline,
            );
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
            session.camera_lock,
            session.camera_modes.as_deref(),
            session.camera_encoder.as_deref(),
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
        session.cursor_tracker = captures.cursor_tracker;
        session.camera_plan = captures.camera_plan;
        session.camera_encoder = captures.camera_encoder;
        session.segment_startup_shift = captures.startup_shift;
        {
            let mut manifest = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            if !is_camera_source(&session.config) {
                manifest.set_cursor_telemetry(cursor_asset_metadata(
                    &session.session_id,
                    bounds,
                    session.profile.width.max(1) as u32,
                    session.profile.height.max(1) as u32,
                )?);
            }
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
        if let Some(sampler) = session.keystroke_sampler.take() {
            sampler.stop();
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
        // Audio and cursor tracks ran ahead of the screen process, so their
        // head trim additionally covers that startup shift; without a live
        // screen there is no shift to apply and this stays the zero timeline.
        let mut track_timeline = timeline;
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
            if is_camera_source(&session.config) {
                // Same measured-origin alignment as pause(): the last camera
                // segment derives the lock too (kept for diagnostics; the
                // session is dropped after finalization anyway).
                timeline = camera_segment_timeline(timeline, screen.camera_first_frame_offset_ms());
                if session.camera_lock.is_none() {
                    session.camera_lock = derive_camera_lock(
                        self.probe_video_geometry(screen.output_path()),
                        session.camera_plan.as_ref(),
                    );
                }
            }
            track_timeline = timeline.with_startup_shift(session.segment_startup_shift);
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
                track_timeline,
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
            self.align_cursor_segment(
                &session.work_dir,
                session.cursor_segment_start_ms,
                track_timeline,
            );
        }
        // Session-level sampler: stop here (not on pause) so events span all
        // segments. Writes keystrokes.json into the work dir.
        if let Some(sampler) = session.keystroke_sampler.take() {
            sampler.stop();
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
        // Camera library rows take their dimensions from the encoded output
        // stream, not the profile — the profile only describes the tier's
        // capture budget, and a camera that negotiated smaller must not be
        // listed at a resolution it never produced.
        if is_camera_source(&session.config) {
            if let Some(stream) = metadata.streams.iter().find(|s| s.kind == "video") {
                if let (Some(width), Some(height), Some(fps)) =
                    (stream.width, stream.height, stream.fps)
                {
                    if let Err(error) = crate::database::library::update_recording_dimensions(
                        &db,
                        &recording.id,
                        width,
                        height,
                        fps,
                    ) {
                        tracing::warn!(%error, "failed to persist camera recording dimensions");
                    }
                }
            }
        }
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

    /// Probe the segment file's video stream geometry and rate — the
    /// authoritative output dims used to lock every later camera segment
    /// (the plan is only the budget; the file is what was actually encoded).
    fn probe_video_geometry(&self, path: &Path) -> Option<(u32, u32, f64)> {
        crate::media::probe::probe_media(
            &self.ffprobe_path.to_string_lossy(),
            path,
            "camera-output-lock",
        )
        .ok()
        .and_then(|metadata| {
            let stream = metadata.streams.iter().find(|s| s.kind == "video")?;
            match (stream.width, stream.height, stream.fps) {
                (Some(w), Some(h), Some(fps)) if w > 0 && h > 0 && fps > 0.0 => {
                    Some((w as u32, h as u32, fps))
                }
                _ => None,
            }
        })
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
                // The primary process reports under the CAMERA slot for
                // camera sources, SCREEN otherwise — matching the slot the
                // manifest diagnostics were attached into at startup.
                super::metrics::upsert_capture_diagnostics(
                    &mut snapshot.segments,
                    session.segment_index,
                    is_camera_source(&session.config),
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

    /// Latest audio levels for the HUD meter, or `None` unless a session is
    /// actively `Recording` (idle/countdown/paused all suppress the tick so
    /// the UI never sees stale values). Reads each worker's peak-since-last-
    /// read atomic — `try_lock` on both the session and its manifest keeps
    /// the 12 Hz emit loop from queueing behind start/stop, and a `None`
    /// result makes the loop back off instead of emitting empty payloads.
    pub fn audio_levels(&self) -> Option<AudioLevels> {
        let guard = self.current.try_lock().ok()?;
        let session = guard.as_ref()?;
        if session.manifest.try_lock().ok()?.state != RecorderState::Recording {
            return None;
        }
        let mut levels = AudioLevels::default();
        for capture in &session.audio_captures {
            match capture.kind {
                AudioCaptureKind::Microphone => levels.microphone = capture.track.level(),
                AudioCaptureKind::SystemLoopback => levels.system_audio = capture.track.level(),
            }
        }
        Some(levels)
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

        let camera_source = is_camera_source(&session.config);
        // Liveness comes from the child process status itself, not the
        // stderr EOF flag — a stalled process can still hold the device.
        // For camera sources the camera IS the primary capture and lives in
        // the screen slot; there is no sidecar.
        let camera_live = if camera_source {
            session
                .screen_capture
                .as_mut()
                .is_some_and(|capture| capture.is_running())
        } else {
            session
                .webcam_capture
                .as_mut()
                .is_some_and(|capture| capture.is_running())
        };
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
            // even when the config asked for one. For camera sources the
            // primary camera process reports here so the HUD can bind to it.
            webcam_active: camera_live,
            webcam_device_id: if camera_source {
                Some(session.config.source.id.clone())
            } else {
                session.config.webcam_device_id.clone()
            },
            webcam_device_name: if camera_source {
                Some(session.config.source.name.clone())
            } else {
                session.config.webcam_device_id.clone()
            },
            webcam_preview_url: session
                .webcam_preview_server
                .as_ref()
                .map(|s| s.preview_url()),
            // Paused segments have no live capture; fall back to the stored
            // snapshot for THIS segment — never a prior segment's camera,
            // which may have belonged to a mode the resumed attempt no longer uses.
            // For camera sources the primary capture reports under `camera`
            // (the manifest diagnostics were attached to that slot at startup).
            screen_diagnostics: if camera_source {
                None
            } else {
                session
                    .screen_capture
                    .as_ref()
                    .map(|capture| capture.diagnostics())
                    .or_else(|| {
                        m.capture_diagnostics
                            .iter()
                            .find(|segment| segment.index == session.segment_index)
                            .and_then(|segment| segment.screen.clone())
                    })
            },
            camera_diagnostics: if camera_source {
                session
                    .screen_capture
                    .as_ref()
                    .map(|capture| capture.diagnostics())
                    .or_else(|| {
                        m.capture_diagnostics
                            .iter()
                            .find(|segment| segment.index == session.segment_index)
                            .and_then(|segment| segment.camera.clone())
                    })
            } else {
                session
                    .webcam_capture
                    .as_ref()
                    .map(|capture| capture.diagnostics())
                    .or_else(|| {
                        m.capture_diagnostics
                            .iter()
                            .find(|segment| segment.index == session.segment_index)
                            .and_then(|segment| segment.camera.clone())
                    })
            },
            error: if m.state == RecorderState::Recording {
                if camera_source {
                    // A camera session without its primary process is a dead
                    // recording — say so explicitly instead of the generic
                    // "unavailable" phrasing the screen path uses.
                    let mut problems = Vec::new();
                    if session.config.capture_microphone && !microphone_live {
                        problems.push("Microphone capture is unavailable.".to_string());
                    }
                    if !screen_live {
                        problems.push(
                            "Camera stopped unexpectedly (disconnected or taken by another app). Your recording so far is kept - stop to save it."
                                .to_string(),
                        );
                    }
                    if problems.is_empty() {
                        None
                    } else {
                        Some(problems.join(" "))
                    }
                } else {
                    // A requested capture that produced no live worker is a
                    // degradation the user must see — otherwise a track is
                    // lost silently while its toggle still reads "on".
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
                }
            } else {
                None
            },
        })
    }
}

/// Live audio levels for the HUD meter — each track's peak amplitude
/// accumulated since the previous read. `None` when a track is not
/// captured or the platform does not report levels.
#[derive(Debug, Clone, Copy, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLevels {
    pub microphone: Option<f32>,
    pub system_audio: Option<f32>,
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
    fn segment_timeline_startup_shift_only_extends_the_head_trim() {
        let timeline = SegmentTimeline {
            head_trim: Duration::from_millis(270),
            duration: Duration::from_millis(80_316),
        };

        let shifted = timeline.with_startup_shift(Duration::from_millis(600));
        assert_eq!(shifted.head_trim, Duration::from_millis(870));
        assert_eq!(shifted.duration, Duration::from_millis(80_316));

        // A zero shift is the identity.
        let unchanged = timeline.with_startup_shift(Duration::ZERO);
        assert_eq!(unchanged.head_trim, Duration::from_millis(270));
        assert_eq!(unchanged.duration, Duration::from_millis(80_316));

        // An extreme shift saturates the head trim rather than panicking.
        let saturated = timeline.with_startup_shift(Duration::MAX);
        assert_eq!(saturated.head_trim, Duration::MAX);
        assert_eq!(saturated.duration, Duration::from_millis(80_316));
    }

    #[test]
    fn discarding_failed_segment_auxiliaries_removes_wavs_and_trailing_cursor_events() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("mic_001.wav"), b"mic").expect("write mic wav");
        std::fs::write(dir.path().join("sys_001.wav"), b"sys").expect("write sys wav");

        let event = |t_ms: u64| crate::capture::cursor_v2::CursorTelemetryEventV2 {
            t_ms,
            raw_x: 100,
            raw_y: 200,
            source_x: 100.0,
            source_y: 200.0,
            buttons: crate::capture::cursor_v2::CursorButtonState::default(),
            button_event: "none".into(),
            visible: true,
            shape_id: "arrow".into(),
            shape_changed: false,
        };
        let metadata = crate::capture::cursor_v2::CursorTelemetryMetadata::new(
            "rec".into(),
            1920,
            1080,
            crate::capture::cursor_v2::CursorCaptureBounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
        );
        let telemetry = crate::capture::cursor_v2::CursorTelemetryFileV2 {
            metadata,
            events: vec![event(100), event(4_900), event(5_100), event(5_200)],
        };
        crate::capture::cursor_v2::write_v2_telemetry(dir.path(), &telemetry)
            .expect("write telemetry");

        // Segment 1 failed before the screen came up; events at 5_001ms on
        // belong to the abandoned attempt and must be dropped.
        discard_failed_segment_auxiliaries(dir.path(), 1, 5_000);

        assert!(!dir.path().join("mic_001.wav").exists());
        assert!(!dir.path().join("sys_001.wav").exists());
        let remaining =
            crate::capture::cursor_v2::read_v2_telemetry(dir.path()).expect("read telemetry");
        let times: Vec<u64> = remaining.events.iter().map(|event| event.t_ms).collect();
        assert_eq!(times, vec![100, 4_900]);

        // Repeating the cleanup is a harmless no-op.
        discard_failed_segment_auxiliaries(dir.path(), 1, 5_000);
        let remaining =
            crate::capture::cursor_v2::read_v2_telemetry(dir.path()).expect("read telemetry");
        let times: Vec<u64> = remaining.events.iter().map(|event| event.t_ms).collect();
        assert_eq!(times, vec![100, 4_900]);
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
            capture_keystrokes: false,
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
            capture_keystrokes: false,
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
            capture_keystrokes: false,
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
            camera_modes: None,
            camera_lock: None,
            camera_encoder: None,
            camera_plan: None,
            keystroke_sampler: None,
            cursor_segment_start_ms: 0,
            segment_startup_shift: Duration::ZERO,
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

    fn test_camera_config() -> RecordingConfig {
        RecordingConfig {
            source: CaptureSource {
                kind: "camera".into(),
                id: "cam-device-0".into(),
                name: "Integrated Camera".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            },
            profile: "camera-balanced".into(),
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

    #[test]
    fn camera_prepare_creates_countdown_manifest_and_cancel_cleans_up() {
        let temp_dir = tempfile::tempdir().expect("create temporary sessions directory");
        let recorder = test_recorder(temp_dir.path());

        let session_id = recorder
            .prepare(test_camera_config())
            .expect("prepare camera session");
        assert_eq!(
            recorder.status().expect("status").state,
            RecorderState::Countdown
        );
        let manifest =
            RecordingManifest::read(temp_dir.path().join(&session_id).join("session.json"))
                .expect("read prepared manifest");
        assert_eq!(manifest.source.kind, "camera");
        assert_eq!(manifest.profile_name, "camera-balanced");
        assert!(
            manifest.cursor_telemetry.is_none(),
            "camera sessions must not declare cursor telemetry"
        );

        recorder
            .cancel_prepared(&session_id)
            .expect("cancel camera countdown");
        assert_eq!(
            recorder.status().expect("status").state,
            RecorderState::Idle
        );
        assert!(!temp_dir.path().join(&session_id).exists());
    }

    #[test]
    fn camera_status_maps_primary_capture_to_camera_fields() {
        let temp_dir = tempfile::tempdir().expect("create temporary sessions directory");
        let recorder = test_recorder(temp_dir.path());
        let work_dir = temp_dir.path().join("session-1");
        std::fs::create_dir_all(&work_dir).expect("create session work dir");

        let mut config = test_camera_config();
        config.capture_microphone = true;
        config.microphone_device_id = Some("mic-1".into());
        let mut session = test_session(&work_dir, config);
        session
            .manifest
            .lock()
            .expect("manifest")
            .set_state(RecorderState::Recording);

        let status = recorder
            .status_from_session(&mut session)
            .expect("read camera status");
        assert_eq!(status.source_kind, "camera");
        assert_eq!(status.source_name, "Integrated Camera");
        // The primary camera process reports through the webcam slots so the
        // HUD/preview bindings keep working unchanged.
        assert!(!status.webcam_active);
        assert_eq!(status.webcam_device_id.as_deref(), Some("cam-device-0"));
        assert_eq!(
            status.webcam_device_name.as_deref(),
            Some("Integrated Camera")
        );
        assert!(status.screen_diagnostics.is_none());

        let error = status.error.expect("dead session must report an error");
        assert!(
            error.contains("Microphone capture is unavailable."),
            "{error}"
        );
        assert!(error.contains("Camera stopped unexpectedly"), "{error}");

        session
            .manifest
            .lock()
            .expect("manifest")
            .set_state(RecorderState::Paused);
        let status = recorder
            .status_from_session(&mut session)
            .expect("read paused status");
        assert!(status.error.is_none(), "paused sessions report no error");
    }

    #[test]
    fn camera_diagnostics_stay_under_camera_slot() {
        let temp_dir = tempfile::tempdir().expect("create temporary sessions directory");
        let recorder = test_recorder(temp_dir.path());
        recorder
            .prepare(test_camera_config())
            .expect("prepare camera session");

        // Seed the manifest the way `FfmpegCapture::run` does for camera
        // captures (meta.camera = true → camera slot).
        {
            let guard = recorder.current.lock().expect("session lock");
            let session = guard.as_ref().expect("session");
            let mut manifest = session.manifest.lock().expect("manifest");
            crate::capture::metrics::upsert_capture_diagnostics(
                &mut manifest.capture_diagnostics,
                0,
                true,
                crate::capture::metrics::CaptureDiagnostics {
                    process_id: 1,
                    encoder: "libx264".into(),
                    backend: "dshow-camera".into(),
                    requested_fps: 30.0,
                    startup_ready_ms: Some(120),
                    preview_fps: None,
                    requested_camera_mode: None,
                    fallback_reason: None,
                    progress: crate::capture::metrics::CaptureProgress::default(),
                    progress_age_ms: None,
                    exited: false,
                    camera_first_frame_offset_ms: Some(80),
                    camera_timing_rejection: None,
                },
            );
        }

        let snapshot = recorder.capture_diagnostics().expect("diagnostics");
        let segment = snapshot
            .segments
            .iter()
            .find(|segment| segment.index == 0)
            .expect("segment 0");
        assert!(segment.camera.is_some(), "primary stays under camera slot");
        assert!(segment.screen.is_none());
    }

    #[test]
    fn prefer_encoder_first_moves_the_previous_winner_front() {
        let candidates = vec![
            "h264_nvenc".to_string(),
            "h264_mf".to_string(),
            "libx264".to_string(),
        ];
        assert_eq!(
            prefer_encoder_first(&candidates, Some("h264_mf")),
            vec!["h264_mf", "h264_nvenc", "libx264"]
        );
        // A preferred encoder that is no longer available keeps the order.
        assert_eq!(
            prefer_encoder_first(&candidates, Some("h264_amf")),
            candidates
        );
        assert_eq!(prefer_encoder_first(&candidates, None), candidates);
    }

    #[test]
    fn camera_segment_timeline_prefers_measured_origin() {
        let base = SegmentTimeline {
            head_trim: Duration::from_millis(600),
            duration: Duration::from_millis(5_000),
        };
        // A plausible measured offset becomes the head trim; duration stays
        // the probed video duration.
        let timeline = camera_segment_timeline(base, Some(180));
        assert_eq!(timeline.head_trim, Duration::from_millis(180));
        assert_eq!(timeline.duration, Duration::from_millis(5_000));

        // An implausible (above-cap) or missing measurement falls back to
        // the duration-derived timeline unchanged.
        let timeline = camera_segment_timeline(base, Some(MAX_VIDEO_STARTUP_GAP_MS + 1));
        assert_eq!(timeline, base);
        assert_eq!(camera_segment_timeline(base, None), base);
    }

    #[test]
    fn derive_camera_lock_prefers_probed_geometry_then_plan() {
        let plan = CameraCapturePlan {
            profile_id: "camera-balanced".into(),
            input: None,
            output_width: 1920,
            output_height: 1080,
            output_fps: 30.0,
            video_bitrate_kbps: 6_800,
            max_bitrate_kbps: 10_200,
            buffer_kbps: 10_200,
            crf: 21,
            fit: crate::capture::camera_plan::CameraFit::Native,
            limited_by_camera: false,
        };
        // The probed file wins over the plan.
        assert_eq!(
            derive_camera_lock(Some((1280, 720, 30.0)), Some(&plan)),
            Some(CameraOutputLock {
                width: 1280,
                height: 720,
                fps: 30.0
            })
        );
        // Without a probe the winning plan's output geometry is the lock.
        assert_eq!(
            derive_camera_lock(None, Some(&plan)),
            Some(CameraOutputLock {
                width: 1920,
                height: 1080,
                fps: 30.0
            })
        );
        assert_eq!(derive_camera_lock(None, None), None);
    }

    #[test]
    fn audio_levels_only_emit_while_recording() {
        let temp_dir = tempfile::tempdir().expect("create temporary sessions directory");
        let recorder = test_recorder(temp_dir.path());
        // Idle: no session at all.
        assert!(recorder.audio_levels().is_none());
        // A prepared session is still in Countdown — no ticks.
        recorder.prepare(test_config()).expect("prepare session");
        assert!(recorder.audio_levels().is_none());

        // Flip the session to Recording with a live (fake) audio track.
        {
            let guard = recorder.current.lock().expect("session lock");
            let session = guard.as_ref().expect("session");
            session
                .manifest
                .lock()
                .expect("manifest")
                .set_state(RecorderState::Recording);
        }
        assert!(
            recorder.audio_levels().is_some(),
            "a Recording session must emit levels"
        );

        // Paused suppresses the tick again — the UI must never see stale
        // values after the meter should stop.
        {
            let guard = recorder.current.lock().expect("session lock");
            let session = guard.as_ref().expect("session");
            session
                .manifest
                .lock()
                .expect("manifest")
                .set_state(RecorderState::Paused);
        }
        assert!(recorder.audio_levels().is_none());
    }

    #[test]
    fn ensure_camera_disk_space_gates_below_one_gib() {
        assert!(ensure_camera_disk_space(Some(512 << 20)).is_err());
        let error = ensure_camera_disk_space(Some(512 << 20)).unwrap_err();
        assert!(error.to_string().contains("Not enough free disk space"));
        assert!(ensure_camera_disk_space(Some(2 << 30)).is_ok());
        // An unreadable stat never blocks a recording.
        assert!(ensure_camera_disk_space(None).is_ok());
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
            capture_keystrokes: false,
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
            capture_keystrokes: false,
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
    #[ignore = "requires an active desktop session and a microphone; records ~4 s"]
    fn live_recording_audio_and_cursor_cover_the_screen_startup_window() {
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

        let microphone = crate::capture::audio::enumerate_audio_devices()
            .ok()
            .and_then(|devices| {
                devices
                    .iter()
                    .find(|device| !device.is_loopback && device.is_default)
                    .or_else(|| devices.iter().find(|device| !device.is_loopback))
                    .map(|device| device.id.clone())
            });
        let Some(microphone) = microphone else {
            eprintln!("skipping: no input audio device available");
            return;
        };

        let recorder = Recorder::new(ffmpeg.clone(), ffprobe, temp_dir.path().to_path_buf(), db);
        let config = RecordingConfig {
            source: CaptureSource {
                kind: "region".into(),
                id: "region-0".into(),
                name: "Region".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 640,
                    height: 360,
                },
            },
            profile: "smooth-60fps".into(),
            capture_microphone: true,
            capture_system_audio: false,
            capture_webcam: false,
            webcam_device_id: None,
            microphone_device_id: Some(microphone),
            system_audio_device_id: None,
            webcam_preview_mode: Default::default(),
            gpu_screen_capture: true,
            smart_zoom_enabled: false,
            smart_zoom_preset: "product-demo".into(),
            capture_keystrokes: false,
        };

        let session_id = recorder.prepare(config).expect("prepare session");
        recorder
            .start_prepared(&session_id)
            .expect("start recording");
        std::thread::sleep(Duration::from_secs(4));
        recorder.stop().expect("stop recording");

        let work_dir = temp_dir.path().join(&session_id);

        // Measure the digital-zero lead-in of the first audio stream: the
        // worker should have been running since (before) the first video
        // frame, so real signal must start near t=0.
        let mut decode = crate::process::create_command(&ffmpeg);
        decode
            .arg("-v")
            .arg("error")
            .arg("-i")
            .arg(work_dir.join("output.mp4"))
            .args([
                "-map", "0:a:0", "-f", "s16le", "-ac", "2", "-ar", "48000", "-",
            ]);
        let decoded = decode.output().expect("decode first audio stream");
        if !decoded.status.success() || decoded.stdout.is_empty() {
            eprintln!("skipping: final output has no audio stream");
            return;
        }
        // s16le stereo = 4 bytes per frame at 48 kHz.
        let audio_leading_silence_ms = match decoded
            .stdout
            .as_chunks::<4>()
            .0
            .iter()
            .position(|frame| frame.iter().any(|byte| *byte != 0))
        {
            Some(frame_index) => frame_index as u64 * 1_000 / 48_000,
            None => {
                eprintln!("skipping: captured audio is entirely silent (muted device?)");
                return;
            }
        };

        // Index entry 0 anchors the first 1024-event chunk, so its tMs is the
        // first recorded cursor event on the session timeline.
        let first_cursor_event_ms = std::fs::read_to_string(work_dir.join("cursor_telemetry.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|value| value.get("index")?.get(0)?.get("tMs")?.as_u64());

        let manifest =
            RecordingManifest::read(work_dir.join("session.json")).expect("load session manifest");
        let startup_ready_ms = manifest
            .capture_diagnostics
            .first()
            .and_then(|segment| segment.screen.as_ref())
            .and_then(|screen| screen.startup_ready_ms);

        eprintln!(
            "startup_ready_ms={startup_ready_ms:?} audio_leading_silence_ms={audio_leading_silence_ms} first_cursor_event_ms={first_cursor_event_ms:?}"
        );

        assert!(
            audio_leading_silence_ms <= 400,
            "audio starts with {audio_leading_silence_ms}ms of digital silence"
        );
        if let Some(first_cursor_event_ms) = first_cursor_event_ms {
            assert!(
                first_cursor_event_ms <= 400,
                "first cursor event landed at {first_cursor_event_ms}ms"
            );
        }
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
            capture_keystrokes: false,
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

    /// End-to-end camera-mode coverage on real hardware: the first
    /// enumerated camera becomes the primary capture, the default mic joins
    /// when present, and the output is a plain `output.mp4` with no
    /// screen-recording side products.
    #[test]
    #[ignore = "requires a real camera and will activate it for ~4 s"]
    fn camera_only_recording_captures_video_and_audio_when_available() {
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

        let device = enumerate_video_devices(&ffmpeg.to_string_lossy())
            .ok()
            .and_then(|devices| devices.into_iter().find(|d| d.kind == "webcam"))
            .map(|d| d.name);
        let Some(device) = device else {
            eprintln!("skipping: no camera found");
            return;
        };
        let microphone = crate::capture::audio::enumerate_audio_devices()
            .ok()
            .and_then(|devices| {
                devices
                    .iter()
                    .find(|device| !device.is_loopback && device.is_default)
                    .or_else(|| devices.iter().find(|device| !device.is_loopback))
                    .map(|device| device.id.clone())
            });
        let microphone_enabled = microphone.is_some();

        let recorder = Recorder::new(
            ffmpeg.clone(),
            ffprobe.clone(),
            temp_dir.path().to_path_buf(),
            db,
        );
        let config = RecordingConfig {
            source: CaptureSource {
                kind: "camera".into(),
                id: device,
                name: "Camera".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            },
            profile: "camera-balanced".into(),
            capture_microphone: microphone_enabled,
            capture_system_audio: false,
            capture_webcam: false,
            webcam_device_id: None,
            microphone_device_id: microphone,
            system_audio_device_id: None,
            webcam_preview_mode: Default::default(),
            gpu_screen_capture: true,
            smart_zoom_enabled: false,
            smart_zoom_preset: "product-demo".into(),
            capture_keystrokes: false,
        };

        let session_id = recorder.prepare(config).expect("prepare camera session");
        recorder
            .start_prepared(&session_id)
            .expect("start camera recording");
        std::thread::sleep(Duration::from_secs(4));
        recorder.stop().expect("stop camera recording");

        let session_dir = temp_dir.path().join(&session_id);
        let output = session_dir.join("output.mp4");
        assert!(output.exists(), "camera output must exist");

        let metadata =
            crate::media::probe::probe_media(&ffprobe.to_string_lossy(), &output, "camera-test")
                .expect("probe camera output");
        let video = metadata
            .streams
            .iter()
            .find(|stream| stream.kind == "video")
            .expect("video stream");
        let (width, height, fps) = (
            video.width.unwrap_or(0),
            video.height.unwrap_or(0),
            video.fps.unwrap_or(0.0),
        );
        eprintln!(
            "camera output: {}x{} @ {:.2} fps, container {} kbps",
            width,
            height,
            fps,
            metadata.bitrate_kbps.unwrap_or(0.0)
        );
        assert!(width >= 640 && height >= 360, "resolution {width}x{height}");
        assert!(
            (25.0..=31.0).contains(&fps),
            "frame rate {fps} outside 25-31"
        );
        if microphone_enabled {
            assert!(
                metadata.streams.iter().any(|stream| stream.kind == "audio"),
                "microphone was enabled but no audio stream was muxed"
            );
        }

        // Camera sessions must produce no screen-recording side products.
        assert!(!session_dir.join("cursor_events.bin").exists());
        assert!(!session_dir.join("cursor_telemetry.json").exists());
        assert!(
            !session_dir.join("output.mp4.webcam.mp4").exists()
                && std::fs::read_dir(&session_dir)
                    .expect("read session dir")
                    .filter_map(|entry| entry.ok())
                    .all(|entry| !entry.file_name().to_string_lossy().starts_with("webcam")),
            "camera sessions must not produce webcam sidecar assets"
        );

        let manifest =
            RecordingManifest::read(session_dir.join("session.json")).expect("read manifest");
        assert_eq!(manifest.source.kind, "camera");
        assert_eq!(manifest.state, RecorderState::Completed);
        assert!(manifest.fragments.iter().any(|f| f.index == 0));
        let diagnostics = manifest
            .capture_diagnostics
            .iter()
            .find(|segment| segment.index == 0)
            .expect("fragment 0 diagnostics");
        assert!(
            diagnostics.camera.is_some(),
            "camera diagnostics must slot under camera"
        );
        assert!(diagnostics.screen.is_none());

        // The library row carries the camera source and the probed geometry
        // (overwritten from the tier budget at finalize).
        let db = recorder.db.lock().expect("db");
        let recordings = crate::database::library::list_recordings(&db).expect("list recordings");
        let recording = recordings
            .iter()
            .find(|recording| recording.session_id == session_id)
            .expect("camera library row");
        assert_eq!(recording.source.kind, "camera");
        assert_eq!(recording.width, width);
        assert_eq!(recording.height, height);
        assert_eq!(recording.fps, fps.round() as i32);
    }

    /// Pause/resume coverage: two camera segments must concatenate into one
    /// `output.mp4` with identical geometry — the output lock derived at
    /// pause forces the resumed segment to the first segment's resolution
    /// and rate.
    #[test]
    #[ignore = "requires a real camera; records ~4 s across a pause"]
    fn camera_recording_pause_resume_concatenates_matching_segments() {
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
        let device = enumerate_video_devices(&ffmpeg.to_string_lossy())
            .ok()
            .and_then(|devices| devices.into_iter().find(|d| d.kind == "webcam"))
            .map(|d| d.name);
        let Some(device) = device else {
            eprintln!("skipping: no camera found");
            return;
        };

        let recorder = Recorder::new(
            ffmpeg.clone(),
            ffprobe.clone(),
            temp_dir.path().to_path_buf(),
            db,
        );
        let config = RecordingConfig {
            source: CaptureSource {
                kind: "camera".into(),
                id: device,
                name: "Camera".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            },
            profile: "camera-balanced".into(),
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

        let session_id = recorder.prepare(config).expect("prepare camera session");
        recorder
            .start_prepared(&session_id)
            .expect("start camera recording");
        std::thread::sleep(Duration::from_secs(2));
        recorder.pause().expect("pause camera recording");
        recorder.resume().expect("resume camera recording");
        std::thread::sleep(Duration::from_secs(2));
        recorder.stop().expect("stop camera recording");

        let session_dir = temp_dir.path().join(&session_id);
        let output = session_dir.join("output.mp4");
        assert!(output.exists(), "concatenated output must exist");

        // Both fragments must have produced identical output geometry — the
        // lock makes the resumed segment stream-copy-concat compatible.
        let segment_probe = |index: u32| {
            let segment = session_dir.join(format!("seg_{index:03}.mp4"));
            let metadata = crate::media::probe::probe_media(
                &ffprobe.to_string_lossy(),
                &segment,
                "camera-seg",
            )
            .expect("probe segment");
            let video = metadata
                .streams
                .iter()
                .find(|stream| stream.kind == "video")
                .expect("segment video stream");
            (
                video.width,
                video.height,
                video.fps,
                video.duration_ms.or(Some(metadata.duration_ms)),
            )
        };
        let (w0, h0, f0, d0) = segment_probe(0);
        let (w1, h1, f1, d1) = segment_probe(1);
        eprintln!("segment geometries: ({w0:?},{h0:?},{f0:?}) / ({w1:?},{h1:?},{f1:?})");
        assert_eq!(
            (w0, h0, f0),
            (w1, h1, f1),
            "resumed segment must match the first"
        );

        // The concatenated output covers both recorded stretches. Segments
        // legitimately exceed the 2 s sleeps: `start_prepared`/`resume`
        // return only once the camera produces frames, so each stream also
        // contains its ~1 s sensor startup. Assert the output equals the sum
        // of the segment video durations (within 15%) and matches the
        // manifest's recorded total.
        let segment_total_ms = d0.unwrap_or(0) + d1.unwrap_or(0);
        let metadata =
            crate::media::probe::probe_media(&ffprobe.to_string_lossy(), &output, "camera-final")
                .expect("probe output");
        let duration_ms = metadata.duration_ms as f64;
        eprintln!("camera output duration: {duration_ms}ms vs segments {segment_total_ms}ms");
        assert!(
            (duration_ms - segment_total_ms as f64).abs() <= segment_total_ms as f64 * 0.15 + 200.0,
            "output {duration_ms}ms deviates from the {segment_total_ms}ms of captured video"
        );
        let manifest =
            RecordingManifest::read(session_dir.join("session.json")).expect("read manifest");
        assert!(
            (manifest.total_recorded_ms as f64 - duration_ms).abs() <= 500.0,
            "totalRecordedMs {} vs output {duration_ms}",
            manifest.total_recorded_ms
        );
    }
}
