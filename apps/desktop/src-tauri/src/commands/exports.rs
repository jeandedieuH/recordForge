use std::path::Path;
use tauri::{Manager, State};
use tracing::instrument;

use crate::database::media::MediaJob;
use crate::errors::{InternalError, Result};
use crate::exports::{ExportSettings, RenderPlan};
use crate::jobs::ExportRequest;
use crate::state::AppState;

/// Export input contains a project identity and an explicit destination. Rust
/// resolves every source asset from the saved project before starting FFmpeg.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTimelineOptions {
    pub project_id: String,
    pub output_path: String,
    pub plan: RenderPlan,
    pub settings: ExportSettings,
}

/// Start one durable export job. The manager persists the request before the
/// worker thread starts, so the returned job id is authoritative end-to-end.
#[tauri::command]
#[instrument(skip(options))]
pub fn export_timeline(
    options: ExportTimelineOptions,
    state: State<'_, AppState>,
) -> Result<MediaJob> {
    let _update_operation = state.update_gate.acquire_operation()?;
    if options.project_id.trim().is_empty() {
        return Err(InternalError::Project("project id is required for export".into()).into());
    }
    if options.plan.project_id != options.project_id {
        return Err(InternalError::Project(
            "render plan project does not match export project".into(),
        )
        .into());
    }
    let manager = state
        .job_manager
        .lock()
        .map_err(|_| InternalError::Unknown("job manager mutex poisoned".into()))?;
    manager.start_export(ExportRequest {
        project_id: options.project_id,
        output_path: options.output_path,
        plan: options.plan,
        settings: options.settings,
    })
}

/// Retry a failed/cancelled export with the persisted request and job identity.
#[tauri::command]
#[instrument]
pub fn retry_export(job_id: String, state: State<'_, AppState>) -> Result<MediaJob> {
    let _update_operation = state.update_gate.acquire_operation()?;
    let manager = state
        .job_manager
        .lock()
        .map_err(|_| InternalError::Unknown("job manager mutex poisoned".into()))?;
    manager.retry_export(&job_id)
}

/// Reveal a completed export without allowing the UI to provide an arbitrary path.
#[tauri::command]
#[instrument(skip(state))]
pub fn reveal_export(job_id: String, state: State<'_, AppState>) -> Result<()> {
    let manager = state
        .job_manager
        .lock()
        .map_err(|_| InternalError::Unknown("job manager mutex poisoned".into()))?;
    let job = manager.get_job(&job_id)?;
    let path = job
        .outputs
        .output_path
        .ok_or_else(|| InternalError::Media("export has no published output".into()))?;
    let validated = state
        .path_policy
        .validate_export_destination(Path::new(&path))?;
    if !validated.is_file() {
        return Err(InternalError::Storage("published export is missing".into()).into());
    }

    #[cfg(windows)]
    {
        let validated_str = validated.to_string_lossy();
        crate::process::create_command("explorer")
            .args(["/select,", validated_str.as_ref()])
            .spawn()
            .map_err(|error| InternalError::Media(format!("reveal export: {error}")))?;
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = validated;
        Err(InternalError::Media("reveal is only implemented on Windows".into()).into())
    }
}

/// Flash taskbar or request dock attention when an export finishes in the background.
#[tauri::command]
#[instrument(skip(app))]
pub fn request_export_attention(app: tauri::AppHandle) -> Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
    Ok(())
}

