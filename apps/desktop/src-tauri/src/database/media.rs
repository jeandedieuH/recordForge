use chrono::Utc;
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::errors::{InternalError, Result};

/// Media job status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaJobStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl MediaJobStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            MediaJobStatus::Pending => "pending",
            MediaJobStatus::Running => "running",
            MediaJobStatus::Completed => "completed",
            MediaJobStatus::Failed => "failed",
            MediaJobStatus::Cancelled => "cancelled",
        }
    }
}

impl std::str::FromStr for MediaJobStatus {
    type Err = ();

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s {
            "pending" => Ok(MediaJobStatus::Pending),
            "running" => Ok(MediaJobStatus::Running),
            "completed" => Ok(MediaJobStatus::Completed),
            "failed" => Ok(MediaJobStatus::Failed),
            "cancelled" => Ok(MediaJobStatus::Cancelled),
            _ => Err(()),
        }
    }
}

/// Media job kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaJobKind {
    Metadata,
    Proxy,
    Thumbnail,
    Waveform,
    Prepare,
    #[serde(rename = "asset_derivative")]
    AssetDerivative,
    Export,
}

impl MediaJobKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            MediaJobKind::Metadata => "metadata",
            MediaJobKind::Proxy => "proxy",
            MediaJobKind::Thumbnail => "thumbnail",
            MediaJobKind::Waveform => "waveform",
            MediaJobKind::Prepare => "prepare",
            MediaJobKind::AssetDerivative => "asset_derivative",
            MediaJobKind::Export => "export",
        }
    }
}

impl std::str::FromStr for MediaJobKind {
    type Err = ();

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s {
            "metadata" => Ok(MediaJobKind::Metadata),
            "proxy" => Ok(MediaJobKind::Proxy),
            "thumbnail" => Ok(MediaJobKind::Thumbnail),
            "waveform" => Ok(MediaJobKind::Waveform),
            "prepare" => Ok(MediaJobKind::Prepare),
            "asset_derivative" => Ok(MediaJobKind::AssetDerivative),
            "export" => Ok(MediaJobKind::Export),
            _ => Err(()),
        }
    }
}

/// One independently playable audio stream and its waveform assets.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAudioTrackOutput {
    pub stream_index: i32,
    pub title: String,
    pub audio_path: String,
    pub waveform_path: String,
    pub waveform_image_path: String,
}

/// One independently playable secondary video stream for camera preview.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaVideoTrackOutput {
    pub stream_index: i32,
    pub title: String,
    pub video_path: String,
    #[serde(default)]
    pub width: Option<i32>,
    #[serde(default)]
    pub height: Option<i32>,
    #[serde(default)]
    pub thumbnail_dir: Option<String>,
    #[serde(default)]
    pub thumbnail_manifest_path: Option<String>,
}

/// Output files produced by a media job.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaJobOutputs {
    #[serde(default)]
    pub prepare_version: u32,
    #[serde(default)]
    pub asset_id: Option<String>,
    #[serde(default)]
    pub derivatives: HashMap<String, String>,
    pub metadata_path: Option<String>,
    pub proxy_path: Option<String>,
    pub thumbnail_dir: Option<String>,
    pub thumbnail_manifest_path: Option<String>,
    pub waveform_path: Option<String>,
    pub waveform_image_path: Option<String>,
    #[serde(default)]
    pub audio_tracks: Vec<MediaAudioTrackOutput>,
    #[serde(default)]
    pub video_tracks: Vec<MediaVideoTrackOutput>,
    pub output_path: Option<String>,
    pub captions_path: Option<String>,
}

/// Media job record persisted in SQLite.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaJob {
    pub id: String,
    pub recording_id: String,
    pub kind: MediaJobKind,
    pub status: MediaJobStatus,
    pub progress: f64,
    pub stage: String,
    pub message: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub outputs: MediaJobOutputs,
    #[serde(default, skip_serializing)]
    pub options: serde_json::Value,
    #[serde(default, skip_serializing)]
    pub attempts: u32,
}

/// Cached FFprobe metadata for a recording.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMetadata {
    pub recording_id: String,
    pub path: String,
    pub duration_ms: u64,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub fps: Option<f64>,
    pub has_audio: bool,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub bitrate_kbps: Option<f64>,
    pub streams: Vec<MediaStream>,
    pub format: MediaFormat,
    pub updated_at: String,
}

