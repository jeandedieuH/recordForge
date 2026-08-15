use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tracing::{info, instrument, warn};

use crate::capture::disk::atomic_replace;
use crate::database::library::LibraryRecording;
use crate::database::media::MediaMetadata;
use crate::errors::{InternalError, Result};
use crate::path_policy::PathPolicy;

/// On-disk project format discriminator.
pub const PROJECT_FORMAT: &str = "recordforge.project";
pub const PROJECT_VERSION: i32 = 1;
pub const PROJECT_FILE_NAME: &str = "project.json";
pub const PROJECT_BACKUP_NAME: &str = "project.json.bak";
pub const PROJECT_TEMP_NAME: &str = "project.json.tmp";

/// Asset roles for the project asset registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectAssetRole {
    Screen,
    Microphone,
    SystemAudio,
    Music,
    Webcam,
    CursorEvents,
    Caption,
    Image,
}

impl ProjectAssetRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProjectAssetRole::Screen => "screen",
            ProjectAssetRole::Microphone => "microphone",
            ProjectAssetRole::SystemAudio => "system_audio",
            ProjectAssetRole::Music => "music",
            ProjectAssetRole::Webcam => "webcam",
            ProjectAssetRole::CursorEvents => "cursor_events",
            ProjectAssetRole::Caption => "caption",
            ProjectAssetRole::Image => "image",
        }
    }
}

/// Status of an asset in the project registry.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectAssetStatus {
    #[default]
    Available,
    Missing,
    Relinked,
}

/// One asset entry in the project file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAsset {
    pub id: String,
    pub role: ProjectAssetRole,
    pub path: String,
    #[serde(default)]
    pub status: ProjectAssetStatus,
    #[serde(default)]
    pub duration_ms: u64,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub fps: Option<f64>,
    #[serde(default)]
    pub has_audio: bool,
    pub stream_index: Option<i32>,
    #[serde(default)]
    pub source_width: Option<u32>,
    #[serde(default)]
    pub source_height: Option<u32>,
    #[serde(default)]
    pub sample_rate_hz: Option<f64>,
    #[serde(default)]
    pub schema_version: Option<u32>,
    #[serde(default)]
    pub capture_bounds: Option<crate::capture::cursor::CursorCaptureBounds>,
    #[serde(default)]
    pub dpi_scale: Option<crate::capture::cursor::CursorDpiScale>,
    #[serde(default)]
    pub timebase: Option<crate::capture::cursor::CursorTelemetryTimebase>,
    #[serde(default)]
    pub cursor_metadata: Option<String>,
}

/// Export settings persisted with the project.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectExportSettings {
    #[serde(default = "default_export_preset")]
    pub preset: String,
    #[serde(default = "default_export_codec")]
    pub codec: String,
    #[serde(default = "default_export_container")]
    pub container: String,
    #[serde(default = "default_caption_mode")]
    pub caption_mode: String,
    #[serde(default)]
    pub range: Option<crate::exports::ExportRange>,
}

impl Default for ProjectExportSettings {
    fn default() -> Self {
        Self {
            preset: default_export_preset(),
            codec: default_export_codec(),
            container: default_export_container(),
            caption_mode: default_caption_mode(),
            range: None,
        }
    }
}

fn default_export_preset() -> String {
    "default-mp4".to_string()
}

fn default_export_codec() -> String {
    "h264".to_string()
}

fn default_export_container() -> String {
    "mp4".to_string()
}

fn default_caption_mode() -> String {
    "burn-in".to_string()
}

/// Durable, versioned project file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub format: String,
    pub version: i32,
    pub id: String,
    pub name: String,
    pub recording_id: String,
    pub canvas: Value,
    pub assets: Vec<ProjectAsset>,
    pub tracks: Value,
    pub markers: Value,
    #[serde(default = "empty_json_array")]
    pub zoom_segments: Value,
    #[serde(default = "empty_json_object")]
    pub smart_zoom_settings: Value,
    pub export_settings: ProjectExportSettings,
    pub created_at: String,
    pub updated_at: String,
    pub checksum: String,
}

