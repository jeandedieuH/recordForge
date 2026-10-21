//! Instant Share upload engine.
//!
//! Two destinations share one upload pipeline:
//! - **Hosted** (`upload_hosted`): reserve a share + presigned multipart plan
//!   from the license server → PUT 8 MiB parts straight to R2 → optional
//!   captions sidecar → POST the multipart-complete XML → mark the share live.
//! - **BYO bucket** (`upload_to_profile`): multipart-upload the MP4 plus a
//!   generated static player page into the user's S3-compatible bucket.
//!
//! Both are single-flight (`ShareGuard`) so a job-driven delivery and a manual
//! share can't interleave parts, and both watch a caller-supplied cancel flag
//! that `cancel_share_upload` flips whichever upload is currently registered.

use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::{info, warn};

use crate::errors::{AppError, ErrorCategory, InternalError, Result};
use crate::licensing::client::{LicenseClient, ShareChapter, ShareMeta};
use crate::storage::s3::S3Client;
use crate::storage::vault;
use crate::storage::StorageManager;

/// Multipart chunk size — MUST stay in sync with `SHARE_PART_SIZE` in
/// recordforge-cloud/convex/r2.ts; the server presigns exactly
/// `ceil(bytes/SHARE_PART_SIZE)` part URLs.
const SHARE_PART_SIZE: usize = 8 * 1024 * 1024;
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(300);
/// Transient part-level failures (5xx, timeouts, resets) retry with
/// exponential backoff before the whole upload is abandoned.
const PART_RETRIES: u32 = 3;

static SHARE_ACTIVE: AtomicBool = AtomicBool::new(false);
static SHARE_CANCEL: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

/// RAII slot for the single in-flight share upload.
pub struct ShareGuard;

/// One share upload at a time; `cancel` is the caller's abort flag and gets
/// registered so `cancel_share_upload` reaches whichever share is running —
/// command-driven or export-job-driven.
pub fn try_begin_share(cancel: Arc<AtomicBool>) -> Result<ShareGuard> {
    if SHARE_ACTIVE.swap(true, Ordering::SeqCst) {
        return Err(storage_error(
            "share_in_progress",
            "a share upload is already in progress",
        ));
    }
    if let Ok(mut slot) = SHARE_CANCEL.lock() {
        *slot = Some(cancel);
    }
    Ok(ShareGuard)
}

impl Drop for ShareGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = SHARE_CANCEL.lock() {
            *slot = None;
        }
        SHARE_ACTIVE.store(false, Ordering::SeqCst);
    }
}

