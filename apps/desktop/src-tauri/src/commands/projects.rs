use std::path::Path;

use tauri::State;
use tracing::instrument;

use crate::database;
use crate::database::library::{get_recording, LibraryRecording};
use crate::database::media::{get_metadata, MediaMetadata};
use crate::database::projects::{upsert_project, ProjectRecord};
use crate::errors::{InternalError, Result};
use crate::projects::{
    asset_path_map, create_project as create_project_file, delete_project as delete_project_file,
    duplicate_project as duplicate_project_file, load_project, project_dir_for_recording,
    relink_asset, rename_project as rename_project_file, save_project as save_project_file,
    snapshot_project as snapshot_project_file, LoadedProject, ProjectFile,
};
use crate::state::AppState;

/// Load the project for a recording. Returns `None` when no project has been
/// created yet, allowing the editor to fall back to the recording bootstrap.
#[tauri::command]
#[instrument]
pub fn load_project_for_recording(
    recording_id: String,
    state: State<'_, AppState>,
) -> Result<Option<LoadedProject>> {
    let recording = get_db_recording(&state, &recording_id)?;
    let project_dir = project_dir_for_recording(&recording);
    let loaded = load_project(&project_dir, &state.path_policy)?;
    if let Some(project) = loaded.as_ref() {
        index_project(&state, &project.project)?;
    }
    Ok(loaded)
}

/// Save a project. If the project file already exists, it is backed up before
/// the new version is written atomically. The checksum is recomputed in Rust.
#[tauri::command]
#[instrument]
pub fn save_project(project: ProjectFile, state: State<'_, AppState>) -> Result<ProjectFile> {
    let recording = get_db_recording(&state, &project.recording_id)?;
    let project_dir = project_dir_for_recording(&recording);

    let saved = save_project_file(&project, &project_dir)?;
    index_project(&state, &saved)?;
    Ok(saved)
}

/// Create a project from a client-supplied project file. This is the typical
/// entry point for the recording bootstrap: the editor builds the initial
/// project in TypeScript and asks Rust to persist it durably.
#[tauri::command]
#[instrument]
pub fn create_project(project: ProjectFile, state: State<'_, AppState>) -> Result<ProjectFile> {
    let recording = get_db_recording(&state, &project.recording_id)?;
    let project_dir = project_dir_for_recording(&recording);

    if project_path(&project_dir).exists() {
        return Err(InternalError::Project(
            "a project already exists for this recording; use save_project".to_string(),
        )
        .into());
    }

    // Register the cursor telemetry asset and a full-duration cursor range if
    // the recording has cursor data. This keeps the bootstrap project in sync
    // with the available source assets without requiring a separate migration.
    let mut project = project;
    crate::projects::ensure_cursor_asset(&mut project, &project_dir)?;

    let saved = save_project_file(&project, &project_dir)?;
    index_project(&state, &saved)?;
    Ok(saved)
}

/// Build a minimal bootstrap project in Rust. Used when the editor does not
/// have a pre-built project and wants the backend to create a safe placeholder.
#[tauri::command]
#[instrument]
pub fn create_bootstrap_project(
    recording_id: String,
    state: State<'_, AppState>,
) -> Result<ProjectFile> {
    let (recording, metadata) = get_recording_and_metadata(&state, &recording_id)?;
    let project_dir = project_dir_for_recording(&recording);
    let project = create_project_file(&recording, &metadata, None, &project_dir)?;
    index_project(&state, &project)?;
    Ok(project)
}

