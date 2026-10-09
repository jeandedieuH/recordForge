//! Instant Share — upload a finished MP4 export to the hosted viewer.
//!
//! Flow (docs/specs/instant-share.md): reserve a share + presigned multipart
//! plan from the license server → PUT each 8 MiB part straight to R2 → PUT
//! the optional captions sidecar → POST the multipart-complete XML → tell the
//! server the share is live. The share id doubles as the capability URL.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use tauri::{Emitter, State};
use tracing::{info, instrument, warn};

use crate::errors::{AppError, ErrorCategory, InternalError, Result};
use crate::licensing::client::{LicenseClient, ShareChapter, ShareInfo};
use crate::state::AppState;
use crate::storage::s3::S3Client;
use crate::storage::vault;

/// Multipart chunk size — MUST stay in sync with `SHARE_PART_SIZE` in
/// recordforge-cloud/convex/r2.ts; the server presigns exactly
/// `ceil(bytes/SHARE_PART_SIZE)` part URLs.
const SHARE_PART_SIZE: usize = 8 * 1024 * 1024;
const UPLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareChapterArg {
    pub t: u64,
    pub label: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareExportArgs {
    /// Absolute path of the finished MP4 export.
    pub path: String,
    pub title: String,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    #[serde(default)]
    pub chapters: Vec<ShareChapterArg>,
    #[serde(default = "default_true")]
    pub allow_download: bool,
    #[serde(default = "default_true")]
    pub allow_embed: bool,
    /// Optional captions sidecar (.vtt) uploaded next to the video.
    pub captions_path: Option<String>,
    /// Pro Cloud extras — server stores only a salted hash.
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub expires_in_days: Option<u32>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareResult {
    pub share_id: String,
    pub url: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ShareProgress {
    share_id: String,
    status: &'static str,
    bytes: u64,
    parts_done: u32,
    parts_total: u32,
}

fn licensing_error(code: &str, message: impl Into<String>) -> AppError {
    AppError::new(ErrorCategory::Licensing, code, message.into())
}

/// Upload `path` as a hosted share link. Pro-gated: Free callers get
/// `pro_feature_required` with `instant-share` so the UI can route to the
/// upgrade dialog. The local export is never touched.
#[tauri::command]
#[instrument(skip(state, app, args))]
pub async fn share_export(
    args: ShareExportArgs,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ShareResult> {
    // Entitlement + token — the server's own auth is the signed token, so a
    // tampered Free client stops here AND there.
    if !state.license.entitlements().pro_enabled {
        let mut details = serde_json::Map::new();
        details.insert("features".to_string(), serde_json::json!(["instant-share"]));
        return Err(licensing_error(
            "pro_feature_required",
            "Instant Share is a RecordForge Pro feature",
        )
        .with_details(details));
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
    let is_mp4 = path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"));
    if !is_mp4 {
        return Err(licensing_error(
            "share_format_unsupported",
            "Instant Share supports MP4 exports only",
        ));
    }
    let metadata = std::fs::metadata(&path).map_err(|error| {
        licensing_error(
            "share_file_missing",
            format!("export file is not readable: {error}"),
        )
    })?;
    let bytes = metadata.len();
    let captions = args
        .captions_path
        .as_deref()
        .map(|raw| {
            crate::path_policy::canonicalize_path(std::path::Path::new(raw)).map_err(|error| {
                licensing_error(
                    "share_captions_invalid",
                    format!("captions path is invalid: {error}"),
                )
            })
        })
        .transpose()?;

    // Reserve the share + presigned plan.
    let client = LicenseClient::new();
    let created = client
        .share_create(
            &token,
            &crate::licensing::client::ShareMeta {
                title: args.title.clone(),
                duration_ms: args.duration_ms,
                bytes,
                width: args.width,
                height: args.height,
                fps: args.fps,
                chapters: args
                    .chapters
                    .iter()
                    .map(|chapter| ShareChapter {
                        t: chapter.t,
                        label: chapter.label.clone(),
                    })
                    .collect(),
                allow_download: args.allow_download,
                allow_embed: args.allow_embed,
                has_captions: captions.is_some(),
                password: args.password.clone().filter(|p| !p.trim().is_empty()),
                expires_in_days: args.expires_in_days,
            },
        )
        .await?;

    let parts_total = created.upload.part_urls.len() as u32;
    info!(share_id = %created.share_id, parts_total, bytes, "share upload started");

    // Multipart upload: each part is a presigned PUT; the response `ETag`
    // goes into the complete XML.
    let upload_client = reqwest::Client::builder()
        .timeout(UPLOAD_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let file = std::fs::File::open(&path)
        .map_err(|error| licensing_error("share_file_missing", format!("{error}")))?;
    let mut reader = std::io::BufReader::new(file);
    let mut etags: Vec<String> = Vec::with_capacity(parts_total as usize);

    for (index, part_url) in created.upload.part_urls.iter().enumerate() {
        let is_last = index == created.upload.part_urls.len() - 1;
        let want = if is_last {
            (bytes as usize) - index * SHARE_PART_SIZE
        } else {
            SHARE_PART_SIZE
        };
        let mut chunk = vec![0u8; want];
        use std::io::Read;
        reader.read_exact(&mut chunk).map_err(|error| {
            licensing_error(
                "share_read_failed",
                format!("could not read export data: {error}"),
            )
        })?;
        let response = upload_client
            .put(part_url)
            .header("Content-Type", "video/mp4")
            .body(chunk)
            .send()
            .await
            .map_err(|error| {
                licensing_error(
                    "share_upload_failed",
                    format!("part {} upload failed: {error}", index + 1),
                )
            })?;
        if !response.status().is_success() {
            return Err(licensing_error(
                "share_upload_failed",
                format!("part {} upload rejected ({})", index + 1, response.status()),
            ));
        }
        etags.push(
            response
                .headers()
                .get("etag")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string(),
        );
        let parts_done = index as u32 + 1;
        let _ = app.emit(
            "share-progress",
            ShareProgress {
                share_id: created.share_id.clone(),
                status: "uploading",
                bytes,
                parts_done,
                parts_total,
            },
        );
        // Best-effort server progress so viewers see the bar move.
        if let Err(error) = client
            .share_progress(&token, &created.share_id, parts_done)
            .await
        {
            warn!(error = %error, "share progress report failed");
        }
    }

    // Captions sidecar — a single presigned PUT. Exports emit .srt sidecars
    // while the web <track> needs WebVTT, so .srt input is converted in
    // memory (comma millisecond separators become dots).
    if let (Some(caption_path), Some(put_url)) =
        (captions, created.upload.captions_put_url.as_ref())
    {
        let raw = std::fs::read_to_string(&caption_path)
            .map_err(|error| licensing_error("share_captions_failed", format!("{error}")))?;
        let body = if caption_path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("srt"))
        {
            srt_to_vtt(&raw)
        } else {
            raw
        };
        let response = upload_client
            .put(put_url)
            .header("Content-Type", "text/vtt")
            .body(body)
            .send()
            .await
            .map_err(|error| licensing_error("share_captions_failed", format!("{error}")))?;
        if !response.status().is_success() {
            warn!(status = %response.status(), "captions upload rejected; continuing without them");
        }
    }

    // Complete the multipart upload directly against R2 (presigned URL).
    let xml = etags.iter().enumerate().fold(
        String::from("<CompleteMultipartUpload>"),
        |mut acc, (index, etag)| {
            acc.push_str(&format!(
                "<Part><PartNumber>{}</PartNumber><ETag>{}</ETag></Part>",
                index + 1,
                etag
            ));
            acc
        },
    ) + "</CompleteMultipartUpload>";
    let response = upload_client
        .post(&created.upload.complete_url)
        .header("Content-Type", "application/xml")
        .body(xml)
        .send()
        .await
        .map_err(|error| licensing_error("share_finalize_failed", format!("{error}")))?;
    if !response.status().is_success() {
        return Err(licensing_error(
            "share_finalize_failed",
            format!("R2 rejected the upload ({})", response.status()),
        ));
    }

    client
        .share_complete(&token, &created.share_id, bytes)
        .await?;
    info!(share_id = %created.share_id, "share upload complete");
    Ok(ShareResult {
        share_id: created.share_id,
        url: created.url,
    })
}

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

/* ---------- BYO-bucket share (Instant Share, own storage) ---------- */

/// Self-contained player page uploaded next to the video — placeholders are
/// filled by `render_share_player`.
const SHARE_PLAYER_HTML: &str = include_str!("assets/share-player.html");

/// Upload `path` plus a generated player page into the user's own
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
    if !state.license.entitlements().pro_enabled {
        let mut details = serde_json::Map::new();
        details.insert("features".to_string(), serde_json::json!(["instant-share"]));
        return Err(licensing_error(
            "pro_feature_required",
            "Instant Share is a RecordForge Pro feature",
        )
        .with_details(details));
    }

    // Same path policy as the normal upload flow — the export must live in an
    // allowed location before it leaves the machine.
    let path = state
        .storage_manager
        .validate_upload_source(std::path::Path::new(&args.path))?;
    let is_mp4 = path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"));
    if !is_mp4 {
        return Err(licensing_error(
            "share_format_unsupported",
            "Instant Share supports MP4 exports only",
        ));
    }

    // BYO is S3-only for v1 — Drive links make a poor player and a local folder
    // is already where the export lives.
    let profile = state.storage_manager.load_profile(&profile_id)?;
    if profile.kind != "s3" {
        return Err(licensing_error(
            "share_provider_unsupported",
            "Instant Share to your own storage currently supports S3-compatible buckets only",
        ));
    }
    let s3_config = profile
        .s3_config
        .ok_or_else(|| InternalError::Storage("S3 configuration missing for profile".into()))?;
    let access_key = vault::get_secret(&format!("{}:access_key", profile.id))?
        .ok_or_else(|| InternalError::Storage("S3 Access Key ID missing from vault".into()))?;
    let secret_key = vault::get_secret(&format!("{}:secret_key", profile.id))?
        .ok_or_else(|| InternalError::Storage("S3 Secret Access Key missing from vault".into()))?;
    let client = S3Client::new(s3_config, access_key, secret_key);

    let slug = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
    let cancel = AtomicBool::new(false);
    let noop = |_uploaded: u64, _total: u64| {};
    let emit = |status: &'static str, done: u32, total: u32| {
        let _ = app.emit(
            "share-progress",
            ShareProgress {
                share_id: slug.clone(),
                status,
                bytes: 0,
                parts_done: done,
                parts_total: total,
            },
        );
    };

    // 1. The video itself.
    emit("uploading", 0, 3);
    client
        .upload_file_typed(
            &path,
            &format!("share/{slug}/video.mp4"),
            "video/mp4",
            noop,
            &cancel,
        )
        .await
        .map_err(|error| licensing_error("share_upload_failed", error.to_string()))?;

    // 2. Captions (optional) — .srt exports convert to VTT for the web.
    let captions = args
        .captions_path
        .as_deref()
        .map(|raw| {
            crate::path_policy::canonicalize_path(std::path::Path::new(raw))
                .map_err(|error| licensing_error("share_captions_invalid", format!("{error}")))
        })
        .transpose()?;
    let staging_dir = std::env::temp_dir().join(format!("recordforge-share-{slug}"));
    let mut staged: Vec<PathBuf> = Vec::new();
    let cleanup = |staged: &[PathBuf], dir: &std::path::Path| {
        for file in staged {
            let _ = std::fs::remove_file(file);
        }
        let _ = std::fs::remove_dir(dir);
    };

    if let Some(caption_path) = captions.as_ref() {
        let raw = std::fs::read_to_string(caption_path)
            .map_err(|error| licensing_error("share_captions_failed", format!("{error}")))?;
        let vtt = if caption_path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("srt"))
        {
            srt_to_vtt(&raw)
        } else {
            raw
        };
        std::fs::create_dir_all(&staging_dir)
            .map_err(|error| licensing_error("share_captions_failed", format!("{error}")))?;
        let vtt_path = staging_dir.join("captions.vtt");
        std::fs::write(&vtt_path, vtt)
            .map_err(|error| licensing_error("share_captions_failed", format!("{error}")))?;
        client
            .upload_file_typed(
                &vtt_path,
                &format!("share/{slug}/captions.vtt"),
                "text/vtt",
                noop,
                &cancel,
            )
            .await
            .map_err(|error| licensing_error("share_captions_failed", error.to_string()))?;
        staged.push(vtt_path);
    }
    emit("uploading", 2, 3);

    // 3. The generated player page — chapters/flags are baked in so it works
    // as a single static file on any public bucket.
    let player_html = render_share_player(
        &args.title,
        &args.chapters,
        captions.is_some(),
        args.allow_download,
    );
    std::fs::create_dir_all(&staging_dir)
        .map_err(|error| licensing_error("share_upload_failed", format!("{error}")))?;
    let player_path = staging_dir.join("index.html");
    std::fs::write(&player_path, player_html)
        .map_err(|error| licensing_error("share_upload_failed", format!("{error}")))?;
    let player_url = client
        .upload_file_typed(
            &player_path,
            &format!("share/{slug}/index.html"),
            "text/html",
            noop,
            &cancel,
        )
        .await
        .map_err(|error| licensing_error("share_upload_failed", error.to_string()))?;
    staged.push(player_path);
    cleanup(&staged, &staging_dir);

    emit("live", 3, 3);
    info!(slug = %slug, "BYO share uploaded");
    Ok(ShareResult {
        share_id: slug,
        url: player_url,
    })
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

/// Convert an SRT document to WebVTT: swap the `,` millisecond separator for
/// `.` on timestamp lines and prepend the required header.
fn srt_to_vtt(srt: &str) -> String {
    let mut out = String::with_capacity(srt.len() + 16);
    out.push_str("WEBVTT\n\n");
    for line in srt.lines() {
        if line.contains(" --> ") {
            out.push_str(&line.replace(',', "."));
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_converts_timestamp_separators_and_keeps_cues() {
        let srt = "1\n00:00:01,000 --> 00:00:02,500\nHello, world\n\n2\n00:00:05,100 --> 00:00:06,000\nSecond cue, with comma\n";
        let vtt = srt_to_vtt(srt);
        assert!(vtt.starts_with("WEBVTT\n\n"));
        assert!(vtt.contains("00:00:01.000 --> 00:00:02.500"));
        assert!(vtt.contains("Hello, world"));
        // Commas in cue text stay untouched.
        assert!(vtt.contains("Second cue, with comma"));
    }

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
}
