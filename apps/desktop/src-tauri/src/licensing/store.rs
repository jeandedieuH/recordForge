//! License persistence.
//!
//! The signed token is not a secret — it proves entitlement only on this
//! device — so it lives in a small JSON file in the app data dir. The raw
//! license *key* (needed for server deactivate/refresh) goes in the OS
//! credential vault via `storage::vault`, never in files or SQLite.

use std::path::{Path, PathBuf};

use crate::errors::{InternalError, Result};

/// Vault account holding the raw license key.
pub const LICENSE_KEY_ACCOUNT: &str = "pro-license-key";

const LICENSE_FILE: &str = "license.json";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredLicense {
    pub token: String,
    #[serde(default)]
    pub last_verified_at_ms: Option<i64>,
}

pub fn token_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(LICENSE_FILE)
}

/// Read the stored license; corrupt or unreadable files degrade to `None`
/// (fail closed → Free) rather than crashing startup.
pub fn load_license(path: &Path) -> Option<StoredLicense> {
    let raw = std::fs::read(path).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Persist atomically (write-then-rename) so a crash mid-write can't leave a
/// half-written token that would silently downgrade the user.
pub fn save_license(path: &Path, license: &StoredLicense) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| InternalError::Storage(format!("create license dir: {error}")))?;
    }
    let tmp = path.with_extension("tmp");
    let bytes = serde_json::to_vec(license)
        .map_err(|error| InternalError::Storage(format!("serialize license: {error}")))?;
    std::fs::write(&tmp, bytes)
        .map_err(|error| InternalError::Storage(format!("write license: {error}")))?;
    std::fs::rename(&tmp, path)
        .map_err(|error| InternalError::Storage(format!("persist license: {error}")))?;
    Ok(())
}

pub fn clear_license(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(InternalError::Storage(format!("remove license: {error}")).into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn license_round_trips_and_clears() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("license.json");
        let stored = StoredLicense {
            token: "a.b".to_string(),
            last_verified_at_ms: Some(42),
        };
        save_license(&path, &stored).expect("save");
        let loaded = load_license(&path).expect("load");
        assert_eq!(loaded.token, "a.b");
        assert_eq!(loaded.last_verified_at_ms, Some(42));
        clear_license(&path).expect("clear");
        assert!(load_license(&path).is_none());
    }

    #[test]
    fn corrupt_license_file_reads_as_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("license.json");
        std::fs::write(&path, b"not json").expect("write");
        assert!(load_license(&path).is_none());
    }
}
