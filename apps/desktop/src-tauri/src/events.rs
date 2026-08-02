use tauri::Emitter;

use crate::database::media::MediaJob;
use crate::errors::Result;

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
            .emit("media-job-update", job)
            .map_err(|e| crate::errors::InternalError::Unknown(format!("emit: {e}")).into())
    }
}
