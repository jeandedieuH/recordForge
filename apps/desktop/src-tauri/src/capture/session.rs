use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tracing::{error, info, instrument};

use super::config::{RecordingConfig, RecordingProfile};
use super::disk;
use super::ffmpeg::FfmpegCapture;
use super::manifest::{RecorderState, RecordingManifest, RecordingMarker, RecordingStats};
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
    webcam_capture: Option<FfmpegCapture>,
    segment_index: u32,
    total_recorded_ms: u64,
    started_at: Option<chrono::DateTime<chrono::Utc>>,
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
        info!(ddagrab_available, "recorder initialized");
        Self {
            ffmpeg_path,
            ffprobe_path,
            sessions_dir,
            db,
            ddagrab_available,
            current: Mutex::new(None),
        }
    }

    /// Discover or verify the FFmpeg binary path.
    pub fn resolve_ffmpeg() -> crate::errors::Result<PathBuf> {
        crate::media::resolve_executable("ffmpeg")
    }

    #[instrument]
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
            webcam_capture: None,
            segment_index: 0,
            total_recorded_ms: 0,
            started_at: None,
        });

        Ok(session_id)
    }

    #[instrument]
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

        let (screen, webcam) = match self.start_segment(
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

        session.screen_capture = Some(screen);
        session.webcam_capture = webcam;
        session.started_at = Some(chrono::Utc::now());
        {
            let mut manifest = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            manifest.set_state(RecorderState::Recording);
            manifest.write()?;
        }

        info!(%session_id, "recording capture started");
        Ok(())
    }

    #[instrument]
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

    #[instrument]
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
    ) -> crate::errors::Result<(FfmpegCapture, Option<FfmpegCapture>)> {
        // Probe audio devices before building the capture command. A device
        // that enumerates but can't be opened (Intel SST mic driver quirk,
        // device in use, Unicode name round-trip issue) would make FFmpeg
        // abort the ENTIRE recording — including video. Skipping a bad mic so
        // the screen recording still proceeds is the right tradeoff for a
        // recorder-first product.
        let mut config = config.clone();
        let ffmpeg = self.ffmpeg_path.to_string_lossy();

        if config.capture_microphone {
            if let Some(name) = &config.microphone_device_id {
                let spec = format!("audio=\"{name}\"");
                if !media::probe_dshow_device(&ffmpeg, &spec) {
                    tracing::warn!(
                        device = %name,
                        "microphone could not be opened; recording video without it"
                    );
                    config.capture_microphone = false;
                    config.microphone_device_id = None;
                }
            }
        }

        if config.capture_system_audio {
            if let Some(name) = &config.system_audio_device_id {
                let spec = format!("audio=\"{name}\"");
                if !media::probe_dshow_device(&ffmpeg, &spec) {
                    tracing::warn!(
                        device = %name,
                        "system audio device could not be opened; recording video without it"
                    );
                    config.capture_system_audio = false;
                    config.system_audio_device_id = None;
                }
            }
        }

        let screen_output = work_dir.join(format!("seg_{:03}.mp4", index));
        let screen = FfmpegCapture::start(
            &ffmpeg,
            &config,
            profile,
            &screen_output.to_string_lossy(),
            index,
            Some(manifest),
            self.ddagrab_available,
        )?;

        let webcam = if config.capture_webcam {
            if let Some(device) = &config.webcam_device_id {
                if !super::webcam::validate_webcam_device(&ffmpeg, device)?.available {
                    tracing::warn!(device = %device, "webcam unavailable; continuing without webcam");
                    None
                } else {
                    let webcam_output = work_dir.join(format!("webcam_{:03}.mp4", index));
                    match FfmpegCapture::start_webcam(
                        &ffmpeg,
                        device,
                        profile,
                        &webcam_output.to_string_lossy(),
                        None,
                    ) {
                        Ok(capture) => Some(capture),
                        Err(error) => {
                            tracing::warn!(error = ?error, "webcam failed to start; continuing without webcam");
                            None
                        }
                    }
                }
            } else {
                info!("capture_webcam enabled but no device specified; skipping webcam");
                None
            }
        } else {
            None
        };

        Ok((screen, webcam))
    }

    #[instrument]
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
                if let Ok(mut manifest) = session.manifest.lock() {
                    manifest.set_state(RecorderState::Failed);
                    if let Err(write_error) = manifest.write() {
                        tracing::error!(error = ?write_error, "failed to persist failed recording state");
                    }
                }
                return Err(error);
            }
        };

        if let Some(mut webcam) = session.webcam_capture.take() {
            if let Err(error) = webcam.stop() {
                error!(%error, "failed to stop webcam sidecar during pause");
            }
        }

        let total = session.total_recorded_ms + stats.duration_ms;
        session.total_recorded_ms = total;
        let _ = self.validated_segments(session)?;
        {
            let mut manifest = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            manifest.set_total_recorded_ms(total);
            manifest.set_state(RecorderState::Paused);
            manifest.set_stats(stats);
            manifest.write()?;
        }

        self.status_from_session(session)
    }

    #[instrument]
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
        let (screen, webcam) = self.start_segment(
            next_index,
            &session.work_dir,
            &session.config,
            &session.profile,
            Arc::clone(&session.manifest),
        )?;

        session.segment_index = next_index;
        session.screen_capture = Some(screen);
        session.webcam_capture = webcam;
        {
            let mut manifest = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            manifest.set_state(RecorderState::Recording);
            manifest.write()?;
        }

        self.status_from_session(session)
    }

    #[instrument]
    pub fn stop(&self) -> crate::errors::Result<RecordingStats> {
        let mut guard = self
            .current
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("recorder mutex poisoned".into()))?;
        let session = guard
            .as_mut()
            .ok_or_else(|| crate::errors::InternalError::Capture("no active recording".into()))?;

        let mut final_stats = if let Some(mut screen) = session.screen_capture.take() {
            match screen.stop() {
                Ok(stats) => stats,
                Err(error) => {
                    if let Ok(mut manifest) = session.manifest.lock() {
                        manifest.set_state(RecorderState::Failed);
                        if let Err(write_error) = manifest.write() {
                            tracing::error!(error = ?write_error, "failed to persist failed recording state");
                        }
                    }
                    return Err(error);
                }
            }
        } else {
            RecordingStats::default()
        };

        if let Some(mut webcam) = session.webcam_capture.take() {
            if let Err(error) = webcam.stop() {
                error!(%error, "failed to stop webcam sidecar during stop");
            }
        }

        let total = session.total_recorded_ms + final_stats.duration_ms;
        {
            let mut manifest = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            manifest.set_total_recorded_ms(total);
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
        let manifest_clone = {
            let mut manifest = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            manifest.set_output_path(output.to_string_lossy());
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

        guard.take();
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

    /// Insert a marker at the current playback position.
    #[instrument]
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
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::source::{Bounds, CaptureSource};

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
}
