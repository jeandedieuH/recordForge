//! Google Drive Cloud Storage Engine
//!
//! Provides OAuth 2.0 PKCE authentication and resumable chunked video uploads
//! to Google Drive with folder organization and progress tracking.

use reqwest::Client;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tracing::info;

use crate::errors::{InternalError, Result};
use crate::storage::s3::ConnectionTestResult;

// Public client credentials for desktop app authorization (installed application)
pub const GOOGLE_DRIVE_CLIENT_ID: &str =
    "254207736726-t74i43783vr9gu3vava8uog2n9i9d15k.apps.googleusercontent.com";
pub const GOOGLE_DRIVE_AUTH_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";

/// Resolves Google Drive OAuth client ID from env, .env file, or fallback constant
pub fn get_google_drive_client_id() -> String {
    std::env::var("RECORD_FORGE_GOOGLE_DRIVE_CLIENT_ID")
        .or_else(|_| std::env::var("GOOGLE_DRIVE_CLIENT_ID"))
        .or_else(|_| read_env_var_from_file("RECORD_FORGE_GOOGLE_DRIVE_CLIENT_ID"))
        .or_else(|_| read_env_var_from_file("GOOGLE_DRIVE_CLIENT_ID"))
        .unwrap_or_else(|_| GOOGLE_DRIVE_CLIENT_ID.to_string())
}

/// Resolves Google Drive OAuth client secret from env, .env file, or a value
/// embedded at compile time.
///
/// Google's token endpoint requires `client_secret` for OAuth clients that have
/// one — including "Desktop app" clients (verified against the live endpoint) —
/// so release builds bake it in via RECORD_FORGE_GOOGLE_DRIVE_CLIENT_SECRET.
/// This is an app credential, not a user credential: installed apps cannot keep
/// secrets and Google treats this value as non-confidential.
pub fn get_google_drive_client_secret() -> String {
    std::env::var("RECORD_FORGE_GOOGLE_DRIVE_CLIENT_SECRET")
        .or_else(|_| std::env::var("GOOGLE_DRIVE_CLIENT_SECRET"))
        .or_else(|_| read_env_var_from_file("RECORD_FORGE_GOOGLE_DRIVE_CLIENT_SECRET"))
        .or_else(|_| read_env_var_from_file("GOOGLE_DRIVE_CLIENT_SECRET"))
        .unwrap_or_else(|_| {
            option_env!("RECORD_FORGE_GOOGLE_DRIVE_CLIENT_SECRET")
                .unwrap_or_default()
                .to_string()
        })
}

/// Helper to read a variable from local untracked `.env` files if not set in process env
fn read_env_var_from_file(key: &str) -> std::result::Result<String, ()> {
    let candidate_paths = [
        std::path::PathBuf::from(".env"),
        std::path::PathBuf::from("../.env"),
        std::path::PathBuf::from("../../.env"),
        std::path::PathBuf::from("apps/desktop/.env"),
    ];

    for path in &candidate_paths {
        if let Ok(contents) = std::fs::read_to_string(path) {
            for line in contents.lines() {
                let line = line.trim();
                if line.starts_with('#') || line.is_empty() {
                    continue;
                }
                if let Some((k, v)) = line.split_once('=') {
                    if k.trim() == key {
                        let mut val = v.trim();
                        if (val.starts_with('"') && val.ends_with('"'))
                            || (val.starts_with('\'') && val.ends_with('\''))
                        {
                            val = &val[1..val.len() - 1];
                        }
                        if !val.is_empty() {
                            return Ok(val.to_string());
                        }
                    }
                }
            }
        }
    }
    Err(())
}

/// Drive MIME type for folders — used both in files.get checks and in
/// find-or-create queries.
const DRIVE_FOLDER_MIME: &str = "application/vnd.google-apps.folder";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleDriveConfig {
    #[serde(default = "default_root_folder")]
    pub folder_id: String,
    #[serde(default = "default_folder_name")]
    pub folder_name: String,
    #[serde(default)]
    pub account_email: Option<String>,
    #[serde(default = "default_drive_chunk_size")]
    pub chunk_size_bytes: usize,
}

