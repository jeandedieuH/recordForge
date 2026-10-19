//! Tauri commands for external publishing (YouTube) plus the loopback+PKCE
//! OAuth flow.
//!
//! `publish_to_youtube` is EXPORT-JOB SOURCED like `share_export`: the
//! request names a finished export job; the video path, captions sidecar,
//! and title come from the job's frozen artifact — never raw caller paths.
//! OAuth is hardened the same way the Drive flow should be: an 8 KiB header
//! cap, a short read timeout on the callback socket, URL-decoded query
//! values, an exact state match, one in-flight flow at a time with a 300 s
//! deadline, and a refresh-token-required token response — a code exchange
//! that returns no refresh token keeps the previous connection untouched.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, State};

use crate::commands::storage::OAuthFlowStartResult;
use crate::errors::{AppError, InternalError, Result};
use crate::publish::hosted::WorkerOutcome;
use crate::publish::jobs::{
    PublicationJob, PublicationProvider, PublicationResult, PublicationYouTubeResult,
};
use crate::publish::runner;
use crate::publish::source::resolve_export_source;
use crate::publish::youtube;
use crate::state::AppState;
use crate::storage::drive::{get_google_drive_client_id, get_google_drive_client_secret};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct YouTubeOAuthCompletedEvent {
    success: bool,
    account_label: Option<String>,
    error: Option<String>,
    /// The flow's own `state` — the frontend correlates the result to the
    /// flow it started instead of trusting any stray emit.
    state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeConnectionInfo {
    pub connected: bool,
    pub account_label: Option<String>,
}

/// One OAuth flow at a time — a second `start_youtube_oauth` while a flow is
/// still waiting fails instead of leaking a second listener.
static OAUTH_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
const OAUTH_DEADLINE_SECS: u64 = 300;
const OAUTH_HEADER_CAP: usize = 8 * 1024;
const OAUTH_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

struct OAuthFlowGuard;
impl Drop for OAuthFlowGuard {
    fn drop(&mut self) {
        OAUTH_IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

// Same construction as commands::share — licensing failures carry the
// code + feature keys the frontend maps to the upgrade dialog.
fn licensing_error(code: &str, message: impl Into<String>) -> AppError {
    let mut details = serde_json::Map::new();
    details.insert(
        "features".to_string(),
        serde_json::json!(["youtube-publish"]),
    );
    AppError::new(
        crate::errors::ErrorCategory::Licensing,
        code,
        message.into(),
    )
    .with_details(details)
}

/// Loopback+PKCE OAuth for the YouTube connection. Mirrors the Google Drive
/// flow but stores the refresh token directly in the credential vault — it
/// never crosses into the frontend.
#[tauri::command]
pub async fn start_youtube_oauth(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<OAuthFlowStartResult> {
    let _update_operation = state.update_gate.acquire_operation()?;
    if !state.license.entitlements().pro_enabled {
        return Err(licensing_error(
            "pro_feature_required",
            "Publishing to YouTube is a RecordForge Pro feature",
        ));
    }
    if OAUTH_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return Err(InternalError::Storage(
            "a YouTube authorization flow is already in progress".into(),
        )
        .into());
    }
    // Dropped when the spawned waiter thread ends — success, failure, or
    // deadline alike.
    let flow_guard = Arc::new(OAuthFlowGuard);

    let verifier = uuid::Uuid::new_v4().to_string() + &uuid::Uuid::new_v4().to_string();
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        hasher.finalize(),
    );
    let state_str = uuid::Uuid::new_v4().to_string();

    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            OAUTH_IN_FLIGHT.store(false, Ordering::SeqCst);
            return Err(
                InternalError::Storage(format!("failed to bind loopback TCP server: {e}")).into(),
            );
        }
    };
    let port = listener
        .local_addr()
        .map_err(|e| InternalError::Storage(format!("failed to get local addr: {e}")))?
        .port();

    let redirect_uri = format!("http://127.0.0.1:{}", port);
    let client_id = get_google_drive_client_id();
    let scope = urlencoding(youtube::YOUTUBE_OAUTH_SCOPE);
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        client_id, redirect_uri, scope, challenge, state_str
    );

    let app_clone = app.clone();
    let state_clone = state_str.clone();
    let verifier_clone = verifier.clone();

    std::thread::spawn(move || {
        let _guard = flow_guard;
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_secs(OAUTH_DEADLINE_SECS);
        // The listener sits on a loop: real browsers often open a probing
        // connection (favicon/preconnect) before the redirect lands, and the
        // deadline bounds the whole wait.
        let outcome = wait_for_callback(&listener, deadline, &state_clone, &verifier_clone, port);
        // Channel title is best-effort — the card falls back to "YouTube".
        let account_label = if outcome.is_ok() {
            tauri::async_runtime::block_on(async {
                youtube::connection_label().await.ok().flatten()
            })
        } else {
            None
        };
        emit_oauth_result(&app_clone, &state_clone, outcome.map(|_| ()), account_label);
    });

    Ok(OAuthFlowStartResult {
        auth_url,
        state: state_str,
        port,
    })
}

