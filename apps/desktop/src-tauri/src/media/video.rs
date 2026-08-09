use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::errors::{InternalError, Result};

/// Extract one independently playable video stream for the editor's camera preview.
pub fn extract_video_track(
    ffmpeg_path: &str,
    input: &Path,
    stream_index: i32,
    output: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    if stream_index < 0 {
        return Err(InternalError::Media("video stream index must be non-negative".into()).into());
    }
    if !input.exists() {
        return Err(InternalError::Media(format!(
            "video source does not exist: {}",
            input.display()
        ))
        .into());
    }

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            InternalError::Storage(format!("create video derivative dir: {error}"))
        })?;
    }

    let map = format!("0:{stream_index}");
    let result = Command::new(ffmpeg_path)
        .args(["-y", "-hide_banner", "-loglevel", "error"])
        .arg("-i")
        .arg(input)
        .args([
            "-map",
            &map,
            "-an",
            "-c:v",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
        ])
        .args(["-movflags", "+faststart"])
        .arg(output)
        .output()
        .map_err(|error| InternalError::Media(format!("video track extraction: {error}")))?;

    if cancel.load(Ordering::Relaxed) {
        let _ = std::fs::remove_file(output);
        return Err(InternalError::Media("video track extraction cancelled".into()).into());
    }
    if !result.status.success() {
        let _ = std::fs::remove_file(output);
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(
            InternalError::Media(format!("video track extraction failed: {stderr}")).into(),
        );
    }

    let size = std::fs::metadata(output)
        .map(|metadata| metadata.len())
        .map_err(|error| InternalError::Storage(format!("video derivative metadata: {error}")))?;
    if size == 0 {
        return Err(
            InternalError::Media("video track extraction produced an empty file".into()).into(),
        );
    }

    Ok(output.to_path_buf())
}
