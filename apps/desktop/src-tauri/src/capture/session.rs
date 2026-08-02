use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tracing::{error, info, instrument};

use super::config::{RecordingConfig, RecordingProfile};
use super::ffmpeg::FfmpegCapture;
use super::manifest::{RecorderState, RecordingManifest, RecordingMarker, RecordingStats};
use super::media;

/// Shared recorder state. Only one recording session can be active at a time.
#[derive(Debug)]
pub struct Recorder {
    ffmpeg_path: PathBuf,
    sessions_dir: PathBuf,
    db: Arc<Mutex<rusqlite::Connection>>,
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
    started_at: chrono::DateTime<chrono::Utc>,
}

impl Recorder {
    pub fn new(
        ffmpeg_path: PathBuf,
        sessions_dir: PathBuf,
        db: Arc<Mutex<rusqlite::Connection>>,
    ) -> Self {
        Self {
            ffmpeg_path,
            sessions_dir,
            db,
            current: Mutex::new(None),
        }
    }

    /// Discover or verify the FFmpeg binary path.
    pub fn resolve_ffmpeg() -> crate::errors::Result<PathBuf> {
        // 1. Bundled binary next to the executable.
        // 2. Binary resolved by the OS PATH.
        if let Ok(exe) = std::env::current_exe() {
            let bundled = exe
                .parent()
                .map(|p| p.join("..").join("ffmpeg").join("ffmpeg.exe"))
                .unwrap_or_else(|| PathBuf::from("ffmpeg.exe"));
            if bundled.exists() {
                return Ok(bundled);
            }
        }

        let in_path = PathBuf::from(if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        });
        if Self::can_run_ffmpeg(&in_path) {
            return Ok(in_path);
        }

        Err(
            crate::errors::InternalError::Media("ffmpeg not found in bundled path or PATH".into())
                .into(),
        )
    }

    fn can_run_ffmpeg(path: &PathBuf) -> bool {
        std::process::Command::new(path)
            .arg("-version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    #[instrument]
    pub fn start(&self, config: RecordingConfig) -> crate::errors::Result<String> {
        let mut guard = self
            .current
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("recorder mutex poisoned".into()))?;

        if guard.is_some() {
            return Err(crate::errors::InternalError::Capture(
                "a recording is already active".into(),
            )
            .into());
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

        // Record the intended final output path now so recovery can find it.
        {
            let mut m = manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            m.set_output_path(output.to_string_lossy());
            let _ = m.write();
        }

        info!(%session_id, ?work_dir, "starting recording session");

        let (screen, webcam) =
            self.start_segment(0, &work_dir, &config, &profile, Arc::clone(&manifest))?;

        {
            let mut m = manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            m.set_state(RecorderState::Recording);
            let _ = m.write();
        }

        *guard = Some(ActiveSession {
            session_id: session_id.clone(),
            work_dir,
            config,
            profile,
            manifest,
            screen_capture: Some(screen),
            webcam_capture: webcam,
            segment_index: 0,
            total_recorded_ms: 0,
            started_at: chrono::Utc::now(),
        });

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
        let screen_output = work_dir.join(format!("seg_{:03}.mp4", index));
        let screen = FfmpegCapture::start(
            &self.ffmpeg_path.to_string_lossy(),
            config,
            profile,
            &screen_output.to_string_lossy(),
            index,
            Some(manifest),
        )?;

        let webcam = if config.capture_webcam {
            if let Some(device) = &config.webcam_device_id {
                let webcam_output = work_dir.join(format!("webcam_{:03}.mp4", index));
                Some(FfmpegCapture::start_webcam(
                    &self.ffmpeg_path.to_string_lossy(),
                    device,
                    profile,
                    &webcam_output.to_string_lossy(),
                    None,
                )?)
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

        if session.screen_capture.is_none() {
            return Err(crate::errors::InternalError::Capture(
                "recording is not in progress".into(),
            )
            .into());
        }

        let screen = session.screen_capture.as_mut().ok_or_else(|| {
            crate::errors::InternalError::Capture("screen capture missing".into())
        })?;
        let stats = screen.stop()?;

        if let Some(webcam) = session.webcam_capture.as_mut() {
            if let Err(e) = webcam.stop() {
                error!(%e, "failed to stop webcam sidecar during pause");
            }
        }

        let total = session.total_recorded_ms + stats.duration_ms;
        session.total_recorded_ms = total;
        session.screen_capture = None;
        session.webcam_capture = None;

        {
            let mut m = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            m.set_total_recorded_ms(total);
            m.set_state(RecorderState::Paused);
            m.set_stats(stats);
            let _ = m.write();
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

        {
            let m = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            if m.state != RecorderState::Paused {
                return Err(
                    crate::errors::InternalError::Capture("session is not paused".into()).into(),
                );
            }
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
            let mut m = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            m.set_state(RecorderState::Recording);
            let _ = m.write();
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
            .take()
            .ok_or_else(|| crate::errors::InternalError::Capture("no active recording".into()))?;

        let mut final_stats = if let Some(mut screen) = session.screen_capture {
            screen.stop()?
        } else {
            RecordingStats::default()
        };

        if let Some(mut webcam) = session.webcam_capture {
            if let Err(e) = webcam.stop() {
                error!(%e, "failed to stop webcam sidecar during stop");
            }
        }

        let total = session.total_recorded_ms + final_stats.duration_ms;
        {
            let mut m = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            m.set_total_recorded_ms(total);
        }

        let output = session.work_dir.join("output.mp4");
        let segment_files: Vec<PathBuf> = {
            let m = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            m.fragments
                .iter()
                .filter(|f| f.validated && f.size_bytes.unwrap_or(0) > 0)
                .map(|f| session.work_dir.join(&f.file_name))
                .collect()
        };

        if segment_files.is_empty() {
            return Err(crate::errors::InternalError::Capture(
                "no valid recording segments".into(),
            )
            .into());
        }

        media::concatenate_segments(
            &self.ffmpeg_path.to_string_lossy(),
            &session.work_dir,
            &segment_files,
            &output,
        )?;

        let output_size = std::fs::metadata(&output)
            .map(|m| m.len())
            .map_err(|e| crate::errors::InternalError::Storage(format!("output metadata: {e}")))?;

        let manifest_clone = {
            let mut m = session.manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;
            m.set_output_path(output.to_string_lossy());
            m.set_state(RecorderState::Completed);
            final_stats.duration_ms = total;
            final_stats.output_size_bytes = output_size;
            m.set_stats(final_stats.clone());
            let _ = m.write();
            (*m).clone()
        };

        let db_guard = self
            .db
            .lock()
            .map_err(|_| crate::errors::InternalError::Storage("database mutex poisoned".into()))?;
        let _ =
            crate::database::library::insert_recording(&db_guard, &manifest_clone, output_size)?;

        Ok(final_stats)
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
            let _ = m.write();
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

        let wall_ms = (chrono::Utc::now() - session.started_at).num_milliseconds() as u64;
        let current_elapsed = session
            .screen_capture
            .as_ref()
            .map(|c| c.elapsed_ms())
            .unwrap_or(0);
        let recorded_ms = session.total_recorded_ms + current_elapsed;

        Ok(RecordingStatus {
            session_id: session.session_id.clone(),
            state: m.state,
            started_at: Some(session.started_at.to_rfc3339()),
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
