use crate::errors::{InternalError, Result};
use std::path::{Path, PathBuf};

/// Strip Windows extended-length verbatim prefixes (`\\?\` and `\\?\UNC\`).
pub fn normalize_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let path_str = path.to_string_lossy();
        if let Some(stripped) = path_str.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{stripped}"));
        }
        if let Some(stripped) = path_str.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    path.to_path_buf()
}

/// Canonicalize a path while removing any Windows verbatim prefix.
pub fn canonicalize_path(path: &Path) -> std::io::Result<PathBuf> {
    let canonical = path.canonicalize()?;
    Ok(normalize_path(&canonical))
}

/// Path authorization and security policy enforcer for recordForge.
///
/// Ensures all filesystem accesses are contained within allowed directories,
/// resolves symlinks and relative path traversals, validates UUID formats, and
/// guards against unsafe file operations.
#[derive(Debug, Clone)]
pub struct PathPolicy {
    app_data_dir: PathBuf,
    sessions_dir: PathBuf,
}

impl PathPolicy {
    pub fn new(app_data_dir: PathBuf, sessions_dir: PathBuf) -> Self {
        Self {
            app_data_dir,
            sessions_dir,
        }
    }

    pub fn app_data_dir(&self) -> &Path {
        &self.app_data_dir
    }

    pub fn sessions_dir(&self) -> &Path {
        &self.sessions_dir
    }

    /// Validate that a `session_id` is a valid UUID and resolve its contained directory.
    pub fn validate_session_dir(&self, session_id: &str) -> Result<PathBuf> {
        // 1. Validate UUID format
        if uuid::Uuid::parse_str(session_id).is_err() {
            return Err(InternalError::Permissions(format!(
                "invalid session ID format: {session_id}"
            ))
            .into());
        }

        // 2. Construct path
        let target = self.sessions_dir.join(session_id);

        // 3. Canonicalize if directory exists, or canonicalize parent
        let canonical = if target.exists() {
            canonicalize_path(&target).map_err(|e| {
                InternalError::Storage(format!("failed to canonicalize session dir: {e}"))
            })?
        } else {
            let parent_canonical = canonicalize_path(&self.sessions_dir).map_err(|e| {
                InternalError::Storage(format!("failed to canonicalize sessions root: {e}"))
            })?;
            parent_canonical.join(session_id)
        };

        // 4. Verify containment
        let sessions_canonical = canonicalize_path(&self.sessions_dir).map_err(|e| {
            InternalError::Storage(format!("failed to canonicalize sessions root: {e}"))
        })?;

        if !canonical.starts_with(&sessions_canonical) {
            return Err(InternalError::Permissions(format!(
                "path traversal blocked: {session_id}"
            ))
            .into());
        }

        Ok(canonical)
    }

    /// Validate a target path for export destination.
    pub fn validate_export_destination(&self, path: &Path) -> Result<PathBuf> {
        let parent = path.parent().ok_or_else(|| {
            InternalError::Permissions("export path has no parent directory".into())
        })?;

        if !parent.exists() {
            return Err(InternalError::Storage(format!(
                "export target parent directory does not exist: {}",
                parent.display()
            ))
            .into());
        }

        let parent_canonical = canonicalize_path(parent).map_err(|e| {
            InternalError::Storage(format!("failed to canonicalize export destination: {e}"))
        })?;

        let filename = path
            .file_name()
            .ok_or_else(|| InternalError::Permissions("export path has no filename".into()))?;

        let canonical = parent_canonical.join(filename);
        if std::fs::symlink_metadata(path).is_ok() {
            let existing = canonicalize_path(path).map_err(|error| {
                InternalError::Storage(format!(
                    "failed to canonicalize existing export destination: {error}"
                ))
            })?;
            if existing != canonical {
                return Err(InternalError::Permissions(
                    "export destination symlinks are not supported".into(),
                )
                .into());
            }
        }

        // Block writing to system directories on Windows
        #[cfg(windows)]
        {
            let canonical_str = canonical.to_string_lossy().to_lowercase();
            let blocked_prefixes = [
                r"c:\windows",
                r"c:\program files",
                r"c:\program files (x86)",
                r"c:\system32",
            ];
            for prefix in &blocked_prefixes {
                if canonical_str.starts_with(prefix) {
                    return Err(InternalError::Permissions(format!(
                        "export to system directory blocked: {}",
                        canonical.display()
                    ))
                    .into());
                }
            }
        }

        Ok(canonical)
    }

    /// Validate that a recorded media file is within the app data directory and
    /// exists on disk. Used before revealing a recording in Explorer or reading
    /// it for media jobs.
    pub fn validate_recording_path(&self, path: &Path) -> Result<PathBuf> {
        if !path.exists() {
            return Err(InternalError::Storage(format!(
                "recording path does not exist: {}",
                path.display()
            ))
            .into());
        }

        let canonical = canonicalize_path(path).map_err(|e| {
            InternalError::Storage(format!("failed to canonicalize recording path: {e}"))
        })?;

        let app_data_canonical = canonicalize_path(&self.app_data_dir).map_err(|e| {
            InternalError::Storage(format!("failed to canonicalize app data dir: {e}"))
        })?;

        if !canonical.starts_with(&app_data_canonical) {
            return Err(InternalError::Permissions(format!(
                "recording path outside app data directory: {}",
                canonical.display()
            ))
            .into());
        }

        Ok(canonical)
    }

