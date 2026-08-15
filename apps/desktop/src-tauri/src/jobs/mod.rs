use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tracing::{error, info, instrument};

use crate::database::library::get_recording;
use crate::database::media as media_db;
use crate::database::media::{
    DerivativeFile, MediaAudioTrackOutput, MediaJob, MediaJobKind, MediaJobOutputs,
    MediaVideoTrackOutput,
};
use crate::errors::{InternalError, Result};
use crate::events::EventPublisher;
use crate::exports::{run_render_plan, ExportSettings, RenderPlan};
use crate::media::audio::extract_audio_track;
use crate::media::disk::{available_space, derivative_dir, estimate_derivative_size};
use crate::media::probe::probe_media;
use crate::media::proxy::generate_proxy;
use crate::media::thumbnails::generate_thumbnails;
use crate::media::video::extract_video_track;
use crate::media::waveform::generate_waveform_for_stream;
use crate::path_policy::PathPolicy;

const PREPARE_OUTPUT_VERSION: u32 = 4;

fn standalone_video_stream_index(metadata: &media_db::MediaMetadata) -> i32 {
    metadata
        .streams
        .iter()
        .map(|stream| stream.index)
        .max()
        .unwrap_or(-1)
        .saturating_add(1)
}

/// Options for a prepare job.
#[derive(Debug, Clone)]
pub struct PrepareOptions {
    pub recording_id: String,
    pub proxy_height: i32,
    pub thumbnail_interval_sec: u64,
    pub force: bool,
}

/// Durable export request stored in the media job options column.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExportRequest {
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "outputPath")]
    pub output_path: String,
    pub plan: RenderPlan,
    pub settings: ExportSettings,
}

/// Manages background media preparation and export jobs.
#[derive(Debug)]
pub struct JobManager {
    app: tauri::AppHandle,
    db: Arc<Mutex<rusqlite::Connection>>,
    ffmpeg_path: PathBuf,
    ffprobe_path: PathBuf,
    path_policy: PathPolicy,
    active_tokens: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    worker_lock: Arc<Mutex<()>>,
    start_lock: Arc<Mutex<()>>,
}

impl JobManager {
    pub fn new(
        app: tauri::AppHandle,
        db: Arc<Mutex<rusqlite::Connection>>,
        ffmpeg_path: PathBuf,
        ffprobe_path: PathBuf,
        path_policy: PathPolicy,
    ) -> Self {
        Self {
            app,
            db,
            ffmpeg_path,
            ffprobe_path,
            path_policy,
            active_tokens: Arc::new(Mutex::new(HashMap::new())),
            worker_lock: Arc::new(Mutex::new(())),
            start_lock: Arc::new(Mutex::new(())),
        }
    }

    /// Start a prepare job for a recording.
    #[instrument]
    pub fn start_prepare(&self, options: PrepareOptions) -> Result<String> {
        // Serialize the check-and-insert sequence so simultaneous completion and
        // editor/manual requests cannot create duplicate non-forced jobs.
        let _start_lock = self
            .start_lock
            .lock()
            .map_err(|_| InternalError::Unknown("job start mutex poisoned".into()))?;
        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;

        // Ensure the recording exists before creating or reusing a job.
        let _recording = get_recording(&conn, &options.recording_id)?;
        if !options.force {
            if let Some(existing) =
                media_db::find_reusable_prepare_job(&conn, &options.recording_id)?
            {
                return Ok(existing.id);
            }
        }
        let job = media_db::insert_job(&conn, &options.recording_id, MediaJobKind::Prepare)?;
        drop(conn);

        let token = Arc::new(AtomicBool::new(false));
        self.active_tokens
            .lock()
            .map_err(|_| InternalError::Unknown("active tokens mutex poisoned".into()))?
            .insert(job.id.clone(), token.clone());

        self.emit_job_update(&job)?;

        let worker = Worker {
            app: self.app.clone(),
            db: Arc::clone(&self.db),
            ffmpeg_path: self.ffmpeg_path.clone(),
            ffprobe_path: self.ffprobe_path.clone(),
            active_tokens: Arc::clone(&self.active_tokens),
            worker_lock: Arc::clone(&self.worker_lock),
            job_id: job.id.clone(),
            options,
        };

        let worker_id = worker.job_id.clone();
        std::thread::spawn(move || {
            if let Err(e) = worker.run(token) {
                error!(job_id = %worker_id, error = %e, "prepare job failed");
            }
        });

        Ok(job.id)
    }

