use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tracing::{info, instrument};

use super::config::RecordingProfile;
use super::disk;

/// Audio source kind used to label independent track inputs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioTrackKind {
    Microphone,
    System,
}

/// An independently captured audio asset to mux into a screen fragment.
#[derive(Debug, Clone)]
pub struct AudioTrackInput {
    pub path: PathBuf,
    pub title: &'static str,
    pub kind: AudioTrackKind,
}

/// Concatenate finalized segment files into a single MP4.
///
/// For a single segment this is a filesystem copy. For multiple segments an
/// FFmpeg concat demuxer list is generated and fed to a stream-copy job.
#[instrument(skip(ffmpeg_path, segment_files))]
pub fn concatenate_segments(
    ffmpeg_path: &str,
    work_dir: &Path,
    segment_files: &[PathBuf],
    output_path: &Path,
) -> crate::errors::Result<()> {
    if segment_files.is_empty() {
        return Err(
            crate::errors::InternalError::Media("no segments to concatenate".into()).into(),
        );
    }

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            crate::errors::InternalError::Storage(format!("create concat output dir: {e}"))
        })?;
    }

    if segment_files.len() == 1 {
        std::fs::copy(&segment_files[0], output_path).map_err(|e| {
            crate::errors::InternalError::Media(format!("copy single segment: {e}"))
        })?;
        disk::sync_file(output_path)?;
        return Ok(());
    }

    let list_path = work_dir.join("concat.txt");
    let mut list = String::new();
    for seg in segment_files {
        // The concat demuxer resolves relative paths against the list file's
        // directory, so we require a plain file name here. A missing file name
        // indicates an unexpected path (e.g. ending in `..`) that we refuse.
        let name = seg
            .file_name()
            .ok_or_else(|| {
                crate::errors::InternalError::Media(format!(
                    "segment path has no file name: {}",
                    seg.display()
                ))
            })?
            .to_string_lossy()
            .to_string();
        list.push_str(&format!("file '{}'\n", name));
    }
    std::fs::write(&list_path, list)
        .map_err(|e| crate::errors::InternalError::Storage(format!("write concat list: {e}")))?;

    let output = crate::process::create_command(ffmpeg_path)
        .arg("-y")
        .args(["-fflags", "+genpts+igndts"])
        .args(["-avoid_negative_ts", "make_zero"])
        .args(["-f", "concat", "-safe", "0", "-i"])
        .arg(&list_path)
        .args(["-map", "0", "-c", "copy", "-movflags", "+faststart"])
        .arg(output_path)
        .output()
        .map_err(|e| crate::errors::InternalError::Media(format!("concat run: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(crate::errors::InternalError::Media(format!("concat failed: {stderr}")).into());
    }

    disk::sync_file(output_path)?;
    Ok(())
}

/// One webcam segment with its screen-relative timing information.
#[derive(Debug, Clone)]
pub struct WebcamSegmentInput {
    pub path: PathBuf,
    pub duration: Duration,
    /// Signed camera-minus-screen start offset in milliseconds.
    pub offset_ms: i64,
}

/// Build one standalone webcam asset from per-segment camera captures.
///
/// Each segment is padded or trimmed to the matching screen segment duration
/// before concatenation. This preserves pause/resume boundaries and prevents a
/// camera startup delay from being collapsed away by the concat demuxer. The
/// camera is re-encoded once, independently of the screen and audio assets, so
/// the editor can seek, trim, mute, or replace it without touching the screen
/// recording.
#[instrument(skip(ffmpeg_path, segments, output_path, profile))]
pub fn concatenate_webcam_segments(
    ffmpeg_path: &str,
    segments: &[WebcamSegmentInput],
    output_path: &Path,
    profile: &RecordingProfile,
) -> crate::errors::Result<()> {
    if segments.is_empty() {
        return Err(crate::errors::InternalError::Media(
            "no webcam segments to concatenate".into(),
        )
        .into());
    }
    for segment in segments {
        if segment.duration.is_zero() {
            return Err(crate::errors::InternalError::Media(
                "webcam segment duration must be positive".into(),
            )
            .into());
        }
        if !segment.path.is_file() {
            return Err(crate::errors::InternalError::Media(format!(
                "webcam segment does not exist: {}",
                segment.path.display()
            ))
            .into());
        }
    }
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            crate::errors::InternalError::Storage(format!(
                "create webcam output directory: {error}"
            ))
        })?;
    }

    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .arg("-y")
        .args(["-hide_banner", "-loglevel", "error"]);
    for segment in segments {
        command.arg("-i").arg(&segment.path);
    }

    let filter = build_webcam_stitch_filter(segments);
    command
        .args(["-filter_complex", &filter])
        .args(["-map", "[webcam]", "-an"]);
    add_profile_video_encoder(&mut command, profile);
    let total_duration = segments
        .iter()
        .map(|segment| segment.duration)
        .fold(Duration::ZERO, |total, duration| {
            total.saturating_add(duration)
        });
    command
        .args(["-t", &format!("{:.6}", total_duration.as_secs_f64())])
        .args(["-movflags", "+faststart"])
        .arg(output_path);

    let output = command.output().map_err(|error| {
        crate::errors::InternalError::Media(format!("webcam concat run: {error}"))
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(
            crate::errors::InternalError::Media(format!("webcam concat failed: {stderr}")).into(),
        );
    }

    let size = std::fs::metadata(output_path)
        .map(|metadata| metadata.len())
        .map_err(|error| {
            crate::errors::InternalError::Media(format!("webcam concat output: {error}"))
        })?;
    if size <= 1024 {
        return Err(crate::errors::InternalError::Media(
            "webcam concat produced an empty asset".into(),
        )
        .into());
    }
    disk::sync_file(output_path)?;
    Ok(())
}