/// Wait on the loopback socket for the OAuth redirect: 8 KiB header cap,
/// per-read 2 s timeout, URL-decoded parameters, exact state match, overall
/// deadline. Returns the exchange outcome (unit on success — the token is
/// vaulted inside).
fn wait_for_callback(
    listener: &TcpListener,
    deadline: std::time::Instant,
    expected_state: &str,
    verifier: &str,
    port: u16,
) -> std::result::Result<(), String> {
    loop {
        if std::time::Instant::now() >= deadline {
            write_error_page(listener);
            return Err("the authorization flow timed out — try connecting again".to_string());
        }
        let accept = match listener.accept() {
            Ok(pair) => pair,
            Err(e) => return Err(format!("loopback listener failed: {e}")),
        };
        let (mut stream, _) = accept;
        let _ = stream.set_read_timeout(Some(OAUTH_READ_TIMEOUT));
        let _ = stream.set_write_timeout(Some(OAUTH_READ_TIMEOUT * 4));

        let mut buffer = [0u8; OAUTH_HEADER_CAP];
        let n = match stream.read(&mut buffer) {
            Ok(n) => n,
            Err(_) => continue, // probing connection / idle timeout — keep waiting
        };
        let request = String::from_utf8_lossy(&buffer[..n]);
        let (code, recv_state, error_param) = parse_oauth_query(&request);

        if code.is_none() && error_param.is_none() {
            // Not an OAuth callback (favicon, probes) — answer minimally and
            // keep waiting for the real redirect.
            let body = "<!DOCTYPE html><html><body></body></html>";
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .as_bytes(),
            );
            continue;
        }

        let outcome = match (code, recv_state, error_param) {
            (_, _, Some(error)) => Err(format!("Google returned an authorization error: {error}")),
            (Some(code), Some(recv_state), None) if recv_state == expected_state => {
                exchange_code(code, verifier, port)
            }
            (Some(_), _, None) => {
                Err("authorization state mismatch — the flow was restarted".to_string())
            }
            _ => Err("no authorization code in the callback".to_string()),
        };

        let ok = outcome.is_ok();
        let body = if ok {
            "<!DOCTYPE html><html><head><title>RecordForge Authentication</title></head><body style=\"font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:#f8fafc;\"><h2 style=\"color:#22c55e;\">&#10004; YouTube Connected!</h2><p>You can close this tab and return to RecordForge.</p><script>setTimeout(() => window.close(), 1500)</script></body></html>"
        } else {
            "<!DOCTYPE html><html><head><title>RecordForge Authentication</title></head><body style=\"font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:#f8fafc;\"><h2 style=\"color:#ef4444;\">&#10008; Authentication Failed</h2><p>Return to RecordForge for details.</p></body></html>"
        };
        let _ = stream.write_all(format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        ).as_bytes());
        return outcome;
    }
}

/// Pull `code`, `state`, and `error` out of the first request line — each
/// value URL-decoded, never compared raw.
fn parse_oauth_query(request: &str) -> (Option<String>, Option<String>, Option<String>) {
    let mut code = None;
    let mut state = None;
    let mut error = None;
    if let Some(first_line) = request.lines().next() {
        if let Some(path) = first_line.split_whitespace().nth(1) {
            if let Some(query) = path.split('?').nth(1) {
                for pair in query.split('&') {
                    let mut parts = pair.splitn(2, '=');
                    match (parts.next(), parts.next().map(url_decode)) {
                        (Some("code"), value) => code = value,
                        (Some("state"), value) => state = value,
                        (Some("error"), value) => error = value,
                        _ => {}
                    }
                }
            }
        }
    }
    (code, state, error)
}