    /// Persist and start one export job. The job row and its restartable request
    /// are committed before the worker thread is spawned.
    #[instrument(skip(self, request))]
    pub fn start_export(&self, request: ExportRequest) -> Result<MediaJob> {
        let _start_lock = self
            .start_lock
            .lock()
            .map_err(|_| InternalError::Unknown("job start mutex poisoned".into()))?;
        request.plan.validate()?;
        crate::exports::validate_export_settings(&request.settings, &request.plan)?;
        if request.plan.project_id != request.project_id {
            return Err(InternalError::Project(
                "render plan project does not match export project".into(),
            )
            .into());
        }
        let destination_path = Path::new(&request.output_path);
        if !destination_path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("mp4"))
        {
            return Err(InternalError::Media(
                "export destination must use the MP4 extension".into(),
            )
            .into());
        }
        let destination = self
            .path_policy
            .validate_export_destination(destination_path)?;

        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let project = crate::database::projects::get_project(&conn, &request.project_id)?
            .ok_or_else(|| InternalError::Project("export project was not found".into()))?;
        let active = media_db::list_jobs(&conn, &project.recording_id)?
            .into_iter()
            .find(|job| {
                job.kind == MediaJobKind::Export
                    && matches!(
                        job.status,
                        crate::database::media::MediaJobStatus::Pending
                            | crate::database::media::MediaJobStatus::Running
                    )
            });
        if let Some(active) = active {
            return Ok(active);
        }

        let mut request = request;
        request.output_path = destination.to_string_lossy().to_string();
        let options = serde_json::to_value(&request).map_err(|error| {
            InternalError::Storage(format!("serialize export request: {error}"))
        })?;
        let job = media_db::insert_job_with_options(
            &conn,
            &project.recording_id,
            MediaJobKind::Export,
            options,
        )?;
        drop(conn);

