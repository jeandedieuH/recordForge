//! License state and offline entitlement management.
//!
//! Pro is unlocked by an Ed25519-signed token issued by the license server
//! (see `client.rs`). The token is verified offline against embedded public
//! keys and bound to this device via a salted machine hash — no raw device
//! identifiers are stored or sent. The license key itself lives in the OS
//! credential vault; only the signed token file sits in the app data dir.

pub mod client;
pub mod device;
pub mod entitlements;
pub mod store;
pub mod token;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tracing::{info, warn};

use crate::errors::{AppError, ErrorCategory, Result};

pub use entitlements::Entitlements;

/// Payload the React UI renders; mirrors `licenseStatusSchema` in contracts.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    pub tier: String,
    pub plan: Option<String>,
    pub license_id: Option<String>,
    pub device_hash: String,
    pub device_label: String,
    pub activated_at_ms: Option<i64>,
    pub last_verified_at_ms: Option<i64>,
    pub server_configured: bool,
    pub features: Vec<String>,
}

/// Verified entitlement snapshot kept in memory; the token string is retained
/// so refresh can prove possession without touching the vault.
#[derive(Debug, Clone)]
struct ActiveLicense {
    token: String,
    plan: String,
    license_id: String,
    activated_at_ms: i64,
    /// Server-issued licenses refresh/deactivate against the license server;
    /// admin-issued ones are fully local — the server never learns they
    /// exist, so it can neither rotate nor revoke them.
    server_managed: bool,
}

#[derive(Debug)]
struct LicenseInner {
    active: Option<ActiveLicense>,
    last_verified_at_ms: Option<i64>,
}

/// Owns license persistence, verification, and the entitlement snapshot that
/// media jobs consult before honoring an export request.
#[derive(Debug)]
pub struct LicenseManager {
    inner: Mutex<LicenseInner>,
    token_path: PathBuf,
    device_hash: String,
    device_label: String,
    client: client::LicenseClient,
    app: tauri::AppHandle,
}

impl LicenseManager {
    /// Load and verify any persisted token. A token that fails verification
    /// (tampered, wrong device, unknown key) is discarded — never trusted.
    pub fn load(app_data_dir: &Path, app: tauri::AppHandle) -> Self {
        let device_hash = device::device_hash().unwrap_or_else(|error| {
            warn!(error = %error, "device identity unavailable; licensing disabled");
            String::new()
        });
        let device_label = device::device_label();
        let token_path = store::token_path(app_data_dir);
        let mut last_verified_at_ms = None;
        let active = store::load_license(&token_path).and_then(|stored| match token::verify_token(
            &stored.token,
            &device_hash,
        ) {
            Ok(payload) if payload.plan.starts_with("pro") => {
                last_verified_at_ms = stored.last_verified_at_ms;
                Some(ActiveLicense {
                    token: stored.token.clone(),
                    server_managed: !token::is_admin_kid(&payload.kid),
                    plan: payload.plan,
                    license_id: payload.license_id,
                    activated_at_ms: payload.iat,
                })
            }
            Ok(_) => {
                warn!("stored license token carries a non-pro plan; ignoring");
                let _ = store::clear_license(&token_path);
                None
            }
            Err(error) => {
                warn!(error = %error, "stored license token failed verification; discarding");
                let _ = store::clear_license(&token_path);
                None
            }
        });
        let manager = Self {
            inner: Mutex::new(LicenseInner {
                active,
                last_verified_at_ms,
            }),
            token_path,
            device_hash,
            device_label,
            client: client::LicenseClient::new(),
            app,
        };
        info!(tier = %manager.tier(), "license state loaded");
        manager
    }