#[derive(Debug, serde::Deserialize)]
struct DriveFileMeta {
    id: String,
    #[serde(rename = "mimeType")]
    mime_type: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct DriveFileList {
    files: Option<Vec<DriveFileMeta>>,
}

/// Escape a value for use inside a single-quoted Drive `q` clause.
fn escape_drive_query_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

fn default_root_folder() -> String {
    "root".to_string()
}

fn default_folder_name() -> String {
    "recordForge".to_string()
}

fn default_drive_chunk_size() -> usize {
    5 * 1024 * 1024 // 5 MB
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
    pub token_type: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DriveUser {
    #[serde(rename = "emailAddress")]
    pub email_address: Option<String>,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DriveAboutResponse {
    pub user: Option<DriveUser>,
}

pub struct GoogleDriveClient {
    config: GoogleDriveConfig,
    refresh_token: String,
    http: Client,
}

impl GoogleDriveClient {
    pub fn new(config: GoogleDriveConfig, refresh_token: String) -> Self {
        let http = Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .unwrap_or_else(|_| Client::new());

        Self {
            config,
            refresh_token,
            http,
        }
    }

    /// Refresh access token using the stored refresh token
    pub async fn get_access_token(&self) -> Result<String> {
        if self.refresh_token.trim().is_empty() {
            return Err(
                InternalError::Storage("Google Drive refresh token is missing".into()).into(),
            );
        }

        let client_id = get_google_drive_client_id();
        let client_secret = get_google_drive_client_secret();
        let mut params = vec![
            ("client_id", client_id.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", self.refresh_token.as_str()),
        ];
        // A present-but-empty client_secret is rejected by the token endpoint —
        // omit the parameter entirely when no secret is configured.
        if !client_secret.is_empty() {
            params.push(("client_secret", client_secret.as_str()));
        }

        let resp = self
            .http
            .post("https://oauth2.googleapis.com/token")
            .form(&params)
            .send()
            .await
            .map_err(|e| InternalError::Storage(format!("token refresh request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(InternalError::Storage(format!(
                "failed to refresh Google token ({status}): {text}"
            ))
            .into());
        }

        let token_resp: TokenResponse = resp
            .json()
            .await
            .map_err(|e| InternalError::Storage(format!("failed to parse token response: {e}")))?;

        Ok(token_resp.access_token)
    }

    /// Test connectivity and token validity
    pub async fn test_connection(&self) -> Result<ConnectionTestResult> {
        let start = Instant::now();
        let access_token = match self.get_access_token().await {
            Ok(t) => t,
            Err(e) => {
                return Ok(ConnectionTestResult {
                    ok: false,
                    message: format!("Google Drive auth failed: {}", e),
                    latency_ms: Some(start.elapsed().as_millis() as u64),
                });
            }
        };

        let resp = self
            .http
            .get("https://www.googleapis.com/drive/v3/about?fields=user")
            .bearer_auth(&access_token)
            .send()
            .await;

        let elapsed = start.elapsed().as_millis() as u64;

        match resp {
            Ok(res) => {
                if res.status().is_success() {
                    let about: DriveAboutResponse = res
                        .json()
                        .await
                        .unwrap_or(DriveAboutResponse { user: None });
                    let user_email = about
                        .user
                        .and_then(|u| u.email_address)
                        .unwrap_or_else(|| "Connected User".into());

                    // Resolve (and if needed create) the destination folder
                    // so a bad folder config fails the test instead of the
                    // first real upload.
                    if let Err(e) = self.resolve_upload_parent(&access_token).await {
                        return Ok(ConnectionTestResult {
                            ok: false,
                            message: format!("Google Drive folder check failed: {}", e),
                            latency_ms: Some(elapsed),
                        });
                    }

                    Ok(ConnectionTestResult {
                        ok: true,
                        message: format!("Connected to Google Drive as {}", user_email),
                        latency_ms: Some(elapsed),
                    })
                } else {
                    let status = res.status();
                    let text = res.text().await.unwrap_or_default();
                    Ok(ConnectionTestResult {
                        ok: false,
                        message: format!("Google Drive error ({status}): {text}"),
                        latency_ms: Some(elapsed),
                    })
                }
            }
            Err(e) => Ok(ConnectionTestResult {
                ok: false,
                message: format!("Could not reach Google Drive: {}", e),
                latency_ms: Some(elapsed),
            }),
        }
    }

    /// Resolve the Drive folder uploads should land in.
    ///
    /// Resolution rules:
    /// - `folder_id` empty or "root" → base folder is My Drive root.
    /// - `folder_id` resolving to a real folder → used as the base folder;
    ///   `folder_name` (when set) is found-or-created inside it.
    /// - `folder_id` Drive can't see → treated as a folder *name* and
    ///   found-or-created at root, then used directly as the destination.
    ///   Users frequently paste a folder name into the ID field, and the
    ///   `drive.file` scope also hides folders the app didn't create — in
    ///   both cases a raw `parents` reference would 404 the upload.
    async fn resolve_upload_parent(&self, access_token: &str) -> Result<String> {
        let folder_id = self.config.folder_id.trim();
        let folder_name = self.config.folder_name.trim();

        let base = if folder_id.is_empty() || folder_id.eq_ignore_ascii_case("root") {
            "root".to_string()
        } else {
            match self.get_file_meta(access_token, folder_id).await? {
                Some(meta) => {
                    if meta.mime_type.as_deref() != Some(DRIVE_FOLDER_MIME) {
                        return Err(InternalError::Storage(format!(
                            "configured Google Drive folder ID '{folder_id}' is not a folder"
                        ))
                        .into());
                    }
                    meta.id
                }
                // Not a Drive file ID (or not visible under drive.file
                // scope) — treat the value as the destination folder name.
                None => {
                    return self
                        .find_or_create_folder(access_token, folder_id, "root")
                        .await;
                }
            }
        };

        if folder_name.is_empty() {
            return Ok(base);
        }
        self.find_or_create_folder(access_token, folder_name, &base)
            .await
    }

    /// Fetch a file's metadata; `None` when the file is not found or not
    /// visible under the `drive.file` scope.
    async fn get_file_meta(
        &self,
        access_token: &str,
        file_id: &str,
    ) -> Result<Option<DriveFileMeta>> {
        let resp = self
            .http
            .get(format!(
                "https://www.googleapis.com/drive/v3/files/{file_id}"
            ))
            .query(&[("fields", "id,mimeType")])
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| InternalError::Storage(format!("failed to check Drive folder: {e}")))?;

        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(InternalError::Storage(format!(
                "failed to check Drive folder ({status}): {text}"
            ))
            .into());
        }

        let meta = resp.json().await.map_err(|e| {
            InternalError::Storage(format!("failed to parse Drive file metadata: {e}"))
        })?;
        Ok(Some(meta))
    }

    /// Find a folder by name inside `parent_id`, creating it when missing.
    async fn find_or_create_folder(
        &self,
        access_token: &str,
        name: &str,
        parent_id: &str,
    ) -> Result<String> {
        let query = format!(
            "name = '{}' and mimeType = '{}' and '{}' in parents and trashed = false",
            escape_drive_query_value(name),
            DRIVE_FOLDER_MIME,
            parent_id
        );
        let resp = self
            .http
            .get("https://www.googleapis.com/drive/v3/files")
            .query(&[
                ("q", query.as_str()),
                ("fields", "files(id,name)"),
                ("pageSize", "1"),
            ])
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| InternalError::Storage(format!("failed to search Drive folders: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(InternalError::Storage(format!(
                "Drive folder search failed ({status}): {text}"
            ))
            .into());
        }

