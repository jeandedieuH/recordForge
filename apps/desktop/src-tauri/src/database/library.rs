use chrono::Utc;
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::capture::config::builtin_profiles;
use crate::capture::manifest::{RecordingManifest, RecordingMarker};
use crate::capture::source::CaptureSource;
use crate::errors::{InternalError, Result};

/// Library recording status. Reflects the lifecycle of a finished recording.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LibraryRecordingStatus {
    Recording,
    Paused,
    Completed,
    Recovered,
    Trashed,
}

impl LibraryRecordingStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            LibraryRecordingStatus::Recording => "recording",
            LibraryRecordingStatus::Paused => "paused",
            LibraryRecordingStatus::Completed => "completed",
            LibraryRecordingStatus::Recovered => "recovered",
            LibraryRecordingStatus::Trashed => "trashed",
        }
    }
}

impl std::str::FromStr for LibraryRecordingStatus {
    type Err = ();

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s {
            "recording" => Ok(LibraryRecordingStatus::Recording),
            "paused" => Ok(LibraryRecordingStatus::Paused),
            "completed" => Ok(LibraryRecordingStatus::Completed),
            "recovered" => Ok(LibraryRecordingStatus::Recovered),
            "trashed" => Ok(LibraryRecordingStatus::Trashed),
            _ => Err(()),
        }
    }
}

/// Recording entry as shown in the local library.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRecording {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub duration_ms: u64,
    pub size_bytes: u64,
    pub width: i32,
    pub height: i32,
    pub fps: i32,
    pub status: LibraryRecordingStatus,
    pub tags: Vec<String>,
    pub source: CaptureSource,
    pub profile_name: String,
    pub output_path: Option<String>,
    pub work_dir: String,
    pub thumbnail_path: Option<String>,
    pub markers: Vec<RecordingMarker>,
}

/// Insert a completed recording into the library from a finalized manifest.
pub fn insert_recording(
    conn: &Connection,
    manifest: &RecordingManifest,
    output_size_bytes: u64,
) -> Result<LibraryRecording> {
    let (width, height, fps) = resolve_profile_dimensions(&manifest.profile_name);
    let now = Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();
    let session_id = manifest.session_id.clone();
    let short = &session_id[..session_id.len().min(8)];
    let name = format!("Recording {short}");
    let source_json = serde_json::to_string(&manifest.source)
        .map_err(|e| InternalError::Storage(format!("serialize source: {e}")))?;
    let markers_json = serde_json::to_string(&manifest.markers)
        .map_err(|e| InternalError::Storage(format!("serialize markers: {e}")))?;
    let tags = "[]";
    let output_path = manifest.output_path.clone().unwrap_or_default();
    let work_dir = manifest.work_dir.clone();

    conn.execute(
        "INSERT INTO recordings (
            id, session_id, name, created_at, updated_at, duration_ms, size_bytes,
            width, height, fps, status, tags, source, profile_name, output_path,
            work_dir, thumbnail_path, markers
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18
        )",
        params![
            id,
            session_id,
            name,
            now.clone(),
            now,
            manifest.total_recorded_ms as i64,
            output_size_bytes as i64,
            width,
            height,
            fps,
            LibraryRecordingStatus::Completed.as_str(),
            tags,
            source_json,
            manifest.profile_name.clone(),
            output_path,
            work_dir,
            None::<String>,
            markers_json,
        ],
    )
    .map_err(|e| InternalError::Storage(format!("insert recording: {e}")))?;

    Ok(LibraryRecording {
        id,
        session_id: manifest.session_id.clone(),
        name,
        created_at: now.clone(),
        updated_at: now,
        duration_ms: manifest.total_recorded_ms,
        size_bytes: output_size_bytes,
        width,
        height,
        fps,
        status: LibraryRecordingStatus::Completed,
        tags: Vec::new(),
        source: manifest.source.clone(),
        profile_name: manifest.profile_name.clone(),
        output_path: manifest.output_path.clone(),
        work_dir: manifest.work_dir.clone(),
        thumbnail_path: None,
        markers: manifest.markers.clone(),
    })
}

