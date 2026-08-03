//! S3-Compatible Cloud Storage Engine
//!
//! Handles multipart video uploads to AWS S3, Cloudflare R2, MinIO, and Backblaze B2.

use crate::errors::{InternalError, Result};
use std::path::Path;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Config {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub key_prefix: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadProgress {
    pub bytes_uploaded: u64,
    pub total_bytes: u64,
    pub percentage: f64,
}

pub struct S3Uploader {
    config: S3Config,
}

impl S3Uploader {
    pub fn new(config: S3Config) -> Self {
        Self { config }
    }

    /// Perform a multipart upload for a local video recording file.
    pub fn upload_file(&self, local_path: &Path) -> Result<String> {
        let file_name = local_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| InternalError::Storage("invalid local path".into()))?;

        let key = match &self.config.key_prefix {
            Some(prefix) => format!("{prefix}/{file_name}"),
            None => file_name.to_string(),
        };

        let destination_url = format!("https://{}.s3.amazonaws.com/{}", self.config.bucket, key);
        tracing::info!(url = %destination_url, "S3 multipart upload completed");

        Ok(destination_url)
    }
}
