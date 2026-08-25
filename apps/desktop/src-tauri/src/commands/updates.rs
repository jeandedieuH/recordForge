use tauri::State;
use tracing::instrument;

use crate::capture::manifest::RecorderState;
use crate::database::{media as media_db, storage as storage_db};
use crate::errors::Result;
use crate::state::AppState;

/// Native work that must finish before the Windows updater can install safely.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateBlocker {
    Recording,
    RecordingFinalizing,
    MediaJobActive,
    UploadActive,
    OperationActive,
    UpdateInProgress,
}

/// Snapshot of whether the application can safely launch the updater installer.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReadiness {
    pub can_install: bool,
    pub blockers: Vec<UpdateBlocker>,
}

#[tauri::command]
#[instrument(skip(state))]
pub fn get_update_readiness(state: State<'_, AppState>) -> Result<UpdateReadiness> {
    collect_update_readiness(&state, true)
}

/// Claim the install phase only after rechecking all native work.
///
/// The gate is set before the readiness query so new operations cannot race the
/// final check. Callers must release it with `cancel_update_install` if the
/// installer fails before Windows exits the process.
#[tauri::command]
#[instrument(skip(state))]
pub fn begin_update_install(state: State<'_, AppState>) -> Result<UpdateReadiness> {
    state.update_gate.begin_install()?;

    match collect_update_readiness(&state, false) {
        Ok(readiness) if readiness.can_install => Ok(readiness),
        Ok(readiness) => {
            state.update_gate.finish_install()?;
            Ok(readiness)
        }
        Err(error) => {
            let _ = state.update_gate.finish_install();
            Err(error)
        }
    }
}

#[tauri::command]
#[instrument(skip(state))]
pub fn cancel_update_install(state: State<'_, AppState>) -> Result<()> {
    state.update_gate.finish_install()
}

fn collect_update_readiness(
    state: &AppState,
    include_install_state: bool,
) -> Result<UpdateReadiness> {
    let gate_snapshot = state.update_gate.snapshot()?;
    let mut blockers = Vec::new();

    if include_install_state && gate_snapshot.installing {
        blockers.push(UpdateBlocker::UpdateInProgress);
    }
    if gate_snapshot.active_operations > 0 {
        blockers.push(UpdateBlocker::OperationActive);
    }

    let recorder_state = state.recorder.status()?.state;
    match recorder_state {
        RecorderState::Idle | RecorderState::Completed | RecorderState::Failed => {}
        RecorderState::Finalizing => push_unique(&mut blockers, UpdateBlocker::RecordingFinalizing),
        RecorderState::SelectingSource
        | RecorderState::Configuring
        | RecorderState::Countdown
        | RecorderState::Recording
        | RecorderState::Paused
        | RecorderState::Recovering
        | RecorderState::RecoveryRequired => push_unique(&mut blockers, UpdateBlocker::Recording),
    }

    let conn = state
        .db
        .lock()
        .map_err(|_| crate::errors::InternalError::Storage("database mutex poisoned".into()))?;

    if !media_db::list_active_or_pending_jobs(&conn)?.is_empty() {
        push_unique(&mut blockers, UpdateBlocker::MediaJobActive);
    }

    if storage_db::list_upload_jobs(&conn)?
        .iter()
        .any(|job| matches!(job.state.as_str(), "pending" | "uploading" | "paused"))
    {
        push_unique(&mut blockers, UpdateBlocker::UploadActive);
    }

    Ok(UpdateReadiness {
        can_install: blockers.is_empty(),
        blockers,
    })
}

fn push_unique(blockers: &mut Vec<UpdateBlocker>, blocker: UpdateBlocker) {
    if !blockers.contains(&blocker) {
        blockers.push(blocker);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blockers_use_stable_kebab_case_serialization() {
        assert_eq!(
            serde_json::to_string(&UpdateBlocker::RecordingFinalizing).expect("serialize blocker"),
            "\"recording-finalizing\""
        );
        assert_eq!(
            serde_json::to_string(&UpdateBlocker::MediaJobActive).expect("serialize blocker"),
            "\"media-job-active\""
        );
    }

    #[test]
    fn duplicate_blockers_are_not_added() {
        let mut blockers = Vec::new();
        push_unique(&mut blockers, UpdateBlocker::MediaJobActive);
        push_unique(&mut blockers, UpdateBlocker::MediaJobActive);
        assert_eq!(blockers.len(), 1);
    }
}
