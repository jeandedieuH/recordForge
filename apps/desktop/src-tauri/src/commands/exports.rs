use std::sync::Arc;
use std::thread;
use tauri::State;
use tracing::instrument;

use crate::database::media::MediaJob;
use crate::errors::Result;
use crate::events::EventPublisher;
use crate::exports::{run_render_plan, RenderPlan};
use crate::state::AppState;

/// Options for exporting a timeline to a final MP4.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTimelineOptions {
    pub recording_id: String,
    pub output_path: String,
    pub plan: RenderPlan,
}

/// Start an export job for the current timeline.
#[tauri::command]
#[instrument]
pub fn export_timeline(
    options: ExportTimelineOptions,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<MediaJob> {
    let recording_id = options.recording_id.clone();
    let plan = options.plan;

    let now = chrono::Utc::now().to_rfc3339();
    let job = MediaJob {
        id: uuid::Uuid::new_v4().to_string(),
        recording_id: recording_id.clone(),
        kind: crate::database::media::MediaJobKind::Export,
        status: crate::database::media::MediaJobStatus::Running,
        progress: 0.0,
        stage: "queued".into(),
        message: Some("starting export".into()),
        error: None,
        created_at: now.clone(),
        updated_at: now.clone(),
        started_at: Some(now),
        completed_at: None,
        outputs: Default::default(),
    };

    // Emit the initial job state before spawning so the UI can show progress
    // immediately and the command can return a job handle.
    EventPublisher::new(&app).media_job_update(&job)?;

    let ffmpeg_path = state.ffmpeg_path.clone();
    let db = Arc::clone(&state.db);
    let app_handle = app.clone();
    let thread_job = job.clone();

    let output_path = std::path::PathBuf::from(options.output_path);

    thread::spawn(move || {
        if let Err(err) = run_render_plan(
            recording_id,
            &output_path,
            plan,
            &ffmpeg_path,
            db,
            &app_handle,
        ) {
            let _ = emit_failed(&app_handle, &thread_job, &err.to_string());
        }
    });

    Ok(job)
}

fn emit_failed(app: &tauri::AppHandle, job: &MediaJob, message: &str) -> Result<()> {
    let failed = MediaJob {
        status: crate::database::media::MediaJobStatus::Failed,
        stage: "failed".into(),
        message: Some(message.into()),
        error: Some(message.into()),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..job.clone()
    };
    EventPublisher::new(app).media_job_update(&failed)
}
