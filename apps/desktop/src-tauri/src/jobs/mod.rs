use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tracing::{error, info, instrument};

use crate::database::library::get_recording;
use crate::database::media as media_db;
use crate::database::media::{
    DerivativeFile, MediaAudioTrackOutput, MediaFormat, MediaJob, MediaJobKind, MediaJobOutputs,
    MediaVideoTrackOutput,
};
use crate::errors::{AppError, ErrorCategory, InternalError, Result};
use crate::events::EventPublisher;
use crate::exports::{run_render_plan, ExportSettings, RenderPlan};
use crate::media::audio::extract_audio_track;
use crate::media::derivatives::{
    copy_audio_preview, generate_image_thumbnail, normalize_derivative_paths,
};
use crate::media::disk::{available_space, derivative_dir, estimate_derivative_size};
use crate::media::probe::probe_media;
use crate::media::proxy::generate_proxy;
use crate::media::thumbnails::generate_thumbnails;
use crate::media::video::extract_video_track;
use crate::media::waveform::generate_waveform_for_stream;
use crate::path_policy::PathPolicy;

const PREPARE_OUTPUT_VERSION: u32 = 7;

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
///
/// Persisted in `media_jobs.options` so deduplication and crash-resume can
/// tell a light prepare (no proxy stage) from a proxy-including prepare.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareOptions {
    pub recording_id: String,
    #[serde(default = "default_proxy_height")]
    pub proxy_height: i32,
    #[serde(default = "default_thumbnail_interval_sec")]
    pub thumbnail_interval_sec: u64,
    /// Whether to transcode the low-res performance preview proxy. Light
    /// prepares skip it so editing can start without a lengthy transcode.
    #[serde(default)]
    pub include_proxy: bool,
    #[serde(default)]
    pub force: bool,
}

fn default_proxy_height() -> i32 {
    540
}

fn default_thumbnail_interval_sec() -> u64 {
    5
}

/// Restartable options for derivatives attached to one imported project asset.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDerivativeOptions {
    pub recording_id: String,
    pub asset_id: String,
    pub source_path: String,
    pub asset_kind: String,
    #[serde(default)]
    pub force: bool,
}

/// Post-export delivery plan persisted inside `ExportRequest`. Deliveries
/// ride the durable job row so a share/publish outlives the export view, a
/// closed window, and an app restart — they are never UI-side fire-and-forget.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDeliveries {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share: Option<ShareDeliveryRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub youtube: Option<YouTubeDeliveryRequest>,
}

/// Instant Share delivery spec. `password` is accepted over IPC but never
/// persisted: `start_export` moves it into the OS credential vault and the
/// job row keeps only the opaque `password_vault_key`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareDeliveryRequest {
    /// `"hosted"` or an S3 storage profile id.
    pub target: String,
    pub title: String,
    #[serde(default = "default_true")]
    pub allow_download: bool,
    #[serde(default = "default_true")]
    pub allow_embed: bool,
    #[serde(default)]
    pub expires_in_days: Option<u32>,
    /// Transient IPC-only field — `skip_serializing` keeps it out of SQLite.
    #[serde(default, skip_serializing)]
    pub password: Option<String>,
    /// Vault account holding the link password for the delivery + retries.
    #[serde(default)]
    pub password_vault_key: Option<String>,
}

/// YouTube auto-publish spec persisted with the export job.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeDeliveryRequest {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_unlisted")]
    pub privacy: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_true")]
    pub attach_captions: bool,
    #[serde(default = "default_en")]
    pub captions_language: String,
}

fn default_true() -> bool {
    true
}
fn default_unlisted() -> String {
    "unlisted".to_string()
}
fn default_en() -> String {
    "en".to_string()
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
    /// Post-export destinations; absent on rows persisted before deliveries.
    #[serde(default)]
    pub deliveries: ExportDeliveries,
}

/// The normalized destination a persisted export request targets. Dedupe
/// compares request destinations so a running export to path A must not
/// swallow a new export to path B — each export job owns its own output
/// path, so destination-scoped dedupe never conflates siblings.
fn export_request_output(options: &serde_json::Value) -> Option<&str> {
    options.get("outputPath").and_then(|value| value.as_str())
}

/// Find an in-flight export job targeting `output_path`, if any.
fn active_export_for_output<'a>(
    jobs: impl IntoIterator<Item = &'a crate::database::media::MediaJob>,
    exclude_job_id: Option<&str>,
    output_path: &str,
) -> Option<&'a crate::database::media::MediaJob> {
    jobs.into_iter().find(|job| {
        Some(job.id.as_str()) != exclude_job_id
            && job.kind == crate::database::media::MediaJobKind::Export
            && matches!(
                job.status,
                crate::database::media::MediaJobStatus::Pending
                    | crate::database::media::MediaJobStatus::Running
            )
            && export_request_output(&job.options) == Some(output_path)
    })
}

fn expected_export_extension(settings: &ExportSettings) -> &'static str {
    if settings.container == "gif" || settings.preset.starts_with("gif-") {
        "gif"
    } else if settings.container == "webp" || settings.preset.starts_with("webp-") {
        "webp"
    } else {
        "mp4"
    }
}

/// Manages background media preparation and export jobs.
#[derive(Debug)]
pub struct JobManager {
    app: tauri::AppHandle,
    db: Arc<Mutex<rusqlite::Connection>>,
    ffmpeg_path: PathBuf,
    ffprobe_path: PathBuf,
    path_policy: PathPolicy,
    // Encoder ids probed once at startup and shared with the capture path, so
    // export and proxy jobs pick hardware encoders without re-probing.
    available_encoders: Vec<String>,
    active_tokens: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    worker_lock: Arc<Mutex<()>>,
    start_lock: Arc<Mutex<()>>,
    // Shared with the recorder: jobs hold a permit for their whole run so a
    // queued job never encodes while capture or finalization is active.
    resource_gate: Arc<crate::state::CaptureWorkGate>,
    // Entitlements are checked at every export entry point (start, retry,
    // startup resume) so a persisted Pro export can't outlive the license.
    license: Arc<crate::licensing::LicenseManager>,
    // Deliveries resolve BYO storage profiles + vault secrets through the
    // manager, never through frontend-supplied credentials.
    storage: crate::storage::StorageManager,
    // Post-export uploads hold an update-gate op so an installer can't swap
    // the binary mid-upload.
    update_gate: Arc<crate::state::UpdateGate>,
    // Delivery phases serialize across jobs — renders may queue but network
    // uploads run one at a time so retries/cancels stay unambiguous.
    delivery_lock: Arc<Mutex<()>>,
}

