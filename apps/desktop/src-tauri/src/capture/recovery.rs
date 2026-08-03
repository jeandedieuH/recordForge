use std::path::{Path, PathBuf};
use tracing::{info, instrument};

use super::manifest::{RecorderState, RecordingManifest};
use super::media;

/// Result of scanning the sessions directory for recoverable recordings.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryScanResult {
    pub session_id: String,
    pub state: RecorderState,
    pub manifest_path: String,
    pub output_path: Option<String>,
    pub output_size_bytes: u64,
    pub is_recoverable: bool,
    pub validation_error: Option<String>,
}

/// Scan the sessions directory for manifests whose state is not completed.
///
/// This is the core of force-quit recovery: every recording writes a manifest
/// incrementally, so even if FFmpeg is killed, the manifest and any finalized
/// MP4 fragments remain on disk.
#[instrument]
pub fn scan_recovery(sessions_dir: &Path) -> crate::errors::Result<Vec<RecoveryScanResult>> {
    let mut results = Vec::new();

    if !sessions_dir.exists() {
        return Ok(results);
    }

    for entry in std::fs::read_dir(sessions_dir)
        .map_err(|e| crate::errors::InternalError::Storage(format!("read sessions dir: {e}")))?
    {
        let entry = entry.map_err(|e| {
            crate::errors::InternalError::Storage(format!("session dir entry: {e}"))
        })?;

        let dir_name = entry.file_name().to_string_lossy().to_string();
        // Only consider UUID-named session directories. Other names are not part
        // of the recovery surface and may be user-created or malicious.
        if uuid::Uuid::parse_str(&dir_name).is_err() {
            continue;
        }

        let manifest_path = entry.path().join("session.json");
        if !manifest_path.exists() {
            continue;
        }

        let manifest = match RecordingManifest::read(&manifest_path) {
            Ok(m) => m,
            Err(e) => {
                let session_id = entry.file_name().to_string_lossy().to_string();
                results.push(RecoveryScanResult {
                    session_id,
                    state: RecorderState::Failed,
                    manifest_path: manifest_path.to_string_lossy().to_string(),
                    output_path: None,
                    output_size_bytes: 0,
                    is_recoverable: false,
                    validation_error: Some(format!("manifest unreadable: {e}")),
                });
                continue;
            }
        };

        if manifest.state == RecorderState::Completed {
            continue;
        }

        let work_dir = entry.path();
        let (fragment_size, fragment_count, fragment_error) =
            validate_fragments(&work_dir, &manifest);
        let total_size = fragment_size;

        let output = work_dir.join("output.mp4");
        let (output_path, output_size, validation_error) =
            if output.exists() && output_size_valid(&output) {
                (
                    Some(output.to_string_lossy().to_string()),
                    std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0),
                    None,
                )
            } else {
                let err = if fragment_count == 0 {
                    Some("no valid fragments found".into())
                } else {
                    Some("final output not yet concatenated; recovery will finalize".into())
                };
                (None, total_size, err.or(fragment_error))
            };

        results.push(RecoveryScanResult {
            session_id: manifest.session_id,
            state: manifest.state,
            manifest_path: manifest_path.to_string_lossy().to_string(),
            output_path,
            output_size_bytes: output_size,
            is_recoverable: fragment_count > 0,
            validation_error,
        });
    }

    info!(count = results.len(), "recovery scan complete");
    Ok(results)
}

