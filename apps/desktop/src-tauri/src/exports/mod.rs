use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::{error, info, instrument};

use crate::capture::media;
use crate::database::library::get_recording;
use crate::database::media::MediaJob;
use crate::errors::{InternalError, Result};
use crate::events::EventPublisher;

/// A single trimmed segment in the final export.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSegment {
    pub asset_id: Option<String>,
    pub source_in_ms: u64,
    pub source_out_ms: u64,
    pub output_start_ms: u64,
    pub output_end_ms: u64,
}

/// Render plan sent from the TypeScript timeline editor.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPlan {
    pub duration_ms: u64,
    pub segments: Vec<RenderSegment>,
}

/// Run a render plan in a background thread, trimming and concatenating segments.
#[instrument(skip(ffmpeg_path, db, plan, app))]
pub fn run_render_plan(
    recording_id: String,
    output_path: &Path,
    plan: RenderPlan,
    ffmpeg_path: &std::path::Path,
    db: Arc<Mutex<rusqlite::Connection>>,
    app: &tauri::AppHandle,
) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let job = MediaJob {
        id: uuid::Uuid::new_v4().to_string(),
        recording_id: recording_id.clone(),
        kind: crate::database::media::MediaJobKind::Export,
        status: crate::database::media::MediaJobStatus::Running,
        progress: 0.0,
        stage: "preparing".into(),
        message: Some("building segments".into()),
        error: None,
        created_at: now.clone(),
        updated_at: now.clone(),
        started_at: Some(now),
        completed_at: None,
        outputs: Default::default(),
    };

    emit_job_update(app, &job)?;

    let conn = db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    let recording = get_recording(&conn, &recording_id)?;
    drop(conn);

    let source_path = recording
        .output_path
        .as_ref()
        .ok_or_else(|| InternalError::Media("recording has no output path".into()))?;
    let work_dir = PathBuf::from(&recording.work_dir);

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| InternalError::Storage(format!("create export dir: {e}")))?;
    }

    info!(recording_id = %recording_id, ?output_path, "starting timeline export");

    let total = plan.segments.len();
    let mut segment_paths: Vec<PathBuf> = Vec::new();

    for (index, segment) in plan.segments.iter().enumerate() {
        let progress = if total > 0 {
            (index as f64 / total as f64) * 0.8
        } else {
            0.0
        };
        emit_progress(
            app,
            &job,
            progress,
            "trimming",
            Some(&format!("segment {}/{}", index + 1, total)),
        )?;

        let temp_path = work_dir.join(format!("export_seg_{}_{}.mp4", index, &job.id[..8]));
        media::trim_recording(
            &ffmpeg_path.to_string_lossy(),
            Path::new(source_path),
            &temp_path,
            segment.source_in_ms,
            segment.source_out_ms,
        )?;
        segment_paths.push(temp_path);
    }

    emit_progress(app, &job, 0.9, "concatenating", Some("stitching segments"))?;

    media::concatenate_segments(
        &ffmpeg_path.to_string_lossy(),
        &work_dir,
        &segment_paths,
        output_path,
    )?;

    // Clean up temporary trimmed segments.
    for path in &segment_paths {
        if let Err(err) = std::fs::remove_file(path) {
            error!(?path, %err, "failed to remove temporary export segment");
        }
    }

    let completed = MediaJob {
        status: crate::database::media::MediaJobStatus::Completed,
        progress: 1.0,
        stage: "completed".into(),
        message: Some("export finished".into()),
        completed_at: Some(chrono::Utc::now().to_rfc3339()),
        outputs: crate::database::media::MediaJobOutputs {
            output_path: Some(output_path.to_string_lossy().to_string()),
            ..Default::default()
        },
        ..job
    };

    emit_job_update(app, &completed)?;
    info!(recording_id = %recording_id, "timeline export completed");

    Ok(())
}

fn emit_job_update(app: &tauri::AppHandle, job: &MediaJob) -> Result<()> {
    // Avoid emitting on a very tight loop by yielding briefly.
    std::thread::sleep(Duration::from_millis(1));
    EventPublisher::new(app).media_job_update(job)
}

fn emit_progress(
    app: &tauri::AppHandle,
    job: &MediaJob,
    progress: f64,
    stage: &str,
    message: Option<&str>,
) -> Result<()> {
    let updated = MediaJob {
        progress,
        stage: stage.into(),
        message: message.map(|s| s.into()),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..job.clone()
    };
    emit_job_update(app, &updated)
}