        let token = Arc::new(AtomicBool::new(false));
        self.active_tokens
            .lock()
            .map_err(|_| InternalError::Unknown("active tokens mutex poisoned".into()))?
            .insert(job.id.clone(), token.clone());
        self.emit_job_update(&job)?;
        self.spawn_export(job.clone(), request, token);
        Ok(job)
    }

    /// Retry an export using its persisted request and the same job identity.
    #[instrument]
    pub fn retry_export(&self, job_id: &str) -> Result<MediaJob> {
        let _start_lock = self
            .start_lock
            .lock()
            .map_err(|_| InternalError::Unknown("job start mutex poisoned".into()))?;
        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let existing = media_db::get_job(&conn, job_id)?;
        if existing.kind != MediaJobKind::Export
            || !matches!(
                existing.status,
                crate::database::media::MediaJobStatus::Failed
                    | crate::database::media::MediaJobStatus::Cancelled
            )
        {
            return Ok(existing);
        }
        if let Some(active) = media_db::list_jobs(&conn, &existing.recording_id)?
            .into_iter()
            .find(|job| {
                job.id != existing.id
                    && job.kind == MediaJobKind::Export
                    && matches!(
                        job.status,
                        crate::database::media::MediaJobStatus::Pending
                            | crate::database::media::MediaJobStatus::Running
                    )
            })
        {
            return Ok(active);
        }
        let request: ExportRequest =
            serde_json::from_value(existing.options.clone()).map_err(|error| {
                InternalError::Media(format!("stored export request is invalid: {error}"))
            })?;
        request.plan.validate()?;
        crate::exports::validate_export_settings(&request.settings, &request.plan)?;
        let destination_path = Path::new(&request.output_path);
        if !destination_path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("mp4"))
        {
            return Err(InternalError::Media(
                "export destination must use the MP4 extension".into(),
            )
            .into());
        }
        let destination = self
            .path_policy
            .validate_export_destination(destination_path)?;
        let mut request = request;
        request.output_path = destination.to_string_lossy().to_string();
        let job = media_db::retry_job(&conn, job_id)?;
        drop(conn);

        let token = Arc::new(AtomicBool::new(false));
        self.active_tokens
            .lock()
            .map_err(|_| InternalError::Unknown("active tokens mutex poisoned".into()))?
            .insert(job.id.clone(), token.clone());
        self.emit_job_update(&job)?;
        self.spawn_export(job.clone(), request, token);
        Ok(job)
    }

    fn spawn_export(&self, job: MediaJob, request: ExportRequest, token: Arc<AtomicBool>) {
        let worker = ExportWorker {
            app: self.app.clone(),
            db: Arc::clone(&self.db),
            ffmpeg_path: self.ffmpeg_path.clone(),
            ffprobe_path: self.ffprobe_path.clone(),
            active_tokens: Arc::clone(&self.active_tokens),
            worker_lock: Arc::clone(&self.worker_lock),
            job_id: job.id,
            request,
        };
        let worker_id = worker.job_id.clone();
        std::thread::spawn(move || {
            if let Err(error) = worker.run(token) {
                error!(job_id = %worker_id, error = %error, "export job failed");
            }
        });
    }

    /// Cancel an active or pending job.
    #[instrument]
    pub fn cancel_job(&self, job_id: &str) -> Result<()> {
        let tokens = self
            .active_tokens
            .lock()
            .map_err(|_| InternalError::Unknown("active tokens mutex poisoned".into()))?;

        if let Some(token) = tokens.get(job_id) {
            token.store(true, Ordering::Relaxed);
        }

        drop(tokens);

        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let job = media_db::cancel_job(&conn, job_id)?;
        drop(conn);

        self.emit_job_update(&job)?;
        Ok(())
    }

    /// Get a job by id.
    pub fn get_job(&self, job_id: &str) -> Result<MediaJob> {
        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        media_db::get_job(&conn, job_id)
    }

    /// List jobs for a recording.
    pub fn list_jobs(&self, recording_id: &str) -> Result<Vec<MediaJob>> {
        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        media_db::list_jobs(&conn, recording_id)
    }

    /// Re-queue any pending or interrupted jobs on startup.
    pub fn resume_pending_jobs(&self) -> Result<()> {
        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let jobs = media_db::list_active_or_pending_jobs(&conn)?;
        drop(conn);

        for job in jobs {
            if matches!(job.kind, crate::database::media::MediaJobKind::Export) {
                let request = match serde_json::from_value::<ExportRequest>(job.options.clone()) {
                    Ok(request) => request,
                    Err(error) => {
                        error!(job_id = %job.id, error = %error, "cannot resume export with invalid options");
                        continue;
                    }
                };
                if let Err(error) = request.plan.validate() {
                    error!(job_id = %job.id, error = %error, "cannot resume invalid export plan");
                    continue;
                }
                if let Err(error) =
                    crate::exports::validate_export_settings(&request.settings, &request.plan)
                {
                    error!(job_id = %job.id, error = %error, "cannot resume export with invalid settings");
                    continue;
                }
                if let Err(error) = self
                    .path_policy
                    .validate_export_destination(Path::new(&request.output_path))
                {
                    error!(job_id = %job.id, error = %error, "cannot resume export with an invalid destination");
                    continue;
                }
                let token = Arc::new(AtomicBool::new(false));
                self.active_tokens
                    .lock()
                    .map_err(|_| InternalError::Unknown("active tokens mutex poisoned".into()))?
                    .insert(job.id.clone(), token.clone());
                self.spawn_export(job, request, token);
                continue;
            }
            if !matches!(job.kind, crate::database::media::MediaJobKind::Prepare) {
                continue;
            }

            let options = PrepareOptions {
                recording_id: job.recording_id.clone(),
                proxy_height: 540,
                thumbnail_interval_sec: 5,
                force: false,
            };

            let token = Arc::new(AtomicBool::new(false));
            self.active_tokens
                .lock()
                .map_err(|_| InternalError::Unknown("active tokens mutex poisoned".into()))?
                .insert(job.id.clone(), token.clone());

            let worker = Worker {
                app: self.app.clone(),
                db: Arc::clone(&self.db),
                ffmpeg_path: self.ffmpeg_path.clone(),
                ffprobe_path: self.ffprobe_path.clone(),
                active_tokens: Arc::clone(&self.active_tokens),
                worker_lock: Arc::clone(&self.worker_lock),
                job_id: job.id.clone(),
                options,
            };

            let worker_id = worker.job_id.clone();
            std::thread::spawn(move || {
                if let Err(e) = worker.run(token) {
                    error!(job_id = %worker_id, error = %e, "resumed prepare job failed");
                }
            });
        }

        Ok(())
    }

    fn emit_job_update(&self, job: &MediaJob) -> Result<()> {
        EventPublisher::new(&self.app).media_job_update(job)
    }
}