fn build_webcam_stitch_filter(segments: &[WebcamSegmentInput]) -> String {
    let mut filters = Vec::with_capacity(segments.len() + 1);
    for (index, segment) in segments.iter().enumerate() {
        let duration = segment.duration.as_secs_f64();
        let offset = segment.offset_ms as f64 / 1000.0;
        let source = if offset >= 0.0 {
            format!(
                "[{}:v]tpad=start_mode=add:start_duration={offset:.6}:color=black",
                index
            )
        } else {
            format!("[{}:v]trim=start={:.6}", index, -offset)
        };
        filters.push(format!(
            "{source},setpts=PTS-STARTPTS,tpad=stop_mode=add:stop_duration={duration:.6}:color=black,trim=duration={duration:.6},setpts=PTS-STARTPTS[v{index}]"
        ));
    }

    if segments.len() == 1 {
        filters.push("[v0]null[webcam]".into());
    } else {
        let inputs = (0..segments.len())
            .map(|index| format!("[v{index}]"))
            .collect::<String>();
        filters.push(format!(
            "{inputs}concat=n={}:v=1:a=0[webcam]",
            segments.len()
        ));
    }
    filters.join(";")
}

fn add_profile_video_encoder(command: &mut Command, profile: &RecordingProfile) {
    let encoder = profile
        .encoder_priority
        .first()
        .map(String::as_str)
        .unwrap_or("libx264");
    command.args(["-c:v", encoder, "-pix_fmt", "yuv420p", "-r"]);
    command.arg(profile.fps.to_string());
    if let Some(crf) = profile.crf {
        if encoder == "libx264" || encoder == "libx265" {
            command.args(["-preset", "ultrafast", "-crf", &crf.to_string()]);
        } else if encoder.starts_with("h264_") || encoder.starts_with("hevc_") {
            command.args([
                "-b:v",
                &format!("{}k", profile.video_bitrate_kbps.unwrap_or(5000)),
            ]);
        }
    } else if let Some(kbps) = profile.video_bitrate_kbps {
        command.args(["-b:v", &format!("{kbps}k")]);
    }
}

