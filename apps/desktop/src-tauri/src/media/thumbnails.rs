use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use tracing::{info, instrument};

use crate::database::media::MediaMetadata;
use crate::errors::{InternalError, Result};

/// Manifest describing the thumbnail sprite for a recording.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailManifest {
    pub sprite_path: String,
    pub columns: u32,
    pub rows: u32,
    pub count: u32,
    pub interval_ms: u64,
    pub thumb_width: u32,
    pub thumb_height: u32,
}

/// Generate a thumbnail sprite and manifest.
#[instrument(skip(ffmpeg_path, metadata))]
pub fn generate_thumbnails(
    ffmpeg_path: &str,
    input: &Path,
    output_dir: &Path,
    metadata: &MediaMetadata,
    thumbnail_interval_sec: u64,
) -> Result<(PathBuf, PathBuf)> {
    std::fs::create_dir_all(output_dir)
        .map_err(|e| InternalError::Storage(format!("create thumbnail dir: {e}")))?;

    if metadata.duration_ms == 0 {
        return Err(InternalError::Media("cannot generate thumbnails for zero-duration video".into()).into());
    }

    let duration_sec = metadata.duration_ms as f64 / 1000.0;
    let count = (duration_sec / thumbnail_interval_sec as f64).ceil() as u32;
    if count == 0 {
        return Err(InternalError::Media("recording too short for thumbnails".into()).into());
    }

    let columns: u32 = 10;
    let rows = count.div_ceil(columns).max(1);
    let interval_ms = thumbnail_interval_sec * 1000;

    let sprite_path = output_dir.join("sprite.jpg");
    let manifest_path = output_dir.join("thumbnails.json");

    let filter = format!(
        "fps=1/{thumbnail_interval_sec},scale=160:-2:force_original_aspect_ratio=decrease,format=yuv420p,tile={columns}x{rows}:nb_frames={count}"
    );

    let mut command = Command::new(ffmpeg_path);
    command
        .arg("-y")
        .arg("-i")
        .arg(input)
        .args(["-vf", &filter])
        .arg("-an")
        .arg("-frames:v")
        .arg("1")
        .arg("-q:v")
        .arg("2")
        .arg(&sprite_path);

    info!(?command, "generating thumbnail sprite");

    let output = command
        .output()
        .map_err(|e| InternalError::Media(format!("thumbnail run: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(InternalError::Media(format!("thumbnail generation failed: {stderr}")).into());
    }

    // Compute the actual thumbnail dimensions after scaling. Fail explicitly
    // if the dimensions are missing instead of panicking on an unwrap.
    let width = metadata.width.ok_or_else(|| {
        InternalError::Media("cannot generate thumbnails without video width".into())
    })?;
    let height = metadata.height.ok_or_else(|| {
        InternalError::Media("cannot generate thumbnails without video height".into())
    })?;
    let aspect = width as f64 / height as f64;
    let thumb_width = 160u32;
    let thumb_height = (160.0 / aspect).round() as u32;

    let manifest = ThumbnailManifest {
        sprite_path: sprite_path.to_string_lossy().to_string(),
        columns,
        rows,
        count,
        interval_ms,
        thumb_width,
        thumb_height,
    };

    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| InternalError::Storage(format!("serialize thumbnail manifest: {e}")))?;
    std::fs::write(&manifest_path, manifest_json)
        .map_err(|e| InternalError::Storage(format!("write thumbnail manifest: {e}")))?;

    Ok((sprite_path, manifest_path))
}
