//! Instant Share — publish a completed export's MP4 to the hosted viewer or
//! a BYO S3 bucket.
//!
//! Both paths are EXPORT-JOB SOURCED: the caller names a finished `export`
//! media job, the source (file, captions, title, measurements) is resolved
//! and authorized natively from the job's persisted outputs + frozen
//! artifact manifest — no caller-supplied media paths, captions, or
//! measurement arrays.
//!
//! Admission pattern (shared with YouTube): validate → resolve source →
//! `PublicationRegistry::begin` (idempotent `operationId`, one active op per
//! provider) → return the admitted `PublicationJob` immediately while the
//! worker owns updates.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::State;
use tracing::{info, instrument};

use crate::errors::{AppError, ErrorCategory, InternalError, Result};
use crate::licensing::client::{LicenseClient, ShareChapter, ShareInfo, ShareMeta};
use crate::publish::hosted::{
    run_hosted_share, HostedShareInput, WorkerOutcome, SHARE_MAX_BYTES, SHARE_MAX_DURATION_MS,
    SHARE_MAX_PIXELS,
};
use crate::publish::jobs::{PublicationJob, PublicationProvider};
use crate::publish::runner;
use crate::publish::source::{resolve_export_source, ResolvedExportSource};
use crate::state::AppState;
use crate::storage::s3::S3Client;
use crate::storage::vault;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareExportArgs {
    /// The finished export job whose output is published.
    pub export_job_id: String,
    /// Caller-generated idempotency key — replaying the same id + request
    /// returns the existing job instead of double-publishing.
    pub operation_id: String,
    #[serde(default = "default_true")]
    pub allow_download: bool,
    #[serde(default = "default_true")]
    pub allow_embed: bool,
    /// Pro Cloud extra — hosted shares only. The server stores a salted hash
    /// and gates the viewer manifest; BYO-bucket shares reject passwords
    /// because a public bucket URL can't gate playback.
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub expires_in_days: Option<u32>,
}

fn default_true() -> bool {
    true
}

fn licensing_error(code: &str, message: impl Into<String>) -> AppError {
    let mut details = serde_json::Map::new();
    details.insert("features".to_string(), serde_json::json!(["instant-share"]));
    AppError::new(ErrorCategory::Licensing, code, message.into()).with_details(details)
}

/// Pro gate + license token + export-source resolution — the shared front
/// half of both share entry points.
fn admit_share_common(
    state: &AppState,
    args: &ShareExportArgs,
) -> Result<(String, ResolvedExportSource)> {
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

    // Source resolution runs under a short DB lock; the artifact backfill
    // probes files, which no lock should wait on — resolve the job row
    // first, then measure.
    let job_id = args.export_job_id.clone();
    let conn = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    let source = resolve_export_source(&conn, &state.ffprobe_path, &job_id)?;
    drop(conn);

    // Manifest product caps — rejected BEFORE any reservation or upload.
    if source.artifact.duration_ms > SHARE_MAX_DURATION_MS {
        return Err(licensing_error(
            "share_too_large",
            "Instant Share is limited to 10-minute exports",
        ));
    }
    if (source.artifact.width as u64) * (source.artifact.height as u64) > SHARE_MAX_PIXELS {
        return Err(licensing_error(
            "share_too_large",
            "Instant Share is limited to 1920×1080 exports",
        ));
    }
    if source.artifact.bytes > SHARE_MAX_BYTES {
        return Err(licensing_error(
            "share_too_large",
            "Instant Share is limited to 8 GB exports",
        ));
    }

    Ok((token, source))
}

fn begin_publication(
    state: &AppState,
    provider: PublicationProvider,
    profile_id: Option<String>,
    args: &ShareExportArgs,
    total_bytes: u64,
) -> Result<(PublicationJob, crate::publish::jobs::CancelToken, bool)> {
    // The idempotency fingerprint freezes the whole request shape.
    let fingerprint = serde_json::json!({
        "exportJobId": args.export_job_id,
        "provider": format!("{provider:?}"),
        "profileId": profile_id,
        "allowDownload": args.allow_download,
        "allowEmbed": args.allow_embed,
        "expiresInDays": args.expires_in_days,
    })
    .to_string();
    state.publication_registry.begin(
        &args.operation_id,
        &args.export_job_id,
        provider,
        profile_id,
        &fingerprint,
        total_bytes,
    )
}

