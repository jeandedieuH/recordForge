//! YouTube Data API v3 publishing.
//!
//! Reuses the Google OAuth client credentials and loopback+PKCE flow from
//! `storage::drive` — same Google Cloud app, different scope set, so the
//! YouTube grant stores its own refresh token in the OS credential vault.
//!
//! Uploads use YouTube's resumable protocol (`videos.insert` +
//! `uploadType=resumable`): a session URI accepts byte-range PUTs, and a
//! status query (`Content-Range: bytes */total`) reports the confirmed offset
//! so interrupted uploads resume mid-file. The session URI is persisted to
//! the app-data dir so a retry after an app restart resumes the same upload
//! (YouTube sessions live ~7 days; we expire after 6).

use reqwest::Client;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tracing::info;

use crate::errors::{InternalError, Result};
use crate::storage::drive::{get_google_drive_client_id, get_google_drive_client_secret};
use crate::storage::vault;

// youtube.force-ssl is required by captions.insert for the SRT attach.
pub const YOUTUBE_OAUTH_SCOPE: &str =
    "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl";

const YOUTUBE_VAULT_ACCOUNT: &str = "youtube:refresh_token";
const CHUNK_SIZE: usize = 8 * 1024 * 1024; // 8 MiB — must be a multiple of 256 KiB
const SESSION_TTL_MS: u64 = 6 * 24 * 60 * 60 * 1000;
const CHUNK_RETRIES: u32 = 3;

static PUBLISH_ACTIVE: AtomicBool = AtomicBool::new(false);
static PUBLISH_CANCEL: AtomicBool = AtomicBool::new(false);

pub fn cancel_publish() {
    PUBLISH_CANCEL.store(true, Ordering::SeqCst);
}

/// One publish at a time; returns false when a publish is already running.
pub fn try_begin_publish() -> Result<PublishGuard> {
    if PUBLISH_ACTIVE.swap(true, Ordering::SeqCst) {
        return Err(
            InternalError::Storage("a YouTube publish is already in progress".into()).into(),
        );
    }
    PUBLISH_CANCEL.store(false, Ordering::SeqCst);
    Ok(PublishGuard)
}

pub struct PublishGuard;
impl Drop for PublishGuard {
    fn drop(&mut self) {
        PUBLISH_ACTIVE.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubePublishRequest {
    pub path: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_privacy")]
    pub privacy: String,
    #[serde(default = "default_category")]
    pub category_id: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub captions_path: Option<String>,
    #[serde(default = "default_caption_language")]
    pub captions_language: String,
}

fn default_privacy() -> String {
    "unlisted".to_string()
}
fn default_category() -> String {
    "28".to_string()
}
fn default_caption_language() -> String {
    "en".to_string()
}

pub fn has_connection() -> Result<bool> {
    Ok(vault::get_secret(YOUTUBE_VAULT_ACCOUNT)?.is_some())
}

pub fn store_refresh_token(refresh_token: &str) -> Result<()> {
    vault::set_secret(YOUTUBE_VAULT_ACCOUNT, refresh_token)
}

pub fn disconnect() -> Result<()> {
    vault::delete_secret(YOUTUBE_VAULT_ACCOUNT)
}

fn refresh_token() -> Result<String> {
    vault::get_secret(YOUTUBE_VAULT_ACCOUNT)?.ok_or_else(|| {
        InternalError::Storage("YouTube is not connected — authorize first".into()).into()
    })
}

async fn get_access_token(http: &Client) -> Result<String> {
    let client_id = get_google_drive_client_id();
    let client_secret = get_google_drive_client_secret();
    let refresh = refresh_token()?;
    let mut params = vec![
        ("client_id", client_id.as_str()),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh.as_str()),
    ];
    // Present-but-empty client_secret is rejected by the token endpoint.
    let secret_holder;
    if !client_secret.is_empty() {
        secret_holder = client_secret;
        params.push(("client_secret", secret_holder.as_str()));
    }

    let resp = http
        .post("https://oauth2.googleapis.com/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| InternalError::Storage(format!("token refresh request failed: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(InternalError::Storage(format!(
            "failed to refresh YouTube token ({status}): {text}"
        ))
        .into());
    }
    let token: crate::storage::drive::TokenResponse = resp
        .json()
        .await
        .map_err(|e| InternalError::Storage(format!("failed to parse token response: {e}")))?;
    Ok(token.access_token)
}

/// Channel label for the connected account (`channels.list?mine`).
pub async fn connection_label() -> Result<Option<String>> {
    if !has_connection()? {
        return Ok(None);
    }
    let http = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| Client::new());
    let token = get_access_token(&http).await?;
    let resp = http
        .get("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| InternalError::Storage(format!("channel lookup failed: {e}")))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    Ok(body
        .pointer("/items/0/snippet/title")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string()))
}