/// Mux native WASAPI audio tracks into a screen fragment as separate audio
/// streams. The webcam is deliberately not an input here: it remains an
/// independent video asset for the editor and export pipeline.
#[allow(clippy::too_many_arguments)]
#[instrument(skip(ffmpeg_path, video_path, audio_tracks, output_path))]
pub fn mux_audio_tracks(
    ffmpeg_path: &str,
    video_path: &Path,
    audio_tracks: &[AudioTrackInput],
    output_path: &Path,
    audio_codec: &str,
    audio_bitrate_kbps: i32,
    duration: Duration,
) -> crate::errors::Result<()> {
    if audio_tracks.is_empty() {
        return Err(crate::errors::InternalError::Media(
            "cannot mux an empty audio track list".into(),
        )
        .into());
    }
    if !video_path.exists() {
        return Err(crate::errors::InternalError::Media(format!(
            "video fragment does not exist: {}",
            video_path.display()
        ))
        .into());
    }
    if audio_codec.trim().is_empty() {
        return Err(
            crate::errors::InternalError::Media("audio codec must be provided".into()).into(),
        );
    }
    if audio_bitrate_kbps <= 0 {
        return Err(
            crate::errors::InternalError::Media("audio bitrate must be positive".into()).into(),
        );
    }
    if duration.is_zero() {
        return Err(crate::errors::InternalError::Media(
            "segment mux duration must be positive".into(),
        )
        .into());
    }
    for track in audio_tracks {
        if !track.path.exists() {
            return Err(crate::errors::InternalError::Media(format!(
                "audio track does not exist: {}",
                track.path.display()
            ))
            .into());
        }
    }
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            crate::errors::InternalError::Storage(format!("create segment mux output dir: {e}"))
        })?;
    }

    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .arg("-y")
        .args(["-hide_banner", "-loglevel", "error"])
        .args(["-fflags", "+genpts"])
        .arg("-i")
        .arg(video_path);

    for track in audio_tracks {
        command.arg("-i").arg(&track.path);
    }

    command.arg("-map").arg("0:v:0");
    for index in 0..audio_tracks.len() {
        command.args(["-map", &format!("{}:a:0", index + 1)]);
    }

    command.args([
        "-map_metadata",
        "0",
        "-c:v",
        "copy",
        "-avoid_negative_ts",
        "make_zero",
        "-movflags",
        "+faststart",
    ]);

    if !audio_tracks.is_empty() {
        command.args([
            "-c:a",
            audio_codec,
            "-b:a",
            &format!("{audio_bitrate_kbps}k"),
        ]);
    }

    command.args(["-t", &format!("{:.6}", duration.as_secs_f64())]);

    for (index, track) in audio_tracks.iter().enumerate() {
        command.args([
            &format!("-metadata:s:a:{index}"),
            &format!("title={}", track.title),
        ]);
    }
    command.arg(output_path);

    info!(
        audio_track_count = audio_tracks.len(),
        "muxing native WASAPI audio tracks"
    );
    let output = command
        .output()
        .map_err(|e| crate::errors::InternalError::Media(format!("segment mux run: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(
            crate::errors::InternalError::Media(format!("segment mux failed: {stderr}")).into(),
        );
    }

    let size = std::fs::metadata(output_path)
        .map(|metadata| metadata.len())
        .map_err(|e| crate::errors::InternalError::Media(format!("segment mux output: {e}")))?;
    if size <= 1024 {
        return Err(crate::errors::InternalError::Media(
            "segment mux produced an empty fragment".into(),
        )
        .into());
    }
    disk::sync_file(output_path)?;
    Ok(())
}