fn empty_json_array() -> Value {
    Value::Array(Vec::new())
}

fn empty_json_object() -> Value {
    Value::Object(serde_json::Map::new())
}

/// Result of loading a project, with any missing asset ids.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedProject {
    pub project: ProjectFile,
    pub missing_assets: Vec<String>,
}

/// Resolve the project directory for a recording.
pub fn project_dir_for_recording(recording: &LibraryRecording) -> PathBuf {
    PathBuf::from(&recording.work_dir)
}

fn project_path(project_dir: &Path) -> PathBuf {
    project_dir.join(PROJECT_FILE_NAME)
}

fn backup_path(project_dir: &Path) -> PathBuf {
    project_dir.join(PROJECT_BACKUP_NAME)
}

fn temp_path(project_dir: &Path) -> PathBuf {
    project_dir.join(PROJECT_TEMP_NAME)
}

/// Compute a SHA-256 checksum over the canonical JSON of the project
/// with the `checksum` field removed. The result is returned as lowercase hex.
pub fn compute_checksum(project: &ProjectFile) -> Result<String> {
    let mut value = serde_json::to_value(project)
        .map_err(|e| InternalError::Project(format!("serialize project for checksum: {e}")))?;

    if let Some(obj) = value.as_object_mut() {
        obj.remove("checksum");
    }

    let canonical = serde_json::to_string(&value)
        .map_err(|e| InternalError::Project(format!("canonical project json: {e}")))?;

    let hash = Sha256::digest(canonical.as_bytes());
    Ok(format!("sha256:{}", hex::encode(hash)))
}

/// Verify that the checksum in the project matches its content.
pub fn validate_checksum(project: &ProjectFile) -> Result<()> {
    let expected = compute_checksum(project)?;
    if expected != project.checksum {
        return Err(InternalError::Project(format!(
            "project checksum mismatch: expected {expected}"
        ))
        .into());
    }
    Ok(())
}

/// Apply forward-only migrations to a raw JSON project. Currently version 1 is
/// the only supported version; future migrations can be registered here.
pub fn migrate_project(value: &mut Value) -> Result<()> {
    let version = value
        .get("version")
        .and_then(Value::as_i64)
        .ok_or_else(|| InternalError::Project("project has no version".to_string()))?;

    if version > PROJECT_VERSION as i64 {
        return Err(InternalError::Project(format!(
            "project version {version} is newer than supported version {PROJECT_VERSION}"
        ))
        .into());
    }

    if version < PROJECT_VERSION as i64 {
        return Err(InternalError::Project(format!(
            "migration from version {version} to {PROJECT_VERSION} is not implemented"
        ))
        .into());
    }

    // Ensure the format field is present.
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "format".to_string(),
            Value::String(PROJECT_FORMAT.to_string()),
        );
    }

    Ok(())
}