#[derive(Debug)]
struct ExportWorker {
    app: tauri::AppHandle,
    db: Arc<Mutex<rusqlite::Connection>>,
    ffmpeg_path: PathBuf,
    ffprobe_path: PathBuf,
    active_tokens: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    worker_lock: Arc<Mutex<()>>,
    job_id: String,
    request: ExportRequest,
}

impl ExportWorker {
    fn run(self, cancel: Arc<AtomicBool>) -> Result<()> {
        let _lock = self
            .worker_lock
            .lock()
            .map_err(|_| InternalError::Unknown("worker lock poisoned".into()))?;
        if cancel.load(Ordering::Relaxed) {
            return self.finish_cancelled();
        }

        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let job = media_db::start_job(&conn, &self.job_id)?;
        drop(conn);
        self.emit(&job)?;

        let result = run_render_plan(
            &self.job_id,
            &self.request.project_id,
            Path::new(&self.request.output_path),
            self.request.plan.clone(),
            self.request.settings.clone(),
            &self.ffmpeg_path,
            &self.ffprobe_path,
            Arc::clone(&self.db),
            &self.app,
            cancel.clone(),
        );

        if cancel.load(Ordering::Relaxed) {
            return self.finish_cancelled();
        }
        match result {
            Ok(()) => {
                let conn = self
                    .db
                    .lock()
                    .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
                let completed = media_db::complete_job(
                    &conn,
                    &self.job_id,
                    &media_db::MediaJobOutputs {
                        output_path: Some(self.request.output_path.clone()),
                        captions_path: if self.request.plan.caption_mode == "sidecar" {
                            Some(
                                Path::new(&self.request.output_path)
                                    .with_extension("srt")
                                    .to_string_lossy()
                                    .to_string(),
                            )
                        } else {
                            None
                        },
                        ..Default::default()
                    },
                )?;
                drop(conn);
                if matches!(
                    completed.status,
                    crate::database::media::MediaJobStatus::Cancelled
                ) {
                    let _ = std::fs::remove_file(&self.request.output_path);
                    let _ = std::fs::remove_file(
                        Path::new(&self.request.output_path).with_extension("srt"),
                    );
                }
                self.emit(&completed)?;
                self.cleanup_active_token();
                Ok(())
            }
            Err(error) => self.fail(&error.to_string()),
        }
    }

    fn fail(&self, message: &str) -> Result<()> {
        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let job = media_db::fail_job(&conn, &self.job_id, message)?;
        drop(conn);
        self.cleanup_partial_outputs();
        self.cleanup_active_token();
        self.emit(&job)
    }

    fn finish_cancelled(&self) -> Result<()> {
        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let job = media_db::cancel_job(&conn, &self.job_id)?;
        drop(conn);
        self.cleanup_partial_outputs();
        self.cleanup_active_token();
        self.emit(&job)
    }

    fn cleanup_partial_outputs(&self) {
        crate::exports::cleanup_export_files(Path::new(&self.request.output_path));
    }

    fn cleanup_active_token(&self) {
        if let Ok(mut tokens) = self.active_tokens.lock() {
            tokens.remove(&self.job_id);
        }
    }

    fn emit(&self, job: &MediaJob) -> Result<()> {
        EventPublisher::new(&self.app).media_job_update(job)
    }
}

#[derive(Debug)]
struct Worker {
    app: tauri::AppHandle,
    db: Arc<Mutex<rusqlite::Connection>>,
    ffmpeg_path: PathBuf,
    ffprobe_path: PathBuf,
    active_tokens: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    worker_lock: Arc<Mutex<()>>,
    job_id: String,
    options: PrepareOptions,
}