/// Individual media stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStream {
    pub index: i32,
    pub kind: String,
    pub codec: String,
    pub title: Option<String>,
    pub start_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub codec_long_name: Option<String>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub fps: Option<f64>,
    pub bitrate_kbps: Option<f64>,
    pub sample_rate: Option<i32>,
    pub channels: Option<i32>,
    pub channel_layout: Option<String>,
    pub language: Option<String>,
}

/// Container format summary.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFormat {
    pub name: String,
    pub duration_ms: Option<u64>,
    pub size_bytes: Option<u64>,
    pub bitrate_kbps: Option<f64>,
}

/// Generated derivative file tracked for cleanup and recreation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivativeFile {
    pub id: String,
    pub recording_id: String,
    pub job_id: String,
    pub kind: String,
    pub path: String,
    pub size_bytes: u64,
    pub created_at: String,
}

/// Create a new pending media job without job-specific options.
pub fn insert_job(conn: &Connection, recording_id: &str, kind: MediaJobKind) -> Result<MediaJob> {
    insert_job_with_options(conn, recording_id, kind, serde_json::json!({}))
}

/// Create a durable job and persist its restartable options before a worker starts.
pub fn insert_job_with_options(
    conn: &Connection,
    recording_id: &str,
    kind: MediaJobKind,
    options: serde_json::Value,
) -> Result<MediaJob> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let outputs_json = serde_json::to_string(&MediaJobOutputs::default())
        .map_err(|e| InternalError::Storage(format!("serialize outputs: {e}")))?;
    let options_json = serde_json::to_string(&options)
        .map_err(|e| InternalError::Storage(format!("serialize job options: {e}")))?;

    conn.execute(
        "INSERT INTO media_jobs (
            id, recording_id, kind, status, progress, stage, message, error,
            created_at, updated_at, started_at, completed_at, outputs, options, attempts
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            id,
            recording_id,
            kind.as_str(),
            MediaJobStatus::Pending.as_str(),
            0.0,
            "queued",
            None::<String>,
            None::<String>,
            now.clone(),
            now,
            None::<String>,
            None::<String>,
            outputs_json,
            options_json,
            0_i64,
        ],
    )
    .map_err(|e| InternalError::Storage(format!("insert media job: {e}")))?;

    Ok(MediaJob {
        id,
        recording_id: recording_id.to_string(),
        kind,
        status: MediaJobStatus::Pending,
        progress: 0.0,
        stage: "queued".into(),
        message: None,
        error: None,
        created_at: now.clone(),
        updated_at: now,
        started_at: None,
        completed_at: None,
        outputs: MediaJobOutputs::default(),
        options,
        attempts: 0,
    })
}

/// Return an existing prepare job that can satisfy a non-forced request.
pub fn find_reusable_prepare_job(
    conn: &Connection,
    recording_id: &str,
) -> Result<Option<MediaJob>> {
    Ok(list_jobs(conn, recording_id)?.into_iter().find(|job| {
        if job.kind != MediaJobKind::Prepare {
            return false;
        }

        match job.status {
            MediaJobStatus::Pending | MediaJobStatus::Running => true,
            MediaJobStatus::Completed => {
                job.outputs.prepare_version >= 2
                    && job
                        .outputs
                        .proxy_path
                        .as_deref()
                        .is_some_and(|path| Path::new(path).is_file())
                    && job.outputs.audio_tracks.iter().all(|track| {
                        Path::new(&track.audio_path).is_file()
                            && Path::new(&track.waveform_path).is_file()
                            && Path::new(&track.waveform_image_path).is_file()
                    })
                    && job
                        .outputs
                        .video_tracks
                        .iter()
                        .all(|track| Path::new(&track.video_path).is_file())
            }
            MediaJobStatus::Failed | MediaJobStatus::Cancelled => false,
        }
    }))
}