/// Percent-decoder for OAuth query values (`%XX` and `+` → space).
fn url_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push((h * 16 + l) as u8);
                        i += 3;
                    }
                    // Malformed escape — keep the '%' literal and let the
                    // following characters decode on their own.
                    _ => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Exchange the authorization code for tokens. A response WITHOUT a refresh
/// token fails the flow and leaves the previous connection intact —
/// partial installs are worse than none.
fn exchange_code(code: String, verifier: &str, port: u16) -> std::result::Result<(), String> {
    tauri::async_runtime::block_on(async {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let client_id = get_google_drive_client_id();
        let client_secret = get_google_drive_client_secret();
        let redirect_uri = format!("http://127.0.0.1:{}", port);
        let mut params = vec![
            ("client_id", client_id.as_str()),
            ("code", code.as_str()),
            ("code_verifier", verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri.as_str()),
        ];
        if !client_secret.is_empty() {
            params.push(("client_secret", client_secret.as_str()));
        }
        match http
            .post("https://oauth2.googleapis.com/token")
            .form(&params)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<crate::storage::drive::TokenResponse>().await {
                    Ok(token_resp) => {
                        let Some(refresh) = token_resp.refresh_token.as_deref() else {
                            return Err(
                                "Google returned no refresh token — reconnect with consent"
                                    .to_string(),
                            );
                        };
                        youtube::store_refresh_token(refresh).map_err(|e| e.to_string())
                    }
                    Err(e) => Err(format!("failed to parse token response: {e}")),
                }
            }
            Ok(resp) => Err(resp.text().await.unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        }
    })
}

fn write_error_page(listener: &TcpListener) {
    if let Ok((mut stream, _)) = listener.accept() {
        let _ = stream.set_read_timeout(Some(OAUTH_READ_TIMEOUT));
        let mut buffer = [0u8; 512];
        let _ = stream.read(&mut buffer);
        let body = "<!DOCTYPE html><html><body><h2>Authorization timed out.</h2></body></html>";
        let _ = stream.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        );
    }
}

fn emit_oauth_result(
    app: &tauri::AppHandle,
    state: &str,
    outcome: std::result::Result<(), String>,
    account_label: Option<String>,
) {
    let _ = app.emit(
        "youtube-oauth-completed",
        YouTubeOAuthCompletedEvent {
            success: outcome.is_ok(),
            account_label,
            error: outcome.err(),
            state: state.to_string(),
        },
    );
}

#[tauri::command]
pub async fn youtube_connection_status() -> Result<YouTubeConnectionInfo> {
    let connected = youtube::has_connection()?;
    if !connected {
        return Ok(YouTubeConnectionInfo {
            connected: false,
            account_label: None,
        });
    }
    Ok(YouTubeConnectionInfo {
        connected: true,
        account_label: youtube::connection_label().await.unwrap_or(None),
    })
}

#[tauri::command]
pub async fn disconnect_youtube() -> Result<()> {
    youtube::disconnect()
}

