//! Tauri commands for external publishing (YouTube).
//!
//! The OAuth flow is loopback+PKCE via `publish::loopback` — the refresh
//! token lands directly in the OS credential vault and never crosses into
//! the frontend. Manual publishes run on the command path; export-job
//! auto-publish deliveries call `youtube::publish_video` directly.

use serde::Serialize;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{Emitter, State};

use crate::commands::storage::OAuthFlowStartResult;
use crate::errors::{AppError, Result};
use crate::publish::loopback;
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

const OAUTH_SUCCESS_HTML: &str = "<!DOCTYPE html><html><head><title>RecordForge Authentication</title></head><body style=\"font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:#f8fafc;\"><h2 style=\"color:#22c55e;\">&#10004; YouTube Connected!</h2><p>You can close this tab and return to RecordForge.</p><script>setTimeout(() => window.close(), 1500)</script></body></html>";
const OAUTH_FAILURE_HTML: &str = "<!DOCTYPE html><html><head><title>RecordForge Authentication</title></head><body style=\"font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:#f8fafc;\"><h2 style=\"color:#ef4444;\">&#10008; Authentication Failed</h2><p>Return to RecordForge for details.</p></body></html>";

/// Exchange an auth code for tokens on Google's token endpoint and stash the
/// refresh token in the vault. Split out so both the happy path and error
/// reporting stay readable in the listener thread.
fn exchange_auth_code(
    verifier: String,
    port: u16,
    auth_code: String,
) -> std::result::Result<(), String> {
    tauri::async_runtime::block_on(async move {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let client_id = get_google_drive_client_id();
        let client_secret = get_google_drive_client_secret();
        let redirect_uri = format!("http://127.0.0.1:{port}");
        let mut params = vec![
            ("client_id", client_id.as_str()),
            ("code", auth_code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri.as_str()),
        ];
        // A present-but-empty client_secret is rejected by the token
        // endpoint — omit the parameter entirely when unset.
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
                            youtube::store_refresh_token(refresh).map_err(|e| e.to_string())?;
                        }
                        Ok(())
                    }
                    Err(e) => Err(format!("failed to parse token response: {e}")),
                }
            }
            Ok(resp) => Err(resp.text().await.unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        }
    })
}

/// Loopback+PKCE OAuth for the YouTube connection. Single-flight via
/// `try_begin_oauth`; the listener thread exits on callback or deadline so
/// abandoned sign-ins don't leak a parked thread.
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
    let _oauth_guard = loopback::try_begin_oauth()?;
    let flow = loopback::begin_loopback_flow()?;

    let redirect_uri = format!("http://127.0.0.1:{}", flow.port);
    let client_id = get_google_drive_client_id();
    let scope = urlencoding(youtube::YOUTUBE_OAUTH_SCOPE);
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        client_id, redirect_uri, scope, flow.challenge, flow.state
    );

    let app_clone = app.clone();
    let loopback::LoopbackFlow {
        listener,
        port,
        state: state_str,
        verifier,
        ..
    } = flow;
    let result = OAuthFlowStartResult {
        auth_url,
        state: state_str.clone(),
        port,
    };

    std::thread::spawn(move || {
        // The guard lives for the listener's whole life so a second Connect
        // click can't race this flow's port.
        let _guard = _oauth_guard;
        let event =
            match loopback::accept_callback(&listener, &state_str, loopback::CALLBACK_TIMEOUT) {
                Ok(loopback::Callback::Code { code, mut stream }) => {
                    let outcome = exchange_auth_code(verifier, port, code);
                    let account_label = if outcome.is_ok() {
                        tauri::async_runtime::block_on(async {
                            youtube::connection_label().await.ok().flatten()
                        })
                    } else {
                        None
                    };
                    match outcome {
                        Ok(()) => {
                            loopback::respond_html(&mut stream, OAUTH_SUCCESS_HTML);
                            YouTubeOAuthCompletedEvent {
                                success: true,
                                account_label,
                                error: None,
                            }
                        }
                        Err(err) => {
                            loopback::respond_html(&mut stream, OAUTH_FAILURE_HTML);
                            YouTubeOAuthCompletedEvent {
                                success: false,
                                account_label: None,
                                error: Some(err),
                            }
                        }
                    }
                }
                Ok(loopback::Callback::Denied { error, mut stream }) => {
                    loopback::respond_html(&mut stream, OAUTH_FAILURE_HTML);
                    YouTubeOAuthCompletedEvent {
                        success: false,
                        account_label: None,
                        error: Some(format!("authorization denied: {error}")),
                    }
                }
                Ok(loopback::Callback::StateMismatch { mut stream }) => {
                    loopback::respond_html(&mut stream, OAUTH_FAILURE_HTML);
                    YouTubeOAuthCompletedEvent {
                        success: false,
                        account_label: None,
                        error: Some("OAuth state mismatch — the sign-in was rejected".to_string()),
                    }
                }
                Ok(loopback::Callback::TimedOut) => YouTubeOAuthCompletedEvent {
                    success: false,
                    account_label: None,
                    error: Some("sign-in timed out — try connecting again".to_string()),
                },
                Err(error) => YouTubeOAuthCompletedEvent {
                    success: false,
                    account_label: None,
                    error: Some(error.message),
                },
            };
        let _ = app_clone.emit("youtube-oauth-completed", event);
    });

    Ok(result)
}

#[tauri::command]
pub async fn youtube_connection_status() -> Result<YouTubeConnectionInfo> {
    match youtube::check_connection().await? {
        youtube::ConnectionState::Connected(account_label) => Ok(YouTubeConnectionInfo {
            connected: true,
            account_label,
        }),
        youtube::ConnectionState::Disconnected => Ok(YouTubeConnectionInfo {
            connected: false,
            account_label: None,
        }),
    }
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

    let (video_id, captions_attached) = youtube::publish_video(
        &app_data_dir,
        &request,
        Arc::new(AtomicBool::new(false)),
        move |event: youtube::PublishProgress| {
            let stage = match event.stage {
                youtube::PublishStage::Uploading => "uploading",
                youtube::PublishStage::AttachingCaptions => "attaching-captions",
            };
            emit(stage, event.uploaded_bytes, event.total_bytes)
        },
    )
    .await
    .inspect_err(|_| {
        emit("failed", 0, 0);
    })?;

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