/// Resolve a project-relative asset path to an absolute path and update status.
fn resolve_asset(asset: &mut ProjectAsset, project_dir: &Path, policy: &PathPolicy) -> Result<()> {
    let relative = Path::new(&asset.path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
    {
        return Err(InternalError::Permissions(format!(
            "asset path must stay relative to the project directory: {}",
            asset.path
        ))
        .into());
    }

    let absolute = project_dir.join(relative);

    // Containment: the resolved absolute path must be inside the project directory.
    // Canonicalize the parent when the asset is missing so Windows extended-path
    // prefixes cannot make a valid missing asset look like traversal.
    let canonical_project = project_dir
        .canonicalize()
        .unwrap_or_else(|_| project_dir.to_path_buf());
    let canonical_asset = absolute.canonicalize().unwrap_or_else(|_| {
        absolute
            .parent()
            .and_then(|parent| parent.canonicalize().ok())
            .and_then(|parent| absolute.file_name().map(|name| parent.join(name)))
            .unwrap_or_else(|| absolute.clone())
    });

    if !policy.is_contained(&canonical_project, &canonical_asset) {
        return Err(InternalError::Permissions(format!(
            "asset path escapes project directory: {}",
            asset.path
        ))
        .into());
    }

    if canonical_asset.exists() {
        if matches!(asset.status, ProjectAssetStatus::Missing) {
            // A file has reappeared (e.g. after relink or media restore).
            asset.status = ProjectAssetStatus::Available;
        }
    } else if matches!(asset.status, ProjectAssetStatus::Available) {
        asset.status = ProjectAssetStatus::Missing;
    }

    Ok(())
}

fn telemetry_asset_from_file(
    project_dir: &Path,
    _recording_id: &str,
) -> Result<Option<(ProjectAsset, u64)>> {
    let path = project_dir.join("cursor_telemetry.json");
    if !path.exists() {
        return Ok(None);
    }

    // Cursor telemetry may be V2 (metadata JSON + binary events) or legacy V1
    // (all events in JSON). read_any_telemetry migrates either into the
    // canonical V2 model for project registration.
    let v2 = match crate::capture::cursor::read_any_telemetry(project_dir) {
        Some(telemetry) => telemetry,
        None => {
            warn!("cursor telemetry asset is unavailable or corrupt");
            return Ok(None);
        }
    };

    let meta = &v2.metadata;
    let duration_ms = v2.events.last().map(|event| event.t_ms).unwrap_or(0);

    let dpi_scale = meta
        .coordinate_transform
        .dpi_scale_from_bounds(meta.source_width, meta.source_height, &meta.capture_bounds)
        .map(|scale| crate::capture::cursor::CursorDpiScale {
            x: scale.x,
            y: scale.y,
        });

    let timebase = Some(crate::capture::cursor::CursorTelemetryTimebase {
        unit: meta.timebase.unit.clone(),
        ticks_per_second: meta.timebase.ticks_per_second,
    });

    let asset = ProjectAsset {
        id: meta.asset_id.clone(),
        role: ProjectAssetRole::CursorEvents,
        path: "cursor_telemetry.json".into(),
        status: ProjectAssetStatus::Available,
        duration_ms,
        width: Some(meta.source_width as i32),
        height: Some(meta.source_height as i32),
        fps: Some(meta.sample_rate_hz as f64),
        has_audio: false,
        stream_index: None,
        source_width: Some(meta.source_width),
        source_height: Some(meta.source_height),
        sample_rate_hz: Some(meta.sample_rate_hz as f64),
        schema_version: Some(meta.schema_version),
        capture_bounds: Some(meta.capture_bounds),
        dpi_scale,
        timebase,
        cursor_metadata: Some("available".into()),
    };
    Ok(Some((asset, duration_ms)))
}

/// Register cursor telemetry in the project asset registry.
pub fn ensure_cursor_asset(project: &mut ProjectFile, project_dir: &Path) -> Result<bool> {
    let Some((asset, _duration_ms)) =
        telemetry_asset_from_file(project_dir, &project.recording_id)?
    else {
        return Ok(false);
    };
    let mut changed = false;
    if let Some(existing) = project
        .assets
        .iter_mut()
        .find(|candidate| candidate.role == ProjectAssetRole::CursorEvents)
    {
        if existing.id != asset.id
            || existing.path != asset.path
            || existing.status != ProjectAssetStatus::Available
            || existing.source_width != asset.source_width
            || existing.source_height != asset.source_height
        {
            *existing = asset.clone();
            changed = true;
        }
    } else {
        project.assets.push(asset.clone());
        changed = true;
    }

    let tracks = project
        .tracks
        .as_array_mut()
        .ok_or_else(|| InternalError::Project("project tracks must be an array".into()))?;
    let before_len = tracks.len();
    tracks.retain(|track| track.get("kind").and_then(Value::as_str) != Some("cursor"));
    if tracks.len() != before_len {
        changed = true;
    }
    Ok(changed)
}

/// Load a project from the recording's work directory.
/// If the project file does not exist, returns `Ok(None)` so the caller can bootstrap.
#[instrument(skip(project_dir, policy))]
pub fn load_project(project_dir: &Path, policy: &PathPolicy) -> Result<Option<LoadedProject>> {
    let path = project_path(project_dir);
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| InternalError::Storage(format!("read project file: {e}")))?;

    let mut value: Value = serde_json::from_str(&content)
        .map_err(|e| InternalError::Project(format!("parse project file: {e}")))?;

    migrate_project(&mut value)?;

    let mut project: ProjectFile = serde_json::from_value(value)
        .map_err(|e| InternalError::Project(format!("deserialize project: {e}")))?;

    // Validate checksum before any mutations. If the primary file is corrupt,
    // fall back to the backup if one exists.
    if let Err(err) = validate_checksum(&project) {
        warn!(error = %err, "project checksum failed; trying backup");
        let backup = backup_path(project_dir);
        if backup.exists() {
            let backup_content = fs::read_to_string(&backup)
                .map_err(|e| InternalError::Storage(format!("read project backup: {e}")))?;
            let mut backup_value: Value = serde_json::from_str(&backup_content)
                .map_err(|e| InternalError::Project(format!("parse project backup: {e}")))?;
            migrate_project(&mut backup_value)?;
            project = serde_json::from_value(backup_value)
                .map_err(|e| InternalError::Project(format!("deserialize project backup: {e}")))?;
            validate_checksum(&project)?;
            info!("loaded project from backup");
        } else {
            return Err(err);
        }
    }

    if project.format != PROJECT_FORMAT {
        return Err(
            InternalError::Project(format!("unknown project format: {}", project.format)).into(),
        );
    }

    let mut missing_assets = Vec::new();
    for asset in &mut project.assets {
        resolve_asset(asset, project_dir, policy)?;
        if matches!(asset.status, ProjectAssetStatus::Missing) {
            missing_assets.push(asset.id.clone());
        }
    }

    if ensure_cursor_asset(&mut project, project_dir)? {
        project = save_project(&project, project_dir)?;
        missing_assets = project
            .assets
            .iter()
            .filter(|asset| matches!(asset.status, ProjectAssetStatus::Missing))
            .map(|asset| asset.id.clone())
            .collect();
    }

    Ok(Some(LoadedProject {
        project,
        missing_assets,
    }))
}

