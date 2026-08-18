use std::path::{Path, PathBuf};
use tracing::instrument;

use crate::database::media::MediaMetadata;
use crate::errors::{InternalError, Result};

/// Estimate the disk space required for proxy + thumbnails + waveform.
///
/// Proxy: assume ~1.5 Mbps for 540p H.264 video + 96 Kbps AAC.
/// Thumbnails: one 160 px wide JPEG per interval.
/// Waveform: a small PNG plus a JSON peak array.
#[instrument(skip(metadata))]
pub fn estimate_derivative_size(
    metadata: &MediaMetadata,
    proxy_height: i32,
    thumbnail_interval_sec: u64,
) -> u64 {
    let duration_sec = (metadata.duration_ms as f64 / 1000.0).max(0.0);

    // Bitrate guesstimate for the proxy, scaled roughly by height.
    let height_factor = (proxy_height as f64 / 540.0).clamp(0.5, 2.0);
    let proxy_kbps = (1500.0 + 96.0) * height_factor;
    let proxy_bytes = (proxy_kbps * duration_sec) / 8.0 * 1024.0;

    let thumb_count = if thumbnail_interval_sec > 0 {
        (duration_sec / thumbnail_interval_sec as f64).ceil() as u64
    } else {
        0
    };
    // ~8 KB per 160px wide JPEG on average.
    let thumbnails_bytes = thumb_count * 8 * 1024;

    let audio_track_count = metadata
        .streams
        .iter()
        .filter(|stream| stream.kind == "audio")
        .count() as f64;
    // Each audio stream gets a compact M4A derivative plus its own waveform.
    let audio_bytes = audio_track_count * (192.0 * duration_sec / 8.0 * 1024.0);
    let waveform_bytes =
        audio_track_count * (200.0 * 1024.0 + (duration_sec as u64) as f64 * 400.0);

    (proxy_bytes + thumbnails_bytes as f64 + audio_bytes + waveform_bytes) as u64
}

/// Return the number of free bytes available to the caller for a path.
#[instrument]
pub fn available_space(path: &Path) -> Result<u64> {
    let parent = path.parent().unwrap_or(path);
    let dir = if parent.exists() {
        parent
    } else {
        Path::new(".")
    };

    #[cfg(windows)]
    {
        available_space_windows(dir)
    }

    #[cfg(not(windows))]
    {
        let output = crate::process::create_command("df")
            .args(["-k", dir.as_os_str().to_string_lossy().as_ref()])
            .output()
            .map_err(|e| InternalError::Storage(format!("df: {e}")))?;
        if !output.status.success() {
            return Err(InternalError::Storage("df failed".into()).into());
        }
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines().skip(1) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 4 {
                if let Ok(available_k) = parts[3].parse::<u64>() {
                    return Ok(available_k * 1024);
                }
            }
        }
        Err(InternalError::Storage("could not parse df output".into()).into())
    }
}

#[cfg(windows)]
fn available_space_windows(path: &Path) -> Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut free_bytes = 0u64;
    unsafe {
        GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free_bytes), None, None)
            .map_err(|e| InternalError::Storage(format!("GetDiskFreeSpaceExW: {e}")))?;
    }

    Ok(free_bytes)
}

/// Build a safe output directory inside a recording's work directory.
pub fn derivative_dir(work_dir: &Path, kind: &str) -> PathBuf {
    work_dir.join("derivatives").join(kind)
}