    /// Check whether `candidate` is contained within `base` using path components.
    pub fn is_contained(&self, base: &Path, candidate: &Path) -> bool {
        candidate.starts_with(base)
    }

    /// Validate a source selected through the desktop file dialog. The dialog
    /// is not an authorization boundary, so the Rust side still canonicalizes
    /// the file and rejects system locations before probing or copying it.
    pub fn validate_import_source_path(&self, path: &Path) -> Result<PathBuf> {
        self.validate_external_asset_path(path)
    }

    /// Validate a referenced asset that may remain outside the project folder.
    /// Reference imports are intentionally limited to regular files outside
    /// protected operating-system directories.
    pub fn validate_external_asset_path(&self, path: &Path) -> Result<PathBuf> {
        if !path.is_file() {
            return Err(InternalError::Storage(format!(
                "asset source is not a file: {}",
                path.display()
            ))
            .into());
        }

        let canonical = canonicalize_path(path)
            .map_err(|e| InternalError::Storage(format!("canonicalize asset source: {e}")))?;
        self.reject_protected_path(&canonical)?;
        Ok(canonical)
    }

    fn reject_protected_path(&self, path: &Path) -> Result<()> {
        #[cfg(windows)]
        {
            let normalized = path.to_string_lossy().replace('/', "\\").to_lowercase();
            let windows_dir = std::env::var("WINDIR")
                .unwrap_or_else(|_| String::from(r"C:\Windows"))
                .replace('/', "\\")
                .to_lowercase();
            let protected_prefixes = [
                windows_dir,
                String::from(r"c:\program files"),
                String::from(r"c:\program files (x86)"),
                String::from(r"c:\programdata"),
            ];
            if protected_prefixes.iter().any(|prefix| {
                normalized == *prefix || normalized.starts_with(&format!("{prefix}\\"))
            }) {
                return Err(InternalError::Permissions(format!(
                    "asset source is in a protected system directory: {}",
                    path.display()
                ))
                .into());
            }
        }
        Ok(())
    }

    /// Validate a new asset path for a project. The path may be absolute or
    /// relative to the project directory, but it must resolve to a file inside
    /// the project directory and it must exist.
    pub fn validate_project_asset_path(&self, project_dir: &Path, path: &Path) -> Result<PathBuf> {
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            project_dir.join(path)
        };

        if !absolute.exists() {
            return Err(InternalError::Storage(format!(
                "asset path does not exist: {}",
                absolute.display()
            ))
            .into());
        }

        let canonical = canonicalize_path(&absolute)
            .map_err(|e| InternalError::Storage(format!("canonicalize asset path: {e}")))?;

        let project_canonical = canonicalize_path(project_dir)
            .map_err(|e| InternalError::Storage(format!("canonicalize project dir: {e}")))?;

        if !canonical.starts_with(&project_canonical) {
            return Err(InternalError::Permissions(format!(
                "asset path outside project directory: {}",
                canonical.display()
            ))
            .into());
        }

        Ok(canonical)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_policy() -> (tempfile::TempDir, PathPolicy) {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("app_data");
        let sessions = app_data.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let policy = PathPolicy::new(app_data, sessions);
        (temp, policy)
    }

    #[test]
    fn test_valid_uuid_session_dir() {
        let (_temp, policy) = setup_policy();
        let uuid_str = uuid::Uuid::new_v4().to_string();
        let session_dir = policy.sessions_dir().join(&uuid_str);
        std::fs::create_dir_all(&session_dir).unwrap();

        let result = policy.validate_session_dir(&uuid_str);
        assert!(result.is_ok());
    }

    #[test]
    fn test_invalid_uuid_rejected() {
        let (_temp, policy) = setup_policy();
        let result = policy.validate_session_dir("../relative_path");
        assert!(result.is_err());
    }

    #[test]
    fn test_traversal_uuid_rejected() {
        let (_temp, policy) = setup_policy();
        let result = policy.validate_session_dir("../../system32");
        assert!(result.is_err());
    }

    #[test]
    fn rejects_project_asset_outside_project_directory() {
        let (temp, policy) = setup_policy();
        let project_dir = temp.path().join("project");
        let outside_file = temp.path().join("outside.mp4");
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(&outside_file, b"fixture").unwrap();

        let result = policy.validate_project_asset_path(&project_dir, &outside_file);
        assert!(result.is_err());
    }

    #[test]
    fn accepts_a_regular_external_import_source() {
        let (temp, policy) = setup_policy();
        let source = temp.path().join("Downloads").join("voice.wav");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, b"fixture").unwrap();

        let result = policy.validate_import_source_path(&source).unwrap();
        assert_eq!(result, canonicalize_path(&source).unwrap());
    }
}