impl Worker {
    fn run(self, cancel: Arc<AtomicBool>) -> Result<()> {
        let _lock = self
            .worker_lock
            .lock()
            .map_err(|_| InternalError::Unknown("worker lock poisoned".into()))?;

        if cancel.load(Ordering::Relaxed) {
            return self.finish_cancelled();
        }

        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let mut job = media_db::start_job(&conn, &self.job_id)?;
        drop(conn);

        self.emit(&job)?;

        let recording = match self.with_db(|conn| get_recording(conn, &self.options.recording_id)) {
            Ok(r) => r,
            Err(e) => return self.fail(&format!("load recording: {e}")),
        };

        let input_path = recording
            .output_path
            .as_ref()
            .map(PathBuf::from)
            .ok_or_else(|| InternalError::Media("recording has no output path".into()))?;

        let work_dir = PathBuf::from(&recording.work_dir);

        // Stage: metadata extraction.
        self.set_progress(0.05, "probing")?;
        let mut outputs = MediaJobOutputs {
            prepare_version: PREPARE_OUTPUT_VERSION,
            ..Default::default()
        };

        let metadata_path = derivative_dir(&work_dir, "metadata").join("metadata.json");
        let mut metadata: Option<media_db::MediaMetadata> = None;

        if !cancel.load(Ordering::Relaxed) {
            match self.extract_metadata(&input_path, &metadata_path, cancel.clone()) {
                Ok(m) => {
                    metadata = Some(m);
                    outputs.metadata_path = Some(metadata_path.to_string_lossy().to_string());
                }
                Err(e) => return self.fail(&format!("metadata extraction: {e}")),
            }
        }

        let metadata = match metadata {
            Some(m) => m,
            None => return self.finish_cancelled(),
        };

        // Stage: disk-space estimate and check.
        self.set_progress(0.10, "estimating")?;
        let required = estimate_derivative_size(
            &metadata,
            self.options.proxy_height,
            self.options.thumbnail_interval_sec,
        );

        match available_space(&work_dir) {
            Ok(available) if available > required => {}
            Ok(available) => {
                return self.fail(&format!(
                    "insufficient disk space: {required} bytes required, {available} available"
                ));
            }
            Err(e) => return self.fail(&format!("disk check: {e}")),
        }

        // Stage: proxy generation.
        self.set_progress(0.10, "proxy")?;
        let proxy_path = derivative_dir(&work_dir, "proxy").join("proxy.mp4");
        if !cancel.load(Ordering::Relaxed) {
            if self.options.force || !proxy_path.exists() {
                let cancel_for_proxy = cancel.clone();
                let progress_handle = Arc::new(Mutex::new(Instant::now()));
                let progress_db = Arc::clone(&self.db);
                let progress_app = self.app.clone();
                let progress_job_id = self.job_id.clone();
                let progress = move |p: f64| {
                    let mut last = progress_handle.lock().unwrap_or_else(|p| p.into_inner());
                    if last.elapsed() > Duration::from_millis(250) {
                        if let Ok(conn) = progress_db.lock() {
                            let _ = media_db::update_job_progress(
                                &conn,
                                &progress_job_id,
                                p,
                                "proxy",
                                None,
                            );
                            if let Ok(job) = media_db::get_job(&conn, &progress_job_id) {
                                let _ = EventPublisher::new(&progress_app).media_job_update(&job);
                            }
                        }
                        *last = Instant::now();
                    }
                };

                match generate_proxy(
                    &self.ffmpeg_path.to_string_lossy(),
                    &input_path,
                    &proxy_path,
                    &metadata,
                    self.options.proxy_height,
                    cancel_for_proxy,
                    progress,
                ) {
                    Ok(_) => {
                        outputs.proxy_path = Some(proxy_path.to_string_lossy().to_string());
                    }
                    Err(e) => return self.fail(&format!("proxy: {e}")),
                }
            } else {
                outputs.proxy_path = Some(proxy_path.to_string_lossy().to_string());
            }
        }

        if cancel.load(Ordering::Relaxed) {
            return self.finish_cancelled();
        }

        // Prefer the recorder's standalone webcam asset. The legacy branch
        // below keeps older recordings with a secondary video stream editable.
        let standalone_webcam_path = work_dir.join("webcam.mp4");
        if standalone_webcam_path.is_file() {
            self.set_progress(0.46, "camera track")?;
            if cancel.load(Ordering::Relaxed) {
                return self.finish_cancelled();
            }
            let webcam_metadata = probe_media(
                &self.ffprobe_path.to_string_lossy(),
                &standalone_webcam_path,
                &self.options.recording_id,
            )?;
            let stream = webcam_metadata
                .streams
                .iter()
                .find(|stream| stream.kind == "video")
                .ok_or_else(|| {
                    InternalError::Media("standalone webcam has no video stream".into())
                })?;

            let webcam_thumb_dir = derivative_dir(&work_dir, "thumbnails_webcam");
            let (webcam_thumb_dir_str, webcam_thumb_manifest_str) = match generate_thumbnails(
                &self.ffmpeg_path.to_string_lossy(),
                &standalone_webcam_path,
                &webcam_thumb_dir,
                &webcam_metadata,
                self.options.thumbnail_interval_sec,
            ) {
                Ok((sprite, manifest)) => {
                    let _ = self.record_derivative(&sprite.to_string_lossy(), "thumbnail");
                    let _ = self.record_derivative(&manifest.to_string_lossy(), "thumbnail");
                    (
                        Some(webcam_thumb_dir.to_string_lossy().to_string()),
                        Some(manifest.to_string_lossy().to_string()),
                    )
                }
                Err(e) => {
                    tracing::warn!("failed to generate webcam thumbnail sprite: {e}");
                    (None, None)
                }
            };

            outputs.video_tracks.push(MediaVideoTrackOutput {
                stream_index: standalone_video_stream_index(&metadata),
                title: "Webcam".into(),
                video_path: standalone_webcam_path.to_string_lossy().to_string(),
                width: stream.width,
                height: stream.height,
                thumbnail_dir: webcam_thumb_dir_str,
                thumbnail_manifest_path: webcam_thumb_manifest_str,
            });
        } else {
            let secondary_video_streams = metadata
                .streams
                .iter()
                .filter(|stream| stream.kind == "video")
                .skip(1)
                .collect::<Vec<_>>();
            if !secondary_video_streams.is_empty() {
                self.set_progress(0.46, "camera tracks")?;
                let video_dir = derivative_dir(&work_dir, "video");
                for stream in secondary_video_streams {
                    if cancel.load(Ordering::Relaxed) {
                        return self.finish_cancelled();
                    }
                    let title = stream
                        .title
                        .clone()
                        .unwrap_or_else(|| format!("Camera {}", stream.index));
                    let video_path = video_dir.join(format!("stream_{:03}.mp4", stream.index));
                    if self.options.force || !video_path.is_file() {
                        if let Err(error) = extract_video_track(
                            &self.ffmpeg_path.to_string_lossy(),
                            &input_path,
                            stream.index,
                            &video_path,
                            cancel.clone(),
                        ) {
                            return self.fail(&format!("video track {}: {error}", stream.index));
                        }
                    }
                    self.record_derivative(&video_path.to_string_lossy(), "video")?;

                    let stream_thumb_dir =
                        derivative_dir(&work_dir, &format!("thumbnails_stream_{}", stream.index));
                    let stream_metadata = probe_media(
                        &self.ffprobe_path.to_string_lossy(),
                        &video_path,
                        &self.options.recording_id,
                    )
                    .unwrap_or_else(|_| metadata.clone());

                    let (stream_thumb_dir_str, stream_thumb_manifest_str) =
                        match generate_thumbnails(
                            &self.ffmpeg_path.to_string_lossy(),
                            &video_path,
                            &stream_thumb_dir,
                            &stream_metadata,
                            self.options.thumbnail_interval_sec,
                        ) {
                            Ok((sprite, manifest)) => {
                                let _ =
                                    self.record_derivative(&sprite.to_string_lossy(), "thumbnail");
                                let _ = self
                                    .record_derivative(&manifest.to_string_lossy(), "thumbnail");
                                (
                                    Some(stream_thumb_dir.to_string_lossy().to_string()),
                                    Some(manifest.to_string_lossy().to_string()),
                                )
                            }
                            Err(e) => {
                                tracing::warn!(
                                    "failed to generate stream {} thumbnail sprite: {e}",
                                    stream.index
                                );
                                (None, None)
                            }
                        };

                    outputs.video_tracks.push(MediaVideoTrackOutput {
                        stream_index: stream.index,
                        title,
                        video_path: video_path.to_string_lossy().to_string(),
                        width: stream.width,
                        height: stream.height,
                        thumbnail_dir: stream_thumb_dir_str,
                        thumbnail_manifest_path: stream_thumb_manifest_str,
                    });
                }
            }
        }

        // Stage: thumbnail sprite.
        self.set_progress(0.50, "thumbnails")?;
        let thumbnail_dir = derivative_dir(&work_dir, "thumbnails");
        let thumbnail_sprite_path = thumbnail_dir.join("sprite.jpg");
        let thumbnail_manifest_path = thumbnail_dir.join("thumbnails.json");
        if !cancel.load(Ordering::Relaxed) {
            if self.options.force
                || !thumbnail_sprite_path.is_file()
                || !thumbnail_manifest_path.is_file()
            {
                match generate_thumbnails(
                    &self.ffmpeg_path.to_string_lossy(),
                    &input_path,
                    &thumbnail_dir,
                    &metadata,
                    self.options.thumbnail_interval_sec,
                ) {
                    Ok((sprite, manifest)) => {
                        outputs.thumbnail_dir = Some(thumbnail_dir.to_string_lossy().to_string());
                        outputs.thumbnail_manifest_path =
                            Some(manifest.to_string_lossy().to_string());
                        self.record_derivative(&sprite.to_string_lossy(), "thumbnail")?;
                        self.record_derivative(&manifest.to_string_lossy(), "thumbnail")?;
                    }
                    Err(e) => return self.fail(&format!("thumbnails: {e}")),
                }
            } else {
                outputs.thumbnail_dir = Some(thumbnail_dir.to_string_lossy().to_string());
                outputs.thumbnail_manifest_path =
                    Some(thumbnail_manifest_path.to_string_lossy().to_string());
            }
        }

        if cancel.load(Ordering::Relaxed) {
            return self.finish_cancelled();
        }

        // Stage: independent audio assets and per-stream waveforms.
        if metadata.has_audio {
            self.set_progress(0.65, "audio tracks")?;
            let audio_dir = derivative_dir(&work_dir, "audio");
            let waveform_dir = derivative_dir(&work_dir, "waveform");
            let audio_streams = metadata
                .streams
                .iter()
                .filter(|stream| stream.kind == "audio")
                .collect::<Vec<_>>();

            for (track_index, stream) in audio_streams.iter().enumerate() {
                if cancel.load(Ordering::Relaxed) {
                    return self.finish_cancelled();
                }

                let title = stream
                    .title
                    .clone()
                    .filter(|value| value != "SoundHandler")
                    .unwrap_or_else(|| {
                        if track_index == 0 {
                            "Microphone".into()
                        } else if track_index == 1 {
                            "System Audio".into()
                        } else {
                            format!("Audio {}", track_index + 1)
                        }
                    });
                let audio_path = audio_dir.join(format!("stream_{:03}.m4a", stream.index));
                if self.options.force || !audio_path.is_file() {
                    if let Err(error) = extract_audio_track(
                        &self.ffmpeg_path.to_string_lossy(),
                        &input_path,
                        stream.index,
                        &audio_path,
                        cancel.clone(),
                    ) {
                        return self.fail(&format!("audio track {}: {error}", stream.index));
                    }
                }

                let track_waveform_dir = waveform_dir.join(format!("stream_{:03}", stream.index));
                let waveform_json = track_waveform_dir.join("waveform.json");
                let waveform_png = track_waveform_dir.join("waveform.png");
                if self.options.force || !waveform_json.is_file() || !waveform_png.is_file() {
                    let (json, png) = match generate_waveform_for_stream(
                        &self.ffmpeg_path.to_string_lossy(),
                        &input_path,
                        &track_waveform_dir,
                        &metadata,
                        stream.index,
                        cancel.clone(),
                    ) {
                        Ok(paths) => paths,
                        Err(error) => {
                            return self.fail(&format!("waveform stream {}: {error}", stream.index))
                        }
                    };
                    self.record_derivative(&json.to_string_lossy(), "waveform")?;
                    self.record_derivative(&png.to_string_lossy(), "waveform")?;
                }

                self.record_derivative(&audio_path.to_string_lossy(), "audio")?;
                let output = MediaAudioTrackOutput {
                    stream_index: stream.index,
                    title,
                    audio_path: audio_path.to_string_lossy().to_string(),
                    waveform_path: waveform_json.to_string_lossy().to_string(),
                    waveform_image_path: waveform_png.to_string_lossy().to_string(),
                };
                if outputs.audio_tracks.is_empty() {
                    outputs.waveform_path = Some(output.waveform_path.clone());
                    outputs.waveform_image_path = Some(output.waveform_image_path.clone());
                }
                outputs.audio_tracks.push(output);
            }
        }

        if cancel.load(Ordering::Relaxed) {
            return self.finish_cancelled();
        }

        // Stage: record derivatives and finish.
        self.set_progress(0.90, "finalizing")?;
        if let Some(path) = outputs.proxy_path.as_ref() {
            self.record_derivative(path, "proxy")?;
        }
        if let Some(path) = outputs.waveform_path.as_ref() {
            self.record_derivative(path, "waveform")?;
        }

        self.with_db(|conn| {
            media_db::upsert_metadata(conn, &metadata)?;
            Ok(())
        })?;

        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        job = media_db::complete_job(&conn, &self.job_id, &outputs)?;
        drop(conn);

        self.cleanup_active_token();
        self.emit(&job)?;

        info!(job_id = %self.job_id, "prepare job completed");
        Ok(())
    }

