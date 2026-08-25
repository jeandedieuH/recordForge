//! Storage Tauri Commands

use chrono::Utc;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use tauri::{Emitter, State};
use tracing::instrument;

use crate::database::storage::{self as storage_db, StorageProfile, UploadJob};
use crate::errors::{InternalError, Result};
use crate::state::AppState;
use crate::storage::drive::{
    GoogleDriveClient, GoogleDriveConfig, GOOGLE_DRIVE_AUTH_SCOPE, GOOGLE_DRIVE_CLIENT_ID,
};
use crate::storage::local::{LocalFolderClient, LocalFolderConfig};
use crate::storage::s3::{ConnectionTestResult, S3Client, S3Config};
use crate::storage::vault;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveS3ProfileInput {
    pub id: Option<String>,
    pub name: String,
    pub config: S3Config,
    pub access_key_id: String,
    pub secret_access_key: String,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveGoogleDriveProfileInput {
    pub id: Option<String>,
    pub name: String,
    pub config: GoogleDriveConfig,
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveLocalFolderProfileInput {
    pub id: Option<String>,
    pub name: String,
    pub config: LocalFolderConfig,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartUploadJobInput {
    pub profile_id: String,
    pub recording_id: Option<String>,
    pub export_id: Option<String>,
    pub local_path: String,
    pub custom_destination_name: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthFlowStartResult {
    pub auth_url: String,
    pub state: String,
    pub port: u16,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCompletedEvent {
    pub success: bool,
    pub refresh_token: Option<String>,
    pub account_email: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
#[instrument(skip(state))]
pub fn list_storage_profiles(state: State<'_, AppState>) -> Result<Vec<StorageProfile>> {
    let conn = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("db mutex poisoned".into()))?;
    storage_db::list_storage_profiles(&conn)
}

#[tauri::command]
#[instrument(skip(input, state))]
pub fn save_s3_profile(
    input: SaveS3ProfileInput,
    state: State<'_, AppState>,
) -> Result<StorageProfile> {
    let profile_id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = Utc::now().to_rfc3339();

    // Store sensitive keys strictly in OS Credential Vault
    if !input.access_key_id.trim().is_empty() {
        vault::set_secret(&format!("{}:access_key", profile_id), &input.access_key_id)?;
    }
    if !input.secret_access_key.trim().is_empty() {
        vault::set_secret(
            &format!("{}:secret_key", profile_id),
            &input.secret_access_key,
        )?;
    }

    let profile = StorageProfile {
        id: profile_id,
        name: input.name,
        kind: "s3".to_string(),
        is_default: input.is_default,
        s3_config: Some(input.config),
        drive_config: None,
        local_config: None,
        has_credentials: true,
        created_at: now.clone(),
        updated_at: now,
    };

    let conn = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("db mutex poisoned".into()))?;

    storage_db::upsert_storage_profile(&conn, &profile)?;
    Ok(profile)
}

#[tauri::command]
#[instrument(skip(input, state))]
pub fn save_google_drive_profile(
    input: SaveGoogleDriveProfileInput,
    state: State<'_, AppState>,
) -> Result<StorageProfile> {
    let profile_id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = Utc::now().to_rfc3339();

    if let Some(token) = &input.refresh_token {
        if !token.trim().is_empty() {
            vault::set_secret(&format!("{}:refresh_token", profile_id), token)?;
        }
    }

    let has_token = vault::get_secret(&format!("{}:refresh_token", profile_id))
        .ok()
        .flatten()
        .is_some();

    let profile = StorageProfile {
        id: profile_id,
        name: input.name,
        kind: "gdrive".to_string(),
        is_default: input.is_default,
        s3_config: None,
        drive_config: Some(input.config),
        local_config: None,
        has_credentials: has_token,
        created_at: now.clone(),
        updated_at: now,
    };

    let conn = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("db mutex poisoned".into()))?;

    storage_db::upsert_storage_profile(&conn, &profile)?;
    Ok(profile)
}

#[tauri::command]
#[instrument(skip(input, state))]
pub fn save_local_profile(
    input: SaveLocalFolderProfileInput,
    state: State<'_, AppState>,
) -> Result<StorageProfile> {
    let profile_id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = Utc::now().to_rfc3339();

    let profile = StorageProfile {
        id: profile_id,
        name: input.name,
        kind: "local".to_string(),
        is_default: input.is_default,
        s3_config: None,
        drive_config: None,
        local_config: Some(input.config),
        has_credentials: true,
        created_at: now.clone(),
        updated_at: now,
    };

    let conn = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("db mutex poisoned".into()))?;

    storage_db::upsert_storage_profile(&conn, &profile)?;
    Ok(profile)
}

#[tauri::command]
#[instrument(skip(state))]
pub fn delete_storage_profile(profile_id: String, state: State<'_, AppState>) -> Result<()> {
    let conn = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("db mutex poisoned".into()))?;

    storage_db::delete_storage_profile(&conn, &profile_id)
}

#[tauri::command]
#[instrument(skip(state))]
pub async fn test_storage_profile(
    profile_id: String,
    state: State<'_, AppState>,
) -> Result<ConnectionTestResult> {
    let (profile, access_key, secret_key, refresh_token) = {
        let conn = state
            .db
            .lock()
            .map_err(|_| InternalError::Storage("db mutex poisoned".into()))?;
        let p = storage_db::get_profile_by_id(&conn, &profile_id)?
            .ok_or_else(|| InternalError::Storage(format!("profile {} not found", profile_id)))?;
        let ak = vault::get_secret(&format!("{}:access_key", profile_id))
            .ok()
            .flatten();
        let sk = vault::get_secret(&format!("{}:secret_key", profile_id))
            .ok()
            .flatten();
        let rt = vault::get_secret(&format!("{}:refresh_token", profile_id))
            .ok()
            .flatten();
        (p, ak, sk, rt)
    };

    match profile.kind.as_str() {
        "s3" => {
            let s3_config = profile.s3_config.ok_or_else(|| {
                InternalError::Storage("S3 configuration missing for profile".into())
            })?;
            let ak =
                access_key.ok_or_else(|| InternalError::Storage("Access key missing".into()))?;
            let sk =
                secret_key.ok_or_else(|| InternalError::Storage("Secret key missing".into()))?;
            let client = S3Client::new(s3_config, ak, sk);
            client.test_connection().await
        }
        "gdrive" => {
            let drive_config = profile.drive_config.ok_or_else(|| {
                InternalError::Storage("Google Drive configuration missing".into())
            })?;
            let rt = refresh_token.ok_or_else(|| {
                InternalError::Storage("Google Drive is not authenticated".into())
            })?;
            let client = GoogleDriveClient::new(drive_config, rt);
            client.test_connection().await
        }
        "local" => {
            let local_config = profile.local_config.ok_or_else(|| {
                InternalError::Storage("Local folder configuration missing".into())
            })?;
            let client = LocalFolderClient::new(local_config);
            client.test_connection()
        }
        other => Err(InternalError::Storage(format!("unknown provider: {other}")).into()),
    }
}

#[tauri::command]
#[instrument(skip(access_key, secret_key))]
pub async fn test_s3_credentials(
    config: S3Config,
    access_key: String,
    secret_key: String,
) -> Result<ConnectionTestResult> {
    let client = S3Client::new(config, access_key, secret_key);
    client.test_connection().await
}

#[tauri::command]
#[instrument(skip(app))]
pub async fn start_google_drive_oauth(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<OAuthFlowStartResult> {
    let _update_operation = state.update_gate.acquire_operation()?;
    // Generate PKCE code verifier and challenge
    let verifier = uuid::Uuid::new_v4().to_string() + &uuid::Uuid::new_v4().to_string();
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        hasher.finalize(),
    );

    let state_str = uuid::Uuid::new_v4().to_string();

    // Bind to ephemeral port
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| InternalError::Storage(format!("failed to bind loopback TCP server: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| InternalError::Storage(format!("failed to get local addr: {e}")))?
        .port();

    let redirect_uri = format!("http://127.0.0.1:{}", port);
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        GOOGLE_DRIVE_CLIENT_ID, redirect_uri, GOOGLE_DRIVE_AUTH_SCOPE, challenge, state_str
    );

    let app_clone = app.clone();
    let state_clone = state_str.clone();
    let verifier_clone = verifier.clone();

    // Spawn loopback listener in background thread
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buffer = [0u8; 4096];
            let n = stream.read(&mut buffer).unwrap_or(0);
            let req_str = String::from_utf8_lossy(&buffer[..n]);

            // Parse GET /?code=...&state=...
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

            let response_body = if code.is_some() && recv_state.as_deref() == Some(&state_clone) {
                "<!DOCTYPE html><html><head><title>recordForge Authentication</title></head><body style=\"font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:#f8fafc;\"><h2 style=\"color:#22c55e;\">&#10004; Google Drive Connected!</h2><p>You can close this tab and return to recordForge.</p><script>setTimeout(() => window.close(), 1500)</script></body></html>"
            } else {
                "<!DOCTYPE html><html><head><title>recordForge Authentication</title></head><body style=\"font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:#f8fafc;\"><h2 style=\"color:#ef4444;\">&#10008; Authentication Failed</h2><p>Invalid state or missing authorization code.</p></body></html>"
            };

            let http_response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            let _ = stream.write_all(http_response.as_bytes());
            let _ = stream.flush();

            if let Some(auth_code) = code {
                if recv_state.as_deref() == Some(&state_clone) {
                    tauri::async_runtime::spawn(async move {
                        let http = reqwest::Client::new();
                        let params = [
                            ("client_id", GOOGLE_DRIVE_CLIENT_ID),
                            ("code", &auth_code),
                            ("code_verifier", &verifier_clone),
                            ("grant_type", "authorization_code"),
                            ("redirect_uri", &format!("http://127.0.0.1:{}", port)),
                        ];

                        let res = http
                            .post("https://oauth2.googleapis.com/token")
                            .form(&params)
                            .send()
                            .await;

                        match res {
                            Ok(resp) if resp.status().is_success() => {
                                if let Ok(token_resp) =
                                    resp.json::<crate::storage::drive::TokenResponse>().await
                                {
                                    // Fetch user email
                                    let mut email = None;
                                    if let Ok(about_res) = http
                                        .get(
                                            "https://www.googleapis.com/drive/v3/about?fields=user",
                                        )
                                        .bearer_auth(&token_resp.access_token)
                                        .send()
                                        .await
                                    {
                                        if let Ok(about) = about_res
                                            .json::<crate::storage::drive::DriveAboutResponse>()
                                            .await
                                        {
                                            email = about.user.and_then(|u| u.email_address);
                                        }
                                    }

                                    let _ = app_clone.emit(
                                        "google-drive-oauth-completed",
                                        OAuthCompletedEvent {
                                            success: true,
                                            refresh_token: token_resp.refresh_token,
                                            account_email: email,
                                            error: None,
                                        },
                                    );
                                }
                            }
                            Ok(resp) => {
                                let err = resp.text().await.unwrap_or_default();
                                let _ = app_clone.emit(
                                    "google-drive-oauth-completed",
                                    OAuthCompletedEvent {
                                        success: false,
                                        refresh_token: None,
                                        account_email: None,
                                        error: Some(err),
                                    },
                                );
                            }
                            Err(e) => {
                                let _ = app_clone.emit(
                                    "google-drive-oauth-completed",
                                    OAuthCompletedEvent {
                                        success: false,
                                        refresh_token: None,
                                        account_email: None,
                                        error: Some(e.to_string()),
                                    },
                                );
                            }
                        }
                    });
                }
            }
        }
    });

    Ok(OAuthFlowStartResult {
        auth_url,
        state: state_str,
        port,
    })
}

