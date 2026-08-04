use std::path::{Path, PathBuf};
use std::process::Command;
use tracing::{info, instrument};

use super::disk;

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
        let is_recoverable = fragment_count > 0 || output_path.is_some();

        results.push(RecoveryScanResult {
            session_id: manifest.session_id,
            state: manifest.state,
            manifest_path: manifest_path.to_string_lossy().to_string(),
            output_path,
            output_size_bytes: output_size,
            is_recoverable,
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
    ffprobe_path: &str,
    conn: &mut rusqlite::Connection,
) -> crate::errors::Result<crate::database::library::LibraryRecording> {
    let manifest_path = work_dir.join("session.json");

    if !manifest_path.exists() {
        return Err(crate::errors::InternalError::Storage("manifest not found".into()).into());
    }

    let mut manifest = RecordingManifest::read(&manifest_path)?;
    manifest.set_state(RecorderState::Recovering);
    manifest.write()?;

    let output = work_dir.join("output.mp4");
    let mut output_size = std::fs::metadata(&output)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let output_is_valid = output_size > 1024 && validate_media_file(ffprobe_path, &output);

    if !output_is_valid {
        let segment_files = recovery_segments(work_dir, &manifest)
            .into_iter()
            .filter(|path| validate_media_file(ffprobe_path, path))
            .collect::<Vec<_>>();

        if segment_files.is_empty() {
            return Err(crate::errors::InternalError::Media(
                "no valid fragments to recover".into(),
            )
            .into());
        }

        let partial_output = work_dir.join("output.partial.mp4");
        if partial_output.exists() {
            std::fs::remove_file(&partial_output).map_err(|error| {
                crate::errors::InternalError::Storage(format!(
                    "remove partial recovery output: {error}"
                ))
            })?;
        }
        media::concatenate_segments(ffmpeg_path, work_dir, &segment_files, &partial_output)?;
        disk::atomic_replace(&partial_output, &output)?;
        output_size = std::fs::metadata(&output)
            .map(|metadata| metadata.len())
            .map_err(|error| {
                crate::errors::InternalError::Storage(format!("recovered output metadata: {error}"))
            })?;
        disk::sync_file(&output)?;
    }

    if output_size <= 1024 || !validate_media_file(ffprobe_path, &output) {
        return Err(crate::errors::InternalError::Media(
            "recovered output failed media validation".into(),
        )
        .into());
    }

    manifest.set_output_path(output.to_string_lossy());
    manifest.set_state(RecorderState::Finalizing);
    manifest.write()?;
    let recording =
        crate::database::library::insert_recovered_recording(conn, &manifest, output_size)?;
    manifest.set_state(RecorderState::Completed);
    manifest.write()?;

    Ok(recording)
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
            crate::errors::InternalError::Storage(format!(
                "failed to canonicalize session path: {e}"
            ))
        })?;

        let canonical_root = sessions_dir.canonicalize().map_err(|e| {
            crate::errors::InternalError::Storage(format!(
                "failed to canonicalize sessions root: {e}"
            ))
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

fn recovery_segments(work_dir: &Path, manifest: &RecordingManifest) -> Vec<PathBuf> {
    let mut paths = manifest
        .fragments
        .iter()
        .filter_map(|fragment| safe_fragment_path(work_dir, &fragment.file_name))
        .filter(|path| {
            std::fs::metadata(path)
                .map(|metadata| metadata.len() > 1024)
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();

    if let Ok(entries) = std::fs::read_dir(work_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if (name.starts_with("seg_") || name.starts_with("segment_"))
                && name.ends_with(".mp4")
                && std::fs::metadata(&path)
                    .map(|metadata| metadata.len() > 1024)
                    .unwrap_or(false)
                && !paths.contains(&path)
            {
                paths.push(path);
            }
        }
    }

    paths.sort_by_key(|path| segment_index(path).unwrap_or(u32::MAX));
    paths
}

fn safe_fragment_path(work_dir: &Path, file_name: &str) -> Option<PathBuf> {
    let relative = Path::new(file_name);
    if relative.components().count() != 1 || relative.extension()?.to_str()? != "mp4" {
        return None;
    }
    Some(work_dir.join(relative))
}

fn segment_index(path: &Path) -> Option<u32> {
    path.file_stem()?
        .to_string_lossy()
        .rsplit('_')
        .next()?
        .parse()
        .ok()
}

fn validate_media_file(ffprobe_path: &str, path: &Path) -> bool {
    let output = Command::new(ffprobe_path)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output();

    output
        .map(|output| output.status.success() && !output.stdout.is_empty())
        .unwrap_or(false)
}

fn validate_fragments(
    work_dir: &Path,
    manifest: &RecordingManifest,
) -> (u64, usize, Option<String>) {
    let paths = recovery_segments(work_dir, manifest);
    let total = paths
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .sum();
    let count = paths.len();
    let error = if count == 0 {
        Some("no valid fragments found".into())
    } else {
        None
    };

    (total, count, error)
}

fn output_size_valid(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.len() > 1024)
        .unwrap_or(false)
}
