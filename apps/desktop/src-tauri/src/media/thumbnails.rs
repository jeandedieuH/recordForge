use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tracing::{info, instrument};

use crate::database::media::MediaMetadata;
use crate::errors::{InternalError, Result};

/// Width of one filmstrip cell inside the sprite sheet. Sized so tiles stay
/// crisp on HiDPI displays without inflating the decoded sprite too much.
const THUMB_WIDTH: u32 = 192;
const SPRITE_COLUMNS: u32 = 10;
/// Aim for roughly this many frames per sprite so short recordings still get
/// dense coverage for zoomed-in editing.
const TARGET_FRAME_COUNT: u64 = 320;
/// Never sample more densely than twice per second — below this the sprite
/// cost grows without adding useful editorial detail.
const MIN_INTERVAL_MS: u64 = 500;
/// Hard cap on frames so very long recordings cannot produce an oversized
/// sprite sheet regardless of the requested interval.
const MAX_FRAME_COUNT: u64 = 480;

/// Resolve the effective thumbnail spacing for a recording.
///
/// `max_interval_sec` is the user's coarsest allowed spacing; short clips are
/// sampled more densely (down to 0.5 s) so the filmstrip stays meaningful when
/// the timeline is zoomed to frame level, while very long recordings are
/// capped so the sprite stays within a sane decoded-size budget.
pub fn effective_thumbnail_interval_ms(duration_ms: u64, max_interval_sec: u64) -> u64 {
    let duration = duration_ms.max(1);
    let user_max_ms = max_interval_sec.max(1) * 1000;
    let adaptive = (duration / TARGET_FRAME_COUNT).clamp(MIN_INTERVAL_MS, user_max_ms);

    // A user-requested coarse interval can still exceed the frame budget on
    // very long recordings, so widen the interval to keep the sprite bounded.
    let cap_interval = duration.div_ceil(MAX_FRAME_COUNT);
    adaptive.max(cap_interval)
}

fn build_thumbnail_filter(interval_ms: u64, columns: u32, rows: u32, count: u32) -> String {
    let capacity = u64::from(columns) * u64::from(rows);
    let padding_frames = capacity.saturating_sub(u64::from(count));
    let padding = if padding_frames > 0 {
        format!(",tpad=stop_mode=add:stop={padding_frames}:color=black")
    } else {
        String::new()
    };

    // The fps filter accepts exact rationals, so spacing is expressed as
    // 1000/interval_ms to avoid fractional rounding drift on long timelines.
    format!(
        "fps=1000/{interval_ms},scale={THUMB_WIDTH}:-2:force_original_aspect_ratio=decrease,format=yuv420p{padding},tile={columns}x{rows}:nb_frames={capacity}:color=black"
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

    let interval_ms = effective_thumbnail_interval_ms(metadata.duration_ms, thumbnail_interval_sec);
    let count = metadata.duration_ms.div_ceil(interval_ms) as u32;
    if count == 0 {
        return Err(InternalError::Media("recording too short for thumbnails".into()).into());
    }

    let columns: u32 = SPRITE_COLUMNS;
    let rows = count.div_ceil(columns).max(1);

    let sprite_path = output_dir.join("sprite.jpg");
    let manifest_path = output_dir.join("thumbnails.json");

    let filter = build_thumbnail_filter(interval_ms, columns, rows, count);

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
        .arg("3")
        .arg(&sprite_path);

    info!(interval_ms, count, "generating thumbnail sprite");

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
    let thumb_width = THUMB_WIDTH;
    let thumb_height = (THUMB_WIDTH as f64 / aspect).round() as u32;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumbnail_filter_pads_unused_grid_cells_with_black() {
        let filter = build_thumbnail_filter(2000, 10, 5, 41);

        assert!(filter.contains("tpad=stop_mode=add:stop=9:color=black"));
        assert!(filter.contains("tile=10x5:nb_frames=50:color=black"));
        assert!(filter.contains("fps=1000/2000"));
    }

    #[test]
    fn short_recordings_get_dense_sub_second_thumbnails() {
        // 30 s clip: adaptive spacing bottoms out at the 0.5 s floor.
        assert_eq!(effective_thumbnail_interval_ms(30_000, 5), 500);
        // 60 s clip: still well below the requested 5 s ceiling.
        assert_eq!(effective_thumbnail_interval_ms(60_000, 5), 500);
    }

    #[test]
    fn long_recordings_never_exceed_the_frame_budget() {
        // 1 h recording with a 5 s ceiling would exceed MAX_FRAME_COUNT, so
        // the interval widens to keep the sprite bounded.
        let interval = effective_thumbnail_interval_ms(3_600_000, 5);
        assert!(3_600_000_u64.div_ceil(interval) <= MAX_FRAME_COUNT);

        // Mid-length recordings land near the target density.
        let interval = effective_thumbnail_interval_ms(600_000, 5);
        assert_eq!(interval, 1875);
    }

    #[test]
    fn user_interval_is_respected_as_the_coarsest_spacing() {
        // User asked for 10 s on a 20 min clip: duration/320 = 3.75 s wins
        // because it is denser than the requested maximum.
        assert_eq!(effective_thumbnail_interval_ms(1_200_000, 10), 3750);
        // User asked for 1 s on the same clip: that would produce 1200
        // frames, so the sprite budget widens the spacing to 2.5 s.
        assert_eq!(effective_thumbnail_interval_ms(1_200_000, 1), 2500);
    }
}