/// Save a project to disk with an atomic write, backup copy, and fresh checksum.
#[instrument(skip(project, project_dir))]
pub fn save_project(project: &ProjectFile, project_dir: &Path) -> Result<ProjectFile> {
    if !project_dir.exists() {
        fs::create_dir_all(project_dir)
            .map_err(|e| InternalError::Storage(format!("create project directory: {e}")))?;
    }

    let mut to_save = project.clone();
    to_save.updated_at = Utc::now().to_rfc3339();
    to_save.checksum = compute_checksum(&to_save)?;

    let path = project_path(project_dir);
    let temp = temp_path(project_dir);
    let backup = backup_path(project_dir);

    // Preserve the previous good version as a backup before overwriting.
    if path.exists() {
        fs::copy(&path, &backup)
            .map_err(|e| InternalError::Storage(format!("backup project before save: {e}")))?;
    }

    let json = serde_json::to_string_pretty(&to_save)
        .map_err(|e| InternalError::Project(format!("serialize project: {e}")))?;

    fs::write(&temp, json)
        .map_err(|e| InternalError::Storage(format!("write project temp: {e}")))?;

    atomic_replace(&temp, &path)?;

    info!(project_id = %to_save.id, "project saved atomically");
    Ok(to_save)
}

/// Create a snapshot backup before a destructive editor operation.
/// Keeps at most 5 timestamped snapshots; older ones are pruned.
#[instrument(skip(project_dir))]
pub fn snapshot_project(project_dir: &Path) -> Result<PathBuf> {
    let path = project_path(project_dir);
    if !path.exists() {
        return Err(InternalError::Project("no project file to snapshot".to_string()).into());
    }

    let timestamp = Utc::now().format("%Y%m%d%H%M%S").to_string();
    let snapshot = project_dir.join(format!("project.{timestamp}.json.bak"));
    fs::copy(&path, &snapshot)
        .map_err(|e| InternalError::Storage(format!("snapshot project: {e}")))?;

    prune_snapshots(project_dir)?;
    Ok(snapshot)
}