/// Finalize and recover a single session, returning the library record.
///
/// `work_dir` must already have been validated as a UUID-named directory
/// inside the sessions root (see `path_policy::validate_session_dir`).
#[instrument]
pub fn recover_session(
    work_dir: &Path,
    ffmpeg_path: &str,
    conn: &rusqlite::Connection,
) -> crate::errors::Result<crate::database::library::LibraryRecording> {
    let manifest_path = work_dir.join("session.json");

    if !manifest_path.exists() {
        return Err(crate::errors::InternalError::Storage("manifest not found".into()).into());
    }

    let mut manifest = RecordingManifest::read(&manifest_path)?;
    let output = work_dir.join("output.mp4");

    let mut output_size = if output.exists() {
        std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    if output_size < 1024 {
        let mut segment_files: Vec<PathBuf> = manifest
            .fragments
            .iter()
            .filter(|f| (f.validated || f.stopped_at.is_some()) && f.size_bytes.unwrap_or(0) > 0)
            .map(|f| work_dir.join(&f.file_name))
            .filter(|p| p.exists())
            .collect();

        // Fallback (P0.1 fix): Scan work_dir directly for physical segments
        if segment_files.is_empty() {
            if let Ok(entries) = std::fs::read_dir(work_dir) {
                for entry in entries.filter_map(Result::ok) {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if (name.starts_with("seg_") || name.starts_with("segment_")) && name.ends_with(".mp4") {
                        if let Ok(meta) = entry.metadata() {
                            if meta.len() > 1024 {
                                segment_files.push(entry.path());
                            }
                        }
                    }
                }
            }
            segment_files.sort();
        }

        if segment_files.is_empty() {
            return Err(crate::errors::InternalError::Media(
                "no valid fragments to recover".into(),
            )
            .into());
        }

        media::concatenate_segments(ffmpeg_path, work_dir, &segment_files, &output)?;

        output_size = std::fs::metadata(&output).map(|m| m.len()).map_err(|e| {
            crate::errors::InternalError::Storage(format!("recovered output metadata: {e}"))
        })?;
    }

    manifest.set_output_path(output.to_string_lossy());
    manifest.set_state(RecorderState::Completed);
    manifest.write()?;

    crate::database::library::insert_recording(conn, &manifest, output_size)
}

/// Remove a recovery session directory from disk.
#[instrument]
pub fn delete_recovery_session(session_id: &str, sessions_dir: &Path) -> crate::errors::Result<()> {
    // 1. Validate UUID format to prevent path traversal via relative components (P0.7)
    if uuid::Uuid::parse_str(session_id).is_err() {
        return Err(crate::errors::InternalError::Permissions(format!(
            "invalid session ID format for deletion: {session_id}"
        ))
        .into());
    }

    let work_dir = sessions_dir.join(session_id);
    if work_dir.exists() {
        // 2. Canonicalize target and parent to enforce containment
        let canonical_target = work_dir.canonicalize().map_err(|e| {
            crate::errors::InternalError::Storage(format!("failed to canonicalize session path: {e}"))
        })?;

        let canonical_root = sessions_dir.canonicalize().map_err(|e| {
            crate::errors::InternalError::Storage(format!("failed to canonicalize sessions root: {e}"))
        })?;

        if !canonical_target.starts_with(&canonical_root) {
            return Err(crate::errors::InternalError::Permissions(format!(
                "path traversal blocked: {session_id}"
            ))
            .into());
        }

        std::fs::remove_dir_all(&canonical_target).map_err(|e| {
            crate::errors::InternalError::Storage(format!("delete recovery session: {e}"))
        })?;
    }
    Ok(())
}

fn validate_fragments(
    work_dir: &Path,
    manifest: &RecordingManifest,
) -> (u64, usize, Option<String>) {
    let mut total = 0u64;
    let mut count = 0usize;
    let mut first_error = None;

    for frag in &manifest.fragments {
        let path = work_dir.join(&frag.file_name);
        match std::fs::metadata(&path) {
            Ok(meta) => {
                if meta.len() > 1024 {
                    total += meta.len();
                    count += 1;
                } else {
                    first_error = Some(format!("fragment {} is too small", frag.index));
                }
            }
            Err(e) => {
                first_error = Some(format!("fragment {} missing: {e}", frag.index));
            }
        }
    }

    // Fallback (P0.1 fix): If manifest fragment records were not finalized due to sudden crash/kill,
    // scan work_dir directly for any segment video files >= 1KB.
    if count == 0 {
        if let Ok(entries) = std::fs::read_dir(work_dir) {
            for entry in entries.filter_map(Result::ok) {
                let name = entry.file_name().to_string_lossy().to_string();
                if (name.starts_with("seg_") || name.starts_with("segment_")) && name.ends_with(".mp4") {
                    if let Ok(meta) = entry.metadata() {
                        if meta.len() > 1024 {
                            total += meta.len();
                            count += 1;
                        }
                    }
                }
            }
        }
    }

    (total, count, first_error)
}

fn output_size_valid(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.len() > 1024)
        .unwrap_or(false)
}
