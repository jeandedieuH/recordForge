//! Local Folder Storage Provider
//!
//! Copies or moves exports to user-specified local folders, NAS drives,
//! or external drives with atomic write and progress tracking.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::errors::{InternalError, Result};
use crate::storage::s3::ConnectionTestResult;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFolderConfig {
    pub destination_path: String,
}

pub struct LocalFolderClient {
    config: LocalFolderConfig,
}

impl LocalFolderClient {
    pub fn new(config: LocalFolderConfig) -> Self {
        Self { config }
    }

    pub fn test_connection(&self) -> Result<ConnectionTestResult> {
        let dest = Path::new(&self.config.destination_path);
        if !dest.exists() {
            if let Err(e) = fs::create_dir_all(dest) {
                return Ok(ConnectionTestResult {
                    ok: false,
                    message: format!("Folder does not exist and cannot be created: {e}"),
                    latency_ms: Some(1),
                });
            }
        }

        Ok(ConnectionTestResult {
            ok: true,
            message: format!("Local folder is ready: {}", dest.display()),
            latency_ms: Some(1),
        })
    }

    pub fn upload_file(
        &self,
        local_path: &Path,
        destination_name: &str,
        progress_cb: impl Fn(u64, u64),
        cancel_flag: &AtomicBool,
    ) -> Result<String> {
        let dest_dir = Path::new(&self.config.destination_path);
        fs::create_dir_all(dest_dir)
            .map_err(|e| InternalError::Storage(format!("failed to create destination folder: {e}")))?;

        let final_dest = dest_dir.join(destination_name);
        let partial_dest = dest_dir.join(format!("{}.partial", destination_name));

        let mut src = File::open(local_path)
            .map_err(|e| InternalError::Storage(format!("failed to open source file: {e}")))?;
        let total_bytes = src
            .metadata()
            .map_err(|e| InternalError::Storage(format!("failed to get metadata: {e}")))?
            .len();

        let mut dst = File::create(&partial_dest)
            .map_err(|e| InternalError::Storage(format!("failed to create partial file: {e}")))?;

        let mut buffer = [0u8; 1024 * 1024]; // 1MB chunk
        let mut copied = 0u64;

        while copied < total_bytes {
            if cancel_flag.load(Ordering::Relaxed) {
                drop(dst);
                let _ = fs::remove_file(&partial_dest);
                return Err(InternalError::Storage("copy cancelled by user".into()).into());
            }

            let n = src
                .read(&mut buffer)
                .map_err(|e| InternalError::Storage(format!("read error: {e}")))?;
            if n == 0 {
                break;
            }

            dst.write_all(&buffer[..n])
                .map_err(|e| InternalError::Storage(format!("write error: {e}")))?;
            copied += n as u64;
            progress_cb(copied, total_bytes);
        }

        dst.flush()
            .map_err(|e| InternalError::Storage(format!("flush error: {e}")))?;
        drop(dst);

        fs::rename(&partial_dest, &final_dest)
            .map_err(|e| InternalError::Storage(format!("failed to finalize destination file: {e}")))?;

        Ok(final_dest.to_string_lossy().to_string())
    }
}
