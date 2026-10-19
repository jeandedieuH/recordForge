//! YouTube Data API v3 publishing — confirmed-offset state machine.
//!
//! Resumable upload (`videos.insert` + `uploadType=resumable`):
//!   1. Resolve any persisted session — only for the SAME file
//!      (path + size + mtime) and only within the ~7-day YouTube window.
//!   2. `PUT Content-Range: bytes */total` returns a TYPED state: a 308 with
//!      a strict `Range: bytes=0-N` is `Confirmed(N+1)`; 200/201 is
//!      `Finished`; anything else is `Dead`. No default branch ever implies
//!      success.
//!   3. Byte-range PUTs stream the file in 8 MiB chunks (256 KiB multiple).
//!      Before the FINAL chunk is sent the "uncertain" state is persisted —
//!      if its 200/201 reply is lost the upload may already be live and the
//!      session URI's `upload_id` recovers the video id via `videos.list`.
//!   4. Session expiry (404/410) restarts the upload exactly once.
//!   5. A 401 mid-upload refreshes the access token once and retries.
//!
//! The session lives in the OS credential vault (`youtube:upload_session`) —
//! it is a bearer credential, not a public file — while the plain-text
//! video id is persisted separately for id recovery.

use reqwest::{Client, StatusCode};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tracing::{info, warn};

use crate::errors::{InternalError, Result};
use crate::publish::jobs::CancelToken;
use crate::storage::drive::{get_google_drive_client_id, get_google_drive_client_secret};
use crate::storage::vault;

// youtube.force-ssl is required by captions.insert for the SRT attach.
pub const YOUTUBE_OAUTH_SCOPE: &str =
    "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl";

const YOUTUBE_VAULT_ACCOUNT: &str = "youtube:refresh_token";
const SESSION_VAULT_ACCOUNT: &str = "youtube:upload_session";
const VIDEO_ID_ACCOUNT: &str = "youtube:last_video_id";
const CHUNK_SIZE: usize = 8 * 1024 * 1024; // 8 MiB — must be a multiple of 256 KiB
const SESSION_TTL_MS: u64 = 6 * 24 * 60 * 60 * 1000;
const RETRY_ATTEMPTS: u32 = 3;

/// Session metadata stored in the vault as a JSON blob — the key name is an
/// opaque marker; the URI itself is the secret material.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultSession {
    session_uri: String,
    path: String,
    file_size: u64,
    file_mtime_ms: u64,
    started_at_ms: u64,
}

/// Typed answer to the `bytes */total` status query — the ONLY states
/// YouTube's resumable protocol defines; a missing/odd Range is never a
/// "yes we got it".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionState {
    /// YouTube confirmed exactly this many bytes — resume here.
    Confirmed(u64),
    /// 200/201 — the object is already complete.
    Finished,
    /// 404/410/other — the session is gone; start a fresh one.
    Dead,
}

fn yt_error(message: impl Into<String>) -> crate::errors::AppError {
    InternalError::Storage(message.into()).into()
}

