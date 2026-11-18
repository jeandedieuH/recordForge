//! Tauri commands for offline camera AI (#4a–c runtime plumbing).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tracing::{instrument, warn};

use crate::database::media as media_db;
use crate::database::media::{MediaJob, MediaJobKind, MediaJobOutputs, MediaJobStatus};
use crate::errors::{AppError, ErrorCategory, InternalError, Result};
use crate::events::EventPublisher;
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

fn emit_job_update(app: &AppHandle, job: &MediaJob) {
    if let Err(error) = EventPublisher::new(app).media_job_update(job) {
        warn!(error = %error, "camera AI job update emit failed");
    }
}

/// Camera AI derives a durable `media_jobs` row keyed by the UI's job id, so
/// progress, cancellation, and the completed artifact paths outlive the editor
/// view. The in-memory registry only owns the busy gate and the FFmpeg child.
fn begin_camera_ai_job(
    db: &Mutex<rusqlite::Connection>,
    request: &CameraAiRequest,
    stream_index: i32,
) -> Result<MediaJob> {
    let options = serde_json::json!({
        "assetId": request.asset_id,
        "streamIndex": stream_index,
        "features": {
            "matte": request.features.matte,
            "faceTrack": request.features.face_track,
        },
        "force": request.force,
    });
    let conn = db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    let existing = media_db::list_jobs(&conn, &request.recording_id)?
        .into_iter()
        .find(|job| job.id == request.job_id);
    let job = match existing {
        None => media_db::insert_job_with_id(
            &conn,
            &request.job_id,
            &request.recording_id,
            MediaJobKind::CameraAi,
            options,
        )?,
        Some(job) if job.kind != MediaJobKind::CameraAi => {
            return Err(InternalError::Media(format!(
                "job id '{}' belongs to a different job kind",
                job.id
            ))
            .into())
        }
        Some(job) => match job.status {
            MediaJobStatus::Failed | MediaJobStatus::Cancelled => {
                media_db::retry_job(&conn, &job.id)?
            }
            MediaJobStatus::Pending => job,
            _ => {
                return Err(InternalError::Media(format!(
                    "camera AI job '{}' already finished; start a new job",
                    job.id
                ))
                .into())
            }
        },
    };
    media_db::start_job(&conn, &job.id)
}

fn publish_camera_ai_progress(
    app: &AppHandle,
    db: &Mutex<rusqlite::Connection>,
    job_id: &str,
    phase: &str,
    percent: u8,
) {
    let job = db.lock().ok().and_then(|conn| {
        if let Err(error) =
            media_db::update_job_progress(&conn, job_id, f64::from(percent) / 100.0, phase, None)
        {
            warn!(error = %error, "camera AI job progress update failed");
        }
        media_db::get_job(&conn, job_id).ok()
    });
    if let Some(job) = job {
        emit_job_update(app, &job);
    }
}

fn complete_camera_ai_job(
    app: &AppHandle,
    db: &Mutex<rusqlite::Connection>,
    recording_id: &str,
    job_id: &str,
    result: &CameraAiResult,
) {
    let job = db.lock().ok().and_then(|conn| {
        let mut derivatives = std::collections::HashMap::new();
        if let Some(path) = result.matte_path.clone() {
            derivatives.insert("matte".to_string(), path);
        }
        if let Some(path) = result.face_track_path.clone() {
            derivatives.insert("faceTrack".to_string(), path);
        }
        // Derivative paths are deterministic, so a re-run replaces the same
        // paths; refresh the registry rows instead of stacking duplicates.
        let paths = derivatives.values().cloned().collect::<Vec<_>>();
        if let Err(error) = media_db::delete_derivatives_for_paths(&conn, recording_id, &paths) {
            warn!(error = %error, "camera AI derivative cleanup failed");
        }
        for (key, path) in &derivatives {
            let derivative = media_db::DerivativeFile {
                id: uuid::Uuid::new_v4().to_string(),
                recording_id: recording_id.to_string(),
                job_id: job_id.to_string(),
                kind: if key == "matte" {
                    "matte"
                } else {
                    "face_track"
                }
                .to_string(),
                path: path.clone(),
                size_bytes: std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0),
                created_at: chrono::Utc::now().to_rfc3339(),
            };
            if let Err(error) = media_db::insert_derivative(&conn, &derivative) {
                warn!(error = %error, "camera AI derivative record failed");
            }
        }
        media_db::complete_job(
            &conn,
            job_id,
            &MediaJobOutputs {
                derivatives,
                ..Default::default()
            },
        )
        .ok()
    });
    if let Some(job) = job {
        emit_job_update(app, &job);
    }
}

