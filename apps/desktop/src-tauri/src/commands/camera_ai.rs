//! Tauri commands for offline camera AI (#4a–c runtime plumbing).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tracing::{instrument, warn};

use crate::errors::{AppError, ErrorCategory, InternalError, Result};
use crate::media::camera_ai::{self, CameraAiOptions, CameraAiResult};
use crate::ml;
use crate::state::AppState;

pub const CAMERA_AI_PROGRESS_EVENT: &str = "camera-ai-progress";
pub const CAMERA_AI_SETUP_EVENT: &str = "camera-ai-setup";

const MAX_LUT_BYTES: u64 = 8_000_000;
const MAX_FACE_TRACK_BYTES: u64 = 32_000_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CameraAiFeatures {
    #[serde(default)]
    pub matte: bool,
    #[serde(default)]
    pub face_track: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CameraAiRequest {
    pub job_id: String,
    pub recording_id: String,
    pub asset_id: String,
    pub stream_index: Option<i32>,
    pub features: CameraAiFeatures,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraAiArtifacts {
    pub matte_path: Option<String>,
    pub face_track_path: Option<String>,
}

fn emit_progress(app: &AppHandle, job_id: &str, phase: &str, percent: u8) {
    use tauri::Emitter;
    let _ = app.emit(
        CAMERA_AI_PROGRESS_EVENT,
        serde_json::json!({
            "jobId": job_id,
            "phase": phase,
            "percent": percent,
        }),
    );
}

fn camera_ai_pro_required(features: &[&'static str]) -> AppError {
    AppError::new(
        ErrorCategory::Licensing,
        "pro_feature_required",
        "This feature requires RecordForge Pro",
    )
    .with_details(
        [(
            "features".to_string(),
            serde_json::Value::from(features.iter().map(|f| f.to_string()).collect::<Vec<_>>()),
        )]
        .into_iter()
        .collect(),
    )
}

/// Runtime + model readiness for the Camera AI settings card.
#[tauri::command]
pub fn get_camera_ai_status(state: State<'_, AppState>) -> Result<ml::MlStatus> {
    Ok(ml::status(state.path_policy.app_data_dir()))
}

/// Download the pinned ONNX Runtime and the selected models. Pro-gated like
/// the rest of the camera-AI surface; setup itself does not touch media.
#[tauri::command]
pub async fn download_camera_ai_engine(
    models: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<()> {
    if !state.license.entitlements().pro_enabled {
        return Err(camera_ai_pro_required(&["camera-cutout"]));
    }
    let app_data_dir = state.path_policy.app_data_dir().to_path_buf();
    {
        use tauri::Emitter;
        let _ = app.emit(
            CAMERA_AI_SETUP_EVENT,
            serde_json::json!({
                "stage": "runtime",
                "downloadedBytes": 0,
                "totalBytes": 0,
            }),
        );
    }
    let progress_app = app.clone();
    ml::runtime::download(&app_data_dir, move |done, total| {
        use tauri::Emitter;
        let _ = progress_app.emit(
            CAMERA_AI_SETUP_EVENT,
            serde_json::json!({
                "stage": "runtime",
                "downloadedBytes": done,
                "totalBytes": total,
            }),
        );
    })
    .await?;

    for model in models {
        if ml::models::model_spec(&model).is_none() {
            return Err(InternalError::Media(format!("unknown camera model '{model}'")).into());
        }
        use tauri::Emitter;
        let _ = app.emit(
            CAMERA_AI_SETUP_EVENT,
            serde_json::json!({
                "stage": "model",
                "model": model,
                "downloadedBytes": 0,
                "totalBytes": 0,
            }),
        );
        let progress_app = app.clone();
        let progress_model = model.clone();
        ml::models::download(&app_data_dir, &model, move |done, total| {
            use tauri::Emitter;
            let _ = progress_app.emit(
                CAMERA_AI_SETUP_EVENT,
                serde_json::json!({
                    "stage": "model",
                    "model": progress_model,
                    "downloadedBytes": done,
                    "totalBytes": total,
                }),
            );
        })
        .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_camera_ai_model(model: String, state: State<'_, AppState>) -> Result<()> {
    if !state.license.entitlements().pro_enabled {
        return Err(camera_ai_pro_required(&["camera-cutout"]));
    }
    ml::models::delete(state.path_policy.app_data_dir(), &model)
}

/// Run the offline matte / face-track derivative job. Results are deterministic
/// paths under the recording work dir; the UI reloads them via
/// `get_camera_ai_artifacts`.
#[tauri::command]
#[instrument(skip(app, state, request), fields(job_id = %request.job_id))]
pub async fn analyze_camera_ai(
    request: CameraAiRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CameraAiResult> {
    if !state.license.entitlements().pro_enabled {
        let mut features = Vec::new();
        if request.features.matte {
            features.push("camera-cutout");
        }
        if request.features.face_track {
            features.push("face-tracking");
        }
        if features.is_empty() {
            features.push("camera-cutout");
        }
        return Err(camera_ai_pro_required(&features));
    }
    if !request.features.matte && !request.features.face_track {
        return Err(InternalError::Media("select a camera AI feature".into()).into());
    }
    if request.job_id.trim().is_empty() || request.recording_id.trim().is_empty() {
        return Err(InternalError::Media("jobId and recordingId are required".into()).into());
    }
    let registration = state.camera_ai.begin(&request.job_id)?;

    let status = ml::status(state.path_policy.app_data_dir());
    if !status.supported {
        return Err(
            InternalError::Media("Camera AI is not available on this platform".into()).into(),
        );
    }
    if !status.runtime_ready {
        return Err(InternalError::Media("Download the camera AI runtime first".into()).into());
    }
    let model_ready = |id: &str| {
        status
            .models
            .iter()
            .any(|model| model.id == id && model.downloaded)
    };
    if request.features.matte && !model_ready(ml::models::MATTE) {
        return Err(InternalError::Media("Download the portrait matte model first".into()).into());
    }
    if request.features.face_track && !model_ready(ml::models::FACE) {
        return Err(InternalError::Media("Download the face detector model first".into()).into());
    }

    let (source_path, work_dir, stream_index, stream, standalone_meta) =
        {
            let db = state
                .db
                .lock()
                .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
            let recording = crate::database::library::get_recording(&db, &request.recording_id)?;
            let work_dir = PathBuf::from(&recording.work_dir);
            let project = crate::projects::load_project(&work_dir, &state.path_policy)?
                .ok_or_else(|| InternalError::Project("project file is missing".into()))?
                .project;
            let asset = project
                .assets
                .iter()
                .find(|asset| asset.id == request.asset_id);
            let standalone = asset.filter(|asset| {
                asset.role == crate::projects::ProjectAssetRole::Webcam
                    && asset.path.to_lowercase().ends_with(".mp4")
                    && !asset.path.contains(':')
            });
            let metadata = crate::database::media::get_metadata(&db, &request.recording_id)?;
            let video_streams: Vec<_> = metadata
                .as_ref()
                .map(|metadata| {
                    metadata
                        .streams
                        .iter()
                        .filter(|stream| stream.kind == "video")
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let (stream_index, stream) = if standalone.is_some() {
                let index = request.stream_index.unwrap_or(0);
                let stream = video_streams
                    .iter()
                    .find(|stream| stream.index == index)
                    .copied()
                    .cloned();
                (index, stream)
            } else {
                if video_streams.is_empty() {
                    return Err(InternalError::Media("recording has no video stream".into()).into());
                }
                let index = request.stream_index.unwrap_or(video_streams[0].index);
                let stream = video_streams
                    .iter()
                    .find(|stream| stream.index == index)
                    .copied()
                    .cloned()
                    .ok_or_else(|| {
                        InternalError::Media("the requested camera stream does not exist".into())
                    })?;
                (index, Some(stream))
            };
            // A standalone webcam asset lives beside the recording; otherwise the
            // camera is a stream inside the recording's output file.
            let source_path =
                if let Some(asset) = standalone {
                    crate::projects::absolute_asset_path(asset, &work_dir)
                } else {
                    PathBuf::from(recording.output_path.clone().ok_or_else(|| {
                        InternalError::Media("recording has no output path".into())
                    })?)
                };
            let standalone_meta =
                standalone.map(|asset| (asset.width, asset.height, asset.fps, asset.duration_ms));
            (source_path, work_dir, stream_index, stream, standalone_meta)
        };

    let fps = standalone_meta
        .as_ref()
        .and_then(|meta| meta.2)
        .or_else(|| stream.as_ref().and_then(|stream| stream.fps))
        .filter(|fps| *fps > 0.0)
        .unwrap_or(30.0);
    let width = standalone_meta
        .as_ref()
        .and_then(|meta| meta.0)
        .or_else(|| stream.as_ref().and_then(|stream| stream.width))
        .unwrap_or(1280)
        .max(2) as u32;
    let height = standalone_meta
        .as_ref()
        .and_then(|meta| meta.1)
        .or_else(|| stream.as_ref().and_then(|stream| stream.height))
        .unwrap_or(720)
        .max(2) as u32;
    let duration_ms = standalone_meta
        .as_ref()
        .map(|meta| meta.3)
        .filter(|duration| *duration > 0)
        .or_else(|| stream.as_ref().and_then(|stream| stream.duration_ms))
        .unwrap_or(0);

    let options = CameraAiOptions {
        ffmpeg_path: state.ffmpeg_path.clone(),
        source_path,
        stream_index,
        source_width: width,
        source_height: height,
        fps,
        duration_ms,
        work_dir,
        matte: request.features.matte,
        face_track: request.features.face_track,
        force: request.force,
    };
    let app_data_dir = state.path_policy.app_data_dir().to_path_buf();
    let job = registration.job().clone();
    let job_id = request.job_id.clone();
    let progress_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        camera_ai::run(&app_data_dir, &options, &job, move |phase, percent| {
            emit_progress(&progress_app, &job_id, phase, percent);
        })
    })
    .await
    .map_err(|error| InternalError::Media(format!("camera AI task: {error}")))??;
    emit_progress(&app, &request.job_id, "finalizing", 100);
    Ok(result)
}

#[tauri::command]
pub fn cancel_camera_ai(job_id: String, state: State<'_, AppState>) -> Result<()> {
    state.camera_ai.cancel(&job_id);
    Ok(())
}

/// Deterministic artifact paths for one recording's camera stream, when they
/// exist. The editor loads them on open so the plan and preview use the
/// completed derivatives.
#[tauri::command]
pub fn get_camera_ai_artifacts(
    recording_id: String,
    stream_index: Option<i32>,
    state: State<'_, AppState>,
) -> Result<CameraAiArtifacts> {
    let (work_dir, stream_index) = {
        let db = state
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let recording = crate::database::library::get_recording(&db, &recording_id)?;
        let metadata = crate::database::media::get_metadata(&db, &recording_id)?;
        let fallback = metadata
            .as_ref()
            .and_then(|metadata| {
                metadata
                    .streams
                    .iter()
                    .find(|stream| stream.kind == "video")
                    .map(|stream| stream.index)
            })
            .unwrap_or(0);
        (
            PathBuf::from(&recording.work_dir),
            stream_index.unwrap_or(fallback),
        )
    };
    let matte = camera_ai::matte_path(&work_dir, stream_index);
    let face = camera_ai::face_track_path(&work_dir, stream_index);
    Ok(CameraAiArtifacts {
        matte_path: matte.is_file().then(|| matte.to_string_lossy().to_string()),
        face_track_path: face.is_file().then(|| face.to_string_lossy().to_string()),
    })
}

/// Read a completed face-track JSON for the preview resolver.
#[tauri::command]
pub fn read_camera_face_track(
    recording_id: String,
    stream_index: Option<i32>,
    state: State<'_, AppState>,
) -> Result<Option<String>> {
    let work_dir = recording_work_dir(&state, &recording_id)?;
    let stream_index = stream_index.unwrap_or_else(|| default_video_stream(&state, &recording_id));
    let path = camera_ai::face_track_path(&work_dir, stream_index);
    read_bounded_text(&path, MAX_FACE_TRACK_BYTES).map(Some)
}

/// Imported `.cube` LUT text for the preview. The path comes from the project
/// asset registry and is revalidated against the project work dir.
#[tauri::command]
pub fn read_camera_lut(
    recording_id: String,
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<String> {
    let (work_dir, asset) = {
        let db = state
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let recording = crate::database::library::get_recording(&db, &recording_id)?;
        let work_dir = PathBuf::from(&recording.work_dir);
        let project = crate::projects::load_project(&work_dir, &state.path_policy)?
            .ok_or_else(|| InternalError::Project("project file is missing".into()))?;
        let asset = project
            .project
            .assets
            .into_iter()
            .find(|asset| asset.id == asset_id)
            .ok_or_else(|| InternalError::Project("LUT asset was not found".into()))?;
        (work_dir, asset)
    };
    if asset.role != crate::projects::ProjectAssetRole::Lut {
        return Err(InternalError::Project("asset is not a LUT".into()).into());
    }
    let path = crate::projects::absolute_asset_path(&asset, &work_dir);
    let path = state
        .path_policy
        .validate_project_asset_path(&work_dir, &path)?;
    read_bounded_text(&path, MAX_LUT_BYTES)
}

fn read_bounded_text(path: &Path, max_bytes: u64) -> Result<String> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| InternalError::Storage(format!("read file: {error}")))?;
    if !metadata.is_file() || metadata.len() > max_bytes {
        return Err(InternalError::Media("file is too large".into()).into());
    }
    std::fs::read_to_string(path)
        .map_err(|error| InternalError::Storage(format!("read file: {error}")).into())
}

fn recording_work_dir(state: &AppState, recording_id: &str) -> Result<PathBuf> {
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    let recording = crate::database::library::get_recording(&db, recording_id)?;
    Ok(PathBuf::from(&recording.work_dir))
}

fn default_video_stream(state: &AppState, recording_id: &str) -> i32 {
    let Ok(db) = state.db.lock() else { return 0 };
    crate::database::media::get_metadata(&db, recording_id)
        .ok()
        .flatten()
        .and_then(|metadata| {
            metadata
                .streams
                .into_iter()
                .find(|stream| stream.kind == "video")
                .map(|stream| stream.index)
        })
        .unwrap_or(0)
}

/// Parse/validate a `.cube` file at import time. Returns the number of entries
/// so the UI can show a concrete error for malformed LUTs.
pub fn validate_cube_text(text: &str) -> Result<usize> {
    let lut = overlay_engine::color::Lut3d::parse_cube(text)
        .map_err(|error| InternalError::Media(format!("invalid LUT: {error}")))?;
    Ok((lut.size() * lut.size() * lut.size()) as usize)
}

/// Warn (never fail) when an imported `.cube` is malformed; the asset registry
/// still records it so the user can replace it.
pub fn warn_if_invalid_cube(path: &Path) {
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("cube"))
    {
        return;
    }
    match std::fs::read_to_string(path) {
        Ok(text) => {
            if let Err(error) = validate_cube_text(&text) {
                warn!(error = %error, "imported camera LUT failed validation");
            }
        }
        Err(error) => warn!(error = %error, "could not read imported camera LUT"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cube_validation_reports_entries() {
        let mut text = String::from("LUT_3D_SIZE 2\n");
        for b in 0..2 {
            for g in 0..2 {
                for r in 0..2 {
                    text.push_str(&format!("{r} {g} {b}\n"));
                }
            }
        }
        assert_eq!(validate_cube_text(&text).unwrap(), 35_937);
        assert!(validate_cube_text("LUT_3D_SIZE 2\n0 0\n").is_err());
    }

    #[test]
    fn read_bounded_text_rejects_directories() {
        let dir = std::env::temp_dir();
        assert!(read_bounded_text(&dir, 1024).is_err());
    }
}
