use tauri::Emitter;

use crate::capture::manifest::RecordingMarker;
use crate::capture::session::RecordingStatus;
use crate::database::media::MediaJob;
use crate::errors::Result;

/// Event names emitted to the React UI.
///
/// Keep these in sync with the listeners in `src/hooks/use-recorder.ts`.
pub mod event_names {
    pub const MEDIA_JOB_UPDATE: &str = "media-job-update";
    pub const RECORDER_STATUS: &str = "recorder-status";
    pub const RECORDING_COMPLETED: &str = "recording-completed";
    pub const RECORDER_MARKER: &str = "recorder-marker";
    pub const REQUEST_DISCARD_CONFIRMATION: &str = "request-discard-confirmation";
}

/// Publishes Tauri events to the React UI.
pub struct EventPublisher<'a> {
    handle: &'a tauri::AppHandle,
}

impl<'a> EventPublisher<'a> {
    pub fn new(handle: &'a tauri::AppHandle) -> Self {
        Self { handle }
    }

    /// Broadcast an updated media job to all windows.
    pub fn media_job_update(&self, job: &MediaJob) -> Result<()> {
        self.handle
            .emit(event_names::MEDIA_JOB_UPDATE, job)
            .map_err(|e| crate::errors::InternalError::Unknown(format!("emit: {e}")).into())
    }
}

/// Broadcast the current recorder status to all windows.
///
/// Used after global-shortcut, tray, and command actions so the React UI updates
/// instantly instead of waiting for the next 1s status poll. This is especially
/// important for the separate floating-controls window, which would otherwise
/// not see state changes triggered outside its own button clicks.
///
/// This is also the single choke point that keeps the tray menu in sync with
/// the recorder state. Callers must NOT hold the recorder mutex when calling:
/// the tray refresh re-acquires it briefly and the mutex is not reentrant.
pub fn emit_recorder_status(handle: &tauri::AppHandle, status: &RecordingStatus) -> Result<()> {
    let emit_result = handle
        .emit(event_names::RECORDER_STATUS, status)
        .map_err(|e| {
            crate::errors::AppError::from(crate::errors::InternalError::Unknown(format!(
                "emit recorder status: {e}"
            )))
        });
    // Refresh the tray regardless of whether any webview listener was
    // reachable; the menu must track the recorder state either way.
    crate::tray::refresh_tray_menu(handle);
    emit_result
}

/// Ask the main window to show its discard-confirmation UI.
///
/// Destructive discard is never executed directly from the tray; the tray (or
/// any headless surface) requests confirmation and the main window's dialog
/// owns the final decision (ADR 011).
pub fn emit_request_discard_confirmation(handle: &tauri::AppHandle) -> Result<()> {
    handle
        .emit(
            event_names::REQUEST_DISCARD_CONFIRMATION,
            serde_json::json!({ "source": "tray" }),
        )
        .map_err(|e| {
            crate::errors::InternalError::Unknown(format!("emit discard confirmation request: {e}"))
                .into()
        })
}

/// Broadcast the persisted library ID after a recording finishes.
pub fn emit_recording_completed(handle: &tauri::AppHandle, recording_id: &str) -> Result<()> {
    handle
        .emit(
            event_names::RECORDING_COMPLETED,
            serde_json::json!({ "recordingId": recording_id }),
        )
        .map_err(|e| {
            crate::errors::InternalError::Unknown(format!("emit recording completed: {e}")).into()
        })
}

/// Broadcast a newly inserted marker to all windows so every surface (floating
/// toolbar, main window) reflects a live count regardless of which input path
/// created it — button click or global shortcut.
pub fn emit_recorder_marker(handle: &tauri::AppHandle, marker: &RecordingMarker) -> Result<()> {
    handle
        .emit(event_names::RECORDER_MARKER, marker)
        .map_err(|e| {
            crate::errors::InternalError::Unknown(format!("emit recorder marker: {e}")).into()
        })
}