fn fail_camera_ai_job(
    app: &AppHandle,
    db: &Mutex<rusqlite::Connection>,
    job_id: &str,
    error: &str,
    cancelled: bool,
) {
    let job = db.lock().ok().and_then(|conn| {
        if cancelled {
            media_db::cancel_job(&conn, job_id).ok()
        } else {
            media_db::fail_job(&conn, job_id, error).ok()
        }
    });
    if let Some(job) = job {
        emit_job_update(app, &job);
    }
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
    // The UI id becomes the durable media-job key; keep it bounded.
    if request.job_id.len() > 128 {
        return Err(InternalError::Media("jobId is too long".into()).into());
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

    let (source_path, work_dir, stream_index, stream, standalone, standalone_meta) =
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
            // Standalone webcam assets are sidecar files next to the output —
            // `webcam.mp4`, or `trim_<id>_webcam.mp4` on trimmed recordings —
            // while an embedded camera stream shares the output's path. Keep
            // this in sync with `isStandaloneWebcamAssetPath` in contracts.
            let standalone = asset.filter(|asset| {
                asset.role == crate::projects::ProjectAssetRole::Webcam
                    && Path::new(&asset.path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .map(|name| name.to_ascii_lowercase())
                        .is_some_and(|name| name == "webcam.mp4" || name.ends_with("_webcam.mp4"))
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
                // The standalone webcam's project stream index is synthetic —
                // it does not exist inside the file. The decoder maps the
                // probed index below; `stream_index` only names derivatives.
                (request.stream_index.unwrap_or(0), None)
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
            (
                source_path,
                work_dir,
                stream_index,
                stream,
                standalone.cloned(),
                standalone_meta,
            )
        };

    // Standalone webcam assets carry a synthetic project stream index and no
    // reliable geometry in the project file; probe the file itself for the
    // stream to decode plus the camera's real dimensions and frame rate.
    let standalone_stream = if standalone.is_some() {
        let probed = crate::media::probe::probe_media(
            &state.ffprobe_path.to_string_lossy(),
            &source_path,
            &request.recording_id,
        )?;
        probed
            .streams
            .into_iter()
            .find(|stream| stream.kind == "video")
    } else {
        None
    };
    let decode_stream_index = match &standalone_stream {
        Some(stream) => stream.index,
        None => {
            if standalone.is_some() {
                return Err(
                    InternalError::Media("standalone webcam has no video stream".into()).into(),
                );
            }
            stream_index
        }
    };

    let fps = standalone_stream
        .as_ref()
        .and_then(|stream| stream.fps)
        .or_else(|| standalone_meta.as_ref().and_then(|meta| meta.2))
        .or_else(|| stream.as_ref().and_then(|stream| stream.fps))
        .filter(|fps| *fps > 0.0)
        .unwrap_or(30.0);
    let width = standalone_stream
        .as_ref()
        .and_then(|stream| stream.width)
        .or_else(|| standalone_meta.as_ref().and_then(|meta| meta.0))
        .or_else(|| stream.as_ref().and_then(|stream| stream.width))
        .unwrap_or(1280)
        .max(2) as u32;
    let height = standalone_stream
        .as_ref()
        .and_then(|stream| stream.height)
        .or_else(|| standalone_meta.as_ref().and_then(|meta| meta.1))
        .or_else(|| stream.as_ref().and_then(|stream| stream.height))
        .unwrap_or(720)
        .max(2) as u32;
    let duration_ms = standalone_stream
        .as_ref()
        .and_then(|stream| stream.duration_ms)
        .or_else(|| {
            standalone_meta
                .as_ref()
                .map(|meta| meta.3)
                .filter(|d| *d > 0)
        })
        .or_else(|| stream.as_ref().and_then(|stream| stream.duration_ms))
        .unwrap_or(0);

    let db = Arc::clone(&state.db);
    let job = begin_camera_ai_job(&db, &request, stream_index)?;
    emit_job_update(&app, &job);

    let options = CameraAiOptions {
        ffmpeg_path: state.ffmpeg_path.clone(),
        source_path,
        stream_index,
        decode_stream_index,
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
    let cancel_job = registration.job().clone();
    let job_id = request.job_id.clone();
    let recording_id = request.recording_id.clone();
    let progress_app = app.clone();
    let progress_db = Arc::clone(&db);
    let progress_job_id = job_id.clone();
    // Progress arrives once per decoded frame; persist/emit the shared job row
    // at most ~4x/s (plus every phase change) so inference is not competing
    // with SQLite and window broadcasts.
    let progress_state = Arc::new(Mutex::new((String::new(), u8::MAX, None::<Instant>)));
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        camera_ai::run(
            &app_data_dir,
            &options,
            &cancel_job,
            move |phase, percent| {
                emit_progress(&progress_app, &progress_job_id, phase, percent);
                let should_publish = match progress_state.lock() {
                    Ok(mut last) => {
                        let phase_changed = last.0 != phase;
                        let due = last
                            .2
                            .is_none_or(|at| at.elapsed() >= Duration::from_millis(250));
                        if phase_changed || percent >= 100 || (percent != last.1 && due) {
                            last.0 = phase.to_string();
                            last.1 = percent;
                            last.2 = Some(Instant::now());
                            true
                        } else {
                            false
                        }
                    }
                    Err(_) => false,
                };
                if should_publish {
                    publish_camera_ai_progress(
                        &progress_app,
                        &progress_db,
                        &progress_job_id,
                        phase,
                        percent,
                    );
                }
            },
        )
    })
    .await;

    let result = match outcome {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            fail_camera_ai_job(
                &app,
                &db,
                &job_id,
                &error.to_string(),
                registration.job().is_cancelled(),
            );
            return Err(error);
        }
        Err(error) => {
            let error: AppError = InternalError::Media(format!("camera AI task: {error}")).into();
            fail_camera_ai_job(&app, &db, &job_id, &error.to_string(), false);
            return Err(error);
        }
    };
    emit_progress(&app, &job_id, "finalizing", 100);
    complete_camera_ai_job(&app, &db, &recording_id, &job_id, &result);
    Ok(result)
}

#[tauri::command]
pub fn cancel_camera_ai(job_id: String, app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    state.camera_ai.cancel(&job_id);
    // The worker's own exit path emits the final row; marking it cancelled here
    // stops the shared jobs UI from showing a running job immediately.
    let cancelled = state
        .db
        .lock()
        .ok()
        .and_then(|conn| media_db::cancel_job(&conn, &job_id).ok());
    if let Some(job) = cancelled {
        emit_job_update(&app, &job);
    }
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
    fn camera_ai_job_row_uses_the_ui_id_and_rejects_other_kinds() {
        let mut conn = rusqlite::Connection::open_in_memory().expect("open in-memory database");
        crate::database::migrations::run_migrations(&mut conn).expect("run migrations");
        let db = Mutex::new(conn);
        let request = CameraAiRequest {
            job_id: "camera-job-1".into(),
            recording_id: "recording-1".into(),
            asset_id: "asset-1".into(),
            stream_index: Some(2),
            features: CameraAiFeatures {
                matte: true,
                face_track: true,
            },
            force: false,
        };

        let job = begin_camera_ai_job(&db, &request, 2).expect("begin camera AI job");
        assert_eq!(job.id, "camera-job-1");
        assert_eq!(job.kind, MediaJobKind::CameraAi);
        assert_eq!(job.status, MediaJobStatus::Running);
        assert_eq!(job.options["streamIndex"], 2);
        assert_eq!(job.options["features"]["matte"].as_bool(), Some(true));

        // A failed row is retried with the same identity.
        media_db::fail_job(&db.lock().expect("db lock"), &job.id, "boom")
            .expect("fail camera AI job");
        let retried = begin_camera_ai_job(&db, &request, 2).expect("retry camera AI job");
        assert_eq!(retried.status, MediaJobStatus::Running);
        assert_eq!(retried.error, None);
        assert!(retried.attempts >= 1);

        // A colliding id owned by another job kind is never hijacked.
        let foreign = media_db::insert_job(
            &db.lock().expect("db lock"),
            "recording-1",
            MediaJobKind::Prepare,
        )
        .expect("insert prepare job");
        let colliding = CameraAiRequest {
            job_id: foreign.id,
            ..request
        };
        assert!(begin_camera_ai_job(&db, &colliding, 2).is_err());
    }

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