/// Publish a finished export to YouTube. Returns the admitted publication
/// job — progress lands on `publication-job-update`.
#[tauri::command]
pub async fn publish_to_youtube(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: youtube::YouTubePublishRequest,
) -> Result<PublicationJob> {
    let _update_operation = state.update_gate.acquire_operation()?;
    if !state.license.entitlements().pro_enabled {
        return Err(licensing_error(
            "pro_feature_required",
            "Publishing to YouTube is a RecordForge Pro feature",
        ));
    }
    if !youtube::has_connection()? {
        return Err(licensing_error(
            "youtube_not_connected",
            "connect a YouTube channel first",
        ));
    }
    youtube::validate_request(&request)?;

    // Source resolution under a short DB lock — the same validated path +
    // captions + frozen manifest the hosted share uses.
    let source = {
        let conn = state
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let source = resolve_export_source(&conn, &state.ffprobe_path, &request.export_job_id)?;
        drop(conn);
        source
    };

    // The manifest title is the default; an explicit override wins.
    let title = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(&source.artifact.title)
        .to_string();

    // Idempotent admission — same operationId + same request replays the job.
    let fingerprint = serde_json::json!({
        "exportJobId": request.export_job_id,
        "title": title,
        "privacy": request.privacy,
        "categoryId": request.category_id,
        "tags": request.tags,
        "description": request.description,
        "captions": request.captions,
        "captionsLanguage": request.captions_language,
    })
    .to_string();
    let (job, cancel, is_new) = state.publication_registry.begin(
        &request.operation_id,
        &request.export_job_id,
        PublicationProvider::YouTube,
        None,
        &fingerprint,
        source.artifact.bytes,
    )?;
    runner::emit_job(&app, &job);
    if !is_new {
        return Ok(job);
    }

    let job_id = job.id.clone();
    let registry = std::sync::Arc::clone(&state.publication_registry);
    let sink = runner::progress_sink(
        app.clone(),
        std::sync::Arc::clone(&registry),
        job_id.clone(),
    );
    let request_clone = request.clone();
    let want_captions = request.captions && source.captions_path.is_some();
    runner::spawn_worker(app, registry, job_id, cancel.clone(), async move {
        match run_youtube_upload(request_clone, source, title, sink, cancel).await {
            Ok((video_id, captions_attached)) => {
                // The video is live even when captions fail — the outcome is
                // a completed job with a warning, never a failed job that
                // invites a duplicate upload.
                let warnings = if want_captions && !captions_attached {
                    vec!["the video is live; captions could not be attached".to_string()]
                } else {
                    Vec::new()
                };
                WorkerOutcome::Completed(
                    PublicationResult::YouTube(PublicationYouTubeResult {
                        url: format!("https://www.youtube.com/watch?v={video_id}"),
                        video_id,
                        captions_attached,
                    }),
                    warnings,
                )
            }
            Err(error) if error.code == "publication_cancelled" => WorkerOutcome::Cancelled,
            // A lost final reply with no recoverable video id is uncertainty,
            // not failure — the video may already be on the channel.
            Err(error) if error.code == "youtube_result_unconfirmed" => {
                WorkerOutcome::Uncertain(error.message)
            }
            Err(error) => WorkerOutcome::Failed(error),
        }
    });
    Ok(job)
}

async fn run_youtube_upload(
    request: youtube::YouTubePublishRequest,
    source: crate::publish::source::ResolvedExportSource,
    title: String,
    progress: crate::publish::hosted::ProgressSink,
    cancel: crate::publish::jobs::CancelToken,
) -> Result<(String, bool)> {
    // A fresh access token per upload — refresh failures surface as the
    // job's error, never a panic.
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let token = youtube::access_token(&http).await?;
    // Captions attach only on explicit request — the UI checkbox is the
    // source of truth, never the mere existence of a sidecar.
    let captions_path = if request.captions {
        source.captions_path
    } else {
        None
    };
    youtube::publish_video(youtube::YouTubeWorkerInput {
        request,
        video_path: source.path,
        captions_path,
        title,
        progress,
        cancel,
        api_base: "https://www.googleapis.com".to_string(),
        access_token: token,
    })
    .await
}

/// Minimal percent-encoding for the OAuth scope query parameter — avoids a
/// `url`-crate dependency just for one URL.
fn urlencoding(value: &str) -> String {
    value
        .replace(' ', "%20")
        .replace(':', "%3A")
        .replace('/', "%2F")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_query_parsing_decodes_and_matches_state() {
        let req =
            "GET /cb?code=abc%2F123&state=the%20state&x=1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        let (code, state, error) = parse_oauth_query(req);
        assert_eq!(code.as_deref(), Some("abc/123"));
        assert_eq!(state.as_deref(), Some("the state"));
        assert!(error.is_none());
    }

    #[test]
    fn oauth_error_parameter_surfaces() {
        let req = "GET /cb?error=access_denied&state=s HTTP/1.1\r\n\r\n";
        let (code, _, error) = parse_oauth_query(req);
        assert!(code.is_none());
        assert_eq!(error.as_deref(), Some("access_denied"));
    }

    #[test]
    fn url_decode_handles_plus_and_bad_percents() {
        assert_eq!(url_decode("a+b%20c"), "a b c");
        assert_eq!(url_decode("100%"), "100%");
        assert_eq!(url_decode("%zz"), "%zz");
    }
}
