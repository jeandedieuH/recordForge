//! Tauri commands for external publishing (YouTube).

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use tauri::{Emitter, State};

use crate::commands::storage::OAuthFlowStartResult;
use crate::errors::{AppError, InternalError, Result};
use crate::publish::youtube;
use crate::state::AppState;
use crate::storage::drive::{get_google_drive_client_id, get_google_drive_client_secret};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct YouTubeOAuthCompletedEvent {
    success: bool,
    account_label: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeConnectionInfo {
    pub connected: bool,
    pub account_label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubePublishResult {
    pub video_id: String,
    pub url: String,
    pub captions_attached: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct YouTubePublishProgress {
    stage: &'static str,
    uploaded_bytes: u64,
    total_bytes: u64,
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

    let verifier = uuid::Uuid::new_v4().to_string() + &uuid::Uuid::new_v4().to_string();
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        hasher.finalize(),
    );
    let state_str = uuid::Uuid::new_v4().to_string();

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| InternalError::Storage(format!("failed to bind loopback TCP server: {e}")))?;
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
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buffer = [0u8; 4096];
            let n = stream.read(&mut buffer).unwrap_or(0);
            let req_str = String::from_utf8_lossy(&buffer[..n]);

            let mut code = None;
            let mut recv_state = None;
            if let Some(first_line) = req_str.lines().next() {
                if let Some(path) = first_line.split_whitespace().nth(1) {
                    if let Some(query) = path.split('?').nth(1) {
                        for pair in query.split('&') {
                            let mut parts = pair.split('=');
                            if let (Some(k), Some(v)) = (parts.next(), parts.next()) {
                                if k == "code" {
                                    code = Some(v.to_string());
                                } else if k == "state" {
                                    recv_state = Some(v.to_string());
                                }
                            }
                        }
                    }
                }
            }

            let outcome = match code.filter(|_| recv_state.as_deref() == Some(&state_clone)) {
                Some(auth_code) => tauri::async_runtime::block_on(async {
                    let http = reqwest::Client::builder()
                        .timeout(std::time::Duration::from_secs(30))
                        .build()
                        .unwrap_or_else(|_| reqwest::Client::new());
                    let client_id = get_google_drive_client_id();
                    let client_secret = get_google_drive_client_secret();
                    let redirect_uri = format!("http://127.0.0.1:{}", port);
                    let mut params = vec![
                        ("client_id", client_id.as_str()),
                        ("code", auth_code.as_str()),
                        ("code_verifier", verifier_clone.as_str()),
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
                                    if let Some(refresh) = token_resp.refresh_token.as_deref() {
                                        youtube::store_refresh_token(refresh)
                                            .map_err(|e| e.to_string())?;
                                    }
                                    Ok(())
                                }
                                Err(e) => Err(format!("failed to parse token response: {e}")),
                            }
                        }
                        Ok(resp) => Err(resp.text().await.unwrap_or_default()),
                        Err(e) => Err(e.to_string()),
                    }
                }),
                None => Err("Invalid state or missing authorization code.".to_string()),
            };

            // Channel title is best-effort — the card falls back to "YouTube".
            let account_label = if outcome.is_ok() {
                tauri::async_runtime::block_on(async {
                    youtube::connection_label().await.ok().flatten()
                })
            } else {
                None
            };

            let (response_body, event) = match outcome {
                Ok(()) => (
                    "<!DOCTYPE html><html><head><title>RecordForge Authentication</title></head><body style=\"font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:#f8fafc;\"><h2 style=\"color:#22c55e;\">&#10004; YouTube Connected!</h2><p>You can close this tab and return to RecordForge.</p><script>setTimeout(() => window.close(), 1500)</script></body></html>",
                    YouTubeOAuthCompletedEvent {
                        success: true,
                        account_label,
                        error: None,
                    },
                ),
                Err(err) => (
                    "<!DOCTYPE html><html><head><title>RecordForge Authentication</title></head><body style=\"font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:#f8fafc;\"><h2 style=\"color:#ef4444;\">&#10008; Authentication Failed</h2><p>Return to RecordForge for details.</p></body></html>",
                    YouTubeOAuthCompletedEvent {
                        success: false,
                        account_label: None,
                        error: Some(err),
                    },
                ),
            };

            let http_response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            let _ = stream.write_all(http_response.as_bytes());
            let _ = stream.flush();

            let _ = app_clone.emit("youtube-oauth-completed", event);
        }
    });

    Ok(OAuthFlowStartResult {
        auth_url,
        state: state_str,
        port,
    })
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

#[tauri::command]
pub async fn publish_to_youtube(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: youtube::YouTubePublishRequest,
) -> Result<YouTubePublishResult> {
    let _update_operation = state.update_gate.acquire_operation()?;
    if !state.license.entitlements().pro_enabled {
        return Err(licensing_error(
            "pro_feature_required",
            "Publishing to YouTube is a RecordForge Pro feature",
        ));
    }

    let app_data_dir = state.path_policy.app_data_dir().to_path_buf();
    let app_clone = app.clone();
    let emit = |stage: &'static str, uploaded: u64, total: u64| {
        let _ = app_clone.emit(
            "youtube-publish-progress",
            YouTubePublishProgress {
                stage,
                uploaded_bytes: uploaded,
                total_bytes: total,
            },
        );
    };

    let (video_id, captions_attached) =
        youtube::publish_video(&app_data_dir, &request, |uploaded, total| {
            emit("uploading", uploaded, total)
        })
        .await
        .inspect_err(|_| {
            emit("failed", 0, 0);
        })?;

    if request.captions_path.is_some() {
        emit("attaching-captions", 0, 0);
    }
    emit("done", 0, 0);
    Ok(YouTubePublishResult {
        url: format!("https://www.youtube.com/watch?v={video_id}"),
        video_id,
        captions_attached,
    })
}

#[tauri::command]
pub async fn cancel_youtube_publish() -> Result<()> {
    youtube::cancel_publish();
    Ok(())
}

/// Minimal percent-encoding for the OAuth scope query parameter — avoids a
/// `url`-crate dependency just for one URL.
fn urlencoding(value: &str) -> String {
    value
        .replace(' ', "%20")
        .replace(':', "%3A")
        .replace('/', "%2F")
}
