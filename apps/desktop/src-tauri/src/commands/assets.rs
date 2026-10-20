use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use tracing::instrument;

use crate::commands::projects::index_project;
use crate::database::library::{get_recording, LibraryRecording};
use crate::database::media::{MediaFormat, MediaJob, MediaMetadata};
use crate::errors::{InternalError, Result};
use crate::jobs::AssetDerivativeOptions;
use crate::projects::{
    absolute_asset_path, load_project, make_project_relative, save_project, ProjectAsset,
    ProjectAssetRole, ProjectAssetStatus, ProjectFile,
};
use crate::state::AppState;

const MAX_IMPORT_COUNT: usize = 100;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetImportRequest {
    pub recording_id: String,
    pub paths: Vec<String>,
    #[serde(default = "default_import_strategy")]
    pub strategy: String,
    pub role: Option<ProjectAssetRole>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAsset {
    pub asset: ProjectAsset,
    pub source_name: String,
    pub derivative_job_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedAsset {
    pub source_name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetImportResult {
    pub project: ProjectFile,
    pub imported: Vec<ImportedAsset>,
    pub skipped: Vec<SkippedAsset>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDeleteRequest {
    pub recording_id: String,
    pub asset_id: String,
    #[serde(default)]
    pub delete_source: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRelinkRequest {
    pub recording_id: String,
    pub asset_id: String,
    pub new_path: String,
    pub strategy: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetProbeRequest {
    pub path: String,
    pub recording_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDerivativeJobRequest {
    pub recording_id: String,
    pub asset_id: String,
    #[serde(default)]
    pub force: bool,
}

fn default_import_strategy() -> String {
    "copy".into()
}

/// Import one or more assets into the durable project registry.
#[tauri::command]
#[instrument(skip(request, state))]
pub fn import_assets(
    request: AssetImportRequest,
    state: State<'_, AppState>,
) -> Result<AssetImportResult> {
    let _update_operation = state.update_gate.acquire_operation()?;
    if request.paths.is_empty() || request.paths.len() > MAX_IMPORT_COUNT {
        return Err(InternalError::Project(format!(
            "select between 1 and {MAX_IMPORT_COUNT} asset files"
        ))
        .into());
    }
    let strategy = normalize_strategy(&request.strategy)?;
    let recording = get_recording_for_state(&state, &request.recording_id)?;
    let project_dir = PathBuf::from(&recording.work_dir);
    let loaded = load_project(&project_dir, &state.path_policy)?.ok_or_else(|| {
        InternalError::Project(format!(
            "no project found for recording {}",
            request.recording_id
        ))
    })?;
    let mut project = loaded.project;
    let mut imported = Vec::new();
    let mut skipped = Vec::new();
    let mut warnings = Vec::new();
    let mut copied_paths = Vec::new();

    for raw_path in request.paths {
        let source = PathBuf::from(&raw_path);
        let source_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("selected asset")
            .to_string();
        let Some(kind) = media_kind_for_path(&source) else {
            skipped.push(SkippedAsset {
                source_name,
                reason: "unsupported media format".into(),
            });
            continue;
        };

        let source = match state.path_policy.validate_import_source_path(&source) {
            Ok(source) => source,
            Err(error) => {
                skipped.push(SkippedAsset {
                    source_name,
                    reason: error.to_string(),
                });
                continue;
            }
        };

        if crate::media::svg::is_svg_path(&source) {
            if let Err(error) = crate::media::svg::read_safe_svg(&source) {
                skipped.push(SkippedAsset {
                    source_name,
                    reason: error.to_string(),
                });
                continue;
            }
        }

        let content_hash = match hash_file(&source) {
            Ok(hash) => hash,
            Err(error) => {
                skipped.push(SkippedAsset {
                    source_name,
                    reason: error.to_string(),
                });
                continue;
            }
        };
        if project
            .assets
            .iter()
            .any(|asset| asset.content_hash.as_deref() == Some(content_hash.as_str()))
        {
            skipped.push(SkippedAsset {
                source_name,
                reason: "asset is already in this project".into(),
            });
            continue;
        }

        let metadata =
            match probe_asset_path(&state.ffprobe_path, &source, &request.recording_id, kind) {
                Ok(metadata) => metadata,
                Err(error) => {
                    skipped.push(SkippedAsset {
                        source_name,
                        reason: format!("could not probe media: {error}"),
                    });
                    continue;
                }
            };

        let role = request.role.unwrap_or_else(|| default_role_for_kind(kind));
        let (stored_path, original_path) = if strategy == "copy" {
            let destination = copy_asset_into_project(&project_dir, &source, &content_hash)?;
            copied_paths.push(destination.clone());
            (
                make_project_relative(&project_dir, &destination).replace('\\', "/"),
                Some(source.to_string_lossy().to_string()),
            )
        } else {
            (
                source.to_string_lossy().to_string(),
                Some(source.to_string_lossy().to_string()),
            )
        };

        let asset = ProjectAsset {
            id: format!("asset-{}", content_hash.trim_start_matches("sha256:")),
            role,
            kind: Some(kind.to_string()),
            path: stored_path,
            status: ProjectAssetStatus::Available,
            content_hash: Some(content_hash),
            import_strategy: Some(strategy.to_string()),
            original_path,
            svg_safe: crate::media::svg::is_svg_path(&source).then_some(true),
            derivative_version: 1,
            derivatives: None,
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
        };
        project.assets.push(asset.clone());
        imported.push(ImportedAsset {
            asset,
            source_name,
            derivative_job_id: None,
        });
    }

    if imported.is_empty() {
        return Ok(AssetImportResult {
            project,
            imported,
            skipped,
            warnings,
        });
    }

    let saved = match save_project(&project, &project_dir) {
        Ok(saved) => saved,
        Err(error) => {
            for copied_path in copied_paths {
                let _ = std::fs::remove_file(copied_path);
            }
            return Err(error);
        }
    };
    index_project(&state, &saved)?;

    for record in &mut imported {
        let source = absolute_asset_path(&record.asset, &project_dir);
        let options = AssetDerivativeOptions {
            recording_id: request.recording_id.clone(),
            asset_id: record.asset.id.clone(),
            source_path: source.to_string_lossy().to_string(),
            asset_kind: record.asset.kind.clone().unwrap_or_default(),
            force: false,
        };
        match queue_derivative_job(&state, options) {
            Ok(job) => record.derivative_job_id = Some(job.id),
            Err(error) => warnings.push(format!(
                "derivatives could not be queued for {}: {error}",
                record.source_name
            )),
        }
    }

    Ok(AssetImportResult {
        project: saved,
        imported,
        skipped,
        warnings,
    })
}

/// Delete an asset when no timeline clip still references it.
#[tauri::command]
#[instrument(skip(request, state))]
pub fn delete_asset(request: AssetDeleteRequest, state: State<'_, AppState>) -> Result<()> {
    let _update_operation = state.update_gate.acquire_operation()?;
    let recording = get_recording_for_state(&state, &request.recording_id)?;
    let project_dir = PathBuf::from(&recording.work_dir);
    let loaded = load_project(&project_dir, &state.path_policy)?.ok_or_else(|| {
        InternalError::Project(format!(
            "no project found for recording {}",
            request.recording_id
        ))
    })?;
    let mut project = loaded.project;
    project
        .assets
        .iter()
        .find(|asset| asset.id == request.asset_id)
        .ok_or_else(|| InternalError::Project("asset was not found".into()))?;

    if value_references_asset(&project.tracks, &request.asset_id) {
        return Err(InternalError::Project(
            "asset is in use by a timeline clip and cannot be deleted".into(),
        )
        .into());
    }

    cancel_asset_jobs(&state, &request.recording_id, &request.asset_id)?;
    let removed = project.assets.remove(
        project
            .assets
            .iter()
            .position(|candidate| candidate.id == request.asset_id)
            .ok_or_else(|| InternalError::Project("asset was not found".into()))?,
    );
    let saved = save_project(&project, &project_dir)?;
    index_project(&state, &saved)?;
    remove_asset_derivatives(&state, &project_dir, &request.recording_id, &removed)?;

    if request.delete_source && removed.import_strategy.as_deref() == Some("copy") {
        let source = absolute_asset_path(&removed, &project_dir);
        let safe_source = state
            .path_policy
            .validate_project_asset_path(&project_dir, &source)?;
        let _ = std::fs::remove_file(safe_source);
    }

    Ok(())
}

/// Relink a missing asset to a newly selected source and restart derivatives.
#[tauri::command]
#[instrument(skip(request, state))]
pub fn relink_asset(
    request: AssetRelinkRequest,
    state: State<'_, AppState>,
) -> Result<ProjectAsset> {
    let _update_operation = state.update_gate.acquire_operation()?;
    let recording = get_recording_for_state(&state, &request.recording_id)?;
    let project_dir = PathBuf::from(&recording.work_dir);
    let loaded = load_project(&project_dir, &state.path_policy)?.ok_or_else(|| {
        InternalError::Project(format!(
            "no project found for recording {}",
            request.recording_id
        ))
    })?;
    let mut project = loaded.project;
    let asset = project
        .assets
        .iter_mut()
        .find(|asset| asset.id == request.asset_id)
        .ok_or_else(|| InternalError::Project("asset was not found".into()))?;

    let source = state
        .path_policy
        .validate_import_source_path(Path::new(&request.new_path))?;
    if crate::media::svg::is_svg_path(&source) {
        crate::media::svg::read_safe_svg(&source)?;
    }
    let kind = media_kind_for_path(&source)
        .ok_or_else(|| InternalError::Media("relink target has an unsupported format".into()))?;
    let metadata = probe_asset_path(&state.ffprobe_path, &source, &request.recording_id, kind)?;
    let content_hash = hash_file(&source)?;
    let strategy = request
        .strategy
        .as_deref()
        .map(normalize_strategy)
        .transpose()?
        .map(str::to_string)
        .unwrap_or_else(|| {
            asset
                .import_strategy
                .as_deref()
                .map(str::to_string)
                .unwrap_or_else(default_import_strategy)
        });
    let (stored_path, original_path) = if strategy == "copy" {
        let destination = copy_asset_into_project(&project_dir, &source, &content_hash)?;
        (
            make_project_relative(&project_dir, &destination).replace('\\', "/"),
            Some(source.to_string_lossy().to_string()),
        )
    } else {
        (
            source.to_string_lossy().to_string(),
            Some(source.to_string_lossy().to_string()),
        )
    };

    asset.kind = Some(kind.to_string());
    asset.path = stored_path;
    asset.status = ProjectAssetStatus::Relinked;
    asset.content_hash = Some(content_hash);
    asset.import_strategy = Some(strategy);
    asset.original_path = original_path;
    asset.svg_safe = crate::media::svg::is_svg_path(&source).then_some(true);
    asset.derivatives = None;
    asset.derivative_version = asset.derivative_version.saturating_add(1);
    asset.duration_ms = metadata.duration_ms;
    asset.width = metadata.width;
    asset.height = metadata.height;
    asset.fps = metadata.fps;
    asset.has_audio = metadata.has_audio;
    let updated_asset = asset.clone();

    let saved = save_project(&project, &project_dir)?;
    index_project(&state, &saved)?;
    cancel_asset_jobs(&state, &request.recording_id, &request.asset_id)?;
    let source_path = absolute_asset_path(&updated_asset, &project_dir);
    let _ = queue_derivative_job(
        &state,
        AssetDerivativeOptions {
            recording_id: request.recording_id,
            asset_id: updated_asset.id.clone(),
            source_path: source_path.to_string_lossy().to_string(),
            asset_kind: kind.to_string(),
            force: true,
        },
    );

    Ok(updated_asset)
}

/// Probe a user-selected asset without mutating the project.
#[tauri::command]
#[instrument(skip(request, state))]
pub fn probe_asset(
    request: AssetProbeRequest,
    state: State<'_, AppState>,
) -> Result<MediaMetadata> {
    let source = state
        .path_policy
        .validate_import_source_path(Path::new(&request.path))?;
    let kind = media_kind_for_path(&source)
        .ok_or_else(|| InternalError::Media("unsupported asset format".into()))?;
    if crate::media::svg::is_svg_path(&source) {
        crate::media::svg::read_safe_svg(&source)?;
    }
    probe_asset_path(
        &state.ffprobe_path,
        &source,
        request.recording_id.as_deref().unwrap_or("asset-probe"),
        kind,
    )
}

/// Restart derivative generation for an existing project asset.
#[tauri::command]
#[instrument(skip(request, state))]
pub fn start_derivative_job(
    request: AssetDerivativeJobRequest,
    state: State<'_, AppState>,
) -> Result<MediaJob> {
    let _update_operation = state.update_gate.acquire_operation()?;
    let recording = get_recording_for_state(&state, &request.recording_id)?;
    let project_dir = PathBuf::from(&recording.work_dir);
    let loaded = load_project(&project_dir, &state.path_policy)?.ok_or_else(|| {
        InternalError::Project(format!(
            "no project found for recording {}",
            request.recording_id
        ))
    })?;
    let asset = loaded
        .project
        .assets
        .iter()
        .find(|asset| asset.id == request.asset_id)
        .ok_or_else(|| InternalError::Project("asset was not found".into()))?;
    let source = absolute_asset_path(asset, &project_dir);
    if !source.is_file() {
        return Err(InternalError::Project("asset source is missing".into()).into());
    }

    queue_derivative_job(
        &state,
        AssetDerivativeOptions {
            recording_id: request.recording_id,
            asset_id: asset.id.clone(),
            source_path: source.to_string_lossy().to_string(),
            asset_kind: asset.kind.clone().unwrap_or_default(),
            force: request.force,
        },
    )
}

fn queue_derivative_job(state: &AppState, options: AssetDerivativeOptions) -> Result<MediaJob> {
    let manager = state
        .job_manager
        .lock()
        .map_err(|_| InternalError::Unknown("job manager mutex poisoned".into()))?;
    manager.start_asset_derivative(options)
}

fn cancel_asset_jobs(state: &AppState, recording_id: &str, asset_id: &str) -> Result<()> {
    let manager = state
        .job_manager
        .lock()
        .map_err(|_| InternalError::Unknown("job manager mutex poisoned".into()))?;
    let jobs = manager.list_jobs(recording_id)?;
    for job in jobs.into_iter().filter(|job| {
        job.kind == crate::database::media::MediaJobKind::AssetDerivative
            && job
                .options
                .get("assetId")
                .and_then(serde_json::Value::as_str)
                == Some(asset_id)
            && matches!(
                job.status,
                crate::database::media::MediaJobStatus::Pending
                    | crate::database::media::MediaJobStatus::Running
            )
    }) {
        let _ = manager.cancel_job(&job.id);
    }
    Ok(())
}

fn remove_asset_derivatives(
    state: &AppState,
    project_dir: &Path,
    recording_id: &str,
    asset: &ProjectAsset,
) -> Result<()> {
    let paths: Vec<String> = asset
        .derivatives
        .as_ref()
        .into_iter()
        .flat_map(|derivatives| derivatives.values().cloned())
        .collect();
    let resolved_paths: Vec<String> = paths
        .iter()
        .map(|path| {
            let candidate = Path::new(path);
            let resolved = if candidate.is_absolute() {
                candidate.to_path_buf()
            } else {
                project_dir.join(candidate)
            };
            if resolved.is_file()
                && state
                    .path_policy
                    .validate_project_asset_path(project_dir, &resolved)
                    .is_ok()
            {
                let _ = std::fs::remove_file(&resolved);
            }
            resolved.to_string_lossy().to_string()
        })
        .collect();

    let conn = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    crate::database::media::delete_derivatives_for_paths(&conn, recording_id, &resolved_paths)
}

fn get_recording_for_state(state: &AppState, recording_id: &str) -> Result<LibraryRecording> {
    let conn = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    get_recording(&conn, recording_id)
}

fn normalize_strategy(strategy: &str) -> Result<&'static str> {
    match strategy {
        "copy" => Ok("copy"),
        "reference" => Ok("reference"),
        _ => Err(
            InternalError::Project("asset import strategy must be copy or reference".into()).into(),
        ),
    }
}

fn media_kind_for_path(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "svg" => Some("image"),
        "mp3" | "wav" | "aac" | "m4a" | "flac" | "ogg" | "opus" => Some("audio"),
        "mp4" | "mov" | "mkv" | "webm" | "avi" | "m4v" => Some("video"),
        _ => None,
    }
}

fn default_role_for_kind(kind: &str) -> ProjectAssetRole {
    match kind {
        "audio" => ProjectAssetRole::Music,
        "video" => ProjectAssetRole::BRoll,
        _ => ProjectAssetRole::Graphic,
    }
}

fn hash_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)
        .map_err(|error| InternalError::Storage(format!("open asset for hashing: {error}")))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| InternalError::Storage(format!("hash asset: {error}")))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn copy_asset_into_project(
    project_dir: &Path,
    source: &Path,
    content_hash: &str,
) -> Result<PathBuf> {
    let assets_dir = project_dir.join("assets");
    std::fs::create_dir_all(&assets_dir).map_err(|error| {
        InternalError::Storage(format!("create project asset directory: {error}"))
    })?;
    let project_root = crate::path_policy::canonicalize_path(project_dir).map_err(|error| {
        InternalError::Storage(format!("canonicalize project directory: {error}"))
    })?;
    let canonical_assets = crate::path_policy::canonicalize_path(&assets_dir).map_err(|error| {
        InternalError::Storage(format!("canonicalize project asset directory: {error}"))
    })?;
    if !canonical_assets.starts_with(&project_root) {
        return Err(InternalError::Permissions(
            "project asset directory escapes the project".into(),
        )
        .into());
    }

    let hash_prefix = content_hash
        .strip_prefix("sha256:")
        .unwrap_or(content_hash)
        .chars()
        .take(16)
        .collect::<String>();
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .map(sanitize_filename)
        .unwrap_or_else(|| "asset.bin".into());
    let destination = canonical_assets.join(format!("{hash_prefix}-{name}"));
    if !destination.starts_with(&canonical_assets) {
        return Err(InternalError::Permissions("asset destination is invalid".into()).into());
    }
    if destination.exists() {
        let canonical_destination =
            crate::path_policy::canonicalize_path(&destination).map_err(|error| {
                InternalError::Storage(format!("canonicalize copied asset: {error}"))
            })?;
        if !canonical_destination.starts_with(&canonical_assets) {
            return Err(InternalError::Permissions(
                "copied asset destination is a symlink outside the project".into(),
            )
            .into());
        }
    } else {
        std::fs::copy(source, &destination)
            .map_err(|error| InternalError::Storage(format!("copy asset into project: {error}")))?;
    }
    Ok(destination)
}

fn sanitize_filename(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('.');
    if trimmed.is_empty() {
        "asset.bin".into()
    } else {
        trimmed.chars().take(120).collect()
    }
}

fn probe_asset_path(
    ffprobe_path: &Path,
    source: &Path,
    recording_id: &str,
    kind: &str,
) -> Result<MediaMetadata> {
    if crate::media::svg::is_svg_path(source) {
        return Ok(static_image_metadata(recording_id, source));
    }
    match crate::media::probe::probe_media(&ffprobe_path.to_string_lossy(), source, recording_id) {
        Ok(metadata) => Ok(metadata),
        Err(_error) if kind == "image" => Ok(static_image_metadata(recording_id, source)),
        Err(error) => Err(error),
    }
}

fn static_image_metadata(recording_id: &str, source: &Path) -> MediaMetadata {
    MediaMetadata {
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
        updated_at: Utc::now().to_rfc3339(),
    }
}

fn value_references_asset(value: &serde_json::Value, asset_id: &str) -> bool {
    match value {
        serde_json::Value::Object(object) => {
            if object.get("assetId").and_then(serde_json::Value::as_str) == Some(asset_id) {
                return true;
            }
            object
                .values()
                .any(|value| value_references_asset(value, asset_id))
        }
        serde_json::Value::Array(values) => values
            .iter()
            .any(|value| value_references_asset(value, asset_id)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_extensions_to_media_kinds_and_roles() {
        assert_eq!(media_kind_for_path(Path::new("logo.SVG")), Some("image"));
        assert_eq!(media_kind_for_path(Path::new("voice.M4A")), Some("audio"));
        assert_eq!(media_kind_for_path(Path::new("clip.MP4")), Some("video"));
        assert_eq!(media_kind_for_path(Path::new("notes.txt")), None);
        assert_eq!(default_role_for_kind("audio"), ProjectAssetRole::Music);
    }

    #[test]
    fn detects_asset_references_in_nested_project_json() {
        let tracks = serde_json::json!([{ "clips": [{ "assetId": "asset-1" }] }]);
        assert!(value_references_asset(&tracks, "asset-1"));
        assert!(!value_references_asset(&tracks, "asset-2"));
    }

    #[test]
    fn sanitizes_names_without_allowing_path_components() {
        assert_eq!(
            sanitize_filename("..\\secret/file?.mp4"),
            "_secret_file_.mp4"
        );
    }
}