/// Trim a recording between `start_ms` and `end_ms` and write to `output_path`.
///
/// This uses an input-seek with stream copy for speed. Edges may not be
/// frame-accurate, but it avoids a re-encode on low-end hardware.
#[instrument(skip(ffmpeg_path, source_path, output_path))]
pub fn trim_recording(
    ffmpeg_path: &str,
    source_path: &Path,
    output_path: &Path,
    start_ms: u64,
    end_ms: u64,
) -> crate::errors::Result<u64> {
    if start_ms >= end_ms {
        return Err(crate::errors::InternalError::Media(
            "trim end must be greater than start".into(),
        )
        .into());
    }

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            crate::errors::InternalError::Storage(format!("create trim output dir: {e}"))
        })?;
    }

    let start_sec = start_ms as f64 / 1000.0;
    let duration_sec = (end_ms - start_ms) as f64 / 1000.0;

    let output = crate::process::create_command(ffmpeg_path)
        .arg("-y")
        .args(["-ss", &format!("{start_sec:.3}")])
        .arg("-i")
        .arg(source_path)
        .args(["-t", &format!("{duration_sec:.3}")])
        .args([
            "-map",
            "0",
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            "-movflags",
            "+faststart",
        ])
        .arg(output_path)
        .output()
        .map_err(|e| crate::errors::InternalError::Media(format!("trim run: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(crate::errors::InternalError::Media(format!("trim failed: {stderr}")).into());
    }

    std::fs::metadata(output_path)
        .map(|m| m.len())
        .map_err(|e| {
            crate::errors::InternalError::Media(format!("trim output metadata: {e}")).into()
        })
}

/// Copy a finished recording to a user-selected destination path.
#[instrument(skip(source_path, destination_path))]
pub fn copy_export(source_path: &Path, destination_path: &Path) -> crate::errors::Result<()> {
    if let Some(parent) = destination_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            crate::errors::InternalError::Storage(format!("create export dir: {e}"))
        })?;
    }

    std::fs::copy(source_path, destination_path)
        .map_err(|e| crate::errors::InternalError::Media(format!("copy export: {e}")))?;

    Ok(())
}

/// Return the FFmpeg version string reported by `ffmpeg -version`.
#[instrument(skip(ffmpeg_path))]
pub fn ffmpeg_version(ffmpeg_path: &str) -> crate::errors::Result<String> {
    let output = crate::process::create_command(ffmpeg_path)
        .arg("-version")
        .output()
        .map_err(|e| crate::errors::InternalError::Media(format!("ffmpeg version: {e}")))?;

    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text
        .lines()
        .next()
        .unwrap_or("unknown")
        .split_whitespace()
        .nth(2)
        .unwrap_or("unknown")
        .to_string())
}

/// Return true if this FFmpeg build supports the given filter (e.g. "ddagrab").
///
/// Used to decide whether display capture can use the Desktop Duplication API
/// (`ddagrab`) or must fall back to `gdigrab`. Probed via `ffmpeg -h filter=…`,
/// which exits successfully only when the filter exists.
#[instrument(skip(ffmpeg_path))]
pub fn ffmpeg_has_filter(ffmpeg_path: &str, filter: &str) -> bool {
    let status = crate::process::create_command(ffmpeg_path)
        .args(["-hide_banner", "-h", &format!("filter={filter}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let available = status.map(|s| s.success()).unwrap_or(false);
    info!(filter, available, "probed ffmpeg filter availability");
    available
}

/// Probe whether a DirectShow device can actually be opened for capture.
///
/// This helper remains available for legacy webcam/device diagnostics. Audio
/// recording no longer calls it; microphone and system audio use WASAPI.
#[instrument(skip(ffmpeg_path, input_spec))]
pub fn probe_dshow_device(ffmpeg_path: &str, input_spec: &str) -> bool {
    let output = crate::process::create_command(ffmpeg_path)
        .args(["-hide_banner", "-f", "dshow", "-i", input_spec])
        .args(["-t", "0.1", "-f", "null", "-"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output();

    match output {
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            // FFmpeg prints these when the device can't be opened at all.
            // A device that opens (even if the 0.1s capture has minor issues)
            // will not contain these strings.
            let unopenable = stderr.contains("Error opening input")
                || stderr.contains("Could not find")
                || stderr.contains("Cannot run dshow");
            info!(
                openable = !unopenable,
                input = input_spec,
                "probed dshow device"
            );
            !unopenable
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webcam_stitch_filter_preserves_each_segment_start_offset() {
        let filter = build_webcam_stitch_filter(&[
            WebcamSegmentInput {
                path: PathBuf::from("webcam_000.mp4"),
                duration: Duration::from_secs(3),
                offset_ms: 240,
            },
            WebcamSegmentInput {
                path: PathBuf::from("webcam_001.mp4"),
                duration: Duration::from_secs(2),
                offset_ms: -80,
            },
        ]);

        assert!(filter.contains("tpad=start_mode=add:start_duration=0.240000"));
        assert!(filter.contains("trim=start=0.080000"));
        assert!(filter.contains("concat=n=2:v=1:a=0[webcam]"));
    }
}