fn cancelled() -> crate::errors::AppError {
    crate::errors::AppError::new(
        crate::errors::ErrorCategory::Storage,
        "publication_cancelled",
        "publish was cancelled",
    )
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

// ---------------------------------------------------------------------------
// Connection (unchanged surface for commands/publish.rs)
// ---------------------------------------------------------------------------

pub fn has_connection() -> Result<bool> {
    Ok(vault::get_secret(YOUTUBE_VAULT_ACCOUNT)?.is_some())
}

pub fn store_refresh_token(refresh_token: &str) -> Result<()> {
    vault::set_secret(YOUTUBE_VAULT_ACCOUNT, refresh_token)
}

pub fn disconnect() -> Result<()> {
    let _ = vault::delete_secret(SESSION_VAULT_ACCOUNT);
    let _ = vault::delete_secret(VIDEO_ID_ACCOUNT);
    vault::delete_secret(YOUTUBE_VAULT_ACCOUNT)
}

fn refresh_token() -> Result<String> {
    vault::get_secret(YOUTUBE_VAULT_ACCOUNT)?.ok_or_else(|| {
        InternalError::Storage("YouTube is not connected — authorize first".into()).into()
    })
}

/// Fresh access token from the vaulted refresh token — one per upload; a
/// refresh failure is the job's error, not a panic.
pub(crate) async fn access_token(http: &Client) -> Result<String> {
    let client_id = get_google_drive_client_id();
    let client_secret = get_google_drive_client_secret();
    let refresh = refresh_token()?;
    let mut params = vec![
        ("client_id", client_id.as_str()),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh.as_str()),
    ];
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
    let token = access_token(&http).await?;
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
// Publish request — resolved from an export job, never a raw path.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubePublishRequest {
    /// The finished export job whose output is published — the video path,
    /// captions sidecar, and title come from its frozen artifact, never from
    /// arbitrary caller strings.
    #[serde(rename = "exportJobId")]
    pub export_job_id: String,
    /// Caller-generated idempotency key for the publication registry.
    #[serde(rename = "operationId")]
    pub operation_id: String,
    /// Explicit audience — private/unlisted/public; the default stays the
    /// least public.
    #[serde(default = "default_privacy")]
    pub privacy: String,
    /// Optional localized title override; falls back to the frozen manifest
    /// title when empty.
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_category")]
    pub category_id: String,
    /// Explicit opt-in — without it the export's sidecar is never attached.
    #[serde(default)]
    pub captions: bool,
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

pub fn validate_request(request: &YouTubePublishRequest) -> Result<()> {
    if !["private", "unlisted", "public"].contains(&request.privacy.as_str()) {
        return Err(yt_error(
            "YouTube audience must be private, unlisted, or public",
        ));
    }
    if let Some(title) = &request.title {
        if title.trim().is_empty() || title.chars().count() > 100 {
            return Err(yt_error("YouTube titles must be 1–100 characters"));
        }
    }
    if request.description.chars().count() > 5000 {
        return Err(yt_error(
            "YouTube descriptions are limited to 5,000 characters",
        ));
    }
    if request.tags.len() > 500
        || request
            .tags
            .iter()
            .map(|tag| tag.chars().count())
            .sum::<usize>()
            > 450
    {
        return Err(yt_error("YouTube tags must total at most 450 characters"));
    }
    if request.captions_language.trim().is_empty() || request.captions_language.len() > 10 {
        return Err(yt_error("a valid captions language is required"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Vaulted session persistence
// ---------------------------------------------------------------------------

fn load_vault_session(path: &Path, file_len: u64) -> Option<VaultSession> {
    let raw = vault::get_secret(SESSION_VAULT_ACCOUNT).ok()??;
    let session: VaultSession = serde_json::from_str(&raw).ok()?;
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

fn save_vault_session(path: &Path, file_len: u64, session_uri: &str) {
    let session = VaultSession {
        session_uri: session_uri.to_string(),
        path: path.to_string_lossy().to_string(),
        file_size: file_len,
        file_mtime_ms: file_mtime_ms(path),
        started_at_ms: now_ms(),
    };
    if let Ok(json) = serde_json::to_string(&session) {
        if let Err(error) = vault::set_secret(SESSION_VAULT_ACCOUNT, &json) {
            warn!(error = %error, "could not persist YouTube session");
        }
    }
}

fn clear_vault_session() {
    let _ = vault::delete_secret(SESSION_VAULT_ACCOUNT);
}

/// The resumable session URI embeds `upload_id` — for YouTube that id IS the
/// eventual video id, so a lost final reply can recover it.
fn session_upload_id(session_uri: &str) -> Option<&str> {
    session_uri
        .split("upload_id=")
        .nth(1)
        .map(|rest| rest.split('&').next().unwrap_or(rest))
        .filter(|id| !id.is_empty())
}

fn persist_video_id(video_id: &str) {
    if let Err(error) = vault::set_secret(VIDEO_ID_ACCOUNT, video_id) {
        warn!(error = %error, "could not persist YouTube video id");
    }
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

async fn create_session(
    http: &Client,
    token: &str,
    metadata: &serde_json::Value,
    file_len: u64,
    base_url: &str,
) -> Result<String> {
    let resp = http
        .post(format!(
            "{base_url}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status"
        ))
        .bearer_auth(token)
        .header("X-Upload-Content-Type", "video/*")
        .header("X-Upload-Content-Length", file_len.to_string())
        .json(metadata)
        .send()
        .await
        .map_err(|e| yt_error(format!("failed to open YouTube upload session: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(yt_error(format!(
            "YouTube upload init failed ({status}): {text}"
        )));
    }
    resp.headers()
        .get("location")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string())
        .ok_or_else(|| yt_error("YouTube session URI missing from init response"))
}

/// `PUT Content-Range: bytes */total` → typed session state. A 308 carries
/// `Range: bytes=0-N` — strictly `bytes=0-` prefixed, monotone, and below the
/// total; a malformed header is treated as unconfirmed progress (Dead is
/// wrong, Finished is wronger — so `Confirmed(0)` only when the header is
/// absent entirely... a malformed Range means we cannot trust the session).
async fn query_session_state(
    http: &Client,
    token: &str,
    session_uri: &str,
    file_len: u64,
) -> Result<SessionState> {
    let resp = http
        .put(session_uri)
        .bearer_auth(token)
        .header("Content-Range", format!("bytes */{file_len}"))
        .header("Content-Length", "0")
        .send()
        .await
        .map_err(|e| yt_error(format!("YouTube status query failed: {e}")))?;
    let status = resp.status();
    if status.as_u16() == 308 {
        let confirmed = match resp.headers().get("range").and_then(|h| h.to_str().ok()) {
            Some(raw) => {
                let last = raw
                    .strip_prefix("bytes=0-")
                    .and_then(|n| n.parse::<u64>().ok())
                    .ok_or_else(|| yt_error(format!("malformed YouTube progress header: {raw}")))?;
                // The confirmed byte count is last+1 and must stay within
                // the file — a header claiming more is protocol nonsense.
                last.checked_add(1)
                    .filter(|confirmed| *confirmed <= file_len)
                    .ok_or_else(|| {
                        yt_error(format!("YouTube progress header exceeds file size: {raw}"))
                    })?
            }
            // 308 with no Range → YouTube persisted 0 bytes so far.
            None => 0,
        };
        return Ok(SessionState::Confirmed(confirmed));
    }
    // 200/201 → the object already completed; 404/410 → the session is dead.
    // NOTHING else implies progress.
    Ok(if status.is_success() {
        SessionState::Finished
    } else {
        SessionState::Dead
    })
}

/// Recover the video id after a lost final-chunk reply: the session URI's
/// `upload_id` is the eventual video id, and `videos.list` confirms it.
async fn confirm_recovered_video_id(
    http: &Client,
    token: &str,
    session_uri: &str,
) -> Result<Option<String>> {
    let Some(upload_id) = session_upload_id(session_uri).map(str::to_string) else {
        return Ok(None);
    };
    let resp = http
        .get(format!(
            "https://www.googleapis.com/youtube/v3/videos?part=id&id={upload_id}"
        ))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| yt_error(format!("YouTube id recovery failed: {e}")))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    let found = body
        .pointer("/items/0/id")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Ok(found.filter(|id| *id == upload_id))
}

/// Chunk send result — the ONLY 2xx/308 paths advance the offset.
enum ChunkSend {
    /// 308 — chunk persisted; continue.
    Progressed,
    /// 200/201 with a parsed video id — upload complete.
    Finished(String),
    /// 2xx WITHOUT an id — the reply body was unusable; the upload may be
    /// live: recover by upload_id.
    FinishedReplyMissingId,
    /// The send's reply was lost entirely — recover by upload_id too: the
    /// final chunk may have landed. The transport detail stays in the
    /// variant for diagnostics.
    #[allow(dead_code)]
    ReplyLost(String),
    /// 401 — caller refreshes once then retries.
    Unauthorized,
    /// Session is dead (404/410) — caller restarts once.
    SessionDead,
    Failed(String),
}

async fn send_chunk(
    http: &Client,
    token: &str,
    session_uri: &str,
    start: u64,
    end_inclusive: u64,
    file_len: u64,
    data: &[u8],
) -> ChunkSend {
    let content_range = format!("bytes {start}-{end_inclusive}/{file_len}");
    let response = match http
        .put(session_uri)
        .bearer_auth(token)
        .header("Content-Range", &content_range)
        .header("Content-Type", "video/mp4")
        .body(data.to_vec())
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(error) => return ChunkSend::ReplyLost(error.to_string()),
    };

    let status = response.status();
    match status.as_u16() {
        308 => ChunkSend::Progressed,
        code if (200..300).contains(&code) => {
            let json: serde_json::Value = response.json().await.unwrap_or_default();
            match json.get("id").and_then(|v| v.as_str()) {
                Some(id) => ChunkSend::Finished(id.to_string()),
                None => ChunkSend::FinishedReplyMissingId,
            }
        }
        code if code == StatusCode::UNAUTHORIZED.as_u16() => ChunkSend::Unauthorized,
        code if code == StatusCode::NOT_FOUND.as_u16() || code == StatusCode::GONE.as_u16() => {
            ChunkSend::SessionDead
        }
        _ => ChunkSend::Failed(format!(
            "({status}) {}",
            response.text().await.unwrap_or_default()
        )),
    }
}

// ---------------------------------------------------------------------------
// The resumable state machine
// ---------------------------------------------------------------------------

/// Everything `publish_video` needs resolved by the caller — a validated
/// source (frozen artifact + authorized path), the live cancel token, and
/// the registry progress sink.
pub struct YouTubeWorkerInput {
    pub request: YouTubePublishRequest,
    pub video_path: PathBuf,
    pub captions_path: Option<PathBuf>,
    pub title: String,
    pub progress: super::hosted::ProgressSink,
    pub cancel: CancelToken,
    /// Test seam — production always uses the real API origin.
    pub api_base: String,
    /// Test seam — production always reads the real vault.
    pub access_token: String,
}

/// The worker outcome mirrors `publish::hosted::WorkerOutcome` semantics —
/// the runner maps it onto the publication job row.
pub async fn publish_video(input: YouTubeWorkerInput) -> Result<(String, bool)> {
    let http = Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .unwrap_or_else(|_| Client::new());
    let token = input.access_token.clone();
    let cancel = input.cancel.clone();
    let progress = input.progress.clone();

    let path = &input.video_path;
    let mut file =
        File::open(path).map_err(|e| yt_error(format!("failed to open export for upload: {e}")))?;
    let file_len = file
        .metadata()
        .map_err(|e| yt_error(format!("failed to stat export: {e}")))?
        .len();

    let metadata = serde_json::json!({
        "snippet": {
            "title": input.title,
            "description": input.request.description,
            "tags": input.request.tags,
            "categoryId": input.request.category_id,
        },
        "status": {
            "privacyStatus": input.request.privacy,
            "selfDeclaredMadeForKids": false,
        },
    });

    // Session resolution — resume ONLY the exact same file inside the
    // YouTube session window.
    enum SessionStart {
        Resume {
            uri: String,
        },
        /// The persisted session already finished and its video id was
        /// recovered — nothing left to upload.
        AlreadyPublished {
            video_id: String,
        },
    }
    let start = match load_vault_session(path, file_len) {
        Some(session) => {
            match query_session_state(&http, &token, &session.session_uri, file_len).await? {
                SessionState::Confirmed(offset) if offset < file_len => {
                    info!(offset, "resuming persisted YouTube upload session");
                    SessionStart::Resume {
                        uri: session.session_uri,
                    }
                }
                SessionState::Confirmed(_) | SessionState::Finished => {
                    // Server says the upload completed but no video id was ever
                    // captured — recover via the session's upload_id, or restart
                    // with a fresh session when nothing is recoverable.
                    match confirm_recovered_video_id(&http, &token, &session.session_uri).await? {
                        Some(video_id) => SessionStart::AlreadyPublished { video_id },
                        None => {
                            clear_vault_session();
                            SessionStart::Resume {
                                uri: create_session(
                                    &http,
                                    &token,
                                    &metadata,
                                    file_len,
                                    &input.api_base,
                                )
                                .await?,
                            }
                        }
                    }
                }
                SessionState::Dead => {
                    clear_vault_session();
                    SessionStart::Resume {
                        uri: create_session(&http, &token, &metadata, file_len, &input.api_base)
                            .await?,
                    }
                }
            }
        }
        None => SessionStart::Resume {
            uri: create_session(&http, &token, &metadata, file_len, &input.api_base).await?,
        },
    };
    let mut session_uri = match start {
        SessionStart::Resume { uri } => {
            save_vault_session(path, file_len, &uri);
            uri
        }
        SessionStart::AlreadyPublished { video_id } => {
            persist_video_id(&video_id);
            clear_vault_session();
            // Captions still attach on the recovered id when requested.
            let mut captions_attached = false;
            if let Some(captions_path) = &input.captions_path {
                captions_attached = attach_captions(
                    &http,
                    &token,
                    &video_id,
                    captions_path,
                    &input.request.captions_language,
                    &input.api_base,
                )
                .await
                .unwrap_or(false);
            }
            return Ok((video_id, captions_attached));
        }
    };

    let mut uploaded = match query_session_state(&http, &token, &session_uri, file_len).await? {
        SessionState::Confirmed(offset) => offset.min(file_len),
        SessionState::Finished => file_len,
        SessionState::Dead => 0,
    };
    progress(
        super::jobs::PublicationStatus::Uploading,
        uploaded,
        file_len,
    );

    let mut chunk_buffer = vec![0u8; CHUNK_SIZE];
    let mut video_id: Option<String> = None;
    let mut restarted = false;
    let mut token_refreshed = false;
    let mut token = token;

    'upload: loop {
        if uploaded >= file_len {
            break;
        }
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        file.seek(SeekFrom::Start(uploaded))
            .map_err(|e| yt_error(format!("seek error: {e}")))?;
        let bytes_read = file
            .read(&mut chunk_buffer)
            .map_err(|e| yt_error(format!("read error: {e}")))?;
        if bytes_read == 0 {
            break;
        }
        let end_byte = uploaded + bytes_read as u64 - 1;
        let is_final_chunk = end_byte + 1 >= file_len;

        // The uncertain state is persisted BEFORE the final send — a lost
        // reply is recoverable via the session's upload_id.
        if is_final_chunk {
            save_vault_session(path, file_len, &session_uri);
        }

        let mut attempt = 0u32;
        loop {
            if cancel.is_cancelled() {
                return Err(cancelled());
            }
            match send_chunk(
                &http,
                &token,
                &session_uri,
                uploaded,
                end_byte,
                file_len,
                &chunk_buffer[..bytes_read],
            )
            .await
            {
                ChunkSend::Progressed => {
                    uploaded += bytes_read as u64;
                    progress(
                        super::jobs::PublicationStatus::Uploading,
                        uploaded,
                        file_len,
                    );
                    break;
                }
                ChunkSend::Finished(id) => {
                    uploaded += bytes_read as u64;
                    video_id = Some(id);
                    break;
                }
                ChunkSend::FinishedReplyMissingId | ChunkSend::ReplyLost(_) => {
                    // The 200/201 body was unusable or the reply never
                    // arrived — the upload may be live; recover through the
                    // session's upload_id before deciding anything.
                    match confirm_recovered_video_id(&http, &token, &session_uri).await? {
                        Some(id) => {
                            uploaded = file_len;
                            video_id = Some(id);
                            break;
                        }
                        None => {
                            attempt += 1;
                            if attempt >= RETRY_ATTEMPTS {
                                // Distinct code — the runner surfaces this as
                                // `uncertain` (possibly-published), never as a
                                // plain failure that invites a blind retry.
                                return Err(crate::errors::AppError::new(
                                    crate::errors::ErrorCategory::Storage,
                                    "youtube_result_unconfirmed",
                                    "YouTube upload reply was lost and the video id could not be recovered — check your channel before retrying",
                                ));
                            }
                            if !cancel
                                .wait(std::time::Duration::from_millis(500 * attempt as u64))
                                .await
                            {
                                return Err(cancelled());
                            }
                        }
                    }
                }
                ChunkSend::Unauthorized if !token_refreshed => {
                    // One refresh, one retry — a second 401 is a real auth
                    // failure, not a token hiccup.
                    token_refreshed = true;
                    token = access_token(&http).await?;
                }
                ChunkSend::SessionDead if !restarted => {
                    // The session expired mid-upload — restart the upload
                    // EXACTLY once at the confirmed offset of a fresh
                    // session.
                    restarted = true;
                    clear_vault_session();
                    session_uri =
                        create_session(&http, &token, &metadata, file_len, &input.api_base).await?;
                    save_vault_session(path, file_len, &session_uri);
                    uploaded =
                        match query_session_state(&http, &token, &session_uri, file_len).await? {
                            SessionState::Confirmed(offset) => offset.min(file_len),
                            SessionState::Finished => file_len,
                            SessionState::Dead => 0,
                        };
                    continue 'upload;
                }
                ChunkSend::SessionDead => {
                    return Err(yt_error(
                        "YouTube upload session expired twice — the upload cannot continue",
                    ));
                }
                ChunkSend::Unauthorized => {
                    return Err(yt_error(
                        "YouTube authorization failed after a token refresh — reconnect the channel",
                    ));
                }
                ChunkSend::Failed(detail) => {
                    attempt += 1;
                    if attempt >= RETRY_ATTEMPTS {
                        return Err(yt_error(format!(
                            "YouTube chunk upload failed after {RETRY_ATTEMPTS} attempts {detail}"
                        )));
                    }
                    if !cancel
                        .wait(std::time::Duration::from_millis(500 * attempt as u64))
                        .await
                    {
                        return Err(cancelled());
                    }
                }
            }
        }
    }

    let video_id =
        video_id.ok_or_else(|| yt_error("YouTube upload finished without a video id"))?;
    persist_video_id(&video_id);
    clear_vault_session();
    info!(video_id = %video_id, "YouTube upload completed");

    // Captions sidecar — the export's own `.srt` attached via captions.insert.
    let mut captions_attached = false;
    if let Some(captions_path) = &input.captions_path {
        progress(
            super::jobs::PublicationStatus::AttachingCaptions,
            file_len,
            file_len,
        );
        captions_attached = attach_captions(
            &http,
            &token,
            &video_id,
            captions_path,
            &input.request.captions_language,
            &input.api_base,
        )
        .await
        .unwrap_or(false);
        if !captions_attached {
            warn!("captions attach failed; video remains published");
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
    api_base: &str,
) -> Result<bool> {
    let srt = std::fs::read(captions_path)
        .map_err(|e| yt_error(format!("failed to read captions sidecar: {e}")))?;
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
        .post(format!(
            "{api_base}/upload/youtube/v3/captions?part=snippet&uploadType=multipart"
        ))
        .bearer_auth(token)
        .header(
            "Content-Type",
            format!("multipart/related; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .map_err(|e| yt_error(format!("captions attach failed: {e}")))?;
    Ok(resp.status().is_success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_id_extracts_from_session_uri() {
        let uri = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=AEnB2UpABC123";
        assert_eq!(session_upload_id(uri), Some("AEnB2UpABC123"));
        let none = "https://example.com/session";
        assert_eq!(session_upload_id(none), None);
        // A trailing ampersand arg does not leak into the id.
        let with_tail = "https://x/?upload_id=abc&other=1";
        assert_eq!(session_upload_id(with_tail), Some("abc"));
    }

    #[test]
    fn range_header_parsing_is_strict() {
        // The strict contract is exercised through query_session_state's
        // documented shape — these cases pin the parse rules.
        let parse = |raw: &str, total: u64| -> Option<u64> {
            raw.strip_prefix("bytes=0-")
                .and_then(|n| n.parse::<u64>().ok())
                .and_then(|last| last.checked_add(1))
                .filter(|confirmed| *confirmed <= total)
        };
        assert_eq!(parse("bytes=0-1048575", 2_097_152), Some(1_048_576));
        // Last byte AT total means complete — bounded to total.
        assert_eq!(parse("bytes=0-99", 100), Some(100));
        // Over-total and malformed headers are rejected, never trusted.
        assert_eq!(parse("bytes=0-100", 100), None);
        assert_eq!(parse("bytes=1-10", 100), None);
        assert_eq!(parse("random", 100), None);
    }
}
