use tauri::State;
use tracing::instrument;

use crate::database::media::{MediaJob, MediaMetadata};
use crate::errors::{InternalError, Result};
use crate::jobs::PrepareOptions;
use crate::media::disk::{available_space, estimate_derivative_size};
use crate::state::AppState;

/// Options for starting a media preparation job.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartMediaJobOptions {
    pub recording_id: String,
    pub proxy_height: Option<i32>,
    pub thumbnail_interval_sec: Option<u64>,
    pub force: Option<bool>,
}

/// Start a prepare job for a recording.
#[tauri::command]
#[instrument]
pub fn prepare_media(
    options: StartMediaJobOptions,
    state: State<'_, AppState>,
) -> Result<MediaJob> {
    let _update_operation = state.update_gate.acquire_operation()?;
    let manager = state
        .job_manager
        .lock()
        .map_err(|_| InternalError::Unknown("job manager mutex poisoned".into()))?;

    let job_id = manager.start_prepare(PrepareOptions {
        recording_id: options.recording_id,
        proxy_height: options.proxy_height.unwrap_or(540),
        thumbnail_interval_sec: options.thumbnail_interval_sec.unwrap_or(5),
        force: options.force.unwrap_or(false),
    })?;

    manager.get_job(&job_id)
}

/// Cancel a media job.
#[tauri::command]
#[instrument]
pub fn cancel_media_job(job_id: String, state: State<'_, AppState>) -> Result<()> {
    let manager = state
        .job_manager
        .lock()
        .map_err(|_| InternalError::Unknown("job manager mutex poisoned".into()))?;
    manager.cancel_job(&job_id)
}

/// Get a media job.
#[tauri::command]
#[instrument]
pub fn get_media_job(job_id: String, state: State<'_, AppState>) -> Result<MediaJob> {
    let manager = state
        .job_manager
        .lock()
        .map_err(|_| InternalError::Unknown("job manager mutex poisoned".into()))?;
    manager.get_job(&job_id)
}

/// List media jobs for a recording.
#[tauri::command]
#[instrument]
pub fn list_media_jobs(recording_id: String, state: State<'_, AppState>) -> Result<Vec<MediaJob>> {
    let manager = state
        .job_manager
        .lock()
        .map_err(|_| InternalError::Unknown("job manager mutex poisoned".into()))?;
    manager.list_jobs(&recording_id)
}

/// Delete derivative files and their database rows for a recording.
#[tauri::command]
#[instrument]
pub fn delete_derivatives(recording_id: String, state: State<'_, AppState>) -> Result<()> {
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    crate::database::media::delete_derivatives_for_recording(&db, &recording_id, true)
}

/// Read cached media metadata for a recording.
#[tauri::command]
#[instrument]
pub fn get_media_metadata(
    recording_id: String,
    state: State<'_, AppState>,
) -> Result<Option<MediaMetadata>> {
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    crate::database::media::get_metadata(&db, &recording_id)
}

/// Estimate disk space needed for a prepare job.
#[tauri::command]
#[instrument]
pub fn estimate_prepare_disk_space(
    recording_id: String,
    proxy_height: Option<i32>,
    thumbnail_interval_sec: Option<u64>,
    state: State<'_, AppState>,
) -> Result<DiskSpaceEstimate> {
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;

    let recording = crate::database::library::get_recording(&db, &recording_id)?;
    let output_path = recording
        .output_path
        .as_ref()
        .ok_or_else(|| InternalError::Media("recording has no output path".into()))?;

    let metadata = match crate::database::media::get_metadata(&db, &recording_id)? {
        Some(m) => m,
        None => crate::media::probe::probe_media(
            &state.ffprobe_path.to_string_lossy(),
            std::path::Path::new(output_path),
            &recording_id,
        )?,
    };

    drop(db);

    let proxy_height = proxy_height.unwrap_or(540);
    let thumbnail_interval_sec = thumbnail_interval_sec.unwrap_or(5);
    let required = estimate_derivative_size(&metadata, proxy_height, thumbnail_interval_sec);
    let available = available_space(std::path::Path::new(output_path))?;

    Ok(DiskSpaceEstimate {
        bytes_required: required,
        bytes_available: available,
        bytes_free_after: available.saturating_sub(required),
        safe: available > required,
    })
}

/// Disk space estimate returned to the UI.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskSpaceEstimate {
    pub bytes_required: u64,
    pub bytes_available: u64,
    pub bytes_free_after: u64,
    pub safe: bool,
}
