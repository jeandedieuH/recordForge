//! Instant Share commands — thin validation/entitlement wrappers over the
//! upload engine in `publish/share.rs`. Job-driven export deliveries use the
//! same engine directly.
//!
//! Hosted flow (docs/specs/instant-share.md): reserve a share + presigned
//! multipart plan from the license server → PUT 8 MiB parts to R2 → optional
//! captions sidecar → POST the multipart-complete XML → share goes live.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{Emitter, State};
use tracing::instrument;

use crate::errors::{AppError, ErrorCategory, Result};
use crate::licensing::client::{ShareAnalytics, ShareInfo};
use crate::publish::share as engine;
use crate::publish::share::{ShareExportArgs, ShareProgress, ShareResult, ShareUploadInput};
use crate::state::AppState;

fn licensing_error(code: &str, message: impl Into<String>) -> AppError {
    let mut details = serde_json::Map::new();
    details.insert("features".to_string(), serde_json::json!(["instant-share"]));
    AppError::new(ErrorCategory::Licensing, code, message.into()).with_details(details)
}

/// Upload `args.path` as a hosted share link. Pro-gated: Free callers get
/// `pro_feature_required` with `instant-share` so the UI can route to the
/// upgrade dialog. The local export is never touched.
#[tauri::command]
#[instrument(skip(state, app, args))]
pub async fn share_export(
    args: ShareExportArgs,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ShareResult> {
    let _update_operation = state.update_gate.acquire_operation()?;
    // Entitlement + token — the server's own auth is the signed token, so a
    // tampered Free client stops here AND there.
    if !state.license.entitlements().pro_enabled {
        return Err(licensing_error(
            "pro_feature_required",
            "Instant Share is a RecordForge Pro feature",
        ));
    }
    let token = state
        .license
        .license_token()
        .ok_or_else(|| licensing_error("license_required", "a Pro license is required to share"))?;

    // Path validation: canonicalize and require an MP4 (GIF/WebP shares are
    // a later phase). The export pipeline already validated the destination.
    let path = crate::path_policy::canonicalize_path(std::path::Path::new(&args.path)).map_err(
        |error| {
            licensing_error(
                "share_path_invalid",
                format!("export path is invalid: {error}"),
            )
        },
    )?;

    let input = ShareUploadInput {
        path,
        title: args.title,
        duration_ms: args.duration_ms,
        width: args.width,
        height: args.height,
        fps: args.fps,
        chapters: args.chapters,
        allow_download: args.allow_download,
        allow_embed: args.allow_embed,
        captions_path: engine::resolve_share_captions(args.captions_path.as_deref()),
        password: args.password.filter(|p| !p.trim().is_empty()),
        expires_in_days: args.expires_in_days,
    };
    let progress = move |event: ShareProgress| {
        let _ = app.emit("share-progress", event);
    };
    engine::upload_hosted(&token, &input, Arc::new(AtomicBool::new(false)), progress).await
}

/// Abort whichever share upload is running — manual or export-job-driven.
#[tauri::command]
pub fn cancel_share() -> Result<()> {
    engine::cancel_share_upload();
    Ok(())
}

/// Owner's share list for the "Shared links" management card. Returns the
/// empty list for Free users rather than an error — the card hides itself.
#[tauri::command]
#[instrument(skip(state))]
pub async fn list_shares(state: State<'_, AppState>) -> Result<Vec<ShareInfo>> {
    let Some(token) = state.license.license_token() else {
        return Ok(Vec::new());
    };
    crate::licensing::client::LicenseClient::new()
        .share_list(&token)
        .await
}

/// Extend a live link's expiry by another 30 days.
#[tauri::command]
#[instrument(skip(state))]
pub async fn renew_share(share_id: String, state: State<'_, AppState>) -> Result<i64> {
    let token = state
        .license
        .license_token()
        .ok_or_else(|| licensing_error("license_required", "a Pro license is required"))?;
    crate::licensing::client::LicenseClient::new()
        .share_renew(&token, &share_id)
        .await
}

/// Owner analytics for one share — views, uniques, watch time, comments.
#[tauri::command]
#[instrument(skip(state))]
pub async fn share_analytics(
    share_id: String,
    state: State<'_, AppState>,
) -> Result<ShareAnalytics> {
    let token = state
        .license
        .license_token()
        .ok_or_else(|| licensing_error("license_required", "a Pro license is required"))?;
    crate::licensing::client::LicenseClient::new()
        .share_analytics(&token, &share_id)
        .await
}

/// Permanently remove a share link — deletes the hosted object.
#[tauri::command]
#[instrument(skip(state))]
pub async fn revoke_share(share_id: String, state: State<'_, AppState>) -> Result<()> {
    let token = state
        .license
        .license_token()
        .ok_or_else(|| licensing_error("license_required", "a Pro license is required"))?;
    crate::licensing::client::LicenseClient::new()
        .share_revoke(&token, &share_id)
        .await
}

/// Upload `args.path` plus a generated player page into the user's own
/// S3-compatible bucket at `share/<slug>/`. The returned link points at the
/// player's public URL — no RecordForge server involved beyond the Pro gate.
#[tauri::command]
#[instrument(skip(state, app, args))]
pub async fn share_to_profile(
    profile_id: String,
    args: ShareExportArgs,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ShareResult> {
    let _update_operation = state.update_gate.acquire_operation()?;
    if !state.license.entitlements().pro_enabled {
        return Err(licensing_error(
            "pro_feature_required",
            "Instant Share is a RecordForge Pro feature",
        ));
    }

    // Same path policy as the normal upload flow — the export must live in an
    // allowed location before it leaves the machine.
    let path: PathBuf = state
        .storage_manager
        .validate_upload_source(std::path::Path::new(&args.path))?;

    let input = ShareUploadInput {
        path,
        title: args.title,
        duration_ms: args.duration_ms,
        width: args.width,
        height: args.height,
        fps: args.fps,
        chapters: args.chapters,
        allow_download: args.allow_download,
        allow_embed: args.allow_embed,
        captions_path: engine::resolve_share_captions(args.captions_path.as_deref()),
        password: args.password.filter(|p| !p.trim().is_empty()),
        expires_in_days: args.expires_in_days,
    };
    let progress = move |event: ShareProgress| {
        let _ = app.emit("share-progress", event);
    };
    engine::upload_to_profile(
        &state.storage_manager,
        &profile_id,
        &input,
        Arc::new(AtomicBool::new(false)),
        progress,
    )
    .await
}