fn prune_snapshots(project_dir: &Path) -> Result<()> {
    let mut snapshots: Vec<PathBuf> = fs::read_dir(project_dir)
        .map_err(|e| InternalError::Storage(format!("list snapshots: {e}")))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("project.") && n.ends_with(".json.bak"))
                .unwrap_or(false)
        })
        .collect();

    snapshots.sort();
    while snapshots.len() > 5 {
        if let Some(oldest) = snapshots.first() {
            if let Err(err) = fs::remove_file(oldest) {
                warn!(error = %err, "failed to prune old snapshot");
            }
            snapshots.remove(0);
        }
    }

    Ok(())
}

/// Return a path relative to the project directory when the absolute path is
/// inside it; otherwise return the absolute path as a fallback.
fn make_project_relative(project_dir: &Path, absolute: &Path) -> String {
    if let Ok(project_canonical) = project_dir.canonicalize() {
        if let Ok(asset_canonical) = absolute.canonicalize() {
            if asset_canonical.starts_with(&project_canonical) {
                return asset_canonical
                    .strip_prefix(&project_canonical)
                    .unwrap_or(absolute)
                    .to_string_lossy()
                    .to_string()
                    .trim_start_matches(['\\', '/'])
                    .to_string();
            }
        }
    }
    absolute.to_string_lossy().to_string()
}