/// Trim and bound the viewer password — empty means public; the server caps
/// hashes at 128 chars so we reject longer input before a job is admitted.
fn normalized_password(args: &ShareExportArgs) -> Result<Option<String>> {
    let password = args
        .password
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string);
    if let Some(p) = &password {
        if p.chars().count() > 128 {
            return Err(licensing_error(
                "share_password_too_long",
                "share passwords are limited to 128 characters",
            ));
        }
    }
    Ok(password)
}

/// Publish the export's MP4 to the hosted share viewer. Returns the admitted
/// publication job; its progress arrives over `publication-job-update`.
#[tauri::command]
#[instrument(skip(state, app, args))]
pub async fn share_export(
    args: ShareExportArgs,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<PublicationJob> {
    let (token, source) = admit_share_common(&state, &args)?;
    let password = normalized_password(&args)?;
    let (job, cancel, is_new) = begin_publication(
        &state,
        PublicationProvider::Hosted,
        None,
        &args,
        source.artifact.bytes,
    )?;
    runner::emit_job(&app, &job);
    if !is_new {
        return Ok(job);
    }

    let artifact = source.artifact.clone();
    let meta = ShareMeta {
        title: artifact.title.clone(),
        duration_ms: artifact.duration_ms,
        bytes: artifact.bytes,
        width: artifact.width,
        height: artifact.height,
        fps: artifact.fps.round() as u32,
        chapters: artifact
            .chapters
            .iter()
            .map(|c| ShareChapter {
                t: c.t,
                label: c.label.clone(),
            })
            .collect(),
        allow_download: args.allow_download,
        allow_embed: args.allow_embed,
        has_captions: source.captions_path.is_some(),
        password,
        expires_in_days: args.expires_in_days,
    };

    // The reservation is created inside the worker so an admitted job that
    // never runs leaves no orphaned server-side share.
    let job_id = job.id.clone();
    let registry = Arc::clone(&state.publication_registry);
    let sink = runner::progress_sink(app.clone(), Arc::clone(&registry), job_id.clone());
    runner::spawn_worker(app, registry, job_id, cancel.clone(), async move {
        let client = LicenseClient::new();
        let created = match client.share_create(&token, &meta).await {
            Ok(created) => created,
            Err(error) => return WorkerOutcome::Failed(error),
        };
        run_hosted_share(HostedShareInput {
            client,
            license_token: token,
            video_path: source.path,
            captions_path: source.captions_path,
            created,
            bytes: meta.bytes,
            progress: sink,
            cancel,
        })
        .await
    });
    Ok(job)
}

/* ---------- BYO-bucket share (Instant Share, own storage) ---------- */

/// Self-contained player page uploaded next to the video — placeholders are
/// filled by `render_share_player`.
const SHARE_PLAYER_HTML: &str = include_str!("assets/share-player.html");

/// Upload the export's MP4 plus a generated player page into the user's own
/// S3 bucket at `share/<slug>/`. Requires the profile's `publicBaseUrl` —
/// a bucket with no public read URL cannot produce a shareable player.
#[tauri::command]
#[instrument(skip(state, app, args))]
pub async fn share_to_profile(
    profile_id: String,
    args: ShareExportArgs,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<PublicationJob> {
    let (_token, source) = admit_share_common(&state, &args)?;

    // A file in the user's own bucket is reachable at its public URL — a
    // password field there would gate nothing, so it is rejected loudly
    // rather than publishing a falsely-"protected" link.
    if args
        .password
        .as_deref()
        .is_some_and(|p| !p.trim().is_empty())
    {
        return Err(licensing_error(
            "share_password_unsupported",
            "password-protected shares need hosted Instant Share — a file in your own bucket cannot gate playback",
        ));
    }

    let profile = state.storage_manager.load_profile(&profile_id)?;
    if profile.kind != "s3" {
        return Err(licensing_error(
            "share_provider_unsupported",
            "Instant Share to your own storage currently supports S3-compatible buckets only",
        ));
    }
    let s3_config = profile
        .s3_config
        .clone()
        .ok_or_else(|| InternalError::Storage("S3 configuration missing for profile".into()))?;
    let public_base = s3_config
        .public_base_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            licensing_error(
                "share_public_url_missing",
                "this storage profile has no public base URL — set one on the profile so the player link is reachable",
            )
        })?;
    // Only http(s) origins are shareable.
    if !(public_base.starts_with("https://") || public_base.starts_with("http://")) {
        return Err(licensing_error(
            "share_public_url_invalid",
            "the profile's public base URL must be an http(s) origin",
        ));
    }
    let access_key = vault::get_secret(&format!("{}:access_key", profile.id))?
        .ok_or_else(|| InternalError::Storage("S3 Access Key ID missing from vault".into()))?;
    let secret_key = vault::get_secret(&format!("{}:secret_key", profile.id))?
        .ok_or_else(|| InternalError::Storage("S3 Secret Access Key missing from vault".into()))?;

    let (job, cancel, is_new) = begin_publication(
        &state,
        PublicationProvider::S3,
        Some(profile.id.clone()),
        &args,
        source.artifact.bytes,
    )?;
    runner::emit_job(&app, &job);
    if !is_new {
        return Ok(job);
    }

    let job_id = job.id.clone();
    let registry = Arc::clone(&state.publication_registry);
    let sink = runner::progress_sink(app.clone(), Arc::clone(&registry), job_id.clone());
    let artifact = source.artifact.clone();
    runner::spawn_worker(app, registry, job_id, cancel.clone(), async move {
        run_byo_share(
            S3Client::new(s3_config, access_key, secret_key),
            public_base,
            source,
            artifact,
            args.allow_download,
            sink,
            cancel,
        )
        .await
    });
    Ok(job)
}