#[tauri::command]
#[instrument(skip(input, state))]
pub fn start_upload_job(
    input: StartUploadJobInput,
    state: State<'_, AppState>,
) -> Result<UploadJob> {
    let _update_operation = state.update_gate.acquire_operation()?;
    state.storage_manager.start_upload(
        &input.profile_id,
        input.recording_id,
        input.export_id,
        &input.local_path,
        input.custom_destination_name,
    )
}

#[tauri::command]
#[instrument(skip(state))]
pub fn cancel_upload_job(job_id: String, state: State<'_, AppState>) -> Result<()> {
    state.storage_manager.cancel_upload(&job_id)
}

#[tauri::command]
#[instrument(skip(state))]
pub fn retry_upload_job(job_id: String, state: State<'_, AppState>) -> Result<UploadJob> {
    let _update_operation = state.update_gate.acquire_operation()?;
    state.storage_manager.retry_upload(&job_id)
}

#[tauri::command]
#[instrument(skip(state))]
pub fn list_upload_jobs(state: State<'_, AppState>) -> Result<Vec<UploadJob>> {
    let conn = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("db mutex poisoned".into()))?;
    storage_db::list_upload_jobs(&conn)
}

#[tauri::command]
#[instrument(skip(state))]
pub fn delete_upload_job(job_id: String, state: State<'_, AppState>) -> Result<()> {
    let conn = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("db mutex poisoned".into()))?;
    storage_db::delete_upload_job(&conn, &job_id)
}