/// Build the primary screen asset from a recording and its metadata.
fn create_screen_asset(recording: &LibraryRecording, metadata: &MediaMetadata) -> ProjectAsset {
    let filename = recording
        .output_path
        .as_ref()
        .and_then(|p| Path::new(p).file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("output.mp4")
        .to_string();

    ProjectAsset {
        id: recording.id.clone(),
        role: ProjectAssetRole::Screen,
        path: filename,
        status: ProjectAssetStatus::Available,
        duration_ms: metadata.duration_ms,
        width: metadata.width,
        height: metadata.height,
        fps: metadata.fps,
        has_audio: metadata.has_audio,
        stream_index: None,
        source_width: None,
        source_height: None,
        sample_rate_hz: None,
        schema_version: None,
        capture_bounds: None,
        dpi_scale: None,
        timebase: None,
        cursor_metadata: None,
    }
}

/// Bootstrap a new project file from a library recording and cached metadata.
#[instrument(skip(recording, metadata, project_dir))]
pub fn create_project(
    recording: &LibraryRecording,
    metadata: &MediaMetadata,
    name: Option<&str>,
    project_dir: &Path,
) -> Result<ProjectFile> {
    let now = Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();

    if !project_dir.exists() {
        fs::create_dir_all(project_dir)
            .map_err(|e| InternalError::Storage(format!("create project directory: {e}")))?;
    }

    let screen_asset = create_screen_asset(recording, metadata);

    // Placeholder timeline structure that the editor will replace on first load.
    // It is valid enough to be saved and loaded, and every clip is expected to
    // reference the screen asset id (the recording id) for the bootstrap.
    let tracks = serde_json::json!([
        {
            "id": uuid::Uuid::new_v4().to_string(),
            "kind": "screen",
            "name": "Screen",
            "muted": false,
            "locked": false,
            "solo": false,
            "volume": 1,
            "clips": [
                {
                    "id": uuid::Uuid::new_v4().to_string(),
                    "kind": "screen",
                    "assetId": recording.id,
                    "streamIndex": null,
                    "startMs": 0,
                    "durationMs": metadata.duration_ms,
                    "sourceInMs": 0,
                    "sourceOutMs": metadata.duration_ms,
                    "speed": 1
                }
            ]
        }
    ]);

    let project = ProjectFile {
        format: PROJECT_FORMAT.to_string(),
        version: PROJECT_VERSION,
        id,
        name: name.unwrap_or(&recording.name).to_string(),
        recording_id: recording.id.clone(),
        canvas: serde_json::json!({
            "width": metadata.width.unwrap_or(recording.width),
            "height": metadata.height.unwrap_or(recording.height),
            "fps": metadata.fps.map(|f| f.round() as i32).unwrap_or(recording.fps),
            "background": "#000000",
            "padding": 0,
            "borderRadius": 0,
            "shadow": false,
            "cursorSettings": {
                "preset": "recorded-system",
                "scale": 1.0,
                "fillColor": "#3b82f6",
                "fillOpacity": 1.0,
                "strokeColor": "#ffffff",
                "strokeWidth": 2.0,
                "strokeOpacity": 1.0,
                "shadowEnabled": true,
                "shadowColor": "#000000",
                "shadowBlur": 8.0,
                "shadowOffsetX": 2.0,
                "shadowOffsetY": 4.0,
                "shadowOpacity": 0.4,
                "clickFeedback": "ripple",
                "clickColor": "#60a5fa",
                "clickSize": 36.0,
                "smoothMovement": true,
                "smoothFactor": 0.25,
                "autoHideIdle": false,
                "idleTimeoutMs": 2000,
                "spotlightMode": false,
                "spotlightRadius": 120,
                "spotlightDimOpacity": 0.5,
                "hideNativeCursor": true
            }
        }),
        assets: vec![screen_asset],
        tracks,
        markers: Value::Array(vec![]),
        zoom_segments: Value::Array(vec![]),
        smart_zoom_settings: empty_json_object(),
        export_settings: ProjectExportSettings::default(),
        created_at: now.clone(),
        updated_at: now,
        checksum: String::new(),
    };

    let mut project = project;
    // The command layer will replace the bootstrap tracks via the domain
    // timeline builder; leaving a valid project file on disk satisfies the
    // "opening creates a stable project identity" acceptance criterion.
    ensure_cursor_asset(&mut project, project_dir)?;
    save_project(&project, project_dir)
}

/// Rename an existing project.
#[instrument]
pub fn rename_project(
    project: &ProjectFile,
    project_dir: &Path,
    new_name: &str,
) -> Result<ProjectFile> {
    let mut renamed = project.clone();
    renamed.name = new_name.to_string();
    save_project(&renamed, project_dir)
}

/// Duplicate a project in memory, returning a new project with a fresh id and name.
/// The caller is responsible for saving the duplicate to a chosen location.
#[instrument]
pub fn duplicate_project(project: &ProjectFile, new_name: Option<&str>) -> ProjectFile {
    let now = Utc::now().to_rfc3339();
    let name = new_name
        .map(|n| n.to_string())
        .unwrap_or_else(|| format!("Copy of {}", project.name));

    let mut duplicate = project.clone();
    duplicate.id = uuid::Uuid::new_v4().to_string();
    duplicate.name = name;
    duplicate.created_at = now.clone();
    duplicate.updated_at = now;
    duplicate.checksum = String::new();
    duplicate
}

/// Delete a project's persisted files and return the project id.
#[instrument(skip(project_dir))]
pub fn delete_project(project_dir: &Path) -> Result<()> {
    let path = project_path(project_dir);
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| InternalError::Storage(format!("delete project file: {e}")))?;
    }
    let backup = backup_path(project_dir);
    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    // Remove timestamped snapshots as well.
    if let Ok(entries) = fs::read_dir(project_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                if name.starts_with("project.") && name.ends_with(".json.bak") {
                    let _ = fs::remove_file(&p);
                }
            }
        }
    }
    Ok(())
}

