use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};
use tracing::{info, instrument, warn};

use crate::path_policy::PathPolicy;

use crate::capture;
use crate::capture::benchmark::{run_benchmark, BenchmarkReport};
use crate::capture::config::RecordingConfig;
use crate::capture::devices::{AudioDevice, VideoDevice};
use crate::capture::encoder::{detect_encoders, EncoderInfo};
use crate::capture::manifest::{
    RecordingManifest, RecordingMarker, RecordingSmartZoom, RecordingStats,
};
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
use crate::jobs::JobManager;
use crate::media;
use crate::state::AppState;
use crate::window::{BoundaryWindow, CountdownWindow, FloatingWindow, MainWindow};

/// Initialize the shared application state. Called once in `setup`.
pub fn init(app: &tauri::App) -> Result<()> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| InternalError::Unknown(format!("app data dir: {e}")))?;

    // Tauri's resource dir is where externalBin sidecars land in production
    // installs. In dev mode this may differ, but resolve_executable falls
    // through to other candidates transparently.
    let resource_dir = app.path().resource_dir().ok();

    let db_path = app_data_dir.join("app.db");
    let conn = database::initialize(&db_path)
        .map_err(|e| InternalError::Storage(format!("open database: {e}")))?;
    let db = Arc::new(Mutex::new(conn));

    let sessions_dir = app_data_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir)
        .map_err(|e| InternalError::Storage(format!("create sessions dir: {e}")))?;

    let path_policy = PathPolicy::new(app_data_dir.clone(), sessions_dir.clone());

    let ffmpeg_path =
        media::resolve_executable_with_resource_dir("ffmpeg", resource_dir.as_deref())?;
    let ffprobe_path =
        media::resolve_executable_with_resource_dir("ffprobe", resource_dir.as_deref())?;
    let recorder = Recorder::new(
        ffmpeg_path.clone(),
        ffprobe_path.clone(),
        sessions_dir.clone(),
        Arc::clone(&db),
    );
    // The recorder probed encoders at construction; share the result with the
    // media jobs so export and proxy pick hardware encoders without re-probing.
    let available_encoders = recorder.available_encoders().to_vec();

    let job_manager = JobManager::new(
        app.handle().clone(),
        Arc::clone(&db),
        ffmpeg_path.clone(),
        ffprobe_path.clone(),
        path_policy.clone(),
        available_encoders,
    );

    // Resume any pending or interrupted jobs from a previous run.
    if let Err(err) = job_manager.resume_pending_jobs() {
        tracing::error!(error = ?err, "failed to resume media jobs");
    }

    let storage_manager = crate::storage::StorageManager::new(
        app.handle().clone(),
        Arc::clone(&db),
        path_policy.clone(),
    );

    app.manage(AppState {
        recorder: Arc::new(recorder),
        db,
        job_manager: Arc::new(Mutex::new(job_manager)),
        sessions_dir,
        ffmpeg_path,
        ffprobe_path,
        quick_config: Arc::new(Mutex::new(None)),
        path_policy,
        storage_manager,
        update_gate: Arc::new(crate::state::UpdateGate::default()),
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

/// Best-effort broadcast of the current recorder status to all windows.
///
/// Used after transport actions so every UI surface (main window, floating
/// controls) reflects state changes immediately, including those triggered by
/// global shortcuts or the tray menu. Emission failures are ignored so a
/// listener-side hiccup can't fail an otherwise-successful recording action.
pub(crate) fn emit_current_status(app: &tauri::AppHandle, state: &AppState) {
    let status = match state.recorder.status() {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(error = ?e, "failed to read recorder status for event");
            return;
        }
    };
    if let Err(e) = crate::events::emit_recorder_status(app, &status) {
        tracing::warn!(error = ?e, "failed to emit recorder-status event");
    }
}

#[tauri::command]
#[instrument]
pub async fn start_recording(
    config: RecordingConfig,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String> {
    let _update_operation = state.update_gate.acquire_operation()?;
    let session_id = state.recorder.prepare(config.clone())?;
    remember_quick_config(&state, config.clone());

    if let Err(error) = MainWindow::minimize(&app) {
        abort_prepared_start(&app, &state, &session_id);
        return Err(error);
    }
    if let Err(error) = start_prepared_session(&app, &state, &session_id, config.source.bounds) {
        abort_prepared_start(&app, &state, &session_id);
        return Err(error);
    }

    emit_current_status(&app, &state);
    Ok(session_id)
}

#[tauri::command]
#[instrument]
pub async fn prepare_recording(
    config: RecordingConfig,
    countdown_seconds: u8,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String> {
    let _update_operation = state.update_gate.acquire_operation()?;
    if !matches!(countdown_seconds, 0 | 3 | 5) {
        return Err(InternalError::Capture("countdown must be 0, 3, or 5 seconds".into()).into());
    }

    let session_id = state.recorder.prepare(config.clone())?;
    remember_quick_config(&state, config.clone());

    if let Err(error) = MainWindow::minimize(&app) {
        abort_prepared_start(&app, &state, &session_id);
        return Err(error);
    }

    if countdown_seconds == 0 {
        if let Err(error) = start_prepared_session(&app, &state, &session_id, config.source.bounds)
        {
            abort_prepared_start(&app, &state, &session_id);
            return Err(error);
        }
    } else if let Err(error) = CountdownWindow::open_or_focus(
        &app,
        &session_id,
        countdown_seconds,
        &config.source.name,
        config.source.bounds,
    ) {
        abort_prepared_start(&app, &state, &session_id);
        return Err(error);
    }

    emit_current_status(&app, &state);
    Ok(session_id)
}

#[tauri::command]
#[instrument]
pub async fn confirm_recording_start(
    session_id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<()> {
    let _update_operation = state.update_gate.acquire_operation()?;
    let bounds = match quick_config_bounds(&state) {
        Ok(bounds) => bounds,
        Err(error) => {
            abort_prepared_start(&app, &state, &session_id);
            return Err(error);
        }
    };

    if let Err(error) = start_prepared_session(&app, &state, &session_id, bounds) {
        abort_prepared_start(&app, &state, &session_id);
        return Err(error);
    }
    CountdownWindow::hide(&app);
    emit_current_status(&app, &state);
    Ok(())
}

#[tauri::command]
#[instrument]
pub async fn cancel_recording_start(
    session_id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<()> {
    cancel_prepared_recording(&app, &state, &session_id)
}

fn remember_quick_config(state: &AppState, config: RecordingConfig) {
    if let Ok(mut guard) = state.quick_config.lock() {
        *guard = Some(config);
    }
}

fn quick_config_bounds(state: &AppState) -> Result<crate::capture::source::Bounds> {
    let guard = state
        .quick_config
        .lock()
        .map_err(|_| InternalError::Capture("quick config mutex poisoned".into()))?;
    guard
        .as_ref()
        .map(|config| config.source.bounds)
        .ok_or_else(|| InternalError::Capture("recording source is unavailable".into()).into())
}

fn abort_prepared_start(app: &tauri::AppHandle, state: &AppState, session_id: &str) {
    if let Err(error) = cancel_prepared_session(state, session_id) {
        tracing::debug!(error = ?error, "prepared recording was already past cancellation");
    }
    cleanup_recording_windows(app);
    if let Err(error) = MainWindow::restore(app) {
        tracing::error!(error = ?error, "failed to restore main window after recording startup failure");
    }
    emit_current_status(app, state);
}

fn cancel_prepared_recording(
    app: &tauri::AppHandle,
    state: &AppState,
    session_id: &str,
) -> Result<()> {
    let cancel_result = cancel_prepared_session(state, session_id);
    cleanup_recording_windows(app);
    let restore_result = MainWindow::restore(app);
    emit_current_status(app, state);

    match cancel_result {
        Ok(()) => restore_result,
        Err(error) => Err(error),
    }
}

fn cleanup_recording_windows(app: &tauri::AppHandle) {
    FloatingWindow::hide(app);
    BoundaryWindow::hide(app);
    CountdownWindow::hide(app);
}

fn start_prepared_session(
    app: &tauri::AppHandle,
    state: &AppState,
    session_id: &str,
    bounds: crate::capture::source::Bounds,
) -> Result<()> {
    state.recorder.start_prepared(session_id)?;
    open_recording_windows_async(app, bounds);
    Ok(())
}

fn cancel_prepared_session(state: &AppState, session_id: &str) -> Result<()> {
    state.recorder.cancel_prepared(session_id)
}

fn open_recording_windows(
    app: &tauri::AppHandle,
    bounds: crate::capture::source::Bounds,
) -> Result<()> {
    FloatingWindow::open_or_focus(app)?;
    if let Err(error) = BoundaryWindow::open_or_focus(app, bounds) {
        FloatingWindow::hide(app);
        BoundaryWindow::hide(app);
        return Err(error);
    }
    Ok(())
}

pub(crate) fn open_recording_windows_async(
    app: &tauri::AppHandle,
    bounds: crate::capture::source::Bounds,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if !recording_is_active(&app) {
            return;
        }
        if let Err(error) = open_recording_windows(&app, bounds) {
            tracing::error!(error = ?error, "failed to open recording control windows");
            if recording_is_active(&app) {
                stop_after_window_failure(&app);
            }
            return;
        }
        if !recording_is_active(&app) {
            cleanup_recording_windows(&app);
        }
    });
}

fn recording_is_active(app: &tauri::AppHandle) -> bool {
    let state = app.state::<AppState>();
    state
        .recorder
        .status()
        .ok()
        .map(|status| {
            matches!(
                status.state,
                capture::manifest::RecorderState::Recording
                    | capture::manifest::RecorderState::Paused
            )
        })
        .unwrap_or(false)
}

fn stop_after_window_failure(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if let Err(error) = state.recorder.stop() {
        tracing::warn!(error = ?error, "failed to stop recording after control window failure");
    }
    cleanup_recording_windows(app);
    if let Err(error) = MainWindow::restore(app) {
        tracing::error!(error = ?error, "failed to restore main window after control window failure");
    }
    emit_current_status(app, &state);
}

#[tauri::command]
#[instrument]
pub fn pause_recording(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<RecordingStatus> {
    let status = state.recorder.pause()?;
    let _ = crate::events::emit_recorder_status(&app, &status);
    Ok(status)
}

#[tauri::command]
#[instrument]
pub fn resume_recording(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<RecordingStatus> {
    let status = state.recorder.resume()?;
    let _ = crate::events::emit_recorder_status(&app, &status);
    Ok(status)
}

#[tauri::command]
#[instrument]
pub async fn stop_recording(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<RecordingStats> {
    // A pending countdown has captured nothing yet: stopping cancels the
    // pending start instead of running finalization over an empty session
    // (which would fail with "no valid recording segments").
    let countdown_session = {
        let status = state.recorder.status()?;
        if status.state == capture::manifest::RecorderState::Countdown {
            Some(status.session_id)
        } else {
            None
        }
    };
    if let Some(session_id) = countdown_session {
        let cancel_result = state.recorder.cancel_prepared(&session_id);
        FloatingWindow::hide(&app);
        BoundaryWindow::hide(&app);
        CountdownWindow::hide(&app);
        if let Err(error) = MainWindow::restore(&app) {
            tracing::error!(error = ?error, "failed to restore main window after cancel");
        }
        emit_current_status(&app, &state);
        return cancel_result.map(|_| RecordingStats::default());
    }

    // Hide boundary and countdown windows immediately as capture is concluding
    BoundaryWindow::hide(&app);
    CountdownWindow::hide(&app);

    let app_handle = app.clone();
    let recorder = state.recorder.clone();
    let stop_result = tauri::async_runtime::spawn_blocking(move || {
        let session_id = recorder.status()?.session_id;
        let app_cb = app_handle.clone();
        let result = recorder.stop_with_progress(move |progress| {
            let _ = crate::events::emit_finalization_progress(&app_cb, &progress);
        });
        Ok::<_, crate::errors::AppError>((session_id, result))
    })
    .await
    .map_err(|e| InternalError::Unknown(format!("stop recording worker thread panicked: {e}")))?;

    let (session_id, result) = match stop_result {
        Ok((s_id, res)) => (s_id, res),
        Err(err) => (String::new(), Err(err)),
    };

    if result.is_ok() {
        if let Ok(db) = state.db.lock() {
            if let Ok(recordings) = library_list_recordings(&db) {
                if let Some(recording) = recordings
                    .iter()
                    .find(|recording| recording.session_id == session_id)
                {
                    if let Err(error) = crate::events::emit_recording_completed(&app, &recording.id)
                    {
                        tracing::warn!(error = ?error, "failed to emit recording completion");
                    }
                }
            }
        }
    }
    FloatingWindow::hide(&app);
    if let Err(error) = MainWindow::restore(&app) {
        tracing::error!(error = ?error, "failed to restore main window after stop");
    }
    emit_current_status(&app, &state);
    result
}

#[tauri::command]
#[instrument]
pub fn recording_status(state: State<'_, AppState>) -> Result<RecordingStatus> {
    state.recorder.status()
}

#[tauri::command]
#[instrument]
pub fn insert_marker(
    label: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<RecordingMarker> {
    insert_marker_broadcast(&app, &state, label)
}

/// Insert a marker and broadcast it to every window so all surfaces show a
/// live count regardless of the input path (button, global shortcut, tray).
pub(crate) fn insert_marker_broadcast(
    app: &tauri::AppHandle,
    state: &AppState,
    label: String,
) -> Result<RecordingMarker> {
    let marker = state.recorder.insert_marker(label)?;
    if let Err(error) = crate::events::emit_recorder_marker(app, &marker) {
        tracing::warn!(error = ?error, "failed to emit recorder marker event");
    }
    Ok(marker)
}

/// Discard the active recording without saving: stops all captures, deletes
/// the session working directory, and hides the recording windows.
///
/// Security review (ADR 011): the command takes no arguments — it can only
/// ever affect the single in-memory active session's directory under the
/// app-managed sessions root, so React cannot aim it at arbitrary paths.
#[tauri::command]
#[instrument]
pub async fn discard_recording(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<()> {
    BoundaryWindow::hide(&app);
    CountdownWindow::hide(&app);

    let recorder = state.recorder.clone();
    let result = tauri::async_runtime::spawn_blocking(move || recorder.discard())
        .await
        .map_err(|e| {
            InternalError::Unknown(format!("discard recording worker thread panicked: {e}"))
        })?;

    let final_result = result;

    if let Err(error) = &final_result {
        tracing::error!(error = ?error, "failed to delete discarded session data");
    }

    FloatingWindow::hide(&app);
    if let Err(error) = MainWindow::restore(&app) {
        tracing::error!(error = ?error, "failed to restore main window after discard");
    }
    emit_current_status(&app, &state);
    final_result
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

    let cpu_cores = std::thread::available_parallelism().map(|n| n.get()).ok();
    let cpu = cpu_cores.map(|c| {
        if c == 1 {
            "1 Core".to_string()
        } else {
            format!("{c} Cores")
        }
    });

    Ok(DiagnosticsReport {
        platform: PlatformInfo {
            os: diagnostic_os(),
            ffmpeg_version,
            cpu,
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
pub async fn recover_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<LibraryRecording> {
    let _update_operation = state.update_gate.acquire_operation()?;
    // Validate the session ID as a UUID and ensure its directory stays inside
    // the sessions root before any recovery work begins.
    let work_dir = state.path_policy.validate_session_dir(&session_id)?;
    let ffmpeg = state.ffmpeg_path.to_string_lossy().to_string();
    let ffprobe = state.ffprobe_path.to_string_lossy().to_string();
    let db = state.db.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let mut db = db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        recovery_recover_session(&work_dir, &ffmpeg, &ffprobe, &mut db)
    })
    .await
    .map_err(|e| InternalError::Unknown(format!("recover session worker thread panicked: {e}")))?
}

#[tauri::command]
#[instrument]
pub async fn delete_recovery_session(session_id: String, state: State<'_, AppState>) -> Result<()> {
    let sessions_dir = state.sessions_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        recovery_delete_session(&session_id, &sessions_dir)
    })
    .await
    .map_err(|e| {
        InternalError::Unknown(format!(
            "delete recovery session worker thread panicked: {e}"
        ))
    })?
}

#[tauri::command]
#[instrument]
pub async fn run_encoder_benchmark(state: State<'_, AppState>) -> Result<BenchmarkReport> {
    let _update_operation = state.update_gate.acquire_operation()?;
    let ffmpeg = state.ffmpeg_path.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let encoders = detect_encoders(&ffmpeg)?;
        let profiles = capture::config::builtin_profiles();
        run_benchmark(&ffmpeg, profiles, encoders)
    })
    .await
    .map_err(|e| InternalError::Unknown(format!("benchmark worker thread panicked: {e}")))?
}

#[tauri::command]
#[instrument]
pub fn list_recordings(state: State<'_, AppState>) -> Result<Vec<LibraryRecording>> {
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    let mut recordings = library_list_recordings(&db)?;

    let ffmpeg_path = state.ffmpeg_path.to_string_lossy().to_string();
    for rec in &mut recordings {
        let work_dir = if !rec.work_dir.is_empty() {
            Some(PathBuf::from(&rec.work_dir))
        } else {
            rec.output_path
                .as_ref()
                .and_then(|out| Path::new(out).parent().map(|p| p.to_path_buf()))
        };

        let needs_thumb = rec.thumbnail_path.as_deref().is_none_or(|p| {
            let p_path = Path::new(p);
            if p_path.is_absolute() {
                !p_path.is_file()
            } else if let Some(dir) = &work_dir {
                !dir.join(p_path).is_file()
            } else {
                !p_path.is_file()
            }
        });

        if needs_thumb {
            if let Some(output_str) = &rec.output_path {
                let raw_output = Path::new(output_str);
                let output_path = if raw_output.is_absolute() {
                    raw_output.to_path_buf()
                } else if let Some(dir) = &work_dir {
                    dir.join(raw_output)
                } else {
                    raw_output.to_path_buf()
                };

                if output_path.is_file() {
                    if let Some(dir) = &work_dir {
                        let poster_path = dir.join("poster.jpg");
                        if crate::media::thumbnails::generate_poster_frame(
                            &ffmpeg_path,
                            &output_path,
                            &poster_path,
                        )
                        .is_ok()
                        {
                            let poster_str = poster_path.to_string_lossy().to_string();
                            let _ = db.execute(
                                "UPDATE recordings SET thumbnail_path = ?1 WHERE id = ?2",
                                rusqlite::params![poster_str, rec.id],
                            );
                            rec.thumbnail_path = Some(poster_str);
                        }
                    }
                }
            }
        }
    }

    tracing::info!(count = recordings.len(), "list_recordings returned");
    Ok(recordings)
}

#[tauri::command]
#[instrument]
pub async fn delete_recording(recording_id: String, state: State<'_, AppState>) -> Result<()> {
    let _update_operation = state.update_gate.acquire_operation()?;
    let db = state.db.clone();
    let app_data_dir = state.path_policy.app_data_dir().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let db = db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        library_delete_recording(&db, &recording_id, &app_data_dir)
    })
    .await
    .map_err(|e| InternalError::Unknown(format!("delete recording worker thread panicked: {e}")))?
}

#[tauri::command]
#[instrument]
pub fn reveal_recording(recording_id: String, state: State<'_, AppState>) -> Result<()> {
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    let recording = get_recording(&db, &recording_id)?;
    let _path = recording
        .output_path
        .as_ref()
        .ok_or_else(|| InternalError::Storage("recording has no output path".into()))?;

    #[cfg(windows)]
    {
        // Reveal only resolves paths that exist and are inside the app data
        // directory, preventing a compromised database from opening arbitrary files.
        let validated = state
            .path_policy
            .validate_recording_path(Path::new(_path))?;
        let validated_str = validated.to_string_lossy();
        crate::process::create_command("explorer")
            .args(["/select,", validated_str.as_ref()])
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
    let _update_operation = state.update_gate.acquire_operation()?;
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
    let _update_operation = state.update_gate.acquire_operation()?;
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    remove_tag(&db, &recording_id, &tag)
}

#[tauri::command]
#[instrument]
pub fn trash_recording(recording_id: String, state: State<'_, AppState>) -> Result<()> {
    let _update_operation = state.update_gate.acquire_operation()?;
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    database::library::trash_recording(&db, &recording_id)
}

#[tauri::command]
#[instrument]
pub fn restore_recording(recording_id: String, state: State<'_, AppState>) -> Result<()> {
    let _update_operation = state.update_gate.acquire_operation()?;
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    database::library::restore_recording(&db, &recording_id)
}

#[tauri::command]
#[instrument]
pub fn empty_trash(state: State<'_, AppState>) -> Result<()> {
    let _update_operation = state.update_gate.acquire_operation()?;
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    let recordings = database::library::list_recordings(&db)?;
    let app_data_dir = state.path_policy.app_data_dir();
    for rec in recordings
        .into_iter()
        .filter(|r| r.status == database::library::LibraryRecordingStatus::Trashed)
    {
        let _ = database::library::delete_recording(&db, &rec.id, app_data_dir);
    }
    Ok(())
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
pub async fn trim_recording(
    options: TrimOptions,
    state: State<'_, AppState>,
) -> Result<LibraryRecording> {
    let _update_operation = state.update_gate.acquire_operation()?;
    let db_arc = state.db.clone();
    let ffmpeg_path = state.ffmpeg_path.to_string_lossy().to_string();
    let path_policy = state.path_policy.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let db = db_arc
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let original = get_recording(&db, &options.recording_id)?;
        let source_path = original
            .output_path
            .as_ref()
            .ok_or_else(|| InternalError::Media("recording has no output path".into()))?;

        // Validate that both the source file and the work directory belong to the
        // app data area before writing a trimmed file next to the original.
        path_policy.validate_recording_path(Path::new(source_path))?;
        let work_dir = path_policy.validate_recording_path(Path::new(&original.work_dir))?;

        let suffix = uuid::Uuid::new_v4().to_string();
        let short = &suffix[..suffix.len().min(8)];
        let trimmed_path = work_dir.join(format!("trim_{short}.mp4"));

        let trimmed_size = capture::media::trim_recording(
            &ffmpeg_path,
            Path::new(source_path),
            &trimmed_path,
            options.start_ms,
            options.end_ms,
        )?;

        let trimmed_webcam_path = if let Some(webcam_path) = original.webcam_path.as_deref() {
            path_policy.validate_recording_path(Path::new(webcam_path))?;
            let path = work_dir.join(format!("trim_{short}_webcam.mp4"));
            capture::media::trim_recording(
                &ffmpeg_path,
                Path::new(webcam_path),
                &path,
                options.start_ms,
                options.end_ms,
            )?;
            Some(path)
        } else {
            None
        };

        let duration_ms = options.end_ms - options.start_ms;
        insert_trimmed_recording(
            &db,
            &original,
            &trimmed_path,
            trimmed_webcam_path.as_deref(),
            trimmed_size,
            duration_ms,
            options.start_ms,
            options.end_ms,
        )
    })
    .await
    .map_err(|e| InternalError::Unknown(format!("trim recording worker thread panicked: {e}")))?
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
    let _update_operation = state.update_gate.acquire_operation()?;
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    let recording = get_recording(&db, &options.recording_id)?;
    let source_path = recording
        .output_path
        .as_ref()
        .ok_or_else(|| InternalError::Media("recording has no output path".into()))?;

    // Validate the user-selected destination before copying. This blocks writes
    // to system directories and path-traversal attempts via the save dialog.
    let destination = state
        .path_policy
        .validate_export_destination(Path::new(&options.output_path))?;

    capture::media::copy_export(Path::new(source_path), &destination)
}

/// Open a small always-on-top floating window for transport controls.
#[tauri::command]
#[instrument]
pub async fn open_floating_controls(app: tauri::AppHandle) -> Result<()> {
    crate::window::FloatingWindow::open_or_focus(&app)
}

/// Open the fullscreen region selection window on the monitor under the cursor.
/// The selection is broadcast back via the `region-selected` event.
#[tauri::command]
#[instrument]
pub async fn open_region_picker(app: tauri::AppHandle) -> Result<()> {
    crate::window::RegionPickerWindow::open(&app)
}

/// Close the region selection window without applying a selection.
#[tauri::command]
#[instrument]
pub fn cancel_region_picker(app: tauri::AppHandle) -> Result<()> {
    crate::window::RegionPickerWindow::close(&app);
    Ok(())
}

/// Restore and focus the main application window (from the floating toolbar).
#[tauri::command]
#[instrument]
pub fn show_main_window(app: tauri::AppHandle) -> Result<()> {
    MainWindow::restore(&app)
}

/// Hide the floating transport controls window.
#[tauri::command]
#[instrument]
pub fn hide_floating_controls(app: tauri::AppHandle) -> Result<()> {
    crate::window::FloatingWindow::hide(&app);
    Ok(())
}

/// Open a transparent always-on-top fullscreen window for capture boundary outline.
#[tauri::command]
#[instrument]
pub async fn open_boundary_overlay(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<()> {
    let bounds = quick_config_bounds(&state)?;
    BoundaryWindow::open_or_focus(&app, bounds)
}

/// Hide the capture boundary outline window.
#[tauri::command]
#[instrument]
pub fn hide_boundary_overlay(app: tauri::AppHandle) -> Result<()> {
    crate::window::BoundaryWindow::hide(&app);
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

/// Load cursor telemetry for the recording. React only sends the recording id;
/// Rust reads the V2 metadata/binary files directly, so the cursor is available
/// even before the project file is created during the bootstrap path.
#[tauri::command]
#[instrument(skip(state))]
pub fn get_cursor_telemetry(
    state: State<'_, AppState>,
    recording_id: String,
) -> Result<Option<crate::capture::cursor_v2::CursorTelemetryFileV2>> {
    let conn = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    let recording = match get_recording(&conn, &recording_id) {
        Ok(rec) => rec,
        Err(_) => return Ok(None),
    };
    drop(conn);

    let project_dir = crate::projects::project_dir_for_recording(&recording);
    let meta_path = project_dir.join("cursor_telemetry.json");
    let event_path = project_dir.join("cursor_events.bin");

    let result = crate::capture::cursor_v2::read_v2_telemetry(&project_dir);
    match result {
        Some(ref telemetry) => {
            info!(
                recording_id = %recording_id,
                project_dir = %project_dir.display(),
                event_count = telemetry.events.len(),
                "loaded V2 cursor telemetry",
            );
        }
        None => {
            warn!(
                recording_id = %recording_id,
                project_dir = %project_dir.display(),
                meta_exists = meta_path.exists(),
                meta_size = meta_path.metadata().map(|m| m.len()).unwrap_or(0),
                event_exists = event_path.exists(),
                event_size = event_path.metadata().map(|m| m.len()).unwrap_or(0),
                "failed to load V2 cursor telemetry",
            );
        }
    }
    Ok(result)
}

/// Return the smart-zoom preference captured with a recording session.
#[tauri::command]
#[instrument(skip(state))]
pub fn get_recording_smart_zoom(
    state: State<'_, AppState>,
    recording_id: String,
) -> Result<Option<RecordingSmartZoom>> {
    let conn = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    let recording = get_recording(&conn, &recording_id)?;
    drop(conn);

    let manifest_path = Path::new(&recording.work_dir).join("session.json");
    if !manifest_path.is_file() {
        return Ok(None);
    }

    let manifest = match RecordingManifest::read(&manifest_path) {
        Ok(manifest) => manifest,
        Err(error) => {
            warn!(recording_id = %recording_id, error = ?error, "failed to read recording manifest for smart zoom");
            return Ok(None);
        }
    };
    Ok(manifest.smart_zoom)
}