// ---------------------------------------------------------------------------
// Resumable session persistence
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadSession {
    session_uri: String,
    path: String,
    file_size: u64,
    file_mtime_ms: u64,
    started_at_ms: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn file_mtime_ms(path: &Path) -> u64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load_session(session_path: &Path, path: &Path, file_len: u64) -> Option<UploadSession> {
    let raw = std::fs::read_to_string(session_path).ok()?;
    let session: UploadSession = serde_json::from_str(&raw).ok()?;
    // Only resume the exact same file — path, size, and mtime must match, and
    // YouTube expires sessions after ~7 days (we cap at 6 to be safe).
    if session.path != path.to_string_lossy()
        || session.file_size != file_len
        || session.file_mtime_ms != file_mtime_ms(path)
        || now_ms().saturating_sub(session.started_at_ms) > SESSION_TTL_MS
    {
        return None;
    }
    Some(session)
}

fn save_session(session_path: &Path, session: &UploadSession) {
    if let Ok(json) = serde_json::to_string(session) {
        let tmp = session_path.with_extension("tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, session_path);
        }
    }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

async fn create_session(
    http: &Client,
    token: &str,
    request: &YouTubePublishRequest,
    file_len: u64,
) -> Result<String> {
    let metadata = serde_json::json!({
        "snippet": {
            "title": request.title,
            "description": request.description,
            "tags": request.tags,
            "categoryId": request.category_id,
        },
        "status": {
            "privacyStatus": request.privacy,
            "selfDeclaredMadeForKids": false,
        },
    });
    let resp = http
        .post("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status")
        .bearer_auth(token)
        .header("X-Upload-Content-Type", "video/*")
        .header("X-Upload-Content-Length", file_len.to_string())
        .json(&metadata)
        .send()
        .await
        .map_err(|e| {
            InternalError::Storage(format!("failed to open YouTube upload session: {e}"))
        })?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(InternalError::Storage(format!(
            "YouTube upload init failed ({status}): {text}"
        ))
        .into());
    }
    resp.headers()
        .get("location")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            InternalError::Storage("YouTube session URI missing from init response".into()).into()
        })
}

/// `PUT Content-Range: bytes */total` → 308 + `Range: bytes=0-N` tells us how
/// much YouTube actually persisted; `Ok(None)` means the upload finished or
/// the session is dead (caller decides).
async fn query_confirmed_offset(
    http: &Client,
    token: &str,
    session_uri: &str,
    file_len: u64,
) -> Result<Option<u64>> {
    let resp = http
        .put(session_uri)
        .bearer_auth(token)
        .header("Content-Range", format!("bytes */{file_len}"))
        .header("Content-Length", "0")
        .send()
        .await
        .map_err(|e| InternalError::Storage(format!("YouTube status query failed: {e}")))?;
    let status = resp.status();
    if status.as_u16() == 308 {
        let confirmed = resp
            .headers()
            .get("range")
            .and_then(|h| h.to_str().ok())
            .and_then(|r| r.strip_prefix("bytes=0-"))
            .and_then(|n| n.parse::<u64>().ok())
            .map(|last| last + 1)
            .unwrap_or(0);
        return Ok(Some(confirmed));
    }
    // 200/201 → finished already; 404/410 → session expired.
    Ok(if status.is_success() {
        Some(file_len)
    } else {
        None
    })
}