/// Encode one URL path segment — the player link is built from the profile's
/// base URL, so slug/title bytes must not be able to escape it.
fn url_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Join a public base URL with path segments — the base keeps its own
/// trailing path (e.g. a CDN prefix).
fn public_url(base: &str, segments: &[&str]) -> String {
    let mut url = base.trim_end_matches('/').to_string();
    for segment in segments {
        url.push('/');
        url.push_str(&url_segment(segment));
    }
    url
}

/// The BYO worker: video → captions.vtt → player index.html LAST (the page
/// is the link target, so it must not go live before its media does).
async fn run_byo_share(
    client: S3Client,
    public_base: String,
    source: ResolvedExportSource,
    artifact: crate::exports::delivery_metadata::ExportArtifactInfo,
    allow_download: bool,
    progress: crate::publish::hosted::ProgressSink,
    cancel: crate::publish::jobs::CancelToken,
) -> WorkerOutcome {
    use crate::publish::jobs::{PublicationResult, PublicationShareResult, PublicationStatus};

    // upload_file_typed polls a plain AtomicBool — a driver task mirrors the
    // shared CancelToken into it so mid-upload cancels propagate.
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let _flag_driver = {
        let flag = Arc::clone(&cancel_flag);
        let cancel = cancel.clone();
        tokio::spawn(async move {
            loop {
                if cancel.is_cancelled() {
                    flag.store(true, Ordering::SeqCst);
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
    };
    let flag = cancel_flag.as_ref();

    let slug = uuid::Uuid::new_v4().simple().to_string()[..16].to_string();
    let staging_dir = std::env::temp_dir().join(format!("recordforge-share-{slug}"));
    let mut staged: Vec<PathBuf> = Vec::new();
    let cleanup = |staged: &[PathBuf], dir: &std::path::Path| {
        for file in staged {
            let _ = std::fs::remove_file(file);
        }
        let _ = std::fs::remove_dir(dir);
    };

    let noop = |_uploaded: u64, _total: u64| {};
    let total = source
        .path
        .metadata()
        .map(|m| m.len())
        .unwrap_or(artifact.bytes);

    // 1. The video itself.
    if cancel.is_cancelled() {
        cleanup(&staged, &staging_dir);
        return WorkerOutcome::Cancelled;
    }
    progress(PublicationStatus::Uploading, 0, total);
    if let Err(error) = client
        .upload_file_typed(
            &source.path,
            &format!("share/{slug}/video.mp4"),
            "video/mp4",
            noop,
            flag,
        )
        .await
    {
        cleanup(&staged, &staging_dir);
        return if cancel.is_cancelled() {
            WorkerOutcome::Cancelled
        } else {
            WorkerOutcome::Failed(error)
        };
    }

    // 2. Captions (optional) — .srt converts via the shared export VTT writer.
    if let Some(caption_path) = source.captions_path.as_ref() {
        if cancel.is_cancelled() {
            cleanup(&staged, &staging_dir);
            return WorkerOutcome::Cancelled;
        }
        let staged_vtt = staging_dir.join("captions.vtt");
        match stage_captions(caption_path, &staging_dir, &staged_vtt) {
            Ok(()) => {
                if let Err(error) = client
                    .upload_file_typed(
                        &staged_vtt,
                        &format!("share/{slug}/captions.vtt"),
                        "text/vtt",
                        noop,
                        flag,
                    )
                    .await
                {
                    cleanup(&staged, &staging_dir);
                    return if cancel.is_cancelled() {
                        WorkerOutcome::Cancelled
                    } else {
                        WorkerOutcome::Failed(error)
                    };
                }
                staged.push(staged_vtt);
            }
            Err(error) => {
                cleanup(&staged, &staging_dir);
                return WorkerOutcome::Failed(error);
            }
        }
    }

    // 3. The player page LAST — chapters/flags baked in; it is the link
    // target and must never precede its media.
    if cancel.is_cancelled() {
        cleanup(&staged, &staging_dir);
        return WorkerOutcome::Cancelled;
    }
    let player_html = render_share_player(
        &artifact.title,
        &artifact
            .chapters
            .iter()
            .map(|c| ShareChapterArg {
                t: c.t,
                label: c.label.clone(),
            })
            .collect::<Vec<_>>(),
        source.captions_path.is_some(),
        allow_download,
    );
    let player_path = staging_dir.join("index.html");
    if let Err(error) = (|| -> std::result::Result<(), std::io::Error> {
        std::fs::create_dir_all(&staging_dir)?;
        std::fs::write(&player_path, player_html)
    })() {
        cleanup(&staged, &staging_dir);
        return WorkerOutcome::Failed(
            InternalError::Storage(format!("write share player: {error}")).into(),
        );
    }
    if let Err(error) = client
        .upload_file_typed(
            &player_path,
            &format!("share/{slug}/index.html"),
            "text/html",
            noop,
            flag,
        )
        .await
    {
        cleanup(&staged, &staging_dir);
        return if cancel.is_cancelled() {
            WorkerOutcome::Cancelled
        } else {
            WorkerOutcome::Failed(error)
        };
    }
    staged.push(player_path);
    cleanup(&staged, &staging_dir);

    // The link points at the PLAYER under the profile's public base URL.
    let url = public_url(&public_base, &["share", &slug, "index.html"]);
    info!(slug = %slug, "BYO share uploaded");
    WorkerOutcome::Completed(
        PublicationResult::Share(PublicationShareResult {
            share_id: slug,
            url,
        }),
        Vec::new(),
    )
}

fn stage_captions(
    caption_path: &std::path::Path,
    staging_dir: &std::path::Path,
    staged_vtt: &std::path::Path,
) -> Result<()> {
    let raw = std::fs::read_to_string(caption_path)
        .map_err(|error| licensing_error("share_captions_failed", format!("{error}")))?;
    let vtt = if caption_path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("srt"))
    {
        crate::exports::srt_to_vtt(&raw)
    } else {
        raw
    };
    std::fs::create_dir_all(staging_dir)
        .map_err(|error| licensing_error("share_captions_failed", format!("{error}")))?;
    std::fs::write(staged_vtt, vtt)
        .map_err(|error| licensing_error("share_captions_failed", format!("{error}")))?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareChapterArg {
    pub t: u64,
    pub label: String,
}

/// Fill the player template's placeholders. The chapters JSON gets `<`
/// escaped so a `</script>` in a label can't break the inline script tag.
fn render_share_player(
    title: &str,
    chapters: &[ShareChapterArg],
    has_captions: bool,
    allow_download: bool,
) -> String {
    use base64::Engine;
    let chapters_json = serde_json::to_string(chapters).unwrap_or_else(|_| "[]".to_string());
    let chapters_b64 = base64::engine::general_purpose::STANDARD.encode(chapters_json);
    SHARE_PLAYER_HTML
        .replace("{{TITLE}}", &html_escape(title))
        .replace("%%CHAPTERS_B64%%", &chapters_b64)
        .replace("%%HAS_CAPTIONS%%", if has_captions { "1" } else { "0" })
        .replace("%%ALLOW_DOWNLOAD%%", if allow_download { "1" } else { "0" })
}

fn html_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/* ---------- Owner's share management ---------- */

/// Owner's share list for the "Shared links" management card. Returns the
/// empty list for Free users rather than an error — the card hides itself.
#[tauri::command]
#[instrument(skip(state))]
pub async fn list_shares(state: State<'_, AppState>) -> Result<Vec<ShareInfo>> {
    let Some(token) = state.license.license_token() else {
        return Ok(Vec::new());
    };
    LicenseClient::new().share_list(&token).await
}

/// Extend a live link's expiry by another 30 days.
#[tauri::command]
#[instrument(skip(state))]
pub async fn renew_share(share_id: String, state: State<'_, AppState>) -> Result<i64> {
    let token = state
        .license
        .license_token()
        .ok_or_else(|| licensing_error("license_required", "a Pro license is required"))?;
    LicenseClient::new().share_renew(&token, &share_id).await
}

/// Set, change, or clear a hosted link's viewer password. Validation mirrors
/// `normalized_password` — an empty string is rejected (use clear), 128 chars
/// is the server cap.
#[tauri::command]
#[instrument(skip(state, password))]
pub async fn update_share_password(
    share_id: String,
    password: Option<String>,
    clear_password: bool,
    state: State<'_, AppState>,
) -> Result<()> {
    let token = state
        .license
        .license_token()
        .ok_or_else(|| licensing_error("license_required", "a Pro license is required"))?;
    let trimmed = password.as_deref().map(str::trim).filter(|p| !p.is_empty());
    if !clear_password && trimmed.is_none() {
        return Err(licensing_error(
            "share_password_empty",
            "provide a password or clear the existing one",
        ));
    }
    if trimmed.is_some_and(|p| p.chars().count() > 128) {
        return Err(licensing_error(
            "share_password_too_long",
            "share passwords are limited to 128 characters",
        ));
    }
    LicenseClient::new()
        .share_update(&token, &share_id, trimmed, clear_password)
        .await
}

/// Owner analytics for one share — views, uniques, watch time, comments.
#[tauri::command]
#[instrument(skip(state))]
pub async fn share_analytics(
    share_id: String,
    state: State<'_, AppState>,
) -> Result<crate::licensing::client::ShareAnalytics> {
    let token = state
        .license
        .license_token()
        .ok_or_else(|| licensing_error("license_required", "a Pro license is required"))?;
    LicenseClient::new()
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
    LicenseClient::new().share_revoke(&token, &share_id).await
}

/* ---------- Publication job surface ---------- */

/// Current state of one publication job.
#[tauri::command]
#[instrument(skip(state))]
pub fn get_publication_job(job_id: String, state: State<'_, AppState>) -> Result<PublicationJob> {
    state
        .publication_registry
        .get(&job_id)
        .ok_or_else(|| InternalError::Storage("publication job not found".into()).into())
}

/// Recent publication jobs (terminal ones are capped at 100).
#[tauri::command]
#[instrument(skip(state))]
pub fn list_publication_jobs(state: State<'_, AppState>) -> Result<Vec<PublicationJob>> {
    Ok(state.publication_registry.list())
}

/// Request cancellation — the operation moves to `cancelling` until its
/// worker unwinds; a confirmed result is never fabricated into a cancel.
#[tauri::command]
#[instrument(skip(state))]
pub fn cancel_publication_job(
    job_id: String,
    state: State<'_, AppState>,
) -> Result<PublicationJob> {
    state.publication_registry.request_cancel(&job_id)
}

/// The frozen artifact manifest for one finished export — the delivery
/// card's read model (reuses the same validation as publishing).
#[tauri::command]
#[instrument(skip(state))]
pub fn get_export_artifact(
    export_job_id: String,
    state: State<'_, AppState>,
) -> Result<crate::exports::delivery_metadata::ExportArtifactInfo> {
    let conn = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    let artifact = crate::publish::source::export_artifact_for_job(
        &conn,
        &state.ffprobe_path,
        &export_job_id,
    )?;
    drop(conn);
    Ok(artifact)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_template_bakes_title_chapters_and_flags() {
        let html = render_share_player(
            "Demo <b>video</b>",
            &[ShareChapterArg {
                t: 1_000,
                label: "Intro</script>".to_string(),
            }],
            true,
            false,
        );
        // Title is HTML-escaped; chapters travel as base64 so a </script>
        // in a label can't break out of the inline script tag.
        assert!(html.contains("Demo &lt;b&gt;video&lt;/b&gt;"));
        assert!(!html.contains("Intro</script>"));
        assert!(html.contains("const HAS_CAPTIONS = \"1\" === \"1\""));
        assert!(html.contains("const ALLOW_DOWNLOAD = \"0\" === \"1\""));
        // The template placeholders must all be consumed.
        assert!(!html.contains("%%CHAPTERS_B64%%"));
        assert!(!html.contains("%%HAS_CAPTIONS%%"));
        assert!(!html.contains("%%ALLOW_DOWNLOAD%%"));
        assert!(!html.contains("{{TITLE}}"));
    }

    #[test]
    fn public_url_joins_and_encodes_segments() {
        assert_eq!(
            public_url(
                "https://cdn.example.com/base/",
                &["share", "abc", "index.html"]
            ),
            "https://cdn.example.com/base/share/abc/index.html"
        );
        // Reserved bytes are percent-encoded, never smuggled raw.
        assert_eq!(
            public_url("https://cdn.example.com", &["a b?c"]),
            "https://cdn.example.com/a%20b%3Fc"
        );
    }

    #[test]
    fn url_segment_encodes_anything_not_unreserved() {
        assert_eq!(url_segment("plain-OK_1.2"), "plain-OK_1.2");
        assert_eq!(url_segment("a/b\\c"), "a%2Fb%5Cc");
    }

    fn share_args(password: Option<&str>) -> ShareExportArgs {
        ShareExportArgs {
            export_job_id: "job".into(),
            operation_id: "op".into(),
            allow_download: true,
            allow_embed: true,
            password: password.map(str::to_string),
            expires_in_days: None,
        }
    }

    #[test]
    fn normalized_password_trims_bounds_and_empties() {
        assert_eq!(normalized_password(&share_args(None)).unwrap(), None);
        // Whitespace-only means "no password", never a stored empty hash.
        assert_eq!(normalized_password(&share_args(Some("   "))).unwrap(), None);
        assert_eq!(
            normalized_password(&share_args(Some("  s3cret  "))).unwrap(),
            Some("s3cret".to_string())
        );
        // 128 chars exactly is the server cap; 129 is rejected before a job
        // is ever admitted.
        let max = "x".repeat(128);
        assert_eq!(
            normalized_password(&share_args(Some(&max))).unwrap(),
            Some(max)
        );
        assert!(normalized_password(&share_args(Some(&"y".repeat(129)))).is_err());
    }
}