/// Mark a pending job as running.
pub fn start_job(conn: &Connection, id: &str) -> Result<MediaJob> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE media_jobs SET status = ?1, stage = ?2, started_at = ?3, updated_at = ?3, attempts = attempts + 1 WHERE id = ?4 AND status IN ('pending', 'running')",
        params![MediaJobStatus::Running.as_str(), "starting", now, id],
    )
    .map_err(|e| InternalError::Storage(format!("start job: {e}")))?;

    get_job(conn, id)
}

/// Update the progress and current stage of a running job.
pub fn update_job_progress(
    conn: &Connection,
    id: &str,
    progress: f64,
    stage: &str,
    message: Option<&str>,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE media_jobs SET progress = ?1, stage = ?2, message = ?3, updated_at = ?4 WHERE id = ?5 AND status = 'running'",
        params![progress.clamp(0.0, 1.0), stage, message, now, id],
    )
    .map_err(|e| InternalError::Storage(format!("update job progress: {e}")))?;
    Ok(())
}

/// Mark a job completed with its output paths.
pub fn complete_job(conn: &Connection, id: &str, outputs: &MediaJobOutputs) -> Result<MediaJob> {
    let now = Utc::now().to_rfc3339();
    let outputs_json = serde_json::to_string(outputs)
        .map_err(|e| InternalError::Storage(format!("serialize outputs: {e}")))?;

    conn.execute(
        "UPDATE media_jobs SET status = ?1, progress = ?2, stage = ?3, completed_at = ?4, updated_at = ?4, outputs = ?5 WHERE id = ?6 AND status IN ('pending', 'running', 'cancelled')",
        params![
            MediaJobStatus::Completed.as_str(),
            1.0,
            "completed",
            now,
            outputs_json,
            id,
        ],
    )
    .map_err(|e| InternalError::Storage(format!("complete job: {e}")))?;

    get_job(conn, id)
}

/// Mark a job as failed.
pub fn fail_job(conn: &Connection, id: &str, error: &str) -> Result<MediaJob> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE media_jobs SET status = ?1, progress = ?2, stage = ?3, error = ?4, completed_at = ?5, updated_at = ?5 WHERE id = ?6 AND status IN ('pending', 'running')",
        params![
            MediaJobStatus::Failed.as_str(),
            0.0,
            "failed",
            error,
            now,
            id,
        ],
    )
    .map_err(|e| InternalError::Storage(format!("fail job: {e}")))?;

    get_job(conn, id)
}

/// Mark a job as cancelled.
pub fn cancel_job(conn: &Connection, id: &str) -> Result<MediaJob> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE media_jobs SET status = ?1, stage = ?2, completed_at = ?3, updated_at = ?3 WHERE id = ?4 AND status IN ('pending', 'running')",
        params![MediaJobStatus::Cancelled.as_str(), "cancelled", now, id],
    )
    .map_err(|e| InternalError::Storage(format!("cancel job: {e}")))?;

    get_job(conn, id)
}

/// Re-queue a failed or cancelled job while retaining its durable identity and options.
pub fn retry_job(conn: &Connection, id: &str) -> Result<MediaJob> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE media_jobs SET status = ?1, progress = 0, stage = ?2, message = ?3, error = NULL, started_at = NULL, completed_at = NULL, updated_at = ?4 WHERE id = ?5 AND status IN ('failed', 'cancelled')",
        params![
            MediaJobStatus::Pending.as_str(),
            "queued",
            "retry queued",
            now,
            id,
        ],
    )
    .map_err(|e| InternalError::Storage(format!("retry job: {e}")))?;
    get_job(conn, id)
}

/// Get a single job by id.
pub fn get_job(conn: &Connection, id: &str) -> Result<MediaJob> {
    Ok(conn
        .query_row(
            "SELECT * FROM media_jobs WHERE id = ?1",
            params![id],
            row_to_job,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                InternalError::Storage(format!("job not found: {id}"))
            }
            _ => InternalError::Storage(format!("get job: {e}")),
        })?)
}

/// List all jobs for a recording, newest first.
pub fn list_jobs(conn: &Connection, recording_id: &str) -> Result<Vec<MediaJob>> {
    let mut stmt = conn
        .prepare("SELECT * FROM media_jobs WHERE recording_id = ?1 ORDER BY created_at DESC")
        .map_err(|e| InternalError::Storage(format!("prepare list jobs: {e}")))?;
    let rows = stmt
        .query_map(params![recording_id], row_to_job)
        .map_err(|e| InternalError::Storage(format!("query jobs: {e}")))?;

    Ok(rows
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| InternalError::Storage(format!("map job: {e}")))?)
}

