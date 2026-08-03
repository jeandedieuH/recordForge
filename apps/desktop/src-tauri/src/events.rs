use tauri::Emitter;

use crate::capture::session::RecordingStatus;
use crate::database::media::MediaJob;
use crate::errors::Result;

/// Event names emitted to the React UI.
///
/// Keep these in sync with the listeners in `src/hooks/use-recorder.ts`.
pub mod event_names {
    pub const MEDIA_JOB_UPDATE: &str = "media-job-update";
    pub const RECORDER_STATUS: &str = "recorder-status";
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
pub fn emit_recorder_status(handle: &tauri::AppHandle, status: &RecordingStatus) -> Result<()> {
    handle
        .emit(event_names::RECORDER_STATUS, status)
        .map_err(|e| {
            crate::errors::InternalError::Unknown(format!("emit recorder status: {e}")).into()
        })
}
