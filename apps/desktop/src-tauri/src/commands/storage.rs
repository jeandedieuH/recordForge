//! Storage Tauri Commands

use chrono::Utc;
use tauri::{Emitter, State};
use tracing::instrument;

use crate::database::storage::{self as storage_db, StorageProfile, UploadJob};
use crate::errors::{InternalError, Result};
use crate::state::AppState;
use crate::storage::drive::{
    get_google_drive_client_id, get_google_drive_client_secret, GoogleDriveClient,
    GoogleDriveConfig, GOOGLE_DRIVE_AUTH_SCOPE,
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

/// Exchange the Drive auth code for tokens, then fetch the account email —
/// the refresh token travels back to the frontend which stores it in the
/// vault via `create_storage_profile` (the established Drive contract).
fn exchange_drive_auth_code(
    verifier: String,
    port: u16,
    auth_code: String,
) -> std::result::Result<(Option<String>, Option<String>), String> {
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
                        let mut email = None;
                        if let Ok(about_res) = http
                            .get("https://www.googleapis.com/drive/v3/about?fields=user")
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
                        Ok((token_resp.refresh_token, email))
                    }
                    Err(e) => Err(format!("failed to parse token response: {e}")),
                }
            }
            Ok(resp) => Err(resp.text().await.unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        }
    })
}

const DRIVE_OAUTH_SUCCESS_HTML: &str = "<!DOCTYPE html><html><head><title>RecordForge Authentication</title></head><body style=\"font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:#f8fafc;\"><h2 style=\"color:#22c55e;\">&#10004; Google Drive Connected!</h2><p>You can close this tab and return to RecordForge.</p><script>setTimeout(() => window.close(), 1500)</script></body></html>";
const DRIVE_OAUTH_FAILURE_HTML: &str = "<!DOCTYPE html><html><head><title>RecordForge Authentication</title></head><body style=\"font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:#f8fafc;\"><h2 style=\"color:#ef4444;\">&#10008; Authentication Failed</h2><p>Return to RecordForge for details.</p></body></html>";

#[tauri::command]
#[instrument(skip(app))]
pub async fn start_google_drive_oauth(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<OAuthFlowStartResult> {
    let _update_operation = state.update_gate.acquire_operation()?;
    // Shared loopback machinery: single-flight guard, percent-decoded
    // callback params, and a deadline so abandoned sign-ins can't leak a
    // parked listener thread.
    let oauth_guard = crate::publish::loopback::try_begin_oauth()?;
    let flow = crate::publish::loopback::begin_loopback_flow()?;

    let redirect_uri = format!("http://127.0.0.1:{}", flow.port);
    let client_id = get_google_drive_client_id();
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        client_id, redirect_uri, GOOGLE_DRIVE_AUTH_SCOPE, flow.challenge, flow.state
    );

    let app_clone = app.clone();
    let crate::publish::loopback::LoopbackFlow {
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
        // Held for the listener's life so a second Connect click can't race.
        let _guard = oauth_guard;
        let event = match crate::publish::loopback::accept_callback(
            &listener,
            &state_str,
            crate::publish::loopback::CALLBACK_TIMEOUT,
        ) {
            Ok(crate::publish::loopback::Callback::Code { code, mut stream }) => {
                let outcome = exchange_drive_auth_code(verifier, port, code);
                match outcome {
                    Ok((refresh_token, account_email)) => {
                        crate::publish::loopback::respond_html(
                            &mut stream,
                            DRIVE_OAUTH_SUCCESS_HTML,
                        );
                        OAuthCompletedEvent {
                            success: true,
                            refresh_token,
                            account_email,
                            error: None,
                        }
                    }
                    Err(err) => {
                        crate::publish::loopback::respond_html(
                            &mut stream,
                            DRIVE_OAUTH_FAILURE_HTML,
                        );
                        OAuthCompletedEvent {
                            success: false,
                            refresh_token: None,
                            account_email: None,
                            error: Some(err),
                        }
                    }
                }
            }
            Ok(crate::publish::loopback::Callback::Denied { error, mut stream }) => {
                crate::publish::loopback::respond_html(&mut stream, DRIVE_OAUTH_FAILURE_HTML);
                OAuthCompletedEvent {
                    success: false,
                    refresh_token: None,
                    account_email: None,
                    error: Some(format!("authorization denied: {error}")),
                }
            }
            Ok(crate::publish::loopback::Callback::StateMismatch { mut stream }) => {
                crate::publish::loopback::respond_html(&mut stream, DRIVE_OAUTH_FAILURE_HTML);
                OAuthCompletedEvent {
                    success: false,
                    refresh_token: None,
                    account_email: None,
                    error: Some("OAuth state mismatch — the sign-in was rejected".to_string()),
                }
            }
            Ok(crate::publish::loopback::Callback::TimedOut) => OAuthCompletedEvent {
                success: false,
                refresh_token: None,
                account_email: None,
                error: Some("sign-in timed out — try connecting again".to_string()),
            },
            Err(error) => OAuthCompletedEvent {
                success: false,
                refresh_token: None,
                account_email: None,
                error: Some(error.message),
            },
        };
        let _ = app_clone.emit("google-drive-oauth-completed", event);
    });

    Ok(result)
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
