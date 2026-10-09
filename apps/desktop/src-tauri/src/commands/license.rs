use tauri::State;
use tracing::instrument;

use crate::errors::Result;
use crate::licensing::LicenseStatus;
use crate::state::AppState;

/// Current entitlement snapshot for the UI. Free when nothing valid is stored.
#[tauri::command]
#[instrument(skip(state))]
pub fn get_license_status(state: State<'_, AppState>) -> Result<LicenseStatus> {
    Ok(state.license.status())
}

/// Activate a license key against the license server (online once). In debug
/// builds a `dev:`-prefixed signed token installs directly so the full flow
/// can be exercised before the server exists; `admin:`-prefixed tokens signed
/// by the owner's offline key install the same way in every build.
#[tauri::command]
#[instrument(skip(key, state))]
pub async fn activate_license(key: String, state: State<'_, AppState>) -> Result<LicenseStatus> {
    let license = state.license.clone();
    license.activate(&key).await
}

/// Release this device and drop back to Free. Local state always clears,
/// even when the server is unreachable.
#[tauri::command]
#[instrument(skip(state))]
pub async fn deactivate_license(state: State<'_, AppState>) -> Result<LicenseStatus> {
    let license = state.license.clone();
    license.deactivate().await
}

/// Explicit refresh trigger (Settings → "Check license"). Only an explicit
/// server "revoked" answer removes Pro; network failures keep it.
#[tauri::command]
#[instrument(skip(state))]
pub async fn refresh_license(state: State<'_, AppState>) -> Result<LicenseStatus> {
    let license = state.license.clone();
    license.refresh().await
}
