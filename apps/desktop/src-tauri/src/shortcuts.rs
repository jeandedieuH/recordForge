use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};

use crate::capture::manifest::RecorderState;
use crate::errors::{InternalError, Result};
use crate::state::AppState;

fn map_tauri_err(e: tauri::Error) -> InternalError {
    InternalError::Unknown(format!("{e:?}"))
}

fn map_shortcut_err(e: tauri_plugin_global_shortcut::Error) -> InternalError {
    InternalError::Unknown(format!("{e:?}"))
}

/// Register global shortcuts for common recorder actions.
pub fn register_shortcuts(app: &tauri::App) -> Result<()> {
    app.handle()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["ctrl+shift+r", "ctrl+shift+p", "ctrl+shift+m"])
                .map_err(map_shortcut_err)?
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        if shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyR) {
                            let _ = toggle_recording(app);
                        } else if shortcut
                            .matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyP)
                        {
                            let _ = toggle_pause_resume(app);
                        } else if shortcut
                            .matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyM)
                        {
                            let _ = insert_marker(app);
                        }
                    }
                })
                .build(),
        )
        .map_err(map_tauri_err)?;
    Ok(())
}

fn toggle_recording(app: &tauri::AppHandle) -> Result<()> {
    let state = app.state::<AppState>();

    // Track what action was taken so we can open/close auxiliary windows
    // after releasing the recorder mutex.
    enum Action {
        Started(crate::capture::source::Bounds),
        Stopped,
        Aborted,
        None,
    }

    let action = {
        let guard = state
            .recorder
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("recorder mutex poisoned".into()))?;
        let status = guard.status()?;

        match status.state {
            RecorderState::Idle | RecorderState::Completed | RecorderState::Failed => {
                let quick = state.quick_config.lock().map_err(|_| {
                    crate::errors::InternalError::Capture("quick config mutex poisoned".into())
                })?;
                if let Some(config) = quick.as_ref() {
                    let bounds = config.source.bounds;
                    guard.start(config.clone())?;
                    Action::Started(bounds)
                } else {
                    Action::None
                }
            }
            RecorderState::Recording | RecorderState::Paused => {
                guard.stop().map(|_| ())?;
                Action::Stopped
            }
            RecorderState::Countdown => {
                guard.cancel_prepared(&status.session_id)?;
                Action::Aborted
            }
            _ => Action::None,
        }
        // guard is dropped here — safe to do window operations below
    };

    // Open or close auxiliary windows outside the recorder lock
    match action {
        Action::Started(bounds) => {
            if let Err(error) = crate::window::MainWindow::minimize(app) {
                tracing::warn!(error = ?error, "shortcut start could not minimize main window");
            }
            crate::commands::recording::open_recording_windows_async(app, bounds);
        }
        Action::Stopped | Action::Aborted => {
            crate::window::FloatingWindow::hide(app);
            crate::window::BoundaryWindow::hide(app);
            crate::window::CountdownWindow::hide(app);
            if let Err(error) = crate::window::MainWindow::restore(app) {
                tracing::warn!(error = ?error, "shortcut action could not restore main window");
            }
        }
        Action::None => {}
    }

    // Reflect the shortcut-driven change in the UI immediately rather than
    // waiting for the next status poll.
    crate::commands::recording::emit_current_status(app, &state);
    Ok(())
}

fn toggle_pause_resume(app: &tauri::AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let guard = state
        .recorder
        .lock()
        .map_err(|_| crate::errors::InternalError::Capture("recorder mutex poisoned".into()))?;
    let status = guard.status()?;

    let outcome = match status.state {
        RecorderState::Recording => guard.pause().map(|_| ()),
        RecorderState::Paused => guard.resume().map(|_| ()),
        _ => Ok(()),
    };
    drop(guard);

    // Reflect the shortcut-driven change in the UI immediately.
    crate::commands::recording::emit_current_status(app, &state);
    outcome
}

fn insert_marker(app: &tauri::AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let guard = state
        .recorder
        .lock()
        .map_err(|_| crate::errors::InternalError::Capture("recorder mutex poisoned".into()))?;
    guard.insert_marker("shortcut marker".into()).map(|_| ())
}