/// Abort whichever share upload is currently running (no-op when idle).
pub fn cancel_share_upload() {
    if let Ok(slot) = SHARE_CANCEL.lock() {
        if let Some(flag) = slot.as_ref() {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

fn storage_error(code: &str, message: impl Into<String>) -> AppError {
    AppError::new(ErrorCategory::Storage, code, message.into())
}

fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        return Err(storage_error("share_cancelled", "share upload cancelled"));
    }
    Ok(())
}

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
pub struct ShareProgress {
    pub share_id: String,
    pub status: &'static str,
    /// Total bytes of the video payload.
    pub bytes: u64,
    /// Bytes confirmed uploaded so far — drives byte-level progress events.
    pub uploaded_bytes: u64,
    pub parts_done: u32,
    pub parts_total: u32,
}

/// Everything one share upload needs beyond the MP4 itself. Captions are an
/// already-resolved path; `password` is already vault-resolved — never read
/// from the persisted job request (secrets don't land in SQLite).
pub struct ShareUploadInput {
    pub path: PathBuf,
    pub title: String,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub chapters: Vec<ShareChapterArg>,
    pub allow_download: bool,
    pub allow_embed: bool,
    pub captions_path: Option<PathBuf>,
    pub password: Option<String>,
    pub expires_in_days: Option<u32>,
}

/// The optional captions sidecar degrades to "no captions" when the expected
/// file was never written (e.g. sidecar mode on a timeline with no cues) —
/// failing the whole finished upload over a missing extra is the wrong trade.
pub fn resolve_share_captions(raw: Option<&str>) -> Option<PathBuf> {
    raw.and_then(|path| {
        crate::path_policy::canonicalize_path(Path::new(path))
            .map_err(|error| {
                warn!(path = %path, error = %error, "share captions sidecar is unavailable; continuing without it");
            })
            .ok()
    })
}

/// Validate the source file the same way every entry point does: MP4 only,
/// must exist, must be readable.
fn checked_mp4(path: &Path) -> Result<u64> {
    let is_mp4 = path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"));
    if !is_mp4 {
        return Err(storage_error(
            "share_format_unsupported",
            "Instant Share supports MP4 exports only",
        ));
    }
    std::fs::metadata(path)
        .map(|meta| meta.len())
        .map_err(|error| {
            storage_error(
                "share_file_missing",
                format!("export file is not readable: {error}"),
            )
        })
}

// ---------------------------------------------------------------------------
// Hosted share (recordforge-cloud)
// ---------------------------------------------------------------------------

/// Upload `input.path` as a hosted share link. `token` is the signed license
/// token — the server's own auth — so callers must have passed the Pro gate.
pub async fn upload_hosted(
    token: &str,
    input: &ShareUploadInput,
    cancel: Arc<AtomicBool>,
    progress: impl Fn(ShareProgress) + Send,
) -> Result<ShareResult> {
    let _guard = try_begin_share(cancel.clone())?;
    let bytes = checked_mp4(&input.path)?;

    // Reserve the share + presigned plan.
    let client = LicenseClient::new();
    let created = client
        .share_create(
            token,
            &ShareMeta {
                title: input.title.clone(),
                duration_ms: input.duration_ms,
                bytes,
                width: input.width,
                height: input.height,
                fps: input.fps,
                chapters: input
                    .chapters
                    .iter()
                    .map(|chapter| ShareChapter {
                        t: chapter.t,
                        label: chapter.label.clone(),
                    })
                    .collect(),
                allow_download: input.allow_download,
                allow_embed: input.allow_embed,
                has_captions: input.captions_path.is_some(),
                password: input.password.clone().filter(|p| !p.trim().is_empty()),
                expires_in_days: input.expires_in_days,
            },
        )
        .await?;

    let parts_total = created.upload.part_urls.len() as u32;
    info!(share_id = %created.share_id, parts_total, bytes, "share upload started");

    let upload_client = reqwest::Client::builder()
        .timeout(UPLOAD_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    // Multipart upload: each part is a presigned PUT; the response `ETag`
    // goes into the complete XML. A missing ETag means the part didn't land —
    // treat it as a retryable failure rather than corrupting the assembly.
    let mut etags: Vec<String> = Vec::with_capacity(parts_total as usize);
    for (index, part_url) in created.upload.part_urls.iter().enumerate() {
        cancelled(&cancel)?;
        let is_last = index == created.upload.part_urls.len() - 1;
        let want = if is_last {
            (bytes as usize) - index * SHARE_PART_SIZE
        } else {
            SHARE_PART_SIZE
        };
        let etag = upload_part(&upload_client, &input.path, part_url, index, want).await?;
        etags.push(etag);

        let parts_done = index as u32 + 1;
        progress(ShareProgress {
            share_id: created.share_id.clone(),
            status: "uploading",
            bytes,
            uploaded_bytes: (parts_done as u64 * SHARE_PART_SIZE as u64).min(bytes),
            parts_done,
            parts_total,
        });
        // Best-effort server progress so viewers see the bar move.
        if let Err(error) = client
            .share_progress(token, &created.share_id, parts_done)
            .await
        {
            warn!(error = %error, "share progress report failed");
        }
    }

    // Captions sidecar — a single presigned PUT. Exports emit .srt sidecars
    // while the web <track> needs WebVTT, so .srt input is converted in
    // memory (comma millisecond separators become dots).
    if let (Some(caption_path), Some(put_url)) = (
        input.captions_path.as_ref(),
        created.upload.captions_put_url.as_ref(),
    ) {
        let raw = std::fs::read_to_string(caption_path)
            .map_err(|error| storage_error("share_captions_failed", format!("{error}")))?;
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
            .map_err(|error| storage_error("share_captions_failed", format!("{error}")))?;
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
                xml_escape(etag)
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
        .map_err(|error| storage_error("share_finalize_failed", format!("{error}")))?;
    if !response.status().is_success() {
        return Err(storage_error(
            "share_finalize_failed",
            format!("R2 rejected the upload ({})", response.status()),
        ));
    }

    client
        .share_complete(token, &created.share_id, bytes)
        .await?;
    info!(share_id = %created.share_id, "share upload complete");
    Ok(ShareResult {
        share_id: created.share_id,
        url: created.url,
    })
}

/// One presigned-part PUT with bounded retries. Each attempt re-reads the
/// byte range so a half-consumed buffer can't corrupt the retry.
async fn upload_part(
    http: &reqwest::Client,
    path: &Path,
    part_url: &str,
    index: usize,
    len: usize,
) -> Result<String> {
    let offset = (index * SHARE_PART_SIZE) as u64;
    let mut last_error: Option<AppError> = None;
    for attempt in 0..PART_RETRIES {
        match upload_part_once(http, path, part_url, offset, len).await {
            Ok(etag) => return Ok(etag),
            Err(error) => {
                last_error = Some(error);
                if attempt + 1 < PART_RETRIES {
                    tokio::time::sleep(Duration::from_millis(400 << attempt)).await;
                }
            }
        }
    }
    Err(last_error.unwrap_or_else(|| {
        storage_error(
            "share_upload_failed",
            format!("part {} upload failed", index + 1),
        )
    }))
}

async fn upload_part_once(
    http: &reqwest::Client,
    path: &Path,
    part_url: &str,
    offset: u64,
    len: usize,
) -> Result<String> {
    let mut file = std::fs::File::open(path).map_err(|error| {
        storage_error(
            "share_read_failed",
            format!("could not open export data: {error}"),
        )
    })?;
    file.seek(SeekFrom::Start(offset)).map_err(|error| {
        storage_error(
            "share_read_failed",
            format!("could not read export data: {error}"),
        )
    })?;
    let mut chunk = vec![0u8; len];
    file.read_exact(&mut chunk).map_err(|error| {
        storage_error(
            "share_read_failed",
            format!("could not read export data: {error}"),
        )
    })?;

    let response = http
        .put(part_url)
        .header("Content-Type", "video/mp4")
        .body(chunk)
        .send()
        .await
        .map_err(|error| storage_error("share_upload_failed", format!("{error}")))?;
    if !response.status().is_success() {
        return Err(storage_error(
            "share_upload_failed",
            format!("part rejected ({})", response.status()),
        ));
    }
    response
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim_matches('"').to_string())
        .ok_or_else(|| storage_error("share_upload_failed", "part upload returned no ETag"))
}

// ---------------------------------------------------------------------------
// BYO-bucket share (Instant Share, own storage)
// ---------------------------------------------------------------------------

/// Self-contained player page uploaded next to the video — placeholders are
/// filled by `render_share_player`.
const SHARE_PLAYER_HTML: &str = include_str!("../commands/assets/share-player.html");

/// Upload `input.path` plus a generated player page into the user's own
/// S3-compatible bucket at `share/<slug>/`. The returned link points at the
/// player's public URL — no RecordForge server involved beyond the Pro gate.
pub async fn upload_to_profile(
    storage: &StorageManager,
    profile_id: &str,
    input: &ShareUploadInput,
    cancel: Arc<AtomicBool>,
    progress: impl Fn(ShareProgress) + Send,
) -> Result<ShareResult> {
    let _guard = try_begin_share(cancel.clone())?;
    checked_mp4(&input.path)?;

    // BYO is S3-only for v1 — Drive links make a poor player and a local folder
    // is already where the export lives.
    let profile = storage.load_profile(profile_id)?;
    if profile.kind != "s3" {
        return Err(storage_error(
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
    let file_bytes = std::fs::metadata(&input.path).map(|m| m.len()).unwrap_or(0);

    // 1. The video itself — the S3 adapter reports byte progress, which we
    // forward as the upload progress (parts fields are 0 for BYO).
    {
        let progress_slug = slug.clone();
        let progress_ref = &progress;
        let video_progress = move |uploaded: u64, total: u64| {
            progress_ref(ShareProgress {
                share_id: progress_slug.clone(),
                status: "uploading",
                bytes: total.max(file_bytes),
                uploaded_bytes: uploaded,
                parts_done: (uploaded / SHARE_PART_SIZE as u64) as u32,
                parts_total: (total.div_ceil(SHARE_PART_SIZE as u64)) as u32,
            });
        };
        client
            .upload_file_typed(
                &input.path,
                &format!("share/{slug}/video.mp4"),
                "video/mp4",
                video_progress,
                &cancel,
            )
            .await
            .map_err(|error| storage_error("share_upload_failed", error.to_string()))?;
    }
    cancelled(&cancel)?;

    // 2. Captions (optional) — .srt exports convert to VTT for the web.
    let staging_dir = std::env::temp_dir().join(format!("recordforge-share-{slug}"));
    let mut staged: Vec<PathBuf> = Vec::new();
    let player_url =
        upload_share_auxiliary(&client, &slug, input, &staging_dir, &mut staged, &cancel).await;
    // Staging cleanup always runs — a failed captions/player upload must not
    // leak temp files.
    for file in &staged {
        let _ = std::fs::remove_file(file);
    }
    let _ = std::fs::remove_dir(&staging_dir);
    let player_url = player_url?;

    progress(ShareProgress {
        share_id: slug.clone(),
        status: "live",
        bytes: file_bytes,
        uploaded_bytes: file_bytes,
        parts_done: 1,
        parts_total: 1,
    });
    info!(slug = %slug, "BYO share uploaded");
    Ok(ShareResult {
        share_id: slug,
        url: player_url,
    })
}

/// Captions + generated player uploads for the BYO path, factored out so the
/// caller can guarantee staging cleanup on every exit.
async fn upload_share_auxiliary(
    client: &S3Client,
    slug: &str,
    input: &ShareUploadInput,
    staging_dir: &Path,
    staged: &mut Vec<PathBuf>,
    cancel: &AtomicBool,
) -> Result<String> {
    let noop = |_uploaded: u64, _total: u64| {};
    if let Some(caption_path) = input.captions_path.as_ref() {
        let raw = std::fs::read_to_string(caption_path)
            .map_err(|error| storage_error("share_captions_failed", format!("{error}")))?;
        let vtt = if caption_path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("srt"))
        {
            srt_to_vtt(&raw)
        } else {
            raw
        };
        std::fs::create_dir_all(staging_dir)
            .map_err(|error| storage_error("share_captions_failed", format!("{error}")))?;
        let vtt_path = staging_dir.join("captions.vtt");
        std::fs::write(&vtt_path, vtt)
            .map_err(|error| storage_error("share_captions_failed", format!("{error}")))?;
        staged.push(vtt_path.clone());
        client
            .upload_file_typed(
                &vtt_path,
                &format!("share/{slug}/captions.vtt"),
                "text/vtt",
                noop,
                cancel,
            )
            .await
            .map_err(|error| storage_error("share_captions_failed", error.to_string()))?;
    }
    cancelled(cancel)?;

    // The generated player page — chapters/flags are baked in so it works
    // as a single static file on any public bucket.
    let player_html = render_share_player(
        &input.title,
        &input.chapters,
        input.captions_path.is_some(),
        input.allow_download,
    );
    std::fs::create_dir_all(staging_dir)
        .map_err(|error| storage_error("share_upload_failed", format!("{error}")))?;
    let player_path = staging_dir.join("index.html");
    std::fs::write(&player_path, player_html)
        .map_err(|error| storage_error("share_upload_failed", format!("{error}")))?;
    staged.push(player_path.clone());
    let player_url = client
        .upload_file_typed(
            &player_path,
            &format!("share/{slug}/index.html"),
            "text/html",
            noop,
            cancel,
        )
        .await
        .map_err(|error| storage_error("share_upload_failed", error.to_string()))?;
    Ok(player_url)
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

/// R2/S3 ETags are quoted strings that sit inside the complete XML — strip
/// any markup-significant characters defensively.
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
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

    #[test]
    fn missing_captions_sidecar_degrades_to_none_instead_of_failing() {
        // Sidecar mode on a timeline with no cues produces no .srt — the share
        // must still upload without captions rather than erroring out.
        assert!(resolve_share_captions(Some("definitely/missing/export.srt")).is_none());
        assert!(resolve_share_captions(None).is_none());

        let temp = tempfile::tempdir().unwrap();
        let srt = temp.path().join("captions.srt");
        std::fs::write(&srt, b"1\n00:00:01,000 --> 00:00:02,000\nhi\n").unwrap();
        assert_eq!(
            resolve_share_captions(Some(&srt.to_string_lossy())),
            Some(crate::path_policy::canonicalize_path(&srt).unwrap())
        );
    }

    #[test]
    fn xml_escape_strips_markup_chars_from_etags() {
        assert_eq!(xml_escape("\"abc123\""), "&quot;abc123&quot;");
        assert_eq!(xml_escape("<x>&"), "&lt;x&gt;&amp;");
    }

    #[test]
    fn share_guard_is_single_flight() {
        let flag = Arc::new(AtomicBool::new(false));
        let guard = try_begin_share(flag.clone()).unwrap();
        assert!(try_begin_share(Arc::new(AtomicBool::new(false))).is_err());
        cancel_share_upload();
        assert!(flag.load(Ordering::Relaxed));
        drop(guard);
        assert!(try_begin_share(Arc::new(AtomicBool::new(false))).is_ok());
    }
}
