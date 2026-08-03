use std::sync::atomic::{AtomicBool, Ordering};

use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::Manager;

use crate::state::AppState;

/// Whether the Mica effect was successfully applied. The frontend reads this
/// to decide between a transparent canvas (Mica visible) and the opaque
/// fallback background — a failed effect must never leave a see-through window.
static MICA_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn mica_active() -> bool {
    MICA_ACTIVE.load(Ordering::Relaxed)
}

/// Apply or clear the Mica backdrop on the main window (Windows 11 only).
/// Returns whether the requested effect is now active.
pub fn apply_mica(app: &tauri::AppHandle, enabled: bool) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        MICA_ACTIVE.store(false, Ordering::Relaxed);
        return false;
    };

    let result = if enabled {
        window.set_effects(
            EffectsBuilder::new()
                .effect(Effect::Mica)
                .state(EffectState::Active)
                .build(),
        )
    } else {
        window.set_effects(None)
    };

    match result {
        Ok(()) => {
            MICA_ACTIVE.store(enabled, Ordering::Relaxed);
            enabled
        }
        Err(err) => {
            // Opaque fallback: low-end GPUs and pre-Windows-11 machines land here.
            tracing::warn!(error = ?err, "failed to update window effects; keeping opaque fallback");
            MICA_ACTIVE.store(false, Ordering::Relaxed);
            false
        }
    }
}

/// Read the persisted transparency setting and apply it during startup.
/// Defaults to enabled; the stored "false" value (or a preflight low-end GPU
/// flag written by diagnostics) takes the opaque path.
pub fn apply_startup_effects(app: &tauri::App) {
    let enabled = app
        .try_state::<AppState>()
        .and_then(|state| {
            state.db.lock().ok().and_then(|db| {
                crate::database::settings::get_setting(&db, "windowTransparency")
                    .ok()
                    .flatten()
            })
        })
        .map(|value| value != "false")
        .unwrap_or(true);

    apply_mica(app.handle(), enabled);
}