    fn extract_metadata(
        &self,
        input: &Path,
        metadata_path: &Path,
        cancel: Arc<AtomicBool>,
    ) -> Result<media_db::MediaMetadata> {
        if cancel.load(Ordering::Relaxed) {
            return Err(InternalError::Media("cancelled".into()).into());
        }

        let metadata = probe_media(
            &self.ffprobe_path.to_string_lossy(),
            input,
            &self.options.recording_id,
        )?;

        if let Some(parent) = metadata_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| InternalError::Storage(format!("create metadata dir: {e}")))?;
        }

        let json = serde_json::to_string_pretty(&metadata)
            .map_err(|e| InternalError::Storage(format!("serialize metadata: {e}")))?;
        std::fs::write(metadata_path, json)
            .map_err(|e| InternalError::Storage(format!("write metadata: {e}")))?;

        Ok(metadata)
    }

    fn set_progress(&self, progress: f64, stage: &str) -> Result<MediaJob> {
        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        media_db::update_job_progress(&conn, &self.job_id, progress, stage, None)?;
        let job = media_db::get_job(&conn, &self.job_id)?;
        drop(conn);
        self.emit(&job)?;
        Ok(job)
    }

    fn fail(&self, message: &str) -> Result<()> {
        error!(job_id = %self.job_id, %message, "prepare job failed");
        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let job = media_db::fail_job(&conn, &self.job_id, message)?;
        drop(conn);
        self.cleanup_active_token();
        self.emit(&job)?;
        Ok(())
    }

    fn finish_cancelled(&self) -> Result<()> {
        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let job = media_db::cancel_job(&conn, &self.job_id)?;
        drop(conn);
        self.cleanup_active_token();
        self.emit(&job)?;
        Ok(())
    }

    fn cleanup_active_token(&self) {
        let _ = self
            .active_tokens
            .lock()
            .map_err(|_| InternalError::Unknown("active tokens mutex poisoned".into()))
            .map(|mut map| map.remove(&self.job_id));
    }

    fn emit(&self, job: &MediaJob) -> Result<()> {
        EventPublisher::new(&self.app).media_job_update(job)
    }

    fn with_db<T, F>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&rusqlite::Connection) -> Result<T>,
    {
        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        f(&conn)
    }

    fn record_derivative(&self, path: &str, kind: &str) -> Result<()> {
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let derivative = DerivativeFile {
            id: uuid::Uuid::new_v4().to_string(),
            recording_id: self.options.recording_id.clone(),
            job_id: self.job_id.clone(),
            kind: kind.to_string(),
            path: path.to_string(),
            size_bytes: size,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        self.with_db(|conn| media_db::insert_derivative(conn, &derivative))
    }
}