    fn tier(&self) -> &'static str {
        match &self.inner.lock().map(|inner| inner.active.is_some()) {
            Ok(true) => "pro",
            _ => "free",
        }
    }

    /// Snapshot consulted by export validation. Pure and lock-bounded.
    pub fn entitlements(&self) -> Entitlements {
        Entitlements {
            pro_enabled: self.tier() == "pro",
        }
    }

    /// Reject an export that carries Pro-only plan content under Free.
    pub fn enforce_export(
        &self,
        plan: &crate::exports::RenderPlan,
        settings: &crate::exports::ExportSettings,
    ) -> Result<()> {
        entitlements::enforce_export_entitlements(plan, settings, self.entitlements())
    }

    pub fn status(&self) -> LicenseStatus {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        LicenseStatus {
            tier: if inner.active.is_some() {
                "pro"
            } else {
                "free"
            }
            .to_string(),
            plan: inner.active.as_ref().map(|license| license.plan.clone()),
            license_id: inner
                .active
                .as_ref()
                .map(|license| license.license_id.clone()),
            device_hash: self.device_hash.clone(),
            device_label: self.device_label.clone(),
            activated_at_ms: inner.active.as_ref().map(|license| license.activated_at_ms),
            last_verified_at_ms: inner.last_verified_at_ms,
            server_configured: self.client.is_configured(),
            features: if inner.active.is_some() {
                entitlements::PRO_FEATURE_KEYS
                    .iter()
                    .map(|key| key.to_string())
                    .collect()
            } else {
                Vec::new()
            },
        }
    }

    /// Activate a license key against the license server, verify the returned
    /// token offline, then persist it. `dev:`-prefixed tokens bypass the
    /// server in debug builds so the full flow can be tested before launch;
    /// `admin:`-prefixed tokens (signed by the owner's offline key) install
    /// the same way in every build.
    pub async fn activate(&self, key: &str) -> Result<LicenseStatus> {
        let key = key.trim();
        if key.is_empty() {
            return Err(licensing_error(
                "license_key_invalid",
                "license key is required",
            ));
        }
        let token = if let Some(dev_token) = key.strip_prefix("dev:") {
            if !cfg!(debug_assertions) {
                return Err(licensing_error(
                    "license_key_invalid",
                    "dev license tokens are only accepted in debug builds",
                ));
            }
            dev_token.to_string()
        } else if let Some(admin_token) = key.strip_prefix("admin:") {
            // Owner-issued raw token — the signature check in install_token
            // against the embedded admin keyring is the only gate.
            admin_token.to_string()
        } else {
            if !self.client.is_configured() {
                return Err(licensing_error(
                    "licensing_unavailable",
                    "license server is not configured for this build",
                ));
            }
            self.client
                .activate(
                    key,
                    &self.device_hash,
                    &self.device_label,
                    env!("CARGO_PKG_VERSION"),
                    std::env::consts::OS,
                )
                .await?
        };
        self.install_token(&token, Some(key))
    }

    /// Verify + persist a signed token. Shared by server activation and
    /// dev/admin installs so all paths get identical offline verification.
    fn install_token(&self, token: &str, key: Option<&str>) -> Result<LicenseStatus> {
        let payload = token::verify_token(token, &self.device_hash)
            .map_err(|error| licensing_error("license_token_invalid", &error.to_string()))?;
        if !payload.plan.starts_with("pro") {
            return Err(licensing_error(
                "license_plan_unsupported",
                "license plan is not supported by this build",
            ));
        }
        let now = chrono::Utc::now().timestamp_millis();
        store::save_license(
            &self.token_path,
            &store::StoredLicense {
                token: token.to_string(),
                last_verified_at_ms: Some(now),
            },
        )?;
        if let Some(key) = key {
            let _ = crate::storage::vault::set_secret(store::LICENSE_KEY_ACCOUNT, key);
        }
        {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inner.active = Some(ActiveLicense {
                token: token.to_string(),
                server_managed: !token::is_admin_kid(&payload.kid),
                plan: payload.plan,
                license_id: payload.license_id,
                activated_at_ms: payload.iat,
            });
            inner.last_verified_at_ms = Some(now);
        }
        let status = self.status();
        self.emit_changed(&status);
        Ok(status)
    }

    /// Deactivate this device. The server call is best-effort — the local
    /// entitlement is always cleared so a deactivation can't strand Pro.
    /// Admin licenses skip the call entirely: the server never knew them.
    pub async fn deactivate(&self) -> Result<LicenseStatus> {
        let server_managed = {
            let inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inner
                .active
                .as_ref()
                .map(|license| license.server_managed)
                .unwrap_or(true)
        };
        let key = crate::storage::vault::get_secret(store::LICENSE_KEY_ACCOUNT)
            .ok()
            .flatten();
        if server_managed {
            if let Some(key) = key.as_deref() {
                if let Err(error) = self.client.deactivate(key, &self.device_hash).await {
                    warn!(error = %error, "license server deactivation failed; clearing locally");
                }
            }
        }
        self.clear_local();
        let status = self.status();
        self.emit_changed(&status);
        Ok(status)
    }

    /// The stored signed token — the bearer credential for server-authorized
    /// Pro endpoints (Instant Share). `None` when Free.
    pub fn license_token(&self) -> Option<String> {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.active.as_ref().map(|license| license.token.clone())
    }

    /// Periodic server check for refunds/revocations. A network failure never
    /// removes Pro — only an explicit "revoked" answer does. Admin licenses
    /// return early: they are local-only and the server cannot revoke them.
    pub async fn refresh(&self) -> Result<LicenseStatus> {
        let (token, server_managed, key) = {
            let inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let active = inner.active.as_ref();
            (
                active.map(|license| license.token.clone()),
                active.map(|license| license.server_managed).unwrap_or(true),
                crate::storage::vault::get_secret(store::LICENSE_KEY_ACCOUNT)
                    .ok()
                    .flatten(),
            )
        };
        let Some(token) = token else {
            return Ok(self.status());
        };
        if !server_managed {
            return Ok(self.status());
        }
        match self
            .client
            .refresh(key.as_deref().unwrap_or(""), &token, &self.device_hash)
            .await
        {
            Ok(client::RefreshOutcome::Active { token: rotated }) => {
                if let Some(rotated) = rotated {
                    // A rotated token replaces the stored one only after it
                    // passes the same offline verification.
                    let _ = self.install_token(&rotated, key.as_deref());
                }
                let now = chrono::Utc::now().timestamp_millis();
                let mut inner = self
                    .inner
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                inner.last_verified_at_ms = Some(now);
                if let Some(mut stored) = store::load_license(&self.token_path) {
                    stored.last_verified_at_ms = Some(now);
                    let _ = store::save_license(&self.token_path, &stored);
                }
            }
            Ok(client::RefreshOutcome::Revoked) => {
                self.clear_local();
                let status = self.status();
                self.emit_changed(&status);
                return Ok(status);
            }
            Err(error) => {
                warn!(error = %error, "license refresh failed; keeping current entitlement");
            }
        }
        Ok(self.status())
    }

    /// True when a refresh is due (>30 days since last server check).
    /// Admin licenses never need one — they are verified offline forever.
    pub fn refresh_due(&self) -> bool {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match inner.active.as_ref() {
            Some(active) if !active.server_managed => return false,
            None => return false,
            _ => {}
        }
        let interval_ms = 30_i64 * 24 * 60 * 60 * 1000;
        inner
            .last_verified_at_ms
            .map(|last| chrono::Utc::now().timestamp_millis() - last > interval_ms)
            .unwrap_or(true)
    }

    fn clear_local(&self) {
        let _ = store::clear_license(&self.token_path);
        let _ = crate::storage::vault::delete_secret(store::LICENSE_KEY_ACCOUNT);
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.active = None;
        inner.last_verified_at_ms = None;
    }

    fn emit_changed(&self, status: &LicenseStatus) {
        if let Err(error) = crate::events::EventPublisher::new(&self.app).license_changed(status) {
            warn!(error = %error, "failed to emit license-changed event");
        }
    }
}

fn licensing_error(code: &str, message: &str) -> AppError {
    AppError::new(ErrorCategory::Licensing, code, message)
}