/// Rename a project and re-persist it.
#[tauri::command]
#[instrument]
pub fn rename_project(
    recording_id: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<ProjectFile> {
    let recording = get_db_recording(&state, &recording_id)?;
    let project_dir = project_dir_for_recording(&recording);

    let loaded = load_project(&project_dir, &state.path_policy)?.ok_or_else(|| {
        InternalError::Project(format!("no project found for recording {recording_id}"))
    })?;

    let renamed = rename_project_file(&loaded.project, &project_dir, &new_name)?;
    index_project(&state, &renamed)?;
    Ok(renamed)
}

/// Duplicate a project in memory. The returned project has a new id and name
/// and must be saved to a project directory by the caller.
#[tauri::command]
#[instrument]
pub fn duplicate_project(
    recording_id: String,
    new_name: Option<String>,
    state: State<'_, AppState>,
) -> Result<ProjectFile> {
    let recording = get_db_recording(&state, &recording_id)?;
    let project_dir = project_dir_for_recording(&recording);

    let loaded = load_project(&project_dir, &state.path_policy)?.ok_or_else(|| {
        InternalError::Project(format!("no project found for recording {recording_id}"))
    })?;

    Ok(duplicate_project_file(&loaded.project, new_name.as_deref()))
}

/// Delete the persisted project for a recording. Source media is not deleted.
#[tauri::command]
#[instrument]
pub fn delete_project(recording_id: String, state: State<'_, AppState>) -> Result<()> {
    let recording = get_db_recording(&state, &recording_id)?;
    let project_dir = project_dir_for_recording(&recording);

    if let Some(loaded) = load_project(&project_dir, &state.path_policy)? {
        delete_project_file(&project_dir)?;
        let db = get_db(&state)?;
        database::projects::delete_project(&db, &loaded.project.id)?;
    }
    Ok(())
}

/// Relink an asset in a project to a new file chosen by the user.
#[tauri::command]
#[instrument]
pub fn relink_project_asset(
    recording_id: String,
    asset_id: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<ProjectFile> {
    let recording = get_db_recording(&state, &recording_id)?;
    let project_dir = project_dir_for_recording(&recording);

    let loaded = load_project(&project_dir, &state.path_policy)?.ok_or_else(|| {
        InternalError::Project(format!("no project found for recording {recording_id}"))
    })?;

    let new_path = Path::new(&new_path).to_path_buf();
    let updated = relink_asset(
        &loaded.project,
        &project_dir,
        &asset_id,
        &new_path,
        &state.path_policy,
    )?;
    index_project(&state, &updated)?;
    Ok(updated)
}

/// Create a timestamped snapshot of the current project before a destructive
/// editor operation.
#[tauri::command]
#[instrument]
pub fn snapshot_project(recording_id: String, state: State<'_, AppState>) -> Result<String> {
    let recording = get_db_recording(&state, &recording_id)?;
    let project_dir = project_dir_for_recording(&recording);
    let snapshot = snapshot_project_file(&project_dir)?;
    Ok(snapshot.to_string_lossy().to_string())
}

/// Resolve asset paths for a recording's project. This lets the export pipeline
/// translate asset ids to absolute paths without relying on React input.
#[tauri::command]
#[instrument]
pub fn get_project_asset_paths(
    recording_id: String,
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, String>> {
    let recording = get_db_recording(&state, &recording_id)?;
    let project_dir = project_dir_for_recording(&recording);

    let loaded = load_project(&project_dir, &state.path_policy)?.ok_or_else(|| {
        InternalError::Project(format!("no project found for recording {recording_id}"))
    })?;

    let map = asset_path_map(&loaded.project, &project_dir);
    Ok(map
        .into_iter()
        .map(|(k, v)| (k, v.to_string_lossy().to_string()))
        .collect())
}

fn project_path(project_dir: &Path) -> std::path::PathBuf {
    project_dir.join("project.json")
}

fn get_db_recording(state: &AppState, recording_id: &str) -> Result<LibraryRecording> {
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".to_string()))?;
    get_recording(&db, recording_id)
}

fn get_recording_and_metadata(
    state: &AppState,
    recording_id: &str,
) -> Result<(LibraryRecording, MediaMetadata)> {
    let recording = get_db_recording(state, recording_id)?;
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".to_string()))?;

    let metadata = match get_metadata(&db, recording_id)? {
        Some(m) => m,
        None => {
            // Probe on demand if metadata has not been cached yet.
            drop(db);
            let output_path = recording
                .output_path
                .as_ref()
                .ok_or_else(|| InternalError::Media("recording has no output path".to_string()))?;
            let m = crate::media::probe::probe_media(
                &state.ffprobe_path.to_string_lossy(),
                Path::new(output_path),
                recording_id,
            )?;
            // Store metadata so future loads do not re-probe.
            let db = state
                .db
                .lock()
                .map_err(|_| InternalError::Storage("database mutex poisoned".to_string()))?;
            database::media::upsert_metadata(&db, &m)?;
            m
        }
    };

    Ok((recording, metadata))
}

fn get_db(state: &AppState) -> Result<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".to_string()).into())
}

/// Lightweight project summary for project browsing and management in the UI.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub recording_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub duration_ms: u64,
    pub thumbnail_path: Option<String>,
    pub track_count: usize,
    pub clip_count: usize,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
}

/// List all projects indexed in SQLite or found on disk in session work directories.
#[tauri::command]
#[instrument]
pub fn list_projects(state: State<'_, AppState>) -> Result<Vec<ProjectSummary>> {
    let db = get_db(&state)?;
    let records = database::projects::list_projects(&db, None)?;
    let mut summaries = Vec::new();
    let mut indexed_rec_ids = std::collections::HashSet::new();

    for record in records {
        indexed_rec_ids.insert(record.recording_id.clone());
        if let Ok(project) = serde_json::from_str::<ProjectFile>(&record.project_json) {
            let recording = get_recording(&db, &record.recording_id).ok();
            let thumbnail_path = recording.as_ref().and_then(|r| r.thumbnail_path.clone());
            let track_count = project.tracks.as_array().map(|t| t.len()).unwrap_or(0);
            let clip_count = project
                .tracks
                .as_array()
                .map(|tracks| {
                    tracks
                        .iter()
                        .filter_map(|t| t.get("clips")?.as_array())
                        .map(|c| c.len())
                        .sum()
                })
                .unwrap_or(0);
            let duration_ms = project
                .tracks
                .as_array()
                .and_then(|tracks| {
                    tracks
                        .iter()
                        .filter_map(|t| t.get("clips")?.as_array())
                        .flatten()
                        .filter_map(|clip| {
                            let start = clip.get("startMs")?.as_u64()?;
                            let dur = clip.get("durationMs")?.as_u64()?;
                            Some(start + dur)
                        })
                        .max()
                })
                .unwrap_or_else(|| recording.as_ref().map_or(0, |r| r.duration_ms));

            let width = project
                .canvas
                .get("width")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            let height = project
                .canvas
                .get("height")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            let fps = project.canvas.get("fps").and_then(|v| v.as_f64());

            summaries.push(ProjectSummary {
                id: record.id,
                name: record.name,
                recording_id: record.recording_id,
                created_at: record.created_at,
                updated_at: record.updated_at,
                duration_ms,
                thumbnail_path,
                track_count,
                clip_count,
                width,
                height,
                fps,
            });
        }
    }

    // Check for any unindexed project.json files in recording session directories
    if let Ok(recordings) = database::library::list_recordings(&db) {
        for rec in recordings {
            if !indexed_rec_ids.contains(&rec.id) {
                let project_dir = project_dir_for_recording(&rec);
                if project_path(&project_dir).is_file() {
                    if let Ok(Some(loaded)) = load_project(&project_dir, &state.path_policy) {
                        let project = loaded.project;
                        let track_count = project.tracks.as_array().map(|t| t.len()).unwrap_or(0);
                        let clip_count = project
                            .tracks
                            .as_array()
                            .map(|tracks| {
                                tracks
                                    .iter()
                                    .filter_map(|t| t.get("clips")?.as_array())
                                    .map(|c| c.len())
                                    .sum()
                            })
                            .unwrap_or(0);
                        let duration_ms = project
                            .tracks
                            .as_array()
                            .and_then(|tracks| {
                                tracks
                                    .iter()
                                    .filter_map(|t| t.get("clips")?.as_array())
                                    .flatten()
                                    .filter_map(|clip| {
                                        let start = clip.get("startMs")?.as_u64()?;
                                        let dur = clip.get("durationMs")?.as_u64()?;
                                        Some(start + dur)
                                    })
                                    .max()
                            })
                            .unwrap_or(rec.duration_ms);

                        let width = project
                            .canvas
                            .get("width")
                            .and_then(|v| v.as_u64())
                            .map(|v| v as u32);
                        let height = project
                            .canvas
                            .get("height")
                            .and_then(|v| v.as_u64())
                            .map(|v| v as u32);
                        let fps = project.canvas.get("fps").and_then(|v| v.as_f64());

                        let _ = upsert_project(
                            &db,
                            &ProjectRecord {
                                id: project.id.clone(),
                                name: project.name.clone(),
                                recording_id: project.recording_id.clone(),
                                created_at: project.created_at.clone(),
                                updated_at: project.updated_at.clone(),
                                project_json: serde_json::to_string(&project).unwrap_or_default(),
                            },
                        );

                        indexed_rec_ids.insert(rec.id.clone());
                        summaries.push(ProjectSummary {
                            id: project.id,
                            name: project.name,
                            recording_id: project.recording_id,
                            created_at: project.created_at,
                            updated_at: project.updated_at,
                            duration_ms,
                            thumbnail_path: rec.thumbnail_path.clone(),
                            track_count,
                            clip_count,
                            width,
                            height,
                            fps,
                        });
                    }
                }
            }
        }
    }

    // Sort by updated_at descending
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    Ok(summaries)
}

fn index_project(state: &AppState, project: &ProjectFile) -> Result<()> {
    let db = get_db(state)?;
    upsert_project(
        &db,
        &ProjectRecord {
            id: project.id.clone(),
            name: project.name.clone(),
            recording_id: project.recording_id.clone(),
            created_at: project.created_at.clone(),
            updated_at: project.updated_at.clone(),
            project_json: serde_json::to_string(project)
                .map_err(|e| InternalError::Storage(format!("serialize project index: {e}")))?,
        },
    )?;
    Ok(())
}