/// Insert a new library record for a trimmed recording.
pub fn insert_trimmed_recording(
    conn: &Connection,
    original: &LibraryRecording,
    output_path: &Path,
    size_bytes: u64,
    duration_ms: u64,
    start_ms: u64,
    end_ms: u64,
) -> Result<LibraryRecording> {
    let now = Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();
    let name = format!("Trim of {}", original.name);
    let markers: Vec<RecordingMarker> = original
        .markers
        .iter()
        .filter(|m| m.timestamp_ms >= start_ms && m.timestamp_ms <= end_ms)
        .cloned()
        .collect();

    let source_json = serde_json::to_string(&original.source)
        .map_err(|e| InternalError::Storage(format!("serialize source: {e}")))?;
    let markers_json = serde_json::to_string(&markers)
        .map_err(|e| InternalError::Storage(format!("serialize markers: {e}")))?;
    let tags_json = serde_json::to_string(&original.tags)
        .map_err(|e| InternalError::Storage(format!("serialize tags: {e}")))?;

    let output = output_path.to_string_lossy().to_string();

    conn.execute(
        "INSERT INTO recordings (
            id, session_id, name, created_at, updated_at, duration_ms, size_bytes,
            width, height, fps, status, tags, source, profile_name, output_path,
            work_dir, thumbnail_path, markers
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18
        )",
        params![
            id,
            original.session_id.clone(),
            name,
            now.clone(),
            now,
            duration_ms as i64,
            size_bytes as i64,
            original.width,
            original.height,
            original.fps,
            LibraryRecordingStatus::Completed.as_str(),
            tags_json,
            source_json,
            original.profile_name.clone(),
            output,
            original.work_dir.clone(),
            original.thumbnail_path.clone(),
            markers_json,
        ],
    )
    .map_err(|e| InternalError::Storage(format!("insert trimmed recording: {e}")))?;

    Ok(LibraryRecording {
        id,
        session_id: original.session_id.clone(),
        name,
        created_at: now.clone(),
        updated_at: now,
        duration_ms,
        size_bytes,
        width: original.width,
        height: original.height,
        fps: original.fps,
        status: LibraryRecordingStatus::Completed,
        tags: original.tags.clone(),
        source: original.source.clone(),
        profile_name: original.profile_name.clone(),
        output_path: Some(output_path.to_string_lossy().to_string()),
        work_dir: original.work_dir.clone(),
        thumbnail_path: original.thumbnail_path.clone(),
        markers,
    })
}

/// List all library recordings ordered newest first.
pub fn list_recordings(conn: &Connection) -> Result<Vec<LibraryRecording>> {
    let mut stmt = conn
        .prepare("SELECT * FROM recordings ORDER BY created_at DESC")
        .map_err(|e| InternalError::Storage(format!("list recordings: {e}")))?;
    let rows = stmt
        .query_map([], row_to_recording)
        .map_err(|e| InternalError::Storage(format!("query recordings: {e}")))?;

    let mut recordings = Vec::new();
    for row in rows {
        recordings.push(row.map_err(|e| InternalError::Storage(format!("map recording: {e}")))?);
    }
    Ok(recordings)
}

/// Get a single library recording by its library id.
pub fn get_recording(conn: &Connection, id: &str) -> Result<LibraryRecording> {
    Ok(conn
        .query_row(
            "SELECT * FROM recordings WHERE id = ?1",
            params![id],
            row_to_recording,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                InternalError::Storage(format!("recording not found: {id}"))
            }
            _ => InternalError::Storage(format!("get recording: {e}")),
        })?)
}

/// Move a library recording to trash (soft delete).
pub fn trash_recording(conn: &Connection, id: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE recordings SET status = 'trashed', updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )
    .map_err(|e| InternalError::Storage(format!("trash recording: {e}")))?;
    Ok(())
}

/// Restore a trashed recording back to completed status.
pub fn restore_recording(conn: &Connection, id: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE recordings SET status = 'completed', updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )
    .map_err(|e| InternalError::Storage(format!("restore recording: {e}")))?;
    Ok(())
}

