use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tracing::{info, instrument};

use crate::database::media::MediaMetadata;
use crate::errors::{InternalError, Result};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumbnail_filter_pads_unused_grid_cells_with_black() {
        let filter = build_thumbnail_filter(5, 10, 5, 41);

        assert!(filter.contains("tpad=stop_mode=add:stop=9:color=black"));
        assert!(filter.contains("tile=10x5:nb_frames=50:color=black"));
    }
}

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

fn build_thumbnail_filter(interval_sec: u64, columns: u32, rows: u32, count: u32) -> String {
    let capacity = u64::from(columns) * u64::from(rows);
    let padding_frames = capacity.saturating_sub(u64::from(count));
    let padding = if padding_frames > 0 {
        format!(",tpad=stop_mode=add:stop={padding_frames}:color=black")
    } else {
        String::new()
    };

    format!(
        "fps=1/{interval_sec},scale=160:-2:force_original_aspect_ratio=decrease,format=yuv420p{padding},tile={columns}x{rows}:nb_frames={capacity}:color=black"
    )
}

/// Generate a thumbnail sprite and manifest.
#[instrument(skip(ffmpeg_path, input, output_dir, metadata))]
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
        return Err(InternalError::Media(
            "cannot generate thumbnails for zero-duration video".into(),
        )
        .into());
    }
    if thumbnail_interval_sec == 0 {
        return Err(InternalError::Media("thumbnail interval must be positive".into()).into());
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

    let filter = build_thumbnail_filter(thumbnail_interval_sec, columns, rows, count);

    let mut command = crate::process::create_command(ffmpeg_path);
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

    info!("generating thumbnail sprite");

    let output = command
        .output()
        .map_err(|e| InternalError::Media(format!("thumbnail run: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(InternalError::Media(format!("thumbnail generation failed: {stderr}")).into());
    }
    if !sprite_path.is_file() {
        return Err(InternalError::Media("thumbnail generation produced no sprite".into()).into());
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

/// Generate a single poster frame image from a video file.
#[instrument(skip(ffmpeg_path, input, output_image))]
pub fn generate_poster_frame(
    ffmpeg_path: &str,
    input: &Path,
    output_image: &Path,
) -> Result<PathBuf> {
    if let Some(parent) = output_image.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| InternalError::Storage(format!("create poster dir: {e}")))?;
    }

    if !input.is_file() {
        return Err(InternalError::Media("input video does not exist".into()).into());
    }

    // Try extracting at 0.5s first; fallback to 0.0s if needed
    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .arg("-y")
        .arg("-ss")
        .arg("0.5")
        .arg("-i")
        .arg(input)
        .args(["-vf", "scale=480:-2:force_original_aspect_ratio=decrease"])
        .arg("-vframes")
        .arg("1")
        .arg("-q:v")
        .arg("2")
        .arg(output_image);

    let output = command
        .output()
        .map_err(|e| InternalError::Media(format!("poster extraction run: {e}")))?;

    if !output.status.success() || !output_image.is_file() {
        // Fallback: extract first frame at 0.0s
        let mut fallback = crate::process::create_command(ffmpeg_path);
        fallback
            .arg("-y")
            .arg("-ss")
            .arg("0.0")
            .arg("-i")
            .arg(input)
            .args(["-vf", "scale=480:-2:force_original_aspect_ratio=decrease"])
            .arg("-vframes")
            .arg("1")
            .arg("-q:v")
            .arg("2")
            .arg(output_image);

        let fallback_output = fallback
            .output()
            .map_err(|e| InternalError::Media(format!("poster fallback run: {e}")))?;

        if !fallback_output.status.success() || !output_image.is_file() {
            let stderr = String::from_utf8_lossy(&fallback_output.stderr);
            return Err(InternalError::Media(format!("poster extraction failed: {stderr}")).into());
        }
    }

    Ok(output_image.to_path_buf())
}
