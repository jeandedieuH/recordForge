use std::str::FromStr;

use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::capture::manifest::RecorderState;
use crate::errors::{InternalError, Result};
use crate::state::AppState;

fn map_tauri_err(e: tauri::Error) -> InternalError {
    InternalError::Unknown(format!("{e:?}"))
}

// macOS conventions use ⌘ for system-level shortcuts — and the UI advertises
// "⌘ ⇧ R" via the platform.ts modifier labels, so the registration must match.
#[cfg(target_os = "macos")]
const MODIFIER: Modifiers = Modifiers::META;
#[cfg(not(target_os = "macos"))]
const MODIFIER: Modifiers = Modifiers::CONTROL;

#[cfg(target_os = "macos")]
const ACCELERATORS: [&str; 3] = ["cmd+shift+r", "cmd+shift+p", "cmd+shift+m"];
#[cfg(not(target_os = "macos"))]
const ACCELERATORS: [&str; 3] = ["ctrl+shift+r", "ctrl+shift+p", "ctrl+shift+m"];

/// Register global shortcuts for common recorder actions.
pub fn register_shortcuts(app: &tauri::App) -> Result<()> {
    app.handle()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        if shortcut.matches(MODIFIER | Modifiers::SHIFT, Code::KeyR) {
                            let _ = toggle_recording(app);
                        } else if shortcut.matches(MODIFIER | Modifiers::SHIFT, Code::KeyP) {
                            let _ = toggle_pause_resume(app);
                        } else if shortcut.matches(MODIFIER | Modifiers::SHIFT, Code::KeyM) {
                            let _ = insert_marker(app);
                        }
                    }
                })
                .build(),
        )
        .map_err(map_tauri_err)?;

    // Register shortcuts individually so a conflict on one shortcut (e.g. key already registered
    // by another running application or instance) does not prevent other shortcuts or the app from working.
    let global_shortcut = app.global_shortcut();
    for shortcut_str in ACCELERATORS {
        match Shortcut::from_str(shortcut_str) {
            Ok(shortcut) => {
                if let Err(err) = global_shortcut.register(shortcut) {
                    tracing::warn!(
                        shortcut = shortcut_str,
                        error = ?err,
                        "failed to register global shortcut (may already be in use by another application)"
                    );
                } else {
                    tracing::debug!(shortcut = shortcut_str, "registered global shortcut");
                }
            }
            Err(err) => {
                tracing::warn!(
                    shortcut = shortcut_str,
                    error = ?err,
                    "failed to parse global shortcut definition"
                );
            }
        }
    }

    Ok(())
}

/// What the global record shortcut should do for a given recorder state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShortcutAction {
    /// Ask the React store to run the normal start flow (config assembly +
    /// countdown). The shortcut must never start natively: the store owns the
    /// current source/device selection and the start delay.
    RequestStart,
    /// Stop the active session (spawned — the stop command is async).
    Stop,
    /// Cancel a prepared session that is still counting down.
    Cancel,
    /// Another transition is in flight; leave it alone.
    Ignore,
}

pub(crate) fn shortcut_action(state: RecorderState) -> ShortcutAction {
    match state {
        RecorderState::Idle | RecorderState::Completed | RecorderState::Failed => {
            ShortcutAction::RequestStart
        }
        RecorderState::Recording | RecorderState::Paused => ShortcutAction::Stop,
        RecorderState::Countdown => ShortcutAction::Cancel,
        _ => ShortcutAction::Ignore,
    }
}

fn toggle_recording(app: &tauri::AppHandle) -> Result<()> {
    let state = app.state::<AppState>();

    let action = {
        let status = state.recorder.status()?;
        let action = shortcut_action(status.state);

        if action == ShortcutAction::Stop {
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app_handle.state::<AppState>();
                let _ = crate::commands::recording::stop_recording(app_handle.clone(), state).await;
            });
            return Ok(());
        }
        if action == ShortcutAction::Cancel {
            state.recorder.cancel_prepared(&status.session_id)?;
        }
        action
    };

    // Open or close auxiliary windows outside the recorder lock.
    match action {
        ShortcutAction::RequestStart => {
            if !crate::commands::recording::request_start_from_ui(app) {
                // No webview to ask — bring the window back so the user can
                // press Record instead of failing silently.
                if let Err(error) = crate::window::MainWindow::show_or_recreate(app) {
                    tracing::warn!(error = ?error, "shortcut start could not restore main window");
                }
            }
        }
        ShortcutAction::Cancel => {
            crate::window::FloatingWindow::hide(app);
            crate::window::BoundaryWindow::hide(app);
            crate::window::CountdownWindow::hide(app);
            crate::window::WebcamPreviewWindow::hide(app);
            if let Err(error) = crate::window::MainWindow::show_or_recreate(app) {
                tracing::warn!(error = ?error, "shortcut action could not restore main window");
            }
            // Same deliberate-cancel confirmation the capsule's Cancel button
            // produces via `cancel_recording_start`.
            use tauri::Emitter;
            let _ = app.emit(crate::events::event_names::RECORDING_START_CANCELLED, ());
        }
        ShortcutAction::Stop | ShortcutAction::Ignore => {}
    }

    // Reflect the shortcut-driven change in the UI immediately rather than
    // waiting for the next status poll.
    crate::commands::recording::emit_current_status(app, &state);
    Ok(())
}

fn toggle_pause_resume(app: &tauri::AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let status = state.recorder.status()?;

    let outcome = match status.state {
        RecorderState::Recording => state.recorder.pause().map(|_| ()),
        RecorderState::Paused => state.recorder.resume().map(|_| ()),
        _ => Ok(()),
    };

    // Reflect the shortcut-driven change in the UI immediately.
    crate::commands::recording::emit_current_status(app, &state);
    outcome
}

fn insert_marker(app: &tauri::AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    crate::commands::recording::insert_marker_broadcast(app, &state, String::new()).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::{shortcut_action, ShortcutAction};
    use crate::capture::manifest::RecorderState;

    /// The regression this guards: the record shortcut used to start a session
    /// natively from the last quick config, which replayed stale device
    /// selections and skipped the countdown. Every startable state must ask the
    /// React store instead.
    #[test]
    fn idle_states_request_a_frontend_start() {
        for state in [
            RecorderState::Idle,
            RecorderState::Completed,
            RecorderState::Failed,
        ] {
            assert_eq!(
                shortcut_action(state),
                ShortcutAction::RequestStart,
                "{state:?} must request a store-driven start"
            );
        }
    }

    #[test]
    fn active_sessions_stop_and_countdowns_cancel() {
        assert_eq!(
            shortcut_action(RecorderState::Recording),
            ShortcutAction::Stop
        );
        assert_eq!(shortcut_action(RecorderState::Paused), ShortcutAction::Stop);
        assert_eq!(
            shortcut_action(RecorderState::Countdown),
            ShortcutAction::Cancel
        );
    }

    #[test]
    fn transitional_states_are_left_alone() {
        for state in [
            RecorderState::SelectingSource,
            RecorderState::Configuring,
            RecorderState::Finalizing,
            RecorderState::Recovering,
            RecorderState::RecoveryRequired,
        ] {
            assert_eq!(shortcut_action(state), ShortcutAction::Ignore);
        }
    }
}
