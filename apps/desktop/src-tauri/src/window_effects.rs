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

/// The translucent backdrop effect for this platform: Mica on Windows 11,
/// NSVisualEffectMaterial `Sidebar` (vibrancy) on macOS. The main window is
/// `transparent: true` in tauri.conf, so both composites behind the webview.
#[cfg(target_os = "macos")]
const BACKDROP_EFFECT: Effect = Effect::Sidebar;
#[cfg(not(target_os = "macos"))]
const BACKDROP_EFFECT: Effect = Effect::Mica;

/// Apply or clear the translucent backdrop on the main window.
/// Returns whether the requested effect is now active.
pub fn apply_mica(app: &tauri::AppHandle, enabled: bool) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        MICA_ACTIVE.store(false, Ordering::Relaxed);
        return false;
    };

    let result = if enabled {
        window.set_effects(
            EffectsBuilder::new()
                .effect(BACKDROP_EFFECT)
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
    apply_stored_effects(app.handle());
}

/// Same read-and-apply as `apply_startup_effects`, for callers that only have
/// an `AppHandle` (e.g. the tray recreating a destroyed main window).
pub fn apply_stored_effects(app: &tauri::AppHandle) {
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

    apply_mica(app, enabled);
}
