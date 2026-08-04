use std::path::Path;
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tracing::{info, instrument};

use crate::database::media::MediaMetadata;
use crate::errors::{InternalError, Result};

use super::run_ffmpeg_with_progress;

/// Generate a lower-resolution editing proxy.
#[instrument(skip(ffmpeg_path, metadata, cancel, on_progress))]
pub fn generate_proxy(
    ffmpeg_path: &str,
    input: &Path,
    output: &Path,
    metadata: &MediaMetadata,
    proxy_height: i32,
    cancel: Arc<AtomicBool>,
    mut on_progress: impl FnMut(f64) + Send + 'static,
) -> Result<u64> {
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| InternalError::Storage(format!("create proxy dir: {e}")))?;
    }

    let has_audio = metadata.has_audio;
    let scale = if metadata.width.is_some() && metadata.height.is_some() {
        format!("scale=-2:{proxy_height}")
    } else {
        format!("scale=960:{proxy_height}")
    };

    let mut command = Command::new(ffmpeg_path);
    command
        .arg("-y")
        .arg("-i")
        .arg(input)
        .args(["-map", "0:v:0", "-vf", &scale])
        .args([
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
        ]);

    if has_audio {
        command.args(["-map", "0:a?", "-c:a", "aac", "-b:a", "96k"]);
    } else {
        command.arg("-an");
    }

    command.args(["-movflags", "+faststart"]).arg(output);

    info!(?command, "generating proxy");

    let duration = if metadata.duration_ms > 0 {
        Some(metadata.duration_ms)
    } else {
        None
    };

    let stage_progress = move |p: f64| {
        // Proxy is the bulk of the prepare job; give it 40% of the total progress.
        on_progress(0.10 + p * 0.40);
    };

    let status = run_ffmpeg_with_progress(command, duration, cancel, stage_progress)?;
    if !status.success() {
        let _ = std::fs::remove_file(output);
        return Err(InternalError::Media("proxy generation failed".into()).into());
    }

    let size = std::fs::metadata(output)
        .map(|m| m.len())
        .map_err(|e| InternalError::Media(format!("proxy metadata: {e}")))?;

    Ok(size)
}
