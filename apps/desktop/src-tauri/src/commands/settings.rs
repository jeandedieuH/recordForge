use tauri::State;
use tracing::instrument;

use crate::database::settings;
use crate::errors::{InternalError, Result};
use crate::state::AppState;

/// Read a persisted UI setting (theme, transparency, recorder defaults).
#[tauri::command]
#[instrument]
pub fn get_setting(key: String, state: State<'_, AppState>) -> Result<Option<String>> {
    settings::validate_key(&key)?;
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    settings::get_setting(&db, &key)
}

/// Persist a UI setting. Keys are validated against an allowlist in
/// `database::settings` so the IPC surface stays narrow.
#[tauri::command]
#[instrument]
pub fn set_setting(key: String, value: String, state: State<'_, AppState>) -> Result<()> {
    settings::validate_key(&key)?;
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    settings::set_setting(&db, &key, &value)
}

/// Toggle the Mica window transparency effect at runtime (Settings → General).
/// Returns whether the effect is now active so the UI can pick the right canvas.
#[tauri::command]
#[instrument]
pub fn set_window_transparency(enabled: bool, app: tauri::AppHandle) -> Result<bool> {
    Ok(crate::window_effects::apply_mica(&app, enabled))
}

/// Whether the Mica effect is currently active (false = opaque fallback).
#[tauri::command]
#[instrument]
pub fn window_transparency_active() -> Result<bool> {
    Ok(crate::window_effects::mica_active())
}