impl JobManager {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        app: tauri::AppHandle,
        db: Arc<Mutex<rusqlite::Connection>>,
        ffmpeg_path: PathBuf,
        ffprobe_path: PathBuf,
        path_policy: PathPolicy,
        available_encoders: Vec<String>,
        resource_gate: Arc<crate::state::CaptureWorkGate>,
        license: Arc<crate::licensing::LicenseManager>,
        storage: crate::storage::StorageManager,
        update_gate: Arc<crate::state::UpdateGate>,
    ) -> Self {
        Self {
            app,
            db,
            ffmpeg_path,
            ffprobe_path,
            path_policy,
            available_encoders,
            active_tokens: Arc::new(Mutex::new(HashMap::new())),
            worker_lock: Arc::new(Mutex::new(())),
            start_lock: Arc::new(Mutex::new(())),
            resource_gate,
            license,
            storage,
            update_gate,
            delivery_lock: Arc::new(Mutex::new(())),
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
            if let Some(existing) = media_db::find_reusable_prepare_job(
                &conn,
                &options.recording_id,
                options.include_proxy,
            )? {
                return Ok(existing.id);
            }
        }
        let options_json = serde_json::to_value(&options).map_err(|error| {
            InternalError::Storage(format!("serialize prepare options: {error}"))
        })?;
        let job = media_db::insert_job_with_options(
            &conn,
            &options.recording_id,
            MediaJobKind::Prepare,
            options_json,
        )?;
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
            available_encoders: self.available_encoders.clone(),
            active_tokens: Arc::clone(&self.active_tokens),
            worker_lock: Arc::clone(&self.worker_lock),
            resource_gate: Arc::clone(&self.resource_gate),
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

    /// Queue derivatives for one imported asset and reuse an active/completed
    /// job when its output files are still present.
    #[instrument(skip(self, options))]
    pub fn start_asset_derivative(&self, options: AssetDerivativeOptions) -> Result<MediaJob> {
        let _start_lock = self
            .start_lock
            .lock()
            .map_err(|_| InternalError::Unknown("job start mutex poisoned".into()))?;
        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let _recording = get_recording(&conn, &options.recording_id)?;

        if !options.force {
            if let Some(existing) = media_db::list_jobs(&conn, &options.recording_id)?
                .into_iter()
                .find(|job| {
                    if job.kind != MediaJobKind::AssetDerivative
                        || !matches!(
                            job.status,
                            crate::database::media::MediaJobStatus::Pending
                                | crate::database::media::MediaJobStatus::Running
                        )
                    {
                        return false;
                    }
                    job.options
                        .get("assetId")
                        .and_then(serde_json::Value::as_str)
                        == Some(options.asset_id.as_str())
                })
            {
                return Ok(existing);
            }
        }

        let options_json = serde_json::to_value(&options).map_err(|error| {
            InternalError::Storage(format!("serialize asset derivative options: {error}"))
        })?;
        let job = media_db::insert_job_with_options(
            &conn,
            &options.recording_id,
            MediaJobKind::AssetDerivative,
            options_json,
        )?;
        drop(conn);

        let token = Arc::new(AtomicBool::new(false));
        self.active_tokens
            .lock()
            .map_err(|_| InternalError::Unknown("active tokens mutex poisoned".into()))?
            .insert(job.id.clone(), token.clone());
        self.emit_job_update(&job)?;

        let worker = AssetWorker {
            app: self.app.clone(),
            db: Arc::clone(&self.db),
            ffmpeg_path: self.ffmpeg_path.clone(),
            ffprobe_path: self.ffprobe_path.clone(),
            path_policy: self.path_policy.clone(),
            available_encoders: self.available_encoders.clone(),
            active_tokens: Arc::clone(&self.active_tokens),
            worker_lock: Arc::clone(&self.worker_lock),
            resource_gate: Arc::clone(&self.resource_gate),
            job_id: job.id.clone(),
            options,
        };
        let worker_id = worker.job_id.clone();
        std::thread::spawn(move || {
            if let Err(error) = worker.run(token) {
                error!(job_id = %worker_id, error = %error, "asset derivative job failed");
            }
        });

        Ok(job)
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
        self.license
            .enforce_export(&request.plan, &request.settings)?;
        if request.plan.project_id != request.project_id {
            return Err(InternalError::Project(
                "render plan project does not match export project".into(),
            )
            .into());
        }
        let expected_ext = expected_export_extension(&request.settings);
        let destination_path = Path::new(&request.output_path);
        if !destination_path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(expected_ext))
        {
            return Err(InternalError::Media(format!(
                "export destination must use the {} extension",
                expected_ext.to_uppercase()
            ))
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
        // Dedupe on the normalized destination, not "any running export":
        // two exports to different files may coexist and the gate serializes
        // their encode work.
        let active = media_db::list_jobs(&conn, &project.recording_id)?;
        let active = active_export_for_output(&active, None, &destination.to_string_lossy());
        if let Some(active) = active {
            return Ok(active.clone());
        }

        let mut request = request;
        request.output_path = destination.to_string_lossy().to_string();
        // Post-export deliveries are Pro-only; check at admission now and
        // again in the worker at delivery time so a mid-export downgrade
        // can't smuggle Pro uploads through a stale decision.
        self.enforce_delivery_entitlements(&request.deliveries)?;
        // The share password is a secret: move it into the OS credential
        // vault and persist only the opaque vault key in the job row.
        if let Some(share) = request.deliveries.share.as_mut() {
            if let Some(password) = share.password.take().filter(|p| !p.trim().is_empty()) {
                let key = format!("share-link-password:{}", uuid::Uuid::new_v4());
                crate::storage::vault::set_secret(&key, &password)?;
                share.password_vault_key = Some(key);
            }
        }
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

    /// Pro-gate the configured deliveries; the AppError carries the feature
    /// keys the frontend maps to the upgrade dialog.
    fn enforce_delivery_entitlements(&self, deliveries: &ExportDeliveries) -> Result<()> {
        if deliveries.share.is_none() && deliveries.youtube.is_none() {
            return Ok(());
        }
        if self.license.entitlements().pro_enabled {
            return Ok(());
        }
        let mut features = Vec::new();
        if deliveries.share.is_some() {
            features.push("instant-share");
        }
        if deliveries.youtube.is_some() {
            features.push("youtube-publish");
        }
        let mut details = serde_json::Map::new();
        details.insert("features".to_string(), serde_json::json!(features));
        Err(AppError::new(
            ErrorCategory::Licensing,
            "pro_feature_required",
            "Post-export sharing and publishing require RecordForge Pro",
        )
        .with_details(details))
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
        // Same destination-scoped dedupe as start_export: a sibling export
        // running to another output must not suppress this retry, but a fresh
        // export already targeting the same file supersedes it.
        let retried_output = export_request_output(&existing.options).map(str::to_owned);
        let active = media_db::list_jobs(&conn, &existing.recording_id)?;
        if let Some(active) = retried_output
            .as_deref()
            .and_then(|output| active_export_for_output(&active, Some(&existing.id), output))
        {
            return Ok(active.clone());
        }
        let request: ExportRequest =
            serde_json::from_value(existing.options.clone()).map_err(|error| {
                InternalError::Media(format!("stored export request is invalid: {error}"))
            })?;
        request.plan.validate()?;
        crate::exports::validate_export_settings(&request.settings, &request.plan)?;
        self.license
            .enforce_export(&request.plan, &request.settings)?;
        let expected_ext = expected_export_extension(&request.settings);
        let destination_path = Path::new(&request.output_path);
        if !destination_path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(expected_ext))
        {
            return Err(InternalError::Media(format!(
                "export destination must use the {} extension",
                expected_ext.to_uppercase()
            ))
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
            path_policy: self.path_policy.clone(),
            available_encoders: self.available_encoders.clone(),
            active_tokens: Arc::clone(&self.active_tokens),
            worker_lock: Arc::clone(&self.worker_lock),
            resource_gate: Arc::clone(&self.resource_gate),
            // The cap is resolved at spawn — a downgrade between enqueue and
            // retry/resume applies the Free raster limit.
            output_cap: self.license.entitlements().output_cap(),
            job_id: job.id,
            request,
            license: Arc::clone(&self.license),
            storage: self.storage.clone(),
            update_gate: Arc::clone(&self.update_gate),
            delivery_lock: Arc::clone(&self.delivery_lock),
        };
        let worker_id = worker.job_id.clone();
        std::thread::spawn(move || {
            if let Err(error) = worker.run(token) {
                error!(job_id = %worker_id, error = %error, "export job failed");
            }
        });
    }

    /// Re-run one post-export delivery (share or youtube) on a completed
    /// export. The persisted request carries the spec — a failed upload
    /// retries without re-rendering, and the vault key survives for the
    /// password. A second click while the same delivery is running dedupes.
    #[instrument]
    pub fn retry_delivery(&self, job_id: &str, kind: &str) -> Result<MediaJob> {
        let _start_lock = self
            .start_lock
            .lock()
            .map_err(|_| InternalError::Unknown("job start mutex poisoned".into()))?;
        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let job = media_db::get_job(&conn, job_id)?;
        if job.kind != MediaJobKind::Export
            || job.status != crate::database::media::MediaJobStatus::Completed
        {
            return Ok(job);
        }
        // One in-flight attempt per delivery kind.
        if job
            .outputs
            .deliveries
            .iter()
            .any(|delivery| delivery.kind == kind && delivery.status == "running")
        {
            return Ok(job);
        }
        let request: ExportRequest =
            serde_json::from_value(job.options.clone()).map_err(|error| {
                InternalError::Media(format!("stored export request is invalid: {error}"))
            })?;
        let configured = match kind {
            "share" => request.deliveries.share.is_some(),
            "youtube" => request.deliveries.youtube.is_some(),
            _ => false,
        };
        if !configured {
            return Err(InternalError::Media(format!(
                "export {job_id} has no {kind} delivery configured"
            ))
            .into());
        }
        if !self.license.entitlements().pro_enabled {
            return Err(AppError::new(
                ErrorCategory::Licensing,
                "pro_feature_required",
                "Post-export sharing and publishing require RecordForge Pro",
            ));
        }
        drop(conn);

        let token = Arc::new(AtomicBool::new(false));
        self.active_tokens
            .lock()
            .map_err(|_| InternalError::Unknown("active tokens mutex poisoned".into()))?
            .insert(job.id.clone(), token.clone());
        let runner = ExportDeliveryRunner {
            app: self.app.clone(),
            db: Arc::clone(&self.db),
            license: Arc::clone(&self.license),
            storage: self.storage.clone(),
            path_policy: self.path_policy.clone(),
            update_gate: Arc::clone(&self.update_gate),
            delivery_lock: Arc::clone(&self.delivery_lock),
            active_tokens: Arc::clone(&self.active_tokens),
            job_id: job.id.clone(),
            request,
            kinds: vec![kind.to_string()],
        };
        let runner_id = runner.job_id.clone();
        std::thread::spawn(move || {
            if let Err(error) = runner.run(token) {
                error!(job_id = %runner_id, error = %error, "delivery retry failed");
            }
        });
        Ok(job)
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
        // A crash mid-upload leaves "running" deliveries on completed jobs.
        // Flag them failed so the UI offers a retry instead of a frozen bar;
        // the delivery is cheap to re-run and auto-resuming a dead network
        // upload would risk surprise re-uploads.
        if let Err(error) = media_db::fail_interrupted_deliveries(&conn) {
            error!(error = %error, "interrupted delivery sweep failed");
        }
        let jobs = media_db::list_active_or_pending_jobs(&conn)?;
        drop(conn);

        for job in jobs {
            if matches!(
                job.kind,
                crate::database::media::MediaJobKind::AssetDerivative
            ) {
                let options = match serde_json::from_value::<AssetDerivativeOptions>(
                    job.options.clone(),
                ) {
                    Ok(options) => options,
                    Err(error) => {
                        error!(job_id = %job.id, error = %error, "cannot resume asset derivative with invalid options");
                        continue;
                    }
                };
                let token = Arc::new(AtomicBool::new(false));
                self.active_tokens
                    .lock()
                    .map_err(|_| InternalError::Unknown("active tokens mutex poisoned".into()))?
                    .insert(job.id.clone(), token.clone());
                let worker = AssetWorker {
                    app: self.app.clone(),
                    db: Arc::clone(&self.db),
                    ffmpeg_path: self.ffmpeg_path.clone(),
                    ffprobe_path: self.ffprobe_path.clone(),
                    path_policy: self.path_policy.clone(),
                    available_encoders: self.available_encoders.clone(),
                    active_tokens: Arc::clone(&self.active_tokens),
                    worker_lock: Arc::clone(&self.worker_lock),
                    resource_gate: Arc::clone(&self.resource_gate),
                    job_id: job.id.clone(),
                    options,
                };
                let worker_id = worker.job_id.clone();
                std::thread::spawn(move || {
                    if let Err(error) = worker.run(token) {
                        error!(job_id = %worker_id, error = %error, "resumed asset derivative failed");
                    }
                });
                continue;
            }
            if matches!(job.kind, crate::database::media::MediaJobKind::Export) {
                let request = match serde_json::from_value::<ExportRequest>(job.options.clone()) {
                    Ok(request) => request,
                    Err(_) => {
                        self.fail_unresumable_job(
                            &job.id,
                            "stored export request is incompatible with this app version",
                        )?;
                        continue;
                    }
                };
                if request.plan.validate().is_err() {
                    self.fail_unresumable_job(&job.id, "stored export timeline is invalid")?;
                    continue;
                }
                if crate::exports::validate_export_settings(&request.settings, &request.plan)
                    .is_err()
                {
                    self.fail_unresumable_job(&job.id, "stored export settings are invalid")?;
                    continue;
                }
                // A Pro export persisted before the license lapsed must not
                // slip through on resume — re-check current entitlements.
                if self
                    .license
                    .enforce_export(&request.plan, &request.settings)
                    .is_err()
                {
                    self.fail_unresumable_job(&job.id, "stored export requires RecordForge Pro")?;
                    continue;
                }
                let expected_ext = expected_export_extension(&request.settings);
                let destination = Path::new(&request.output_path);
                if !destination
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case(expected_ext))
                    || self
                        .path_policy
                        .validate_export_destination(destination)
                        .is_err()
                {
                    self.fail_unresumable_job(&job.id, "stored export destination is invalid")?;
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

            // Older prepare rows predate persisted options; they resume as
            // light prepares and regenerate the proxy only if it was requested.
            let mut options = serde_json::from_value::<PrepareOptions>(job.options.clone())
                .unwrap_or_else(|_| PrepareOptions {
                    recording_id: job.recording_id.clone(),
                    proxy_height: 540,
                    thumbnail_interval_sec: 5,
                    include_proxy: false,
                    force: false,
                });
            options.recording_id = job.recording_id.clone();

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
                available_encoders: self.available_encoders.clone(),
                active_tokens: Arc::clone(&self.active_tokens),
                worker_lock: Arc::clone(&self.worker_lock),
                resource_gate: Arc::clone(&self.resource_gate),
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

    fn fail_unresumable_job(&self, job_id: &str, message: &str) -> Result<()> {
        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let job = media_db::fail_job(&conn, job_id, message)?;
        drop(conn);
        self.emit_job_update(&job)
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
    path_policy: PathPolicy,
    available_encoders: Vec<String>,
    active_tokens: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    worker_lock: Arc<Mutex<()>>,
    resource_gate: Arc<crate::state::CaptureWorkGate>,
    output_cap: Option<crate::exports::ExportOutputCap>,
    job_id: String,
    request: ExportRequest,
    license: Arc<crate::licensing::LicenseManager>,
    storage: crate::storage::StorageManager,
    update_gate: Arc<crate::state::UpdateGate>,
    delivery_lock: Arc<Mutex<()>>,
}

impl ExportWorker {
    /// Two phases with different resources: the render holds the worker and
    /// media gates; deliveries are plain network uploads that run after both
    /// are released so a slow share can't starve queued jobs or recording.
    fn run(self, cancel: Arc<AtomicBool>) -> Result<()> {
        {
            let _lock = self
                .worker_lock
                .lock()
                .map_err(|_| InternalError::Unknown("worker lock poisoned".into()))?;
            if cancel.load(Ordering::Relaxed) {
                return self.finish_cancelled();
            }
            // Wait for any active capture/finalization to release the media gate
            // before marking the job running; a cancelled wait starts nothing.
            let _resource_permit = match self.resource_gate.wait_for_job(&cancel) {
                Ok(Some(permit)) => permit,
                Ok(None) => return self.finish_cancelled(),
                Err(error) => return self.fail(&error.to_string()),
            };

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
                &self.available_encoders,
                self.output_cap,
            );

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
                    self.emit(&completed)?;
                }
                Err(_) if cancel.load(Ordering::Relaxed) => return self.finish_cancelled(),
                Err(error) => return self.fail(&error.to_string()),
            }
            // `worker_lock` + `resource_permit` drop here — the export file is
            // durable at this point and uploads are pure network work.
        }

        // Post-export deliveries share the job's cancel token so
        // `cancel_media_job` still aborts an upload on a completed job.
        self.run_deliveries(&cancel);
        self.cleanup_active_token();
        Ok(())
    }

    fn run_deliveries(&self, cancel: &Arc<AtomicBool>) {
        let runner = ExportDeliveryRunner {
            app: self.app.clone(),
            db: Arc::clone(&self.db),
            license: Arc::clone(&self.license),
            storage: self.storage.clone(),
            path_policy: self.path_policy.clone(),
            update_gate: Arc::clone(&self.update_gate),
            delivery_lock: Arc::clone(&self.delivery_lock),
            active_tokens: Arc::clone(&self.active_tokens),
            job_id: self.job_id.clone(),
            request: self.request.clone(),
            kinds: vec!["share".to_string(), "youtube".to_string()],
        };
        if let Err(error) = runner.run(cancel.clone()) {
            error!(job_id = %self.job_id, error = %error, "post-export delivery stage failed");
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

/// Payload for `export-delivery-progress` — byte-level upload progress for
/// one delivery on one job. Mirrors `deliveryProgressSchema` in contracts.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DeliveryProgressEvent {
    job_id: String,
    kind: &'static str,
    uploaded_bytes: u64,
    total_bytes: u64,
}

const DELIVERY_PROGRESS_EVENT: &str = "export-delivery-progress";

/// Runs the post-export delivery stage for one job — Instant Share and/or
/// YouTube auto-publish. Every delivery writes its own status onto the job's
/// persisted outputs (`outputs.deliveries`) and emits a fresh job update, so
/// the UI shows a durable result regardless of which screen is open. A
/// delivery failure never flips the completed export.
struct ExportDeliveryRunner {
    app: tauri::AppHandle,
    db: Arc<Mutex<rusqlite::Connection>>,
    license: Arc<crate::licensing::LicenseManager>,
    storage: crate::storage::StorageManager,
    path_policy: PathPolicy,
    update_gate: Arc<crate::state::UpdateGate>,
    delivery_lock: Arc<Mutex<()>>,
    active_tokens: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    job_id: String,
    request: ExportRequest,
    /// Delivery kinds this run covers — both on the export path, a single
    /// kind on `retry_delivery`.
    kinds: Vec<String>,
}

impl ExportDeliveryRunner {
    fn run(&self, cancel: Arc<AtomicBool>) -> Result<()> {
        let want_share =
            self.kinds.iter().any(|k| k == "share") && self.request.deliveries.share.is_some();
        let want_youtube =
            self.kinds.iter().any(|k| k == "youtube") && self.request.deliveries.youtube.is_some();
        if !want_share && !want_youtube {
            return Ok(());
        }

        // Serialize deliveries across jobs — one upload at a time keeps
        // cancel/retry semantics unambiguous and avoids saturating uplinks.
        let _delivery_lock = self
            .delivery_lock
            .lock()
            .map_err(|_| InternalError::Unknown("delivery lock poisoned".into()))?;

        // An in-flight upload must not race an updater install.
        let _update_op = match self.update_gate.acquire_operation() {
            Ok(operation) => operation,
            Err(error) => {
                let detail = format!("delivery deferred — {error}");
                if want_share {
                    self.set_delivery(
                        media_db::JobDelivery::new("share", "failed").detail(detail.clone()),
                    );
                }
                if want_youtube {
                    self.set_delivery(
                        media_db::JobDelivery::new("youtube", "failed").detail(detail),
                    );
                }
                return Ok(());
            }
        };

        let output = PathBuf::from(&self.request.output_path);
        if !output.is_file() {
            let detail = "exported file no longer exists — re-export first".to_string();
            if want_share {
                self.set_delivery(media_db::JobDelivery::new("share", "failed").detail(&detail));
            }
            if want_youtube {
                self.set_delivery(media_db::JobDelivery::new("youtube", "failed").detail(&detail));
            }
            return Ok(());
        }

        // Re-check the entitlement at delivery time: a license change during
        // a long render must not leak Pro uploads.
        let pro = self.license.entitlements().pro_enabled;
        if let Some(spec) = self.request.deliveries.share.clone() {
            if want_share {
                if pro {
                    self.deliver_share(&spec, &cancel);
                } else {
                    self.set_delivery(
                        media_db::JobDelivery::new("share", "skipped")
                            .detail("requires RecordForge Pro"),
                    );
                }
            }
        }
        if let Some(spec) = self.request.deliveries.youtube.clone() {
            if want_youtube {
                if cancel.load(Ordering::Relaxed) {
                    self.set_delivery(media_db::JobDelivery::new("youtube", "cancelled"));
                } else if pro {
                    self.deliver_youtube(&spec, &cancel);
                } else {
                    self.set_delivery(
                        media_db::JobDelivery::new("youtube", "skipped")
                            .detail("requires RecordForge Pro"),
                    );
                }
            }
        }
        // The delivery phase is over — the job's token no longer needs to
        // accept cancels (the export path also cleans up after us).
        if let Ok(mut tokens) = self.active_tokens.lock() {
            tokens.remove(&self.job_id);
        }
        Ok(())
    }

    /// Persist + broadcast one delivery record. The job stays `completed` —
    /// delivery state lives purely in `outputs.deliveries`.
    fn set_delivery(&self, delivery: media_db::JobDelivery) {
        let updated =
            self.db.lock().ok().and_then(|conn| {
                media_db::upsert_job_delivery(&conn, &self.job_id, &delivery).ok()
            });
        if let Some(job) = updated {
            let _ = EventPublisher::new(&self.app).media_job_update(&job);
        }
    }

    fn deliver_share(&self, spec: &ShareDeliveryRequest, cancel: &Arc<AtomicBool>) {
        use crate::publish::share;
        self.set_delivery(media_db::JobDelivery::new("share", "running").detail("uploading"));
        let output = PathBuf::from(&self.request.output_path);
        // Sidecar captions ride along when the render produced them.
        let captions_path = if self.request.plan.caption_mode == "sidecar" {
            let sidecar = output.with_extension("srt");
            sidecar.is_file().then_some(sidecar)
        } else {
            None
        };
        let password = spec
            .password_vault_key
            .as_ref()
            .and_then(|key| crate::storage::vault::get_secret(key).ok().flatten());
        let canvas = self.request.plan.canvas.clone();
        let input = share::ShareUploadInput {
            path: output,
            title: spec.title.clone(),
            duration_ms: self.request.plan.duration_ms,
            width: canvas.as_ref().map(|c| c.width).unwrap_or(1920),
            height: canvas.as_ref().map(|c| c.height).unwrap_or(1080),
            fps: canvas.as_ref().map(|c| c.fps).unwrap_or(30),
            chapters: self
                .request
                .plan
                .chapters
                .iter()
                .map(|chapter| share::ShareChapterArg {
                    t: chapter.start_ms,
                    label: chapter.title.clone(),
                })
                .collect(),
            allow_download: spec.allow_download,
            allow_embed: spec.allow_embed,
            captions_path,
            password,
            expires_in_days: spec.expires_in_days,
        };
        let (app, job_id) = (self.app.clone(), self.job_id.clone());
        let progress = move |event: share::ShareProgress| {
            let _ = app.emit(
                DELIVERY_PROGRESS_EVENT,
                DeliveryProgressEvent {
                    job_id: job_id.clone(),
                    kind: "share",
                    uploaded_bytes: event.uploaded_bytes,
                    total_bytes: event.bytes,
                },
            );
        };
        let result = if spec.target == "hosted" {
            match self.license.license_token() {
                Some(token) => tauri::async_runtime::block_on(share::upload_hosted(
                    &token,
                    &input,
                    cancel.clone(),
                    progress,
                )),
                None => Err(AppError::new(
                    ErrorCategory::Licensing,
                    "license_required",
                    "a Pro license is required to share",
                )),
            }
        } else {
            tauri::async_runtime::block_on(share::upload_to_profile(
                &self.storage,
                &spec.target,
                &input,
                cancel.clone(),
                progress,
            ))
        };
        match result {
            Ok(done) => {
                self.set_delivery(
                    media_db::JobDelivery::new("share", "done")
                        .url(done.url)
                        .detail("link ready"),
                );
                // The vault-held link password has served its purpose — the
                // share itself stores only the salted hash server-side.
                if let Some(key) = &spec.password_vault_key {
                    let _ = crate::storage::vault::delete_secret(key);
                }
            }
            Err(error) => {
                if cancel.load(Ordering::Relaxed) {
                    self.set_delivery(media_db::JobDelivery::new("share", "cancelled"));
                } else {
                    self.set_delivery(
                        media_db::JobDelivery::new("share", "failed").detail(error.message),
                    );
                }
            }
        }
    }

    fn deliver_youtube(&self, spec: &YouTubeDeliveryRequest, cancel: &Arc<AtomicBool>) {
        use crate::publish::youtube;
        self.set_delivery(media_db::JobDelivery::new("youtube", "running").detail("uploading"));
        let captions_path = if spec.attach_captions && self.request.plan.caption_mode == "sidecar" {
            let sidecar = Path::new(&self.request.output_path).with_extension("srt");
            sidecar
                .is_file()
                .then(|| sidecar.to_string_lossy().to_string())
        } else {
            None
        };
        let request = youtube::YouTubePublishRequest {
            path: self.request.output_path.clone(),
            title: spec.title.clone(),
            description: spec.description.clone(),
            privacy: spec.privacy.clone(),
            category_id: "28".to_string(),
            tags: spec.tags.clone(),
            captions_path,
            captions_language: spec.captions_language.clone(),
        };
        let app_data_dir = self.path_policy.app_data_dir().to_path_buf();
        let (app, job_id) = (self.app.clone(), self.job_id.clone());
        let progress = move |event: youtube::PublishProgress| {
            let _ = app.emit(
                DELIVERY_PROGRESS_EVENT,
                DeliveryProgressEvent {
                    job_id: job_id.clone(),
                    kind: "youtube",
                    uploaded_bytes: event.uploaded_bytes,
                    total_bytes: event.total_bytes,
                },
            );
        };
        let result = tauri::async_runtime::block_on(youtube::publish_video(
            &app_data_dir,
            &request,
            cancel.clone(),
            progress,
        ));
        match result {
            Ok((video_id, captions_attached)) => {
                self.set_delivery(
                    media_db::JobDelivery::new("youtube", "done")
                        .url(format!("https://www.youtube.com/watch?v={video_id}"))
                        .detail(if captions_attached {
                            "published with captions"
                        } else {
                            "published"
                        }),
                );
            }
            Err(error) => {
                if cancel.load(Ordering::Relaxed) {
                    self.set_delivery(media_db::JobDelivery::new("youtube", "cancelled"));
                } else {
                    self.set_delivery(
                        media_db::JobDelivery::new("youtube", "failed").detail(error.message),
                    );
                }
            }
        }
    }
}

#[derive(Debug)]
struct Worker {
    app: tauri::AppHandle,
    db: Arc<Mutex<rusqlite::Connection>>,
    ffmpeg_path: PathBuf,
    ffprobe_path: PathBuf,
    available_encoders: Vec<String>,
    active_tokens: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    worker_lock: Arc<Mutex<()>>,
    resource_gate: Arc<crate::state::CaptureWorkGate>,
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
        // Wait for any active capture/finalization to release the media gate
        // before marking the job running; a cancelled wait starts nothing.
        let _resource_permit = match self.resource_gate.wait_for_job(&cancel) {
            Ok(Some(permit)) => permit,
            Ok(None) => return self.finish_cancelled(),
            Err(error) => return self.fail(&error.to_string()),
        };

        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let mut job = media_db::start_job(&conn, &self.job_id)?;
        drop(conn);

        self.emit(&job)?;
        let prepare_started = Instant::now();

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

        // Derivative file formats evolve with PREPARE_OUTPUT_VERSION. Files
        // left by an older prepare are stale even when present on disk, so
        // thumbnails and waveforms regenerate once when the prior completed
        // prepare ran under an older version. Proxy/audio extraction formats
        // are unchanged and keep the cheaper existence check.
        let prior_prepare_version = self
            .with_db(|conn| {
                Ok(media_db::list_jobs(conn, &self.options.recording_id)?
                    .into_iter()
                    .filter(|job| {
                        job.kind == MediaJobKind::Prepare
                            && job.status == media_db::MediaJobStatus::Completed
                            && job.id != self.job_id
                    })
                    .map(|job| job.outputs.prepare_version)
                    .max()
                    .unwrap_or(0))
            })
            .unwrap_or(0);
        let regenerate_derivatives =
            self.options.force || prior_prepare_version < PREPARE_OUTPUT_VERSION;

        let metadata_path = derivative_dir(&work_dir, "metadata").join("metadata.json");
        let mut metadata: Option<media_db::MediaMetadata> = None;

        if !cancel.load(Ordering::Relaxed) {
            let stage_started = Instant::now();
            match self.extract_metadata(&input_path, &metadata_path, cancel.clone()) {
                Ok(m) => {
                    metadata = Some(m);
                    outputs.metadata_path = Some(metadata_path.to_string_lossy().to_string());
                }
                Err(e) => return self.fail(&format!("metadata extraction: {e}")),
            }
            info!(
                job_id = %self.job_id,
                stage = "metadata",
                elapsed_ms = stage_started.elapsed().as_millis() as u64,
                "prepare: stage finished"
            );
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
            self.options.include_proxy,
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

        // Stage: proxy generation (only when requested). The editor previews
        // the original by default and asks for the proxy on demand; an
        // already-generated proxy file is still reported in the outputs so
        // reduced quality modes can pick it up without re-transcoding.
        let proxy_path = derivative_dir(&work_dir, "proxy").join("proxy.mp4");
        if self.options.include_proxy && (self.options.force || !proxy_path.exists()) {
            self.set_progress(0.10, "proxy")?;
            if !cancel.load(Ordering::Relaxed) {
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

                // Reuse the startup encoder probe (shared with capture) so
                // proxies encode on the GPU when the machine has one.
                let proxy_encoder = crate::capture::encoder::select_best_encoder(
                    &self.available_encoders,
                    &crate::capture::config::default_encoder_priority(),
                );

                let stage_started = Instant::now();
                match generate_proxy(
                    &self.ffmpeg_path.to_string_lossy(),
                    &input_path,
                    &proxy_path,
                    &metadata,
                    self.options.proxy_height,
                    &proxy_encoder,
                    cancel_for_proxy,
                    progress,
                ) {
                    Ok(_) => {
                        outputs.proxy_path = Some(proxy_path.to_string_lossy().to_string());
                    }
                    Err(e) => return self.fail(&format!("proxy: {e}")),
                }
                info!(
                    job_id = %self.job_id,
                    stage = "proxy",
                    elapsed_ms = stage_started.elapsed().as_millis() as u64,
                    "prepare: stage finished"
                );
            }
        } else if proxy_path.exists() {
            outputs.proxy_path = Some(proxy_path.to_string_lossy().to_string());
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
            let stage_started = Instant::now();
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
            info!(
                job_id = %self.job_id,
                stage = "camera_track",
                elapsed_ms = stage_started.elapsed().as_millis() as u64,
                "prepare: stage finished"
            );
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
                    let stage_started = Instant::now();
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
                    info!(
                        job_id = %self.job_id,
                        stage = "camera_track",
                        stream_index = stream.index,
                        elapsed_ms = stage_started.elapsed().as_millis() as u64,
                        "prepare: stage finished"
                    );
                }
            }
        }

        // Stage: thumbnail sprite.
        self.set_progress(0.50, "thumbnails")?;
        let thumbnail_dir = derivative_dir(&work_dir, "thumbnails");
        let thumbnail_sprite_path = thumbnail_dir.join("sprite.jpg");
        let thumbnail_manifest_path = thumbnail_dir.join("thumbnails.json");
        let thumbnails_started = Instant::now();
        if !cancel.load(Ordering::Relaxed) {
            if regenerate_derivatives
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
            info!(
                job_id = %self.job_id,
                stage = "thumbnails",
                elapsed_ms = thumbnails_started.elapsed().as_millis() as u64,
                "prepare: stage finished"
            );
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
                let audio_path = audio_dir.join(format!("stream_{:03}.wav", stream.index));
                if self.options.force || !audio_path.is_file() {
                    let stage_started = Instant::now();
                    if let Err(error) = extract_audio_track(
                        &self.ffmpeg_path.to_string_lossy(),
                        &input_path,
                        stream.index,
                        &audio_path,
                        cancel.clone(),
                    ) {
                        return self.fail(&format!("audio track {}: {error}", stream.index));
                    }
                    info!(
                        job_id = %self.job_id,
                        stage = "audio_track",
                        stream_index = stream.index,
                        elapsed_ms = stage_started.elapsed().as_millis() as u64,
                        "prepare: stage finished"
                    );
                }

                let track_waveform_dir = waveform_dir.join(format!("stream_{:03}", stream.index));
                let waveform_json = track_waveform_dir.join("waveform.json");
                if regenerate_derivatives || !waveform_json.is_file() {
                    let stage_started = Instant::now();
                    let json = match generate_waveform_for_stream(
                        &self.ffmpeg_path.to_string_lossy(),
                        &input_path,
                        &track_waveform_dir,
                        stream.index,
                        &metadata,
                        cancel.clone(),
                    ) {
                        Ok(path) => path,
                        Err(error) => {
                            return self.fail(&format!("waveform stream {}: {error}", stream.index))
                        }
                    };
                    self.record_derivative(&json.to_string_lossy(), "waveform")?;
                    info!(
                        job_id = %self.job_id,
                        stage = "waveform",
                        stream_index = stream.index,
                        elapsed_ms = stage_started.elapsed().as_millis() as u64,
                        "prepare: stage finished"
                    );
                }

                self.record_derivative(&audio_path.to_string_lossy(), "audio")?;
                let output = MediaAudioTrackOutput {
                    stream_index: stream.index,
                    title,
                    audio_path: audio_path.to_string_lossy().to_string(),
                    waveform_path: waveform_json.to_string_lossy().to_string(),
                    waveform_image_path: None,
                };
                if outputs.audio_tracks.is_empty() {
                    outputs.waveform_path = Some(output.waveform_path.clone());
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

        info!(
            job_id = %self.job_id,
            prepare_ms = prepare_started.elapsed().as_millis() as u64,
            "prepare: finished"
        );
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

#[derive(Debug)]
struct AssetWorker {
    app: tauri::AppHandle,
    db: Arc<Mutex<rusqlite::Connection>>,
    ffmpeg_path: PathBuf,
    ffprobe_path: PathBuf,
    path_policy: PathPolicy,
    available_encoders: Vec<String>,
    active_tokens: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    worker_lock: Arc<Mutex<()>>,
    resource_gate: Arc<crate::state::CaptureWorkGate>,
    job_id: String,
    options: AssetDerivativeOptions,
}

impl AssetWorker {
    fn run(self, cancel: Arc<AtomicBool>) -> Result<()> {
        let result = self.run_inner(cancel);
        if let Err(error) = &result {
            let _ = self.fail(&error.to_string());
        }
        result
    }

    fn run_inner(&self, cancel: Arc<AtomicBool>) -> Result<()> {
        let _lock = self
            .worker_lock
            .lock()
            .map_err(|_| InternalError::Unknown("worker lock poisoned".into()))?;
        if cancel.load(Ordering::Relaxed) {
            return self.finish_cancelled();
        }
        // Wait for any active capture/finalization to release the media gate
        // before marking the job running; a cancelled wait starts nothing.
        let _resource_permit = match self.resource_gate.wait_for_job(&cancel) {
            Ok(Some(permit)) => permit,
            Ok(None) => return self.finish_cancelled(),
            Err(error) => return self.fail(&error.to_string()),
        };

        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let job = media_db::start_job(&conn, &self.job_id)?;
        drop(conn);
        self.emit(&job)?;

        let source = PathBuf::from(&self.options.source_path);
        if !source.is_file() {
            return self.fail("asset source is missing");
        }

        let recording = match self.with_db(|conn| get_recording(conn, &self.options.recording_id)) {
            Ok(recording) => recording,
            Err(error) => return self.fail(&format!("load recording: {error}")),
        };
        let work_dir = PathBuf::from(&recording.work_dir);
        let metadata = match self.probe_asset(&source) {
            Ok(metadata) => metadata,
            Err(error) => return self.fail(&format!("probe asset: {error}")),
        };

        self.set_progress(0.15, "derivatives")?;
        let asset_dir = work_dir
            .join("derivatives")
            .join("assets")
            .join(safe_asset_directory_name(&self.options.asset_id));
        std::fs::create_dir_all(&asset_dir).map_err(|error| {
            InternalError::Storage(format!("create asset derivative dir: {error}"))
        })?;

        let mut output_paths = Vec::new();
        match self.options.asset_kind.as_str() {
            "audio" => {
                if !metadata.has_audio {
                    return self.fail("asset has no audio stream");
                }
                let extension = source
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("bin");
                let preview_path = asset_dir.join(format!("audio-preview.{extension}"));
                if self.options.force || !preview_path.is_file() {
                    copy_audio_preview(&source, &preview_path)?;
                }
                output_paths.push(("audioPreview".to_string(), preview_path.clone()));
                self.record_derivative(&preview_path.to_string_lossy(), "audio")?;

                let waveform_dir = asset_dir.join("waveform");
                let waveform_json = waveform_dir.join("waveform.json");
                if self.options.force || !waveform_json.is_file() {
                    let json = crate::media::waveform::generate_waveform(
                        &self.ffmpeg_path.to_string_lossy(),
                        &source,
                        &waveform_dir,
                        &metadata,
                        cancel.clone(),
                    )?;
                    output_paths.push(("waveform".to_string(), json));
                } else {
                    output_paths.push(("waveform".to_string(), waveform_json));
                }
                self.set_progress(0.8, "waveform")?;
            }
            "image" => {
                let thumbnail_path = asset_dir.join("thumbnail.png");
                let generated = if self.options.force || !thumbnail_path.is_file() {
                    generate_image_thumbnail(
                        &self.ffmpeg_path.to_string_lossy(),
                        &source,
                        &thumbnail_path,
                        cancel.clone(),
                    )?
                } else {
                    thumbnail_path.clone()
                };
                if generated != source {
                    output_paths.push(("thumbnail".to_string(), generated.clone()));
                    self.record_derivative(&generated.to_string_lossy(), "thumbnail")?;
                }
                self.set_progress(0.8, "thumbnail")?;
            }
            "video" => {
                let proxy_path = asset_dir.join("proxy.mp4");
                if self.options.force || !proxy_path.is_file() {
                    let encoder = crate::capture::encoder::select_best_encoder(
                        &self.available_encoders,
                        &crate::capture::config::default_encoder_priority(),
                    );
                    generate_proxy(
                        &self.ffmpeg_path.to_string_lossy(),
                        &source,
                        &proxy_path,
                        &metadata,
                        540,
                        &encoder,
                        cancel.clone(),
                        |_| {},
                    )?;
                }
                output_paths.push(("proxy".to_string(), proxy_path.clone()));
                self.record_derivative(&proxy_path.to_string_lossy(), "proxy")?;

                let thumbnail_dir = asset_dir.join("thumbnails");
                let (sprite, manifest) = if self.options.force
                    || !thumbnail_dir.join("sprite.jpg").is_file()
                    || !thumbnail_dir.join("thumbnails.json").is_file()
                {
                    crate::media::thumbnails::generate_thumbnails(
                        &self.ffmpeg_path.to_string_lossy(),
                        &source,
                        &thumbnail_dir,
                        &metadata,
                        5,
                    )?
                } else {
                    (
                        thumbnail_dir.join("sprite.jpg"),
                        thumbnail_dir.join("thumbnails.json"),
                    )
                };
                output_paths.push(("thumbnail".to_string(), sprite.clone()));
                output_paths.push(("thumbnailManifest".to_string(), manifest.clone()));
                self.record_derivative(&sprite.to_string_lossy(), "thumbnail")?;
                self.record_derivative(&manifest.to_string_lossy(), "thumbnail")?;
                self.set_progress(0.8, "video thumbnails")?;
            }
            _ => return self.fail("asset kind does not support derivatives"),
        }

        if cancel.load(Ordering::Relaxed) {
            return self.finish_cancelled();
        }

        let derivatives = normalize_derivative_paths(&work_dir, output_paths);
        self.persist_asset_derivatives(&work_dir, &derivatives)?;
        self.set_progress(0.95, "finalizing")?;

        let outputs = MediaJobOutputs {
            asset_id: Some(self.options.asset_id.clone()),
            derivatives: derivatives.clone(),
            ..Default::default()
        };
        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let completed = media_db::complete_job(&conn, &self.job_id, &outputs)?;
        drop(conn);
        self.cleanup_active_token();
        self.emit(&completed)?;
        Ok(())
    }

    fn probe_asset(&self, source: &Path) -> Result<media_db::MediaMetadata> {
        if self.options.asset_kind == "image" {
            if crate::media::svg::is_svg_path(source) {
                crate::media::svg::read_safe_svg(source)?;
                return Ok(static_image_metadata(&self.options.recording_id, source));
            }
            return crate::media::probe::probe_media(
                &self.ffprobe_path.to_string_lossy(),
                source,
                &self.options.recording_id,
            )
            .or_else(|_| Ok(static_image_metadata(&self.options.recording_id, source)));
        }

        crate::media::probe::probe_media(
            &self.ffprobe_path.to_string_lossy(),
            source,
            &self.options.recording_id,
        )
    }

    fn persist_asset_derivatives(
        &self,
        project_dir: &Path,
        derivatives: &HashMap<String, String>,
    ) -> Result<()> {
        let loaded =
            crate::projects::load_project(project_dir, &self.path_policy)?.ok_or_else(|| {
                InternalError::Project("project file is required for asset derivatives".into())
            })?;
        let mut project = loaded.project;
        let asset = project
            .assets
            .iter_mut()
            .find(|asset| asset.id == self.options.asset_id)
            .ok_or_else(|| {
                InternalError::Project("asset was removed before derivatives completed".into())
            })?;
        asset.derivatives = Some(derivatives.clone());
        let saved = crate::projects::save_project(&project, project_dir)?;

        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        crate::database::projects::upsert_project(
            &conn,
            &crate::database::projects::ProjectRecord {
                id: saved.id.clone(),
                name: saved.name.clone(),
                recording_id: saved.recording_id.clone(),
                created_at: saved.created_at.clone(),
                updated_at: saved.updated_at.clone(),
                project_json: serde_json::to_string(&saved).map_err(|error| {
                    InternalError::Storage(format!("serialize asset project: {error}"))
                })?,
            },
        )?;
        Ok(())
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
        error!(job_id = %self.job_id, %message, "asset derivative failed");
        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let job = media_db::fail_job(&conn, &self.job_id, message)?;
        drop(conn);
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
        self.cleanup_active_token();
        self.emit(&job)
    }

    fn cleanup_active_token(&self) {
        if let Ok(mut tokens) = self.active_tokens.lock() {
            tokens.remove(&self.job_id);
        }
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
        let size = std::fs::metadata(path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
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

fn static_image_metadata(recording_id: &str, source: &Path) -> media_db::MediaMetadata {
    media_db::MediaMetadata {
        recording_id: recording_id.into(),
        path: source.to_string_lossy().into_owned(),
        duration_ms: 0,
        width: None,
        height: None,
        fps: None,
        has_audio: false,
        video_codec: None,
        audio_codec: None,
        bitrate_kbps: None,
        streams: Vec::new(),
        format: MediaFormat {
            name: source
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("image")
                .to_ascii_lowercase(),
            duration_ms: Some(0),
            size_bytes: std::fs::metadata(source)
                .ok()
                .map(|metadata| metadata.len()),
            bitrate_kbps: None,
        },
        updated_at: chrono::Utc::now().to_rfc3339(),
    }
}

fn safe_asset_directory_name(asset_id: &str) -> String {
    let value: String = asset_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(96)
        .collect();
    if value.is_empty() {
        "asset".into()
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::media::{MediaJob, MediaJobKind, MediaJobOutputs, MediaJobStatus};

    fn export_job(id: &str, status: MediaJobStatus, output_path: &str) -> MediaJob {
        MediaJob {
            id: id.into(),
            recording_id: "rec-1".into(),
            kind: MediaJobKind::Export,
            status,
            progress: 0.0,
            stage: "rendering".into(),
            message: None,
            error: None,
            created_at: String::new(),
            updated_at: String::new(),
            started_at: None,
            completed_at: None,
            outputs: MediaJobOutputs::default(),
            options: serde_json::json!({
                "projectId": "proj-1",
                "outputPath": output_path,
                "plan": {},
                "settings": {}
            }),
            attempts: 0,
        }
    }

    #[test]
    fn export_dedupe_is_scoped_to_the_output_path() {
        let jobs = vec![
            export_job("job-16x9", MediaJobStatus::Running, "/out/rec.mp4"),
            export_job("job-9x16", MediaJobStatus::Pending, "/out/rec-vertical.mp4"),
            export_job("job-done", MediaJobStatus::Completed, "/out/rec-square.mp4"),
        ];

        // Same destination while its job is in flight → dedupe to that job.
        let found = active_export_for_output(&jobs, None, "/out/rec-vertical.mp4");
        assert_eq!(found.map(|job| job.id.as_str()), Some("job-9x16"));
        let found = active_export_for_output(&jobs, None, "/out/rec.mp4");
        assert_eq!(found.map(|job| job.id.as_str()), Some("job-16x9"));

        // A different destination is a distinct export, never deduped away.
        assert!(active_export_for_output(&jobs, None, "/out/rec-4x5.mp4").is_none());
        // Finished jobs never block a re-export to their destination.
        assert!(active_export_for_output(&jobs, None, "/out/rec-square.mp4").is_none());
        // Retry excludes the job being retried from its own dedupe lookup.
        assert!(
            active_export_for_output(&jobs, Some("job-9x16"), "/out/rec-vertical.mp4").is_none()
        );
    }
}
