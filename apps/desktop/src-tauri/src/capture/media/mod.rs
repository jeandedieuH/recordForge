use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tracing::{info, instrument};

use super::audio::wav::AudioTimelineAlignment;
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
    pub alignment: Option<AudioTimelineAlignment>,
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
///
/// Encoding follows the camera profile (<=30fps) and walks the detected
/// encoder candidates in order, retrying with the next candidate when an
/// encoder fails to initialize — the same fallback chain live capture uses.
#[instrument(skip(ffmpeg_path, segments, output_path, profile, available_encoders))]
pub fn concatenate_webcam_segments(
    ffmpeg_path: &str,
    segments: &[WebcamSegmentInput],
    output_path: &Path,
    profile: &RecordingProfile,
    available_encoders: &[String],
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

    let camera = super::webcam::camera_profile(profile);
    let candidates =
        super::encoder::recording_encoder_candidates(available_encoders, &profile.encoder_priority);

    let mut last_error: Option<crate::errors::InternalError> = None;
    for encoder in &candidates {
        let mut command =
            build_webcam_concat_command(ffmpeg_path, segments, output_path, &camera, encoder);
        let output = command.output().map_err(|error| {
            crate::errors::InternalError::Media(format!("webcam concat run: {error}"))
        })?;
        if !output.status.success() {
            // An encoder that fails to initialize must not abort the whole
            // asset — retry the same private partial path with the next
            // detected candidate (libx264 is always last).
            tracing::warn!(
                encoder,
                "webcam concat encode failed; trying next candidate"
            );
            last_error = Some(crate::errors::InternalError::Media(format!(
                "webcam concat failed with encoder {encoder}"
            )));
            continue;
        }
        last_error = None;
        break;
    }

    if let Some(error) = last_error {
        return Err(error.into());
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

/// Assemble the FFmpeg command that stitches webcam segments onto the screen
/// timeline and re-encodes with the selected encoder. Pure construction so
/// argument layout stays testable without spawning FFmpeg.
fn build_webcam_concat_command(
    ffmpeg_path: &str,
    segments: &[WebcamSegmentInput],
    output_path: &Path,
    camera: &RecordingProfile,
    encoder: &str,
) -> Command {
    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .arg("-y")
        .args(["-hide_banner", "-loglevel", "error"]);
    for segment in segments {
        command.arg("-i").arg(&segment.path);
    }

    let filter = build_webcam_stitch_filter(segments, camera.width, camera.height);
    command
        .args(["-filter_complex", &filter])
        .args(["-map", "[webcam]", "-an"]);
    super::ffmpeg::add_video_encoder(&mut command, camera, encoder, true, camera.fps as f64);
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
    command
}

fn build_webcam_stitch_filter(segments: &[WebcamSegmentInput], width: i32, height: i32) -> String {
    let mut filters = Vec::with_capacity(segments.len() + 1);
    for (index, segment) in segments.iter().enumerate() {
        let duration = segment.duration.as_secs_f64();
        let offset = segment.offset_ms as f64 / 1000.0;
        // Segments negotiated at different camera modes (e.g. after a pause
        // fallback) cannot concat unless geometry matches: scale down without
        // ever upscaling, then black-pad to the target canvas.
        let normalize = format!(
            "scale=w='min(iw,{width})':h='min(ih,{height})':force_original_aspect_ratio=decrease:force_divisible_by=2,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
        );
        let timing = if offset >= 0.0 {
            format!("tpad=start_mode=add:start_duration={offset:.6}:color=black")
        } else {
            format!("trim=start={:.6}", -offset)
        };
        filters.push(format!(
            "[{index}:v]{normalize},{timing},setpts=PTS-STARTPTS,tpad=stop_mode=add:stop_duration={duration:.6}:color=black,trim=duration={duration:.6},setpts=PTS-STARTPTS[v{index}]"
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

fn build_audio_timeline_filter(
    input_index: usize,
    output_index: usize,
    alignment: AudioTimelineAlignment,
) -> String {
    let timeline_end = alignment.head_trim.saturating_add(alignment.duration);
    format!(
        "[{input_index}:a:0]atrim=start_sample={},asetpts=(PTS-STARTPTS)*{:.9}+{:.6}/TB,aresample={}:async=1000:first_pts=0,atrim=start={:.6}:end={:.6},asetpts=PTS-STARTPTS,apad=whole_dur={:.6},atrim=duration={:.6}[aligned_audio_{output_index}]",
        alignment.synthetic_leading_frames,
        alignment.pts_scale,
        alignment.start_offset.as_secs_f64(),
        alignment.sample_rate,
        alignment.head_trim.as_secs_f64(),
        timeline_end.as_secs_f64(),
        alignment.duration.as_secs_f64(),
        alignment.duration.as_secs_f64(),
    )
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

    let filters = audio_tracks
        .iter()
        .enumerate()
        .filter_map(|(index, track)| {
            track
                .alignment
                .map(|alignment| build_audio_timeline_filter(index + 1, index, alignment))
        })
        .collect::<Vec<_>>();
    if !filters.is_empty() {
        command.args(["-filter_complex", &filters.join(";")]);
    }

    command.arg("-map").arg("0:v:0");
    for (index, track) in audio_tracks.iter().enumerate() {
        if track.alignment.is_some() {
            command.args(["-map", &format!("[aligned_audio_{index}]")]);
        } else {
            command.args(["-map", &format!("{}:a:0", index + 1)]);
        }
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
        if audio_codec.starts_with("pcm_") {
            command.args(["-c:a", audio_codec]);
        } else {
            command.args([
                "-c:a",
                audio_codec,
                "-b:a",
                &format!("{audio_bitrate_kbps}k"),
            ]);
        }
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
        let filter = build_webcam_stitch_filter(
            &[
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
            ],
            1280,
            720,
        );

        assert!(filter.contains("tpad=start_mode=add:start_duration=0.240000"));
        assert!(filter.contains("trim=start=0.080000"));
        assert!(filter.contains("concat=n=2:v=1:a=0[webcam]"));
    }

    #[test]
    fn webcam_stitch_filter_normalizes_segment_geometry_before_timing() {
        let filter = build_webcam_stitch_filter(
            &[WebcamSegmentInput {
                path: PathBuf::from("webcam_000.mp4"),
                duration: Duration::from_secs(2),
                offset_ms: 0,
            }],
            1280,
            720,
        );

        // Normalization must run before the trim/tpad timing chain so every
        // concat input already shares the target canvas.
        let scale_pos = filter
            .find("scale=w='min(iw,1280)'")
            .expect("scale present");
        let pad_pos = filter
            .find("pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black")
            .expect("pad present");
        let setsar_pos = filter.find("setsar=1").expect("setsar present");
        let tpad_pos = filter.find("tpad=stop_mode=add").expect("timing tpad");
        assert!(scale_pos < pad_pos && pad_pos < setsar_pos && setsar_pos < tpad_pos);
        // Never upscale: the scale clamps to min(iw, target).
        assert!(filter.contains("h='min(ih,720)'"));
    }

    /// Resolve the first working bundled FFmpeg/FFprobe pair; synthetic tests
    /// skip cleanly when sidecars are not installed.
    #[cfg(windows)]
    fn bundled_ffmpeg_ffprobe() -> Option<(PathBuf, PathBuf)> {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let ffmpeg = manifest_dir.join("binaries/ffmpeg-x86_64-pc-windows-msvc.exe");
        let ffprobe = manifest_dir.join("binaries/ffprobe-x86_64-pc-windows-msvc.exe");
        let ffmpeg_ok = crate::process::create_command(ffmpeg.as_os_str())
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        let ffprobe_ok = crate::process::create_command(ffprobe.as_os_str())
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if ffmpeg_ok && ffprobe_ok {
            Some((ffmpeg, ffprobe))
        } else {
            None
        }
    }

    #[test]
    #[cfg(windows)]
    fn webcam_concat_normalizes_mixed_segment_resolutions() {
        let Some((ffmpeg, ffprobe)) = bundled_ffmpeg_ffprobe() else {
            eprintln!("skipping: FFmpeg/FFprobe sidecars unavailable");
            return;
        };
        let directory = tempfile::tempdir().expect("create media test directory");

        // Two synthetic camera segments at different negotiated resolutions —
        // the exact case a pause/resume mode fallback produces.
        let mut segments = Vec::new();
        for (index, size) in ["640x480", "1280x720"].into_iter().enumerate() {
            let path = directory.path().join(format!("webcam_{index:03}.mp4"));
            let status = crate::process::create_command(ffmpeg.as_os_str())
                .args([
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    &format!("color=c=black:s={size}:r=15:d=1"),
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                ])
                .arg(&path)
                .status()
                .expect("generate synthetic camera segment");
            assert!(status.success(), "generate {size} segment");
            segments.push(WebcamSegmentInput {
                path,
                duration: Duration::from_secs(1),
                offset_ms: 0,
            });
        }

        let profile = RecordingProfile {
            id: "balanced".into(),
            label: "Balanced".into(),
            width: 1920,
            height: 1080,
            fps: 30,
            video_bitrate_kbps: None,
            crf: Some(23),
            encoder_priority: vec!["libx264".into()],
            audio_codec: "aac".into(),
            audio_bitrate_kbps: 128,
        };
        let camera = super::super::webcam::camera_profile(&profile);
        let output_path = directory.path().join("webcam.concat.mp4");
        let mut command = build_webcam_concat_command(
            &ffmpeg.to_string_lossy(),
            &segments,
            &output_path,
            &camera,
            "libx264",
        );
        let output = command.output().expect("run webcam concat");
        assert!(
            output.status.success(),
            "concat must succeed over mixed resolutions"
        );

        let metadata = crate::media::probe::probe_media(
            &ffprobe.to_string_lossy(),
            &output_path,
            "concat-normalize-test",
        )
        .expect("probe concat output");
        let stream = metadata
            .streams
            .iter()
            .find(|stream| stream.kind == "video")
            .expect("video stream");
        assert_eq!(stream.width, Some(camera.width));
        assert_eq!(stream.height, Some(camera.height));
    }

    #[test]
    fn webcam_concat_encodes_at_camera_profile_rate() {
        // A 60fps screen profile must not push the webcam asset to 60fps —
        // the camera profile caps at 30.
        let profile = RecordingProfile {
            id: "smooth-60fps".into(),
            label: "Smooth".into(),
            width: 1920,
            height: 1080,
            fps: 60,
            video_bitrate_kbps: Some(5000),
            crf: Some(24),
            encoder_priority: super::super::config::default_encoder_priority(),
            audio_codec: "aac".into(),
            audio_bitrate_kbps: 128,
        };
        let camera = super::super::webcam::camera_profile(&profile);
        assert_eq!(camera.fps, 30);

        let command = build_webcam_concat_command(
            "ffmpeg",
            &[WebcamSegmentInput {
                path: PathBuf::from("webcam_000.mp4"),
                duration: Duration::from_secs(3),
                offset_ms: 0,
            }],
            Path::new("webcam.partial.mp4"),
            &camera,
            "libx264",
        );
        let debug = format!("{command:?}");
        assert!(debug.contains("\"-c:v\" \"libx264\""));
        assert!(debug.contains("\"-r\" \"30\""));
        assert!(!debug.contains("\"-r\" \"60\""));
    }

    #[test]
    fn webcam_concat_candidates_never_select_undetected_encoders() {
        // With only libx264 detected, the finalize path must never attempt
        // nvenc/MF — a job that cannot initialize would just burn a retry.
        let available = vec!["libx264".to_string()];
        let candidates = super::super::encoder::recording_encoder_candidates(
            &available,
            &super::super::config::default_encoder_priority(),
        );
        assert_eq!(candidates, vec!["libx264".to_string()]);
    }

    #[test]
    fn audio_timeline_filter_applies_start_and_rate_correction() {
        let filter = build_audio_timeline_filter(
            1,
            0,
            AudioTimelineAlignment {
                sample_rate: 48_000,
                synthetic_leading_frames: 9_600,
                start_offset: Duration::from_millis(200),
                source_duration: Duration::from_secs(10),
                wall_duration: Duration::from_millis(10_100),
                pts_scale: 1.01,
                head_trim: Duration::from_millis(100),
                duration: Duration::from_secs(10),
                drift_ms: 100,
            },
        );

        assert!(filter.contains("atrim=start_sample=9600"));
        assert!(filter.contains("asetpts=(PTS-STARTPTS)*1.010000000+0.200000/TB"));
        assert!(filter.contains("aresample=48000:async=1000:first_pts=0"));
        assert!(filter.contains("atrim=start=0.100000:end=10.100000"));
    }

    #[test]
    #[cfg(windows)]
    fn timestamped_audio_mux_places_markers_on_the_master_timeline() {
        use std::io::{Seek, SeekFrom, Write};

        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let candidates = [
            manifest_dir.join("binaries/ffmpeg-x86_64-pc-windows-msvc.exe"),
            manifest_dir.join("target/debug/ffmpeg.exe"),
            PathBuf::from("ffmpeg"),
        ];
        let Some(ffmpeg) = candidates.into_iter().find(|candidate| {
            crate::process::create_command(candidate.as_os_str())
                .arg("-version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        }) else {
            eprintln!("skipping: FFmpeg is unavailable");
            return;
        };

        let directory = tempfile::tempdir().expect("create media test directory");
        let video_path = directory.path().join("video.mkv");
        let audio_path = directory.path().join("microphone.wav");
        let output_path = directory.path().join("aligned.mkv");
        let status = crate::process::create_command(ffmpeg.as_os_str())
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=64x64:r=60:d=4",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&video_path)
            .status()
            .expect("generate video fixture");
        assert!(status.success(), "generate video fixture");

        let sample_rate = 48_000u32;
        let synthetic_leading_frames = 4_800u64;
        let captured_frames = 172_800u64;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&audio_path)
            .expect("open audio fixture");
        super::super::audio::wav::write_wav_header(
            &mut file,
            sample_rate,
            1,
            super::super::audio::wav::AudioSampleFormat::Pcm16,
        )
        .expect("write audio fixture header");
        file.seek(SeekFrom::End(0)).expect("seek audio fixture");
        let total_frames = synthetic_leading_frames + captured_frames;
        let mut samples = vec![0i16; total_frames as usize];
        for start in [38_400usize, 86_400, 134_400] {
            let start = synthetic_leading_frames as usize + start;
            samples[start..start + 480].fill(i16::MAX);
        }
        let bytes = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect::<Vec<_>>();
        file.write_all(&bytes).expect("write audio fixture samples");
        super::super::audio::wav::finalize_wav(&mut file, bytes.len() as u64)
            .expect("finalize audio fixture");
        drop(file);

        let origin = 10_000_000_000;
        let first_packet = origin + 2_000_000;
        let alignment = super::super::audio::wav::compute_audio_timeline_alignment(
            crate::capture::traits::AudioCaptureTiming {
                sample_rate,
                synthetic_leading_frames,
                captured_frames,
                timeline_origin_qpc_100ns: origin,
                first_packet_qpc_100ns: first_packet,
                last_packet_qpc_100ns: first_packet + 36_260_000,
                last_packet_frames: 480,
                timestamp_errors: 0,
                discontinuities: 0,
            },
            Duration::ZERO,
            Duration::from_secs(4),
        )
        .expect("derive audio alignment");
        assert!((alignment.pts_scale - 1.01).abs() < 0.000_001);

        mux_audio_tracks(
            &ffmpeg.to_string_lossy(),
            &video_path,
            &[
                AudioTrackInput {
                    path: audio_path.clone(),
                    title: "Microphone",
                    kind: AudioTrackKind::Microphone,
                    alignment: Some(alignment),
                },
                AudioTrackInput {
                    path: audio_path,
                    title: "System Audio",
                    kind: AudioTrackKind::System,
                    alignment: None,
                },
            ],
            &output_path,
            "pcm_s16le",
            128,
            Duration::from_secs(4),
        )
        .expect("mux aligned audio");

        let decoded = crate::process::create_command(ffmpeg.as_os_str())
            .args(["-v", "error"])
            .arg("-i")
            .arg(&output_path)
            .args([
                "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1",
            ])
            .output()
            .expect("decode aligned audio");
        assert!(decoded.status.success(), "decode aligned audio");
        let (sample_bytes, _) = decoded.stdout.as_chunks::<2>();
        let decoded_samples = sample_bytes
            .iter()
            .map(|bytes| i16::from_le_bytes(*bytes))
            .collect::<Vec<_>>();
        let mut marker_centers = Vec::new();
        let mut index = 0usize;
        while index < decoded_samples.len() {
            if decoded_samples[index].unsigned_abs() < 20_000 {
                index += 1;
                continue;
            }
            let start = index;
            while index < decoded_samples.len() && decoded_samples[index].unsigned_abs() >= 20_000 {
                index += 1;
            }
            if index - start >= 100 {
                marker_centers.push((start + index) / 2);
            }
        }

        assert_eq!(marker_centers.len(), 3);
        for (actual, expected_ms) in marker_centers.iter().zip([1_013u64, 2_023, 3_033]) {
            let actual_ms = (*actual as u64).saturating_mul(1_000) / u64::from(sample_rate);
            assert!(
                actual_ms.abs_diff(expected_ms) <= 17,
                "marker at {actual_ms}ms should be within one frame of {expected_ms}ms"
            );
        }
    }
}