/// Relink an asset to a new file path. The new path is stored relative to the
/// project directory when possible.
#[instrument(skip(project, project_dir, new_path, policy))]
pub fn relink_asset(
    project: &ProjectFile,
    project_dir: &Path,
    asset_id: &str,
    new_path: &Path,
    policy: &PathPolicy,
) -> Result<ProjectFile> {
    let new_path = policy
        .validate_project_asset_path(project_dir, new_path)
        .map_err(|e| InternalError::Project(format!("relink path invalid: {e}")))?;

    if !new_path.exists() {
        return Err(InternalError::Project("relink target does not exist".to_string()).into());
    }

    let relative = make_project_relative(project_dir, &new_path);

    let mut updated = project.clone();
    for asset in &mut updated.assets {
        if asset.id == asset_id {
            asset.path = relative.clone();
            asset.status = ProjectAssetStatus::Relinked;
        }
    }

    save_project(&updated, project_dir)
}

/// Convenience function for building an asset id -> path map for export.
pub fn asset_path_map(project: &ProjectFile, project_dir: &Path) -> HashMap<String, PathBuf> {
    let mut map = HashMap::new();
    for asset in &project.assets {
        if matches!(
            asset.status,
            ProjectAssetStatus::Available | ProjectAssetStatus::Relinked
        ) {
            map.insert(asset.id.clone(), project_dir.join(&asset.path));
        }
    }
    map
}