        let list: DriveFileList = resp
            .json()
            .await
            .map_err(|e| InternalError::Storage(format!("failed to parse Drive file list: {e}")))?;
        if let Some(file) = list.files.and_then(|f| f.into_iter().next()) {
            return Ok(file.id);
        }

        let body = serde_json::json!({
            "name": name,
            "mimeType": DRIVE_FOLDER_MIME,
            "parents": [parent_id],
        });
        let resp = self
            .http
            .post("https://www.googleapis.com/drive/v3/files")
            .query(&[("fields", "id")])
            .bearer_auth(access_token)
            .json(&body)
            .send()
            .await
            .map_err(|e| InternalError::Storage(format!("failed to create Drive folder: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(InternalError::Storage(format!(
                "failed to create Drive folder '{name}' ({status}): {text}"
            ))
            .into());
        }

        let meta: DriveFileMeta = resp.json().await.map_err(|e| {
            InternalError::Storage(format!("failed to parse Drive folder response: {e}"))
        })?;
        Ok(meta.id)
    }

    /// Perform a resumable chunked upload to Google Drive
    pub async fn upload_file(
        &self,
        local_path: &Path,
        destination_name: &str,
        progress_cb: impl Fn(u64, u64),
        cancel_flag: &AtomicBool,
    ) -> Result<String> {
        let mut file = File::open(local_path).map_err(|e| {
            InternalError::Storage(format!("failed to open file for Google Drive upload: {e}"))
        })?;
        let file_len = file
            .metadata()
            .map_err(|e| InternalError::Storage(format!("failed to get file metadata: {e}")))?
            .len();

        let access_token = self.get_access_token().await?;

        if cancel_flag.load(Ordering::Relaxed) {
            return Err(InternalError::Storage("upload cancelled by user".into()).into());
        }

        // Resolve the destination folder to a real Drive file ID — passing
        // a folder name (or an inaccessible ID) as `parents` fails the
        // resumable session init with a 404.
        let parent_id = self.resolve_upload_parent(&access_token).await?;

        // 1. Initiate Resumable Upload Session
        let metadata = serde_json::json!({
            "name": destination_name,
            "parents": [parent_id],
        });

        let init_resp = self
            .http
            .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable")
            .bearer_auth(&access_token)
            .header("X-Upload-Content-Type", "video/mp4")
            .header("X-Upload-Content-Length", file_len.to_string())
            .header("Content-Type", "application/json; charset=UTF-8")
            .json(&metadata)
            .send()
            .await
            .map_err(|e| {
                InternalError::Storage(format!(
                    "failed to initiate Google Drive resumable session: {e}"
                ))
            })?;

        if !init_resp.status().is_success() {
            let status = init_resp.status();
            let text = init_resp.text().await.unwrap_or_default();
            return Err(InternalError::Storage(format!(
                "resumable upload init failed ({status}): {text}"
            ))
            .into());
        }

        let session_uri = init_resp
            .headers()
            .get("location")
            .and_then(|h| h.to_str().ok())
            .ok_or_else(|| {
                InternalError::Storage(
                    "Google Drive Location header missing in resumable response".into(),
                )
            })?
            .to_string();

        info!(
            file_len,
            "Google Drive upload session created, uploading chunks"
        );

        // 2. Upload Chunks
        let chunk_size = self.config.chunk_size_bytes;
        let mut uploaded_bytes = 0u64;
        let mut chunk_buffer = vec![0u8; chunk_size];
        let mut final_file_id = String::new();

        while uploaded_bytes < file_len {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err(
                    InternalError::Storage("Google Drive upload cancelled by user".into()).into(),
                );
            }

            file.seek(SeekFrom::Start(uploaded_bytes))
                .map_err(|e| InternalError::Storage(format!("seek error: {e}")))?;
            let bytes_read = file
                .read(&mut chunk_buffer)
                .map_err(|e| InternalError::Storage(format!("read error: {e}")))?;

            if bytes_read == 0 {
                break;
            }

            let start_byte = uploaded_bytes;
            let end_byte = uploaded_bytes + bytes_read as u64 - 1;
            let content_range = format!("bytes {}-{}/{}", start_byte, end_byte, file_len);

            let chunk_resp = self
                .http
                .put(&session_uri)
                .bearer_auth(&access_token)
                .header("Content-Range", &content_range)
                .header("Content-Type", "video/mp4")
                .body(chunk_buffer[..bytes_read].to_vec())
                .send()
                .await
                .map_err(|e| InternalError::Storage(format!("chunk upload failed: {e}")))?;

            let status = chunk_resp.status();
            if status.as_u16() == 308 {
                // Resume incomplete, continue next chunk
                uploaded_bytes += bytes_read as u64;
                progress_cb(uploaded_bytes, file_len);
            } else if status.is_success() {
                // Completed!
                progress_cb(file_len, file_len);

                let json: serde_json::Value = chunk_resp.json().await.unwrap_or_default();
                if let Some(id) = json.get("id").and_then(|v| v.as_str()) {
                    final_file_id = id.to_string();
                }
                break;
            } else {
                let text = chunk_resp.text().await.unwrap_or_default();
                return Err(InternalError::Storage(format!(
                    "Google Drive chunk upload error ({status}): {text}"
                ))
                .into());
            }
        }

        let drive_url = if !final_file_id.is_empty() {
            format!("https://drive.google.com/file/d/{}/view", final_file_id)
        } else {
            "https://drive.google.com".to_string()
        };

        info!(url = %drive_url, "Google Drive upload completed successfully");
        Ok(drive_url)
    }
}

#[cfg(test)]
mod tests {
    use super::escape_drive_query_value;

    #[test]
    fn escapes_single_quotes_and_backslashes() {
        assert_eq!(escape_drive_query_value("plain"), "plain");
        assert_eq!(escape_drive_query_value("it's"), "it\\'s");
        assert_eq!(escape_drive_query_value("a\\b"), "a\\\\b");
        assert_eq!(escape_drive_query_value("x\\'y"), "x\\\\\\'y");
    }
}