pub async fn publish_video(
    app_data_dir: &Path,
    request: &YouTubePublishRequest,
    progress: impl Fn(u64, u64),
) -> Result<(String, bool)> {
    let _guard = try_begin_publish()?;

    let path = crate::path_policy::canonicalize_path(Path::new(&request.path))
        .map_err(|e| InternalError::Storage(format!("publish path is invalid: {e}")))?;
    if path.extension().and_then(|e| e.to_str()) != Some("mp4") {
        return Err(
            InternalError::Storage("YouTube publish supports MP4 exports only".into()).into(),
        );
    }

    let mut file = File::open(&path)
        .map_err(|e| InternalError::Storage(format!("failed to open export for upload: {e}")))?;
    let file_len = file
        .metadata()
        .map_err(|e| InternalError::Storage(format!("failed to stat export: {e}")))?
        .len();

    let http = Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .unwrap_or_else(|_| Client::new());
    let token = get_access_token(&http).await?;

    let session_path = app_data_dir.join("youtube-upload-session.json");
    let mut session_uri = match load_session(&session_path, &path, file_len) {
        Some(session) => {
            match query_confirmed_offset(&http, &token, &session.session_uri, file_len).await? {
                Some(offset) if offset < file_len => {
                    info!(offset, "resuming persisted YouTube upload session");
                    session.session_uri
                }
                Some(_) => {
                    // Server considers the upload complete — nothing left to send,
                    // but we never captured the video id; start a fresh session.
                    create_session(&http, &token, request, file_len).await?
                }
                None => create_session(&http, &token, request, file_len).await?,
            }
        }
        None => create_session(&http, &token, request, file_len).await?,
    };
    save_session(
        &session_path,
        &UploadSession {
            session_uri: session_uri.clone(),
            path: path.to_string_lossy().to_string(),
            file_size: file_len,
            file_mtime_ms: file_mtime_ms(&path),
            started_at_ms: now_ms(),
        },
    );

    let mut uploaded_bytes =
        match query_confirmed_offset(&http, &token, &session_uri, file_len).await? {
            Some(offset) => offset.min(file_len),
            None => 0,
        };
    progress(uploaded_bytes, file_len);

    let mut chunk_buffer = vec![0u8; CHUNK_SIZE];
    let mut video_id = String::new();

    while uploaded_bytes < file_len {
        if PUBLISH_CANCEL.load(Ordering::Relaxed) {
            return Err(InternalError::Storage("YouTube publish cancelled".into()).into());
        }
        file.seek(SeekFrom::Start(uploaded_bytes))
            .map_err(|e| InternalError::Storage(format!("seek error: {e}")))?;
        let bytes_read = file
            .read(&mut chunk_buffer)
            .map_err(|e| InternalError::Storage(format!("read error: {e}")))?;
        if bytes_read == 0 {
            break;
        }
        let end_byte = uploaded_bytes + bytes_read as u64 - 1;
        let content_range = format!("bytes {}-{}/{}", uploaded_bytes, end_byte, file_len);

        // Per-chunk retry: on transport failure re-query the session so we
        // never re-send bytes YouTube already persisted.
        let mut attempt = 0u32;
        loop {
            let chunk_resp = http
                .put(&session_uri)
                .bearer_auth(&token)
                .header("Content-Range", &content_range)
                .header("Content-Type", "video/mp4")
                .body(chunk_buffer[..bytes_read].to_vec())
                .send()
                .await;

            let status = match &chunk_resp {
                Ok(resp) => Some(resp.status()),
                Err(_) => None,
            };

            match status.map(|s| s.as_u16()) {
                Some(308) => {
                    uploaded_bytes += bytes_read as u64;
                    progress(uploaded_bytes, file_len);
                    break;
                }
                Some(code) if (200..300).contains(&code) => {
                    uploaded_bytes += bytes_read as u64;
                    progress(uploaded_bytes, file_len);
                    let json: serde_json::Value =
                        chunk_resp.unwrap().json().await.unwrap_or_default();
                    if let Some(id) = json.get("id").and_then(|v| v.as_str()) {
                        video_id = id.to_string();
                    }
                    break;
                }
                Some(404) | Some(410) => {
                    // Session expired — restart the whole upload once; the
                    // outer loop re-reads from the confirmed offset.
                    let _ = std::fs::remove_file(&session_path);
                    session_uri = create_session(&http, &token, request, file_len).await?;
                    uploaded_bytes = query_confirmed_offset(&http, &token, &session_uri, file_len)
                        .await?
                        .unwrap_or(0);
                    break;
                }
                _ => {
                    attempt += 1;
                    if attempt >= CHUNK_RETRIES {
                        let detail = match chunk_resp {
                            Ok(resp) => format!(
                                "({}) {}",
                                resp.status(),
                                resp.text().await.unwrap_or_default()
                            ),
                            Err(e) => e.to_string(),
                        };
                        return Err(InternalError::Storage(format!(
                            "YouTube chunk upload failed after {CHUNK_RETRIES} attempts {detail}"
                        ))
                        .into());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(500 * attempt as u64));
                }
            }
        }
        if PUBLISH_CANCEL.load(Ordering::Relaxed) {
            return Err(InternalError::Storage("YouTube publish cancelled".into()).into());
        }
    }

    if video_id.is_empty() {
        return Err(
            InternalError::Storage("YouTube upload finished without a video id".into()).into(),
        );
    }
    let _ = std::fs::remove_file(&session_path);
    info!(video_id = %video_id, "YouTube upload completed");

    // Captions sidecar — same `.srt` the export writes for captionMode
    // "sidecar"; silently skipped when absent.
    let mut captions_attached = false;
    if let Some(captions) = &request.captions_path {
        let captions_path = Path::new(captions);
        if captions_path.is_file() {
            captions_attached = attach_captions(
                &http,
                &token,
                &video_id,
                captions_path,
                &request.captions_language,
            )
            .await
            .unwrap_or(false);
        }
    }

    Ok((video_id, captions_attached))
}

