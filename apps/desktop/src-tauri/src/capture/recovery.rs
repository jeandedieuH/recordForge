use std::path::{Path, PathBuf};
use std::process::Command;
use tracing::{info, instrument};

use super::config::builtin_profiles;
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
    pub cursor_telemetry_available: bool,
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
                    cursor_telemetry_available: false,
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
        let cursor_telemetry_available = super::cursor_v2::read_any_telemetry(&work_dir).is_some();

        results.push(RecoveryScanResult {
            session_id: manifest.session_id,
            state: manifest.state,
            manifest_path: manifest_path.to_string_lossy().to_string(),
            output_path,
            output_size_bytes: output_size,
            is_recoverable,
            cursor_telemetry_available,
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

    // A completed session is already in the library. Re-running recovery would
    // concatenate the fragments again and insert a duplicate row, so reject
    // stale client retries outright.
    if manifest.state == RecorderState::Completed {
        return Err(
            crate::errors::InternalError::Storage("session is already recovered".into()).into(),
        );
    }

    manifest.set_state(RecorderState::Recovering);
    manifest.write()?;

    let finalize = recover_session_inner(work_dir, &mut manifest, ffmpeg_path, ffprobe_path, conn);

    match finalize {
        Ok(recording) => Ok(recording),
        Err(error) => {
            // Mark the manifest failed so the recovery UI stops offering an
            // unrecoverable session and the user can delete it. Files are left
            // untouched; a future FFmpeg/ffprobe fix could still salvage them.
            // Storage/permission errors keep the Recovering state because a
            // retry may legitimately succeed once the underlying issue clears.
            if matches!(
                error.category,
                crate::errors::ErrorCategory::Media | crate::errors::ErrorCategory::Capture
            ) {
                manifest.set_state(RecorderState::Failed);
                manifest.write()?;
            }
            Err(error)
        }
    }
}

fn recover_session_inner(
    work_dir: &Path,
    manifest: &mut RecordingManifest,
    ffmpeg_path: &str,
    ffprobe_path: &str,
    conn: &mut rusqlite::Connection,
) -> crate::errors::Result<crate::database::library::LibraryRecording> {
    let output = work_dir.join("output.mp4");
    let mut output_size = std::fs::metadata(&output)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let output_is_valid = output_size > 1024 && validate_media_file(ffprobe_path, &output);

    if !output_is_valid {
        let segment_files = recovery_segments(work_dir, manifest)
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

    if let Some(webcam_path) = recover_webcam_asset(work_dir, manifest, ffmpeg_path, ffprobe_path)?
    {
        manifest.set_webcam_path(webcam_path.to_string_lossy());
    }
    manifest.set_output_path(output.to_string_lossy());
    manifest.set_state(RecorderState::Finalizing);
    manifest.write()?;
    let recording =
        crate::database::library::insert_recovered_recording(conn, manifest, output_size)?;
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

fn recover_webcam_asset(
    work_dir: &Path,
    manifest: &RecordingManifest,
    ffmpeg_path: &str,
    ffprobe_path: &str,
) -> crate::errors::Result<Option<PathBuf>> {
    let Some(existing) = manifest.webcam_path.as_ref() else {
        if manifest.webcam_fragments.is_empty() {
            return Ok(None);
        }
        let Some(profile) = builtin_profiles()
            .into_iter()
            .find(|profile| profile.id == manifest.profile_name)
        else {
            return Ok(None);
        };
        let mut segments = Vec::with_capacity(manifest.webcam_fragments.len());
        for fragment in &manifest.webcam_fragments {
            let Some(path) = safe_fragment_path(work_dir, &fragment.file_name) else {
                return Ok(None);
            };
            if !path.is_file() || !validate_media_file(ffprobe_path, &path) {
                return Ok(None);
            }
            segments.push(media::WebcamSegmentInput {
                path,
                duration: std::time::Duration::from_millis(fragment.duration_ms),
                offset_ms: fragment.offset_ms,
            });
        }

        let output = work_dir.join("webcam.mp4");
        let partial = work_dir.join("webcam.partial.mp4");
        if partial.exists() {
            let _ = std::fs::remove_file(&partial);
        }
        media::concatenate_webcam_segments(ffmpeg_path, &segments, &partial, &profile)?;
        disk::atomic_replace(&partial, &output)?;
        return Ok(Some(output));
    };

    let path = PathBuf::from(existing);
    if !path.is_file() || !validate_media_file(ffprobe_path, &path) {
        return Ok(None);
    }
    let canonical_root = work_dir.canonicalize().map_err(|error| {
        crate::errors::InternalError::Storage(format!("canonicalize session: {error}"))
    })?;
    let canonical_path = path.canonicalize().map_err(|error| {
        crate::errors::InternalError::Storage(format!("canonicalize webcam asset: {error}"))
    })?;
    if !canonical_path.starts_with(&canonical_root) {
        return Ok(None);
    }
    Ok(Some(canonical_path))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::source::{Bounds, CaptureSource};

    fn completed_manifest(work_dir: &Path) {
        let source = CaptureSource {
            kind: "display".into(),
            id: "display-0".into(),
            name: "Display 1".into(),
            bounds: Bounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
        };
        let mut manifest = RecordingManifest::new(
            "11111111-1111-4111-8111-111111111111",
            work_dir.to_string_lossy(),
            source,
            "balanced",
        );
        manifest.set_state(RecorderState::Completed);
        manifest.write().expect("write completed manifest");
    }

    // Re-running recovery on a completed session must fail fast instead of
    // inserting a duplicate library row.
    #[test]
    fn recover_session_rejects_already_completed_manifest() {
        let temp_dir = tempfile::tempdir().expect("create temp sessions dir");
        let work_dir = temp_dir.path().join("11111111-1111-4111-8111-111111111111");
        std::fs::create_dir_all(&work_dir).expect("create work dir");
        completed_manifest(&work_dir);

        let mut conn = rusqlite::Connection::open_in_memory().expect("open db");
        let result = recover_session(&work_dir, "ffmpeg", "ffprobe", &mut conn);
        let error = result.expect_err("completed session must be rejected");
        assert!(error.message.contains("already recovered"));
    }
}