/// List jobs that are pending or running so the app can resume them on startup.
pub fn list_active_or_pending_jobs(conn: &Connection) -> Result<Vec<MediaJob>> {
    let mut stmt = conn
        .prepare(
            "SELECT * FROM media_jobs WHERE status IN ('pending', 'running') ORDER BY created_at ASC",
        )
        .map_err(|e| InternalError::Storage(format!("prepare active jobs: {e}")))?;
    let rows = stmt
        .query_map([], row_to_job)
        .map_err(|e| InternalError::Storage(format!("query active jobs: {e}")))?;

    Ok(rows
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| InternalError::Storage(format!("map job: {e}")))?)
}

fn row_to_job(row: &Row<'_>) -> std::result::Result<MediaJob, rusqlite::Error> {
    let outputs_json: String = row.get("outputs")?;
    let outputs: MediaJobOutputs = serde_json::from_str(&outputs_json).unwrap_or_default();

    Ok(MediaJob {
        id: row.get("id")?,
        recording_id: row.get("recording_id")?,
        kind: row
            .get::<_, String>("kind")?
            .parse()
            .unwrap_or(MediaJobKind::Prepare),
        status: row
            .get::<_, String>("status")?
            .parse()
            .unwrap_or(MediaJobStatus::Failed),
        progress: row.get("progress")?,
        stage: row.get("stage")?,
        message: row.get("message")?,
        error: row.get("error")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        started_at: row.get("started_at")?,
        completed_at: row.get("completed_at")?,
        outputs,
        options: row
            .get::<_, String>("options")
            .ok()
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_else(|| serde_json::json!({})),
        attempts: row.get::<_, i64>("attempts").unwrap_or(0).max(0) as u32,
    })
}

/// Upsert cached media metadata.
pub fn upsert_metadata(conn: &Connection, metadata: &MediaMetadata) -> Result<MediaMetadata> {
    let streams_json = serde_json::to_string(&metadata.streams)
        .map_err(|e| InternalError::Storage(format!("serialize streams: {e}")))?;
    let format_json = serde_json::to_string(&metadata.format)
        .map_err(|e| InternalError::Storage(format!("serialize format: {e}")))?;
    let has_audio = if metadata.has_audio { 1 } else { 0 };

    conn.execute(
        "INSERT OR REPLACE INTO media_metadata (
            recording_id, path, duration_ms, width, height, fps, has_audio,
            video_codec, audio_codec, bitrate_kbps, streams, format, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            metadata.recording_id,
            metadata.path,
            metadata.duration_ms as i64,
            metadata.width,
            metadata.height,
            metadata.fps,
            has_audio,
            metadata.video_codec,
            metadata.audio_codec,
            metadata.bitrate_kbps,
            streams_json,
            format_json,
            metadata.updated_at,
        ],
    )
    .map_err(|e| InternalError::Storage(format!("upsert metadata: {e}")))?;

    Ok(metadata.clone())
}

/// Read cached media metadata for a recording.
pub fn get_metadata(conn: &Connection, recording_id: &str) -> Result<Option<MediaMetadata>> {
    let result = conn.query_row(
        "SELECT * FROM media_metadata WHERE recording_id = ?1",
        params![recording_id],
        row_to_metadata,
    );

    match result {
        Ok(m) => Ok(Some(m)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(InternalError::Storage(format!("get metadata: {e}")).into()),
    }
}

fn row_to_metadata(row: &Row<'_>) -> std::result::Result<MediaMetadata, rusqlite::Error> {
    let streams_json: String = row.get("streams")?;
    let format_json: String = row.get("format")?;
    let has_audio: i32 = row.get("has_audio")?;

    let streams: Vec<MediaStream> = serde_json::from_str(&streams_json).unwrap_or_default();
    let format: MediaFormat = serde_json::from_str(&format_json).unwrap_or_default();

    Ok(MediaMetadata {
        recording_id: row.get("recording_id")?,
        path: row.get("path")?,
        duration_ms: row.get::<_, i64>("duration_ms")? as u64,
        width: row.get("width")?,
        height: row.get("height")?,
        fps: row.get("fps")?,
        has_audio: has_audio != 0,
        video_codec: row.get("video_codec")?,
        audio_codec: row.get("audio_codec")?,
        bitrate_kbps: row.get("bitrate_kbps")?,
        streams,
        format,
        updated_at: row.get("updated_at")?,
    })
}

/// Insert a generated derivative file.
pub fn insert_derivative(conn: &Connection, derivative: &DerivativeFile) -> Result<()> {
    conn.execute(
        "INSERT INTO derivatives (
            id, recording_id, job_id, kind, path, size_bytes, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            derivative.id,
            derivative.recording_id,
            derivative.job_id,
            derivative.kind,
            derivative.path,
            derivative.size_bytes as i64,
            derivative.created_at,
        ],
    )
    .map_err(|e| InternalError::Storage(format!("insert derivative: {e}")))?;
    Ok(())
}

