use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::capture::config::RecordingConfig;
use crate::capture::session::Recorder;
use crate::errors::{InternalError, Result};
use crate::jobs::JobManager;
use crate::path_policy::PathPolicy;

/// Coordinates updater installation with operations that can outlive an IPC call.
#[derive(Debug, Default)]
pub struct UpdateGate {
    state: Mutex<UpdateGateState>,
}

#[derive(Debug, Default)]
struct UpdateGateState {
    installing: bool,
    active_operations: usize,
}

/// A counted operation that prevents an update from beginning while work is starting.
#[derive(Debug)]
pub struct UpdateOperation {
    gate: Arc<UpdateGate>,
}

/// Snapshot used to build the user-facing update readiness response.
#[derive(Debug, Clone, Copy, Default)]
pub struct UpdateGateSnapshot {
    pub installing: bool,
    pub active_operations: usize,
}

impl UpdateGate {
    /// Acquire a counted slot for a command that starts native work.
    pub fn acquire_operation(self: &Arc<Self>) -> Result<UpdateOperation> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| InternalError::Update("update gate mutex poisoned".into()))?;

        if state.installing {
            return Err(
                InternalError::Update("an application update is being installed".into()).into(),
            );
        }

        state.active_operations = state
            .active_operations
            .checked_add(1)
            .ok_or_else(|| InternalError::Update("too many active operations".into()))?;

        Ok(UpdateOperation {
            gate: Arc::clone(self),
        })
    }

    /// Mark installation as started. New native work is rejected until this is released.
    pub fn begin_install(&self) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| InternalError::Update("update gate mutex poisoned".into()))?;

        if state.installing {
            return Err(InternalError::Update(
                "an application update is already being installed".into(),
            )
            .into());
        }

        state.installing = true;
        Ok(())
    }

    /// Release the installation lock after a failed or cancelled install attempt.
    pub fn finish_install(&self) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| InternalError::Update("update gate mutex poisoned".into()))?;
        state.installing = false;
        Ok(())
    }

    pub fn snapshot(&self) -> Result<UpdateGateSnapshot> {
        let state = self
            .state
            .lock()
            .map_err(|_| InternalError::Update("update gate mutex poisoned".into()))?;
        Ok(UpdateGateSnapshot {
            installing: state.installing,
            active_operations: state.active_operations,
        })
    }
}

impl Drop for UpdateOperation {
    fn drop(&mut self) {
        if let Ok(mut state) = self.gate.state.lock() {
            state.active_operations = state.active_operations.saturating_sub(1);
        }
    }
}

#[cfg(test)]
mod update_gate_tests {
    use super::*;

    #[test]
    fn active_operation_is_counted_until_dropped() {
        let gate = Arc::new(UpdateGate::default());
        let operation = UpdateGate::acquire_operation(&gate).expect("operation should start");
        assert_eq!(gate.snapshot().expect("snapshot").active_operations, 1);

        drop(operation);
        assert_eq!(gate.snapshot().expect("snapshot").active_operations, 0);
    }

    #[test]
    fn installation_blocks_new_operations_until_finished() {
        let gate = Arc::new(UpdateGate::default());
        gate.begin_install().expect("install should begin");

        assert!(UpdateGate::acquire_operation(&gate).is_err());

        gate.finish_install().expect("install should finish");
        assert!(UpdateGate::acquire_operation(&gate).is_ok());
    }
}

/// Application state shared between Tauri commands and the Tauri setup hook.
///
/// The recorder, media job manager, and database connection live here so that
/// any command can access the current capture session, queue media jobs, or
/// persist library metadata.
#[derive(Debug)]
pub struct AppState {
    pub recorder: Arc<Recorder>,
    pub db: Arc<Mutex<rusqlite::Connection>>,
    pub job_manager: Arc<Mutex<JobManager>>,
    pub sessions_dir: PathBuf,
    pub ffmpeg_path: PathBuf,
    pub ffprobe_path: PathBuf,
    /// Last-used quick-start config for global shortcuts and the tray menu.
    pub quick_config: Arc<Mutex<Option<RecordingConfig>>>,
    /// Path authorization policy shared across commands.
    pub path_policy: PathPolicy,
    /// Storage upload manager for cloud and local destinations.
    pub storage_manager: crate::storage::StorageManager,
    /// Application-wide gate used to prevent work starting during an update install.
    pub update_gate: Arc<UpdateGate>,
}
