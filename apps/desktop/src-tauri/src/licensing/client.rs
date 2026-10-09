//! License server client.
//!
//! Talks to the private `recordforge-cloud` service (`POST /v1/license/*`).
//! The base URL is compiled in like the Google Drive secret: release builds
//! read `RECORD_FORGE_LICENSE_SERVER_URL` at compile time via `option_env!`,
//! and dev builds may override it from the process environment. Requests are
//! short-timeout and log-redacted — the license key is never logged.

use serde::{Deserialize, Serialize};

use crate::errors::{AppError, ErrorCategory, Result};

const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Compile-time server URL; dev builds may override via env at runtime.
const COMPILED_SERVER_URL: Option<&str> = option_env!("RECORD_FORGE_LICENSE_SERVER_URL");
const SERVER_URL_ENV: &str = "RECORD_FORGE_LICENSE_SERVER_URL";

#[derive(Debug)]
pub struct LicenseClient {
    base_url: Option<String>,
    http: reqwest::Client,
}

#[derive(Debug)]
pub enum RefreshOutcome {
    /// Still entitled; may carry a rotated replacement token.
    Active { token: Option<String> },
    /// Server says the license is revoked/refunded — drop to Free.
    Revoked,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivateResponse {
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshResponse {
    status: String,
    #[serde(default)]
    token: Option<String>,
}

/* ---------- Instant Share (Phase 2) ---------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareUploadPlan {
    #[serde(default)]
    pub upload_id: String,
    pub part_urls: Vec<String>,
    pub complete_url: String,
    #[serde(default)]
    pub captions_put_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareCreateResponse {
    pub share_id: String,
    pub url: String,
    pub upload: ShareUploadPlan,
}

/// One row in the owner's "Shared links" list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    pub share_id: String,
    pub url: String,
    pub title: String,
    pub status: String,
    pub bytes: u64,
    pub views: u64,
    #[serde(default)]
    pub has_password: bool,
    pub expires_at_ms: i64,
    pub created_at_ms: i64,
}

/// Owner analytics for one share (Pro Cloud extras — password/expiry
/// changes go through `share_update`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareAnalytics {
    pub views: u64,
    pub unique_viewers: u64,
    pub avg_watch_seconds: f64,
    pub comments: u64,
    pub unresolved_comments: u64,
    pub series: Vec<ShareAnalyticsPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareAnalyticsPoint {
    pub day: String,
    pub views: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShareListResponse {
    #[serde(default)]
    shares: Vec<ShareInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShareRenewResponse {
    expires_at_ms: i64,
}

/// Metadata the create call needs to size the multipart plan.
#[derive(Debug)]
pub struct ShareMeta {
    pub title: String,
    pub duration_ms: u64,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub chapters: Vec<ShareChapter>,
    pub allow_download: bool,
    pub allow_embed: bool,
    pub has_captions: bool,
    pub password: Option<String>,
    pub expires_in_days: Option<u32>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareChapter {
    pub t: u64,
    pub label: String,
}

impl Default for LicenseClient {
    fn default() -> Self {
        Self::new()
    }
}

impl LicenseClient {
    pub fn new() -> Self {
        let base_url = COMPILED_SERVER_URL
            .map(str::to_string)
            .or_else(|| std::env::var(SERVER_URL_ENV).ok())
            .map(|url| url.trim().trim_end_matches('/').to_string())
            .filter(|url| !url.is_empty());
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { base_url, http }
    }

    pub fn is_configured(&self) -> bool {
        self.base_url.is_some()
    }

    /// Exchange a license key + device binding for a signed offline token.
    pub async fn activate(
        &self,
        key: &str,
        device_hash: &str,
        device_label: &str,
        app_version: &str,
        os: &str,
    ) -> Result<String> {
        let url = self.endpoint("/v1/license/activate")?;
        let response = self
            .http
            .post(url)
            .json(&serde_json::json!({
                "key": key,
                "deviceHash": device_hash,
                "deviceLabel": device_label,
                "appVersion": app_version,
                "os": os,
            }))
            .send()
            .await
            .map_err(|error| Self::network_error("activate", &error))?;
        let response = Self::ensure_success(response, "license_key_invalid").await?;
        let body: ActivateResponse = response
            .json()
            .await
            .map_err(|_| Self::server_error("license server returned an unreadable response"))?;
        if body.token.is_empty() {
            return Err(Self::server_error("license server returned no token"));
        }
        Ok(body.token)
    }

    /// Release this device slot. Callers treat the result as best-effort.
    pub async fn deactivate(&self, key: &str, device_hash: &str) -> Result<()> {
        let url = self.endpoint("/v1/license/deactivate")?;
        let response = self
            .http
            .post(url)
            .json(&serde_json::json!({
                "key": key,
                "deviceHash": device_hash,
            }))
            .send()
            .await
            .map_err(|error| Self::network_error("deactivate", &error))?;
        Self::ensure_success(response, "license_deactivate_failed").await?;
        Ok(())
    }

    /// Server-side entitlement check. `Active` may rotate the token; `Revoked`
    /// is the only outcome that removes Pro locally.
    pub async fn refresh(
        &self,
        key: &str,
        current_token: &str,
        device_hash: &str,
    ) -> Result<RefreshOutcome> {
        let url = self.endpoint("/v1/license/refresh")?;
        let response = self
            .http
            .post(url)
            .json(&serde_json::json!({
                "key": key,
                "token": current_token,
                "deviceHash": device_hash,
            }))
            .send()
            .await
            .map_err(|error| Self::network_error("refresh", &error))?;
        if response.status() == reqwest::StatusCode::NOT_FOUND
            || response.status() == reqwest::StatusCode::GONE
        {
            return Ok(RefreshOutcome::Revoked);
        }
        let response = Self::ensure_success(response, "license_refresh_failed").await?;
        let body: RefreshResponse = response
            .json()
            .await
            .map_err(|_| Self::server_error("license server returned an unreadable response"))?;
        match body.status.as_str() {
            "active" => Ok(RefreshOutcome::Active { token: body.token }),
            "revoked" | "refunded" | "disabled" => Ok(RefreshOutcome::Revoked),
            _ => Err(Self::server_error(
                "license server returned an unknown status",
            )),
        }
    }

    /* ---------- Instant Share ---------- */

    /// Reserve a share + presigned multipart plan. 409 = link quota reached,
    /// 413 = over duration/resolution/size limits.
    pub async fn share_create(&self, token: &str, meta: &ShareMeta) -> Result<ShareCreateResponse> {
        let url = self.endpoint("/v1/share/create")?;
        let response = self
            .http
            .post(url)
            .json(&serde_json::json!({
                "token": token,
                "title": meta.title,
                "durationMs": meta.duration_ms,
                "bytes": meta.bytes,
                "width": meta.width,
                "height": meta.height,
                "fps": meta.fps,
                "chapters": meta.chapters,
                "allowDownload": meta.allow_download,
                "allowEmbed": meta.allow_embed,
                "hasCaptions": meta.has_captions,
                "password": meta.password,
                "expiresInDays": meta.expires_in_days,
            }))
            .send()
            .await
            .map_err(|error| Self::network_error("share create", &error))?;
        let response = Self::ensure_success(response, "share_create_failed").await?;
        response
            .json()
            .await
            .map_err(|_| Self::server_error("share server returned an unreadable response"))
    }

    /// Feed the viewer's live progress bar — best-effort.
    pub async fn share_progress(&self, token: &str, share_id: &str, parts_done: u32) -> Result<()> {
        let url = self.endpoint("/v1/share/progress")?;
        let response = self
            .http
            .post(url)
            .json(&serde_json::json!({
                "shareId": share_id,
                "token": token,
                "partsDone": parts_done,
            }))
            .send()
            .await
            .map_err(|error| Self::network_error("share progress", &error))?;
        Self::ensure_success(response, "share_progress_failed").await?;
        Ok(())
    }

    /// Mark the upload finished — flips the viewer from progress to player.
    pub async fn share_complete(&self, token: &str, share_id: &str, bytes: u64) -> Result<()> {
        let url = self.endpoint("/v1/share/complete")?;
        let response = self
            .http
            .post(url)
            .json(&serde_json::json!({
                "shareId": share_id,
                "token": token,
                "bytes": bytes,
            }))
            .send()
            .await
            .map_err(|error| Self::network_error("share complete", &error))?;
        Self::ensure_success(response, "share_complete_failed").await?;
        Ok(())
    }

    /// Owner's share list for the management view.
    pub async fn share_list(&self, token: &str) -> Result<Vec<ShareInfo>> {
        let url = self.endpoint("/v1/share/list")?;
        let response = self
            .http
            .post(url)
            .json(&serde_json::json!({ "token": token }))
            .send()
            .await
            .map_err(|error| Self::network_error("share list", &error))?;
        let response = Self::ensure_success(response, "share_list_failed").await?;
        let body: ShareListResponse = response
            .json()
            .await
            .map_err(|_| Self::server_error("share server returned an unreadable response"))?;
        Ok(body.shares)
    }

    /// Extend a live link's 30-day window.
    pub async fn share_renew(&self, token: &str, share_id: &str) -> Result<i64> {
        let url = self.endpoint("/v1/share/renew")?;
        let response = self
            .http
            .post(url)
            .json(&serde_json::json!({ "shareId": share_id, "token": token }))
            .send()
            .await
            .map_err(|error| Self::network_error("share renew", &error))?;
        let response = Self::ensure_success(response, "share_renew_failed").await?;
        let body: ShareRenewResponse = response
            .json()
            .await
            .map_err(|_| Self::server_error("share server returned an unreadable response"))?;
        Ok(body.expires_at_ms)
    }

    /// Kill a link — the object is deleted server-side.
    /// Owner analytics: views, uniques, watch time, comment counts.
    pub async fn share_analytics(&self, token: &str, share_id: &str) -> Result<ShareAnalytics> {
        let url = self.endpoint("/v1/share/analytics")?;
        let response = self
            .http
            .post(url)
            .json(&serde_json::json!({ "shareId": share_id, "token": token }))
            .send()
            .await
            .map_err(|error| Self::network_error("share analytics", &error))?;
        let response = Self::ensure_success(response, "share_analytics_failed").await?;
        response
            .json()
            .await
            .map_err(|_| Self::server_error("share server returned an unreadable response"))
    }

    pub async fn share_revoke(&self, token: &str, share_id: &str) -> Result<()> {
        let url = self.endpoint("/v1/share/revoke")?;
        let response = self
            .http
            .post(url)
            .json(&serde_json::json!({ "shareId": share_id, "token": token }))
            .send()
            .await
            .map_err(|error| Self::network_error("share revoke", &error))?;
        Self::ensure_success(response, "share_revoke_failed").await?;
        Ok(())
    }

    fn endpoint(&self, path: &str) -> Result<String> {
        let base = self
            .base_url
            .as_ref()
            .ok_or_else(|| Self::server_error("license server is not configured for this build"))?;
        Ok(format!("{base}{path}"))
    }

    async fn ensure_success(response: reqwest::Response, code: &str) -> Result<reqwest::Response> {
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status();
        let message = match status {
            reqwest::StatusCode::UNAUTHORIZED
            | reqwest::StatusCode::FORBIDDEN
            | reqwest::StatusCode::NOT_FOUND => "license key is invalid or unknown".to_string(),
            reqwest::StatusCode::CONFLICT => {
                "license key has no free device slots; deactivate another device".to_string()
            }
            reqwest::StatusCode::TOO_MANY_REQUESTS => {
                "too many activation attempts; try again later".to_string()
            }
            _ => format!("license server error ({status})"),
        };
        Err(AppError::new(ErrorCategory::Licensing, code, message))
    }

    fn network_error(operation: &str, error: &reqwest::Error) -> AppError {
        AppError::new(
            ErrorCategory::Licensing,
            "licensing_unreachable",
            format!("could not reach the license server during {operation}: {error}"),
        )
    }

    fn server_error(message: &str) -> AppError {
        AppError::new(ErrorCategory::Licensing, "licensing_unavailable", message)
    }
}