/// Permanently delete a library recording (P0.8 atomic fix).
///
/// Physical files and derivative entries are removed before deleting the database row.
/// Paths are checked against `app_data_dir` to prevent a compromised database from
/// deleting files outside the application's data area.
pub fn delete_recording(conn: &Connection, id: &str, app_data_dir: &std::path::Path) -> Result<()> {
    let recording = get_recording(conn, id)?;

    let app_data_canonical = app_data_dir.canonicalize().map_err(|e| {
        InternalError::Storage(format!("failed to canonicalize app data dir: {e}"))
    })?;

    // 1. Remove physical files first
    if let Some(output) = &recording.output_path {
        let output_path = Path::new(output);
        if output_path.exists() {
            let canonical = output_path.canonicalize().map_err(|e| {
                InternalError::Storage(format!("failed to canonicalize output path: {e}"))
            })?;
            if !canonical.starts_with(&app_data_canonical) {
                return Err(InternalError::Permissions(format!(
                    "refusing to delete recording file outside app data: {}",
                    canonical.display()
                ))
                .into());
            }
            std::fs::remove_file(&canonical).map_err(|e| {
                InternalError::Storage(format!("failed to remove recording file '{output}': {e}"))
            })?;
        }
    }

    let work_dir = PathBuf::from(&recording.work_dir);
    if work_dir.exists() {
        let canonical = work_dir.canonicalize().map_err(|e| {
            InternalError::Storage(format!("failed to canonicalize work dir: {e}"))
        })?;
        if !canonical.starts_with(&app_data_canonical) {
            return Err(InternalError::Permissions(format!(
                "refusing to delete work dir outside app data: {}",
                canonical.display()
            ))
            .into());
        }
        let _ = std::fs::remove_dir_all(&canonical);
    }

    // 2. Clean associated derivatives and jobs in DB
    let _ = conn.execute("DELETE FROM derivatives WHERE recording_id = ?1", params![id]);
    let _ = conn.execute("DELETE FROM media_jobs WHERE recording_id = ?1", params![id]);
    let _ = conn.execute("DELETE FROM media_metadata WHERE recording_id = ?1", params![id]);

    // 3. Atomically delete database row
    conn.execute("DELETE FROM recordings WHERE id = ?1", params![id])
        .map_err(|e| InternalError::Storage(format!("delete recording row: {e}")))?;

    Ok(())
}

/// Add a tag to a recording if it is not already present.
pub fn add_tag(conn: &Connection, id: &str, tag: &str) -> Result<()> {
    let mut recording = get_recording(conn, id)?;
    if !recording.tags.contains(&tag.to_string()) {
        recording.tags.push(tag.to_string());
    }
    update_tags(conn, id, &recording.tags)
}

/// Remove a tag from a recording.
pub fn remove_tag(conn: &Connection, id: &str, tag: &str) -> Result<()> {
    let mut recording = get_recording(conn, id)?;
    recording.tags.retain(|t| t != tag);
    update_tags(conn, id, &recording.tags)
}

fn update_tags(conn: &Connection, id: &str, tags: &[String]) -> Result<()> {
    let tags_json = serde_json::to_string(tags)
        .map_err(|e| InternalError::Storage(format!("tags json: {e}")))?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE recordings SET tags = ?1, updated_at = ?2 WHERE id = ?3",
        params![tags_json, now, id],
    )
    .map_err(|e| InternalError::Storage(format!("update tags: {e}")))?;
    Ok(())
}

fn row_to_recording(row: &Row<'_>) -> std::result::Result<LibraryRecording, rusqlite::Error> {
    let source: String = row.get("source")?;
    let markers: String = row.get("markers")?;
    let tags: String = row.get("tags")?;
    let status: String = row.get("status")?;

    let source = serde_json::from_str(&source).unwrap_or_else(|_| CaptureSource {
        kind: "unknown".into(),
        id: "".into(),
        name: "".into(),
        bounds: crate::capture::source::Bounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        },
    });

    let markers = serde_json::from_str(&markers).unwrap_or_default();
    let tags = serde_json::from_str(&tags).unwrap_or_default();

    let status = status.parse().unwrap_or(LibraryRecordingStatus::Completed);

    Ok(LibraryRecording {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        name: row.get("name")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        duration_ms: row.get::<_, i64>("duration_ms")? as u64,
        size_bytes: row.get::<_, i64>("size_bytes")? as u64,
        width: row.get("width")?,
        height: row.get("height")?,
        fps: row.get("fps")?,
        status,
        tags,
        source,
        profile_name: row.get("profile_name")?,
        output_path: row.get("output_path")?,
        work_dir: row.get("work_dir")?,
        thumbnail_path: row.get("thumbnail_path")?,
        markers,
    })
}

fn resolve_profile_dimensions(profile_name: &str) -> (i32, i32, i32) {
    builtin_profiles()
        .into_iter()
        .find(|p| p.id == profile_name)
        .map(|p| (p.width, p.height, p.fps))
        .unwrap_or((1920, 1080, 30))
}