/// `captions.insert` multipart upload (metadata part + SRT media part).
async fn attach_captions(
    http: &Client,
    token: &str,
    video_id: &str,
    captions_path: &Path,
    language: &str,
) -> Result<bool> {
    let srt = std::fs::read(captions_path)
        .map_err(|e| InternalError::Storage(format!("failed to read captions sidecar: {e}")))?;
    let boundary = "rf_captions_boundary";
    let metadata = serde_json::json!({
        "snippet": {
            "videoId": video_id,
            "language": language,
            "name": "English",
            "isDraft": false,
        }
    });
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{}\r\n",
            metadata
        )
        .as_bytes(),
    );
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes(),
    );
    body.extend_from_slice(&srt);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let resp = http
        .post("https://www.googleapis.com/upload/youtube/v3/captions?part=snippet&uploadType=multipart")
        .bearer_auth(token)
        .header(
            "Content-Type",
            format!("multipart/related; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .map_err(|e| InternalError::Storage(format!("captions attach failed: {e}")))?;
    Ok(resp.status().is_success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_resumes_only_matching_file() {
        let dir = std::env::temp_dir().join(format!("rf-yt-session-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let video = dir.join("video.mp4");
        std::fs::write(&video, b"fake").unwrap();
        let session_path = dir.join("session.json");
        let session = UploadSession {
            session_uri: "https://upload.example/s".into(),
            path: video.to_string_lossy().to_string(),
            file_size: 4,
            file_mtime_ms: file_mtime_ms(&video),
            started_at_ms: now_ms(),
        };
        save_session(&session_path, &session);
        assert!(load_session(&session_path, &video, 4).is_some());
        // Wrong size → no resume.
        assert!(load_session(&session_path, &video, 8).is_none());
        let other = dir.join("other.mp4");
        std::fs::write(&other, b"fake").unwrap();
        // Different path → no resume.
        assert!(load_session(&session_path, &other, 4).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn expired_session_is_dropped() {
        let dir = std::env::temp_dir().join(format!("rf-yt-exp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let video = dir.join("video.mp4");
        std::fs::write(&video, b"fake").unwrap();
        let session_path = dir.join("session.json");
        save_session(
            &session_path,
            &UploadSession {
                session_uri: "https://upload.example/s".into(),
                path: video.to_string_lossy().to_string(),
                file_size: 4,
                file_mtime_ms: file_mtime_ms(&video),
                started_at_ms: now_ms() - SESSION_TTL_MS - 1,
            },
        );
        assert!(load_session(&session_path, &video, 4).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
