//! Storage Upload Job Manager
//!
//! Orchestrates background upload workers for S3, Google Drive, and local targets.
//! Emits real-time progress events to the React UI and persists job history in SQLite.

use chrono::Utc;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tracing::{info, warn};

use crate::database::storage::{
    get_profile_by_id, get_upload_job, update_upload_job_progress, update_upload_job_status,
    StorageProfile, UploadJob,
};
use crate::errors::{InternalError, Result};
use crate::path_policy::PathPolicy;
use crate::storage::drive::GoogleDriveClient;
use crate::storage::local::LocalFolderClient;
use crate::storage::s3::S3Client;
use crate::storage::vault;

pub const EVENT_UPLOAD_JOB_UPDATE: &str = "upload-job-update";

#[derive(Debug, Clone)]
pub struct StorageManager {
    app: tauri::AppHandle,
    db: Arc<Mutex<rusqlite::Connection>>,
    path_policy: PathPolicy,
    active_tokens: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl StorageManager {
    pub fn new(
        app: tauri::AppHandle,
        db: Arc<Mutex<rusqlite::Connection>>,
        path_policy: PathPolicy,
    ) -> Self {
        Self {
            app,
            db,
            path_policy,
            active_tokens: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn start_upload(
        &self,
        profile_id: &str,
        recording_id: Option<String>,
        export_id: Option<String>,
        local_path: &str,
        custom_destination_name: Option<String>,
    ) -> Result<UploadJob> {
        let path = Path::new(local_path);
        let validated_path = self
            .path_policy
            .validate_recording_path(path)
            .or_else(|_| self.path_policy.validate_export_destination(path))
            .or_else(|_| self.path_policy.validate_external_asset_path(path))
            .map_err(|e| InternalError::Storage(format!("unauthorized file path: {e}")))?;

        if !validated_path.is_file() {
            return Err(InternalError::Storage(format!("file not found at {}", local_path)).into());
        }

        let file_len = validated_path
            .metadata()
            .map_err(|e| InternalError::Storage(format!("failed to get metadata: {e}")))?
            .len();

        let file_name = match custom_destination_name {
            Some(name) if !name.trim().is_empty() => name,
            _ => path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("export.mp4")
                .to_string(),
        };

        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("db mutex poisoned".into()))?;

        let profile = get_profile_by_id(&conn, profile_id)?
            .ok_or_else(|| InternalError::Storage(format!("profile {} not found", profile_id)))?;

        let job_id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        let initial_job = UploadJob {
            id: job_id.clone(),
            provider_profile_id: profile.id.clone(),
            provider_profile_name: Some(profile.name.clone()),
            provider_kind: profile.kind.clone(),
            recording_id,
            export_id,
            local_path: local_path.to_string(),
            remote_path: file_name.clone(),
            state: "uploading".to_string(),
            bytes_uploaded: 0,
            total_bytes: file_len,
            speed_bps: 0,
            remote_url: None,
            retry_count: 0,
            last_error: None,
            created_at: now.clone(),
            updated_at: now,
            completed_at: None,
        };

        crate::database::storage::insert_upload_job(&conn, &initial_job)?;
        drop(conn);

        let cancel_token = Arc::new(AtomicBool::new(false));
        if let Ok(mut tokens) = self.active_tokens.lock() {
            tokens.insert(job_id.clone(), cancel_token.clone());
        }

        // Emit initial status
        let _ = self.app.emit(EVENT_UPLOAD_JOB_UPDATE, &initial_job);

        // Spawn background task
        let app_clone = self.app.clone();
        let db_clone = self.db.clone();
        let active_tokens_clone = self.active_tokens.clone();
        let path_buf = path.to_path_buf();
        let profile_clone = profile.clone();
        let job_id_clone = job_id.clone();

        tauri::async_runtime::spawn(async move {
            let result = Self::run_upload_worker(
                app_clone.clone(),
                db_clone.clone(),
                profile_clone,
                job_id_clone.clone(),
                path_buf,
                file_name,
                file_len,
                cancel_token.clone(),
            )
            .await;

            if let Ok(mut tokens) = active_tokens_clone.lock() {
                tokens.remove(&job_id_clone);
            }

            match result {
                Ok(remote_url) => {
                    info!(job_id = %job_id_clone, url = %remote_url, "upload worker finished successfully");
                    let now = Utc::now().to_rfc3339();
                    if let Ok(conn) = db_clone.lock() {
                        let _ = update_upload_job_status(
                            &conn,
                            &job_id_clone,
                            "completed",
                            Some(&remote_url),
                            None,
                            Some(&now),
                        );
                        if let Ok(Some(job)) = get_upload_job(&conn, &job_id_clone) {
                            let _ = app_clone.emit(EVENT_UPLOAD_JOB_UPDATE, &job);
                        }
                    }
                }
                Err(err) => {
                    let err_msg = err.to_string();
                    let is_cancel = cancel_token.load(Ordering::Relaxed);
                    let final_state = if is_cancel { "cancelled" } else { "failed" };
                    warn!(job_id = %job_id_clone, error = %err_msg, state = final_state, "upload worker terminated");

                    let now = Utc::now().to_rfc3339();
                    if let Ok(conn) = db_clone.lock() {
                        let _ = update_upload_job_status(
                            &conn,
                            &job_id_clone,
                            final_state,
                            None,
                            Some(&err_msg),
                            Some(&now),
                        );
                        if let Ok(Some(job)) = get_upload_job(&conn, &job_id_clone) {
                            let _ = app_clone.emit(EVENT_UPLOAD_JOB_UPDATE, &job);
                        }
                    }
                }
            }
        });

        Ok(initial_job)
    }

    pub fn cancel_upload(&self, job_id: &str) -> Result<()> {
        if let Ok(tokens) = self.active_tokens.lock() {
            if let Some(token) = tokens.get(job_id) {
                token.store(true, Ordering::Relaxed);
            }
        }

        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("db mutex poisoned".into()))?;

        let now = Utc::now().to_rfc3339();
        update_upload_job_status(
            &conn,
            job_id,
            "cancelled",
            None,
            Some("Cancelled by user"),
            Some(&now),
        )?;

        if let Ok(Some(job)) = get_upload_job(&conn, job_id) {
            let _ = self.app.emit(EVENT_UPLOAD_JOB_UPDATE, &job);
        }

        Ok(())
    }

    pub fn retry_upload(&self, job_id: &str) -> Result<UploadJob> {
        let conn = self
            .db
            .lock()
            .map_err(|_| InternalError::Storage("db mutex poisoned".into()))?;

        let existing = get_upload_job(&conn, job_id)?
            .ok_or_else(|| InternalError::Storage(format!("job {} not found", job_id)))?;

        drop(conn);

        self.start_upload(
            &existing.provider_profile_id,
            existing.recording_id,
            existing.export_id,
            &existing.local_path,
            Some(existing.remote_path),
        )
    }

    async fn run_upload_worker(
        app: tauri::AppHandle,
        db: Arc<Mutex<rusqlite::Connection>>,
        profile: StorageProfile,
        job_id: String,
        local_path: PathBuf,
        remote_name: String,
        _total_bytes: u64,
        cancel_token: Arc<AtomicBool>,
    ) -> Result<String> {
        let start_time = Instant::now();
        let last_emit = Arc::new(Mutex::new(Instant::now()));

        let app_emit = app.clone();
        let db_update = db.clone();
        let job_id_update = job_id.clone();
        let last_emit_clone = last_emit.clone();

        let progress_callback = move |uploaded: u64, total: u64| {
            let elapsed_sec = start_time.elapsed().as_secs_f64();
            let speed_bps = if elapsed_sec > 0.1 {
                (uploaded as f64 / elapsed_sec) as u64
            } else {
                0
            };

            let should_emit = {
                if let Ok(mut last) = last_emit_clone.lock() {
                    if last.elapsed() >= Duration::from_millis(250) || uploaded == total {
                        *last = Instant::now();
                        true
                    } else {
                        false
                    }
                } else {
                    false
                }
            };

            if should_emit {
                if let Ok(conn) = db_update.lock() {
                    let _ = update_upload_job_progress(
                        &conn,
                        &job_id_update,
                        uploaded,
                        total,
                        speed_bps,
                    );
                    if let Ok(Some(job)) = get_upload_job(&conn, &job_id_update) {
                        let _ = app_emit.emit(EVENT_UPLOAD_JOB_UPDATE, &job);
                    }
                }
            }
        };

        match profile.kind.as_str() {
            "s3" => {
                let s3_config = profile.s3_config.ok_or_else(|| {
                    InternalError::Storage("S3 configuration missing for profile".into())
                })?;
                let access_key = vault::get_secret(&format!("{}:access_key", profile.id))?
                    .ok_or_else(|| {
                        InternalError::Storage("S3 Access Key ID missing from vault".into())
                    })?;
                let secret_key = vault::get_secret(&format!("{}:secret_key", profile.id))?
                    .ok_or_else(|| {
                        InternalError::Storage("S3 Secret Access Key missing from vault".into())
                    })?;

                let client = S3Client::new(s3_config, access_key, secret_key);
                client
                    .upload_file(&local_path, &remote_name, progress_callback, &cancel_token)
                    .await
            }
            "gdrive" => {
                let drive_config = profile.drive_config.ok_or_else(|| {
                    InternalError::Storage("Google Drive configuration missing for profile".into())
                })?;
                let refresh_token = vault::get_secret(&format!("{}:refresh_token", profile.id))?
                    .ok_or_else(|| {
                        InternalError::Storage(
                            "Google Drive refresh token missing from vault".into(),
                        )
                    })?;

                let client = GoogleDriveClient::new(drive_config, refresh_token);
                client
                    .upload_file(&local_path, &remote_name, progress_callback, &cancel_token)
                    .await
            }
            "local" => {
                let local_config = profile.local_config.ok_or_else(|| {
                    InternalError::Storage("Local folder configuration missing for profile".into())
                })?;
                let client = LocalFolderClient::new(local_config);
                client.upload_file(&local_path, &remote_name, progress_callback, &cancel_token)
            }
            other => Err(InternalError::Storage(format!("unknown provider kind: {other}")).into()),
        }
    }
}