/// List derivatives for a recording.
pub fn list_derivatives(conn: &Connection, recording_id: &str) -> Result<Vec<DerivativeFile>> {
    let mut stmt = conn
        .prepare("SELECT * FROM derivatives WHERE recording_id = ?1 ORDER BY created_at DESC")
        .map_err(|e| InternalError::Storage(format!("prepare list derivatives: {e}")))?;
    let rows = stmt
        .query_map(params![recording_id], row_to_derivative)
        .map_err(|e| InternalError::Storage(format!("query derivatives: {e}")))?;

    Ok(rows
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| InternalError::Storage(format!("map derivative: {e}")))?)
}

/// Delete derivative rows and optionally remove their files from disk.
pub fn delete_derivatives_for_recording(
    conn: &Connection,
    recording_id: &str,
    remove_files: bool,
) -> Result<()> {
    if remove_files {
        let files = list_derivatives(conn, recording_id)?;
        for file in files {
            let path = PathBuf::from(&file.path);
            if path.is_file() {
                let _ = std::fs::remove_file(&path);
            } else if path.is_dir() {
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }

    conn.execute(
        "DELETE FROM derivatives WHERE recording_id = ?1",
        params![recording_id],
    )
    .map_err(|e| InternalError::Storage(format!("delete derivatives: {e}")))?;

    Ok(())
}

/// Delete derivative rows associated with one asset's output paths.
pub fn delete_derivatives_for_paths(
    conn: &Connection,
    recording_id: &str,
    paths: &[String],
) -> Result<()> {
    for path in paths {
        conn.execute(
            "DELETE FROM derivatives WHERE recording_id = ?1 AND path = ?2",
            params![recording_id, path],
        )
        .map_err(|e| InternalError::Storage(format!("delete asset derivative: {e}")))?;
    }
    Ok(())
}

/// Delete a single derivative row and its file.
pub fn delete_derivative(conn: &Connection, id: &str) -> Result<()> {
    let file = conn
        .query_row(
            "SELECT * FROM derivatives WHERE id = ?1",
            params![id],
            row_to_derivative,
        )
        .map_err(|e| InternalError::Storage(format!("get derivative: {e}")))?;

    let path = PathBuf::from(&file.path);
    if path.is_file() {
        let _ = std::fs::remove_file(&path);
    } else if path.is_dir() {
        let _ = std::fs::remove_dir_all(&path);
    }

    conn.execute("DELETE FROM derivatives WHERE id = ?1", params![id])
        .map_err(|e| InternalError::Storage(format!("delete derivative: {e}")))?;

    Ok(())
}

fn row_to_derivative(row: &Row<'_>) -> std::result::Result<DerivativeFile, rusqlite::Error> {
    Ok(DerivativeFile {
        id: row.get("id")?,
        recording_id: row.get("recording_id")?,
        job_id: row.get("job_id")?,
        kind: row.get("kind")?,
        path: row.get("path")?,
        size_bytes: row.get::<_, i64>("size_bytes")? as u64,
        created_at: row.get("created_at")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::migrations::run_migrations;

    #[test]
    fn finds_only_reusable_prepare_jobs() {
        let mut conn = Connection::open_in_memory().expect("open in-memory database");
        run_migrations(&mut conn).expect("run migrations");

        let pending = insert_job(&conn, "recording-1", MediaJobKind::Prepare)
            .expect("insert pending prepare job");
        assert_eq!(
            find_reusable_prepare_job(&conn, "recording-1")
                .expect("find pending job")
                .map(|job| job.id),
            Some(pending.id.clone())
        );

        fail_job(&conn, &pending.id, "test failure").expect("fail prepare job");
        assert!(find_reusable_prepare_job(&conn, "recording-1")
            .expect("find failed job")
            .is_none());

        let stale_completed = insert_job(&conn, "recording-1", MediaJobKind::Prepare)
            .expect("insert stale completed prepare job");
        let temp_dir = tempfile::tempdir().expect("create derivative directory");
        let proxy_path = temp_dir.path().join("proxy.mp4");
        std::fs::write(&proxy_path, b"proxy").expect("write proxy fixture");
        let stale_outputs = MediaJobOutputs {
            prepare_version: 1,
            proxy_path: Some(proxy_path.to_string_lossy().to_string()),
            ..Default::default()
        };
        complete_job(&conn, &stale_completed.id, &stale_outputs)
            .expect("complete stale prepare job");
        assert!(find_reusable_prepare_job(&conn, "recording-1")
            .expect("ignore stale completed job")
            .is_none());

        let completed = insert_job(&conn, "recording-1", MediaJobKind::Prepare)
            .expect("insert current completed prepare job");
        let outputs = MediaJobOutputs {
            prepare_version: 2,
            proxy_path: Some(proxy_path.to_string_lossy().to_string()),
            ..Default::default()
        };
        complete_job(&conn, &completed.id, &outputs).expect("complete current prepare job");
        assert_eq!(
            find_reusable_prepare_job(&conn, "recording-1")
                .expect("find current completed job")
                .map(|job| job.id),
            Some(completed.id)
        );
    }

    #[test]
    fn persists_export_options_and_retries_with_the_same_identity() {
        let mut conn = Connection::open_in_memory().expect("open in-memory database");
        run_migrations(&mut conn).expect("run migrations");
        let options = serde_json::json!({
            "projectId": "project-1",
            "outputPath": "C:/exports/demo.mp4",
        });
        let job =
            insert_job_with_options(&conn, "recording-1", MediaJobKind::Export, options.clone())
                .expect("insert export job");
        assert_eq!(job.options, options);
        assert_eq!(job.attempts, 0);

        start_job(&conn, &job.id).expect("start export job");
        fail_job(&conn, &job.id, "render failed").expect("fail export job");
        let retried = retry_job(&conn, &job.id).expect("retry export job");
        assert_eq!(retried.id, job.id);
        assert_eq!(retried.status, MediaJobStatus::Pending);
        assert_eq!(retried.options, options);
        assert_eq!(retried.attempts, 1);
    }

    #[test]
    fn completion_wins_when_cancellation_races_after_publication() {
        let mut conn = Connection::open_in_memory().expect("open in-memory database");
        run_migrations(&mut conn).expect("run migrations");
        let job =
            insert_job(&conn, "recording-1", MediaJobKind::Export).expect("insert export job");
        start_job(&conn, &job.id).expect("start export job");
        cancel_job(&conn, &job.id).expect("cancel export job");

        let completed = complete_job(
            &conn,
            &job.id,
            &MediaJobOutputs {
                output_path: Some("C:/exports/demo.mp4".into()),
                ..Default::default()
            },
        )
        .expect("complete published export");

        assert_eq!(completed.status, MediaJobStatus::Completed);
        assert_eq!(
            completed.outputs.output_path.as_deref(),
            Some("C:/exports/demo.mp4")
        );
    }

    #[test]
    fn cancellation_does_not_overwrite_completed_jobs() {
        let mut conn = Connection::open_in_memory().expect("open in-memory database");
        run_migrations(&mut conn).expect("run migrations");
        let job =
            insert_job(&conn, "recording-1", MediaJobKind::Export).expect("insert export job");
        start_job(&conn, &job.id).expect("start export job");
        complete_job(&conn, &job.id, &MediaJobOutputs::default()).expect("complete export job");
        let cancelled = cancel_job(&conn, &job.id).expect("cancel completed export");
        assert_eq!(cancelled.status, MediaJobStatus::Completed);
    }
}
