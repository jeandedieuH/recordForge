use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};
use tracing::instrument;

use crate::capture;
use crate::capture::benchmark::{run_benchmark, BenchmarkReport};
use crate::capture::config::RecordingConfig;
use crate::capture::devices::{AudioDevice, VideoDevice};
use crate::capture::encoder::{detect_encoders, EncoderInfo};
use crate::capture::manifest::{RecordingMarker, RecordingStats};
use crate::capture::recovery::{
    delete_recovery_session as recovery_delete_session,
    recover_session as recovery_recover_session, scan_recovery, RecoveryScanResult,
};
use crate::capture::session::{Recorder, RecordingStatus};
use crate::capture::source::CaptureSource;
use crate::database;
use crate::database::library::{
    add_tag, delete_recording as library_delete_recording, get_recording, insert_trimmed_recording,
    list_recordings as library_list_recordings, remove_tag, LibraryRecording,
};
use crate::errors::{InternalError, Result};
use crate::state::AppState;

/// Initialize the shared application state. Called once in `setup`.
pub fn init(app: &tauri::App) -> Result<()> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| InternalError::Unknown(format!("app data dir: {e}")))?;

    let db_path = app_data_dir.join("app.db");
    let conn = database::initialize(&db_path)
        .map_err(|e| InternalError::Storage(format!("open database: {e}")))?;
    let db = Arc::new(Mutex::new(conn));

    let sessions_dir = app_data_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir)
        .map_err(|e| InternalError::Storage(format!("create sessions dir: {e}")))?;

    let ffmpeg_path = Recorder::resolve_ffmpeg()?;
    let recorder = Recorder::new(ffmpeg_path.clone(), sessions_dir.clone(), Arc::clone(&db));

    app.manage(AppState {
        recorder: Arc::new(Mutex::new(recorder)),
        db,
        sessions_dir,
        ffmpeg_path,
        quick_config: Arc::new(Mutex::new(None)),
    });

    Ok(())
}

#[tauri::command]
#[instrument]
pub fn list_capture_sources() -> Result<Vec<CaptureSource>> {
    capture::enumerate_sources()
}

#[tauri::command]
#[instrument]
pub fn list_audio_devices(state: State<'_, AppState>) -> Result<Vec<AudioDevice>> {
    capture::enumerate_audio_devices(&state.ffmpeg_path.to_string_lossy())
}

#[tauri::command]
#[instrument]
pub fn list_video_devices(state: State<'_, AppState>) -> Result<Vec<VideoDevice>> {
    capture::enumerate_video_devices(&state.ffmpeg_path.to_string_lossy())
}

#[tauri::command]
#[instrument]
pub fn list_builtin_profiles() -> Result<Vec<capture::config::RecordingProfile>> {
    Ok(capture::config::builtin_profiles())
}

#[tauri::command]
#[instrument]
pub fn start_recording(config: RecordingConfig, state: State<'_, AppState>) -> Result<String> {
    if let Ok(mut guard) = state.quick_config.lock() {
        *guard = Some(config.clone());
    }

    let guard = state
        .recorder
        .lock()
        .map_err(|_| InternalError::Capture("recorder state mutex poisoned".into()))?;
    guard.start(config)
}

#[tauri::command]
#[instrument]
pub fn pause_recording(state: State<'_, AppState>) -> Result<RecordingStatus> {
    let guard = state
        .recorder
        .lock()
        .map_err(|_| InternalError::Capture("recorder state mutex poisoned".into()))?;
    guard.pause()
}

#[tauri::command]
#[instrument]
pub fn resume_recording(state: State<'_, AppState>) -> Result<RecordingStatus> {
    let guard = state
        .recorder
        .lock()
        .map_err(|_| InternalError::Capture("recorder state mutex poisoned".into()))?;
    guard.resume()
}

#[tauri::command]
#[instrument]
pub fn stop_recording(state: State<'_, AppState>) -> Result<RecordingStats> {
    let guard = state
        .recorder
        .lock()
        .map_err(|_| InternalError::Capture("recorder state mutex poisoned".into()))?;
    guard.stop()
}

#[tauri::command]
#[instrument]
pub fn recording_status(state: State<'_, AppState>) -> Result<RecordingStatus> {
    let guard = state
        .recorder
        .lock()
        .map_err(|_| InternalError::Capture("recorder state mutex poisoned".into()))?;
    guard.status()
}

#[tauri::command]
#[instrument]
pub fn insert_marker(label: String, state: State<'_, AppState>) -> Result<RecordingMarker> {
    let guard = state
        .recorder
        .lock()
        .map_err(|_| InternalError::Capture("recorder state mutex poisoned".into()))?;
    guard.insert_marker(label)
}

#[tauri::command]
#[instrument]
pub fn detect_hardware_encoders(state: State<'_, AppState>) -> Result<Vec<EncoderInfo>> {
    detect_encoders(&state.ffmpeg_path.to_string_lossy())
}

#[tauri::command]
#[instrument]
pub fn get_diagnostics_report(state: State<'_, AppState>) -> Result<DiagnosticsReport> {
    let ffmpeg = state.ffmpeg_path.to_string_lossy();
    let ffmpeg_version = capture::media::ffmpeg_version(&ffmpeg)?;
    let encoders = detect_encoders(&ffmpeg)?;
    let audio_devices = capture::enumerate_audio_devices(&ffmpeg)?;
    let video_devices = capture::enumerate_video_devices(&ffmpeg)?;

    Ok(DiagnosticsReport {
        platform: PlatformInfo {
            os: diagnostic_os(),
            ffmpeg_version,
            cpu: None,
            memory_mb: None,
        },
        encoders,
        audio_devices,
        video_devices,
    })
}

