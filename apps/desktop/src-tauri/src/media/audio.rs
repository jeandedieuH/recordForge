use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::errors::{InternalError, Result};

/// Extract one independently playable audio stream from the finalized MP4.
///
/// The stream is copied into an M4A derivative so the editor can preview and
/// mute microphone/system-audio tracks independently of the video element.
pub fn extract_audio_track(
    ffmpeg_path: &str,
    input: &Path,
    stream_index: i32,
    output: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    if stream_index < 0 {
        return Err(InternalError::Media("audio stream index must be non-negative".into()).into());
    }
    if !input.exists() {
        return Err(InternalError::Media(format!(
            "audio source does not exist: {}",
            input.display()
        ))
        .into());
    }

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            InternalError::Storage(format!("create audio derivative dir: {error}"))
        })?;
    }

    let map = format!("0:{stream_index}");
    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .args(["-y", "-hide_banner", "-loglevel", "error"])
        .arg("-i")
        .arg(input)
        .args([
            "-map",
            &map,
            "-vn",
            "-c:a",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
        ]);

    if output.extension().and_then(|ext| ext.to_str()) == Some("m4a") {
        command.args(["-movflags", "+faststart"]);
    }

    let result = command
        .arg(output)
        .output()
        .map_err(|error| InternalError::Media(format!("audio track extraction: {error}")))?;

    if cancel.load(Ordering::Relaxed) {
        let _ = std::fs::remove_file(output);
        return Err(InternalError::Media("audio track extraction cancelled".into()).into());
    }
    if !result.status.success() {
        let _ = std::fs::remove_file(output);
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(
            InternalError::Media(format!("audio track extraction failed: {stderr}")).into(),
        );
    }

    let size = std::fs::metadata(output)
        .map(|metadata| metadata.len())
        .map_err(|error| InternalError::Storage(format!("audio derivative metadata: {error}")))?;
    if size == 0 {
        return Err(
            InternalError::Media("audio track extraction produced an empty file".into()).into(),
        );
    }

    Ok(output.to_path_buf())
}