/// Resolve all exportable assets through the same containment checks used by
/// project loading. Export callers receive canonical IDs mapped to existing paths only.
pub fn load_asset_path_map(project_dir: &Path) -> Result<HashMap<String, PathBuf>> {
    let policy = PathPolicy::new(project_dir.to_path_buf(), project_dir.to_path_buf());
    let loaded = load_project(project_dir, &policy)?
        .ok_or_else(|| InternalError::Project("project file is required for export".into()))?;
    let mut paths = HashMap::new();
    for asset in loaded.project.assets.iter().filter(|asset| {
        matches!(
            asset.status,
            ProjectAssetStatus::Available | ProjectAssetStatus::Relinked
        )
    }) {
        let path = project_dir.join(&asset.path);
        let canonical = policy.validate_project_asset_path(project_dir, &path)?;
        paths.insert(asset.id.clone(), canonical);
    }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::cursor::CursorTelemetryFile;

    fn make_test_recording(work_dir: &Path) -> (LibraryRecording, MediaMetadata) {
        let recording = LibraryRecording {
            id: "rec-1".to_string(),
            session_id: "session-1".to_string(),
            name: "Test Recording".to_string(),
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
            duration_ms: 10_000,
            size_bytes: 0,
            width: 1920,
            height: 1080,
            fps: 30,
            status: crate::database::library::LibraryRecordingStatus::Completed,
            tags: vec![],
            source: crate::capture::source::CaptureSource {
                kind: "display".to_string(),
                id: "disp-1".to_string(),
                name: "Display".to_string(),
                bounds: crate::capture::source::Bounds {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            },
            profile_name: "balanced".to_string(),
            output_path: Some(work_dir.join("output.mp4").to_string_lossy().to_string()),
            webcam_path: None,
            work_dir: work_dir.to_string_lossy().to_string(),
            thumbnail_path: None,
            markers: vec![],
        };

        let metadata = MediaMetadata {
            recording_id: recording.id.clone(),
            path: recording.output_path.clone().unwrap_or_default(),
            duration_ms: 10_000,
            width: Some(1920),
            height: Some(1080),
            fps: Some(30.0),
            has_audio: true,
            video_codec: Some("h264".to_string()),
            audio_codec: Some("aac".to_string()),
            bitrate_kbps: None,
            streams: vec![],
            format: crate::database::media::MediaFormat::default(),
            updated_at: Utc::now().to_rfc3339(),
        };

        (recording, metadata)
    }

    fn policy() -> PathPolicy {
        let temp = std::env::temp_dir();
        PathPolicy::new(temp.clone(), temp.join("sessions"))
    }

    #[test]
    fn test_checksum_round_trip() {
        let project = ProjectFile {
            format: PROJECT_FORMAT.to_string(),
            version: 1,
            id: "p1".to_string(),
            name: "Test".to_string(),
            recording_id: "rec-1".to_string(),
            canvas: Value::Null,
            assets: vec![],
            tracks: Value::Null,
            markers: Value::Null,
            zoom_segments: Value::Null,
            smart_zoom_settings: Value::Null,
            export_settings: ProjectExportSettings::default(),
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
            checksum: String::new(),
        };

        let checksum = compute_checksum(&project).unwrap();
        let mut with_checksum = project.clone();
        with_checksum.checksum = checksum.clone();
        assert!(validate_checksum(&with_checksum).is_ok());

        with_checksum.checksum = "invalid".to_string();
        assert!(validate_checksum(&with_checksum).is_err());
    }

    #[test]
    fn test_atomic_save_and_load() {
        let temp = tempfile::tempdir().unwrap();
        let project_dir = temp.path().join("project");
        let (recording, metadata) = make_test_recording(&project_dir);
        fs::create_dir_all(&project_dir).unwrap();
        fs::write(project_dir.join("output.mp4"), b"fake").unwrap();

        let project = create_project(&recording, &metadata, None, &project_dir).unwrap();
        assert!(project_path(&project_dir).exists());

        let loaded = load_project(&project_dir, &policy()).unwrap().unwrap();
        assert_eq!(loaded.project.id, project.id);
        assert!(loaded.missing_assets.is_empty());
    }

    #[test]
    fn test_cursor_asset_is_registered() {
        let temp = tempfile::tempdir().unwrap();
        let project_dir = temp.path().join("project");
        let (recording, metadata) = make_test_recording(&project_dir);
        fs::create_dir_all(&project_dir).unwrap();
        fs::write(project_dir.join("output.mp4"), b"fake").unwrap();
        let telemetry = CursorTelemetryFile::new(
            recording.id.clone(),
            1920,
            1080,
            crate::capture::cursor::CursorCaptureBounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            vec![],
        );
        fs::write(
            project_dir.join("cursor_telemetry.json"),
            serde_json::to_string(&telemetry).unwrap(),
        )
        .unwrap();

        let project = create_project(&recording, &metadata, None, &project_dir).unwrap();
        let cursor_asset = project
            .assets
            .iter()
            .find(|asset| asset.role == ProjectAssetRole::CursorEvents)
            .expect("cursor asset");
        assert_eq!(cursor_asset.id, "cursor-events:rec-1");
        let tracks = project.tracks.as_array().expect("tracks");
        assert!(!tracks
            .iter()
            .any(|track| { track.get("kind").and_then(Value::as_str) == Some("cursor") }));
    }

    #[test]
    fn test_missing_asset_detected() {
        let temp = tempfile::tempdir().unwrap();
        let project_dir = temp.path().join("project");
        let (recording, metadata) = make_test_recording(&project_dir);

        fs::create_dir_all(&project_dir).unwrap();
        fs::write(project_dir.join("output.mp4"), b"fake").unwrap();

        let mut project = create_project(&recording, &metadata, None, &project_dir).unwrap();
        project.assets[0].status = ProjectAssetStatus::Available;
        save_project(&project, &project_dir).unwrap();

        fs::remove_file(project_dir.join("output.mp4")).unwrap();

        let loaded = load_project(&project_dir, &policy()).unwrap().unwrap();
        assert_eq!(loaded.missing_assets.len(), 1);
    }
}