#[tauri::command]
#[instrument]
pub fn scan_recovery_sessions(state: State<'_, AppState>) -> Result<Vec<RecoveryScanResult>> {
    scan_recovery(&state.sessions_dir)
}

#[tauri::command]
#[instrument]
pub fn recover_session(session_id: String, state: State<'_, AppState>) -> Result<LibraryRecording> {
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    recovery_recover_session(
        &session_id,
        &state.sessions_dir,
        &state.ffmpeg_path.to_string_lossy(),
        &db,
    )
}

#[tauri::command]
#[instrument]
pub fn delete_recovery_session(session_id: String, state: State<'_, AppState>) -> Result<()> {
    recovery_delete_session(&session_id, &state.sessions_dir)
}

#[tauri::command]
#[instrument]
pub fn run_encoder_benchmark(state: State<'_, AppState>) -> Result<BenchmarkReport> {
    let encoders = detect_encoders(&state.ffmpeg_path.to_string_lossy())?;
    let profiles = capture::config::builtin_profiles();
    run_benchmark(&state.ffmpeg_path.to_string_lossy(), profiles, encoders)
}

#[tauri::command]
#[instrument]
pub fn list_recordings(state: State<'_, AppState>) -> Result<Vec<LibraryRecording>> {
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    library_list_recordings(&db)
}

#[tauri::command]
#[instrument]
pub fn delete_recording(recording_id: String, state: State<'_, AppState>) -> Result<()> {
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    library_delete_recording(&db, &recording_id)
}

#[tauri::command]
#[instrument]
pub fn reveal_recording(recording_id: String, state: State<'_, AppState>) -> Result<()> {
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    let recording = get_recording(&db, &recording_id)?;
    let path = recording
        .output_path
        .as_ref()
        .ok_or_else(|| InternalError::Storage("recording has no output path".into()))?;

    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .args(["/select,", path])
            .spawn()
            .map_err(|e| InternalError::Media(format!("reveal recording: {e}")))?;
        Ok(())
    }

    #[cfg(not(windows))]
    {
        Err(InternalError::Media("reveal is only implemented on Windows".into()).into())
    }
}

#[tauri::command]
#[instrument]
pub fn add_recording_tag(
    recording_id: String,
    tag: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    add_tag(&db, &recording_id, &tag)
}

#[tauri::command]
#[instrument]
pub fn remove_recording_tag(
    recording_id: String,
    tag: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    remove_tag(&db, &recording_id, &tag)
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimOptions {
    pub recording_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[tauri::command]
#[instrument]
pub fn trim_recording(
    options: TrimOptions,
    state: State<'_, AppState>,
) -> Result<LibraryRecording> {
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    let original = get_recording(&db, &options.recording_id)?;
    let source_path = original
        .output_path
        .as_ref()
        .ok_or_else(|| InternalError::Media("recording has no output path".into()))?;

    let work_dir = PathBuf::from(&original.work_dir);
    let suffix = uuid::Uuid::new_v4().to_string();
    let short = &suffix[..suffix.len().min(8)];
    let trimmed_path = work_dir.join(format!("trim_{short}.mp4"));

    let trimmed_size = capture::media::trim_recording(
        &state.ffmpeg_path.to_string_lossy(),
        Path::new(source_path),
        &trimmed_path,
        options.start_ms,
        options.end_ms,
    )?;

    let duration_ms = options.end_ms - options.start_ms;
    insert_trimmed_recording(
        &db,
        &original,
        &trimmed_path,
        trimmed_size,
        duration_ms,
        options.start_ms,
        options.end_ms,
    )
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub recording_id: String,
    pub output_path: String,
}

#[tauri::command]
#[instrument]
pub fn export_recording(options: ExportOptions, state: State<'_, AppState>) -> Result<()> {
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    let recording = get_recording(&db, &options.recording_id)?;
    let source_path = recording
        .output_path
        .as_ref()
        .ok_or_else(|| InternalError::Media("recording has no output path".into()))?;

    capture::media::copy_export(Path::new(source_path), Path::new(&options.output_path))
}

/// Open a small always-on-top floating window for transport controls.
#[tauri::command]
#[instrument]
pub fn open_floating_controls(app: tauri::AppHandle) -> Result<()> {
    if app.get_webview_window("floating").is_some() {
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        "floating",
        tauri::WebviewUrl::App("index.html?floating=1".into()),
    )
    .title("recordForge Controls")
    .inner_size(320.0, 80.0)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .build()
    .map_err(|e| InternalError::Unknown(format!("{e:?}")))?;

    Ok(())
}

/// Platform information returned as part of the diagnostics report.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: String,
    pub ffmpeg_version: String,
    pub cpu: Option<String>,
    pub memory_mb: Option<i64>,
}

/// Device and encoder diagnostics report shown in the settings/diagnostics view.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsReport {
    pub platform: PlatformInfo,
    pub encoders: Vec<EncoderInfo>,
    pub audio_devices: Vec<AudioDevice>,
    pub video_devices: Vec<VideoDevice>,
}

fn diagnostic_os() -> String {
    if cfg!(windows) {
        "windows".into()
    } else if cfg!(target_os = "macos") {
        "macos".into()
    } else if cfg!(target_os = "linux") {
        "linux".into()
    } else {
        "unknown".into()
    }
}
