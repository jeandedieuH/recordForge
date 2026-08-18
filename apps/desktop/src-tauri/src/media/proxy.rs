use std::path::Path;
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tracing::{info, instrument};

use crate::database::media::MediaMetadata;
use crate::errors::{InternalError, Result};

use super::run_ffmpeg_with_progress;

/// Build the FFmpeg command for one proxy encode.
///
/// Proxies are disposable scrub media, so hardware encoders run their
/// speed-oriented tier at roughly the software CRF 28 quality level. Unknown
/// encoder ids fall back to the software path so a stale detection result can
/// never produce an invalid command.
pub(crate) fn build_proxy_command(
    ffmpeg_path: &str,
    input: &Path,
    output: &Path,
    metadata: &MediaMetadata,
    proxy_height: i32,
    encoder: &str,
) -> Command {
    let has_audio = metadata.has_audio;
    let scale = if metadata.width.is_some() && metadata.height.is_some() {
        format!("scale=-2:{proxy_height}")
    } else {
        format!("scale=960:{proxy_height}")
    };

    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .arg("-y")
        .arg("-i")
        .arg(input)
        .args(["-map", "0:v:0", "-vf", &scale])
        .arg("-c:v");

    match encoder {
        "h264_nvenc" => {
            command
                .arg("h264_nvenc")
                .args(["-preset", "p4"])
                .args(["-rc", "vbr", "-cq", "28"])
                // A nonzero default bitrate cap would override -cq.
                .args(["-b:v", "0"]);
        }
        "h264_qsv" => {
            command
                .arg("h264_qsv")
                .args(["-preset", "veryfast", "-global_quality", "28"]);
        }
        "h264_amf" => {
            command.arg("h264_amf").args([
                "-quality", "speed", "-rc", "cqp", "-qp_i", "28", "-qp_p", "30",
            ]);
        }
        "h264_mf" => {
            // Media Foundation has no reliable constant-quality mode; derive a
            // CBR target from the proxy's own dimensions (~0.06 bits/pixel).
            let width = scaled_proxy_width(metadata, proxy_height);
            let bitrate_kbps = (width * proxy_height as i64 * 30 * 6 / 100_000).clamp(500, 8_000);
            command
                .arg("h264_mf")
                .args(["-rate_control", "cbr"])
                .arg("-b:v")
                .arg(format!("{bitrate_kbps}k"));
        }
        _ => {
            command
                .arg("libx264")
                .args(["-preset", "veryfast", "-crf", "28"]);
        }
    }
    command.args(["-pix_fmt", "yuv420p"]);

    if has_audio {
        command.args(["-map", "0:a?", "-c:a", "aac", "-b:a", "96k"]);
    } else {
        command.arg("-an");
    }

    command.args(["-movflags", "+faststart"]).arg(output);
    command
}

fn scaled_proxy_width(metadata: &MediaMetadata, proxy_height: i32) -> i64 {
    match (metadata.width, metadata.height) {
        (Some(width), Some(height)) if height > 0 => {
            ((width as i64 * proxy_height as i64 + height as i64 / 2) / height as i64).max(2)
        }
        _ => 960,
    }
}

/// Generate a lower-resolution editing proxy.
#[allow(clippy::too_many_arguments)]
#[instrument(skip(ffmpeg_path, metadata, cancel, on_progress))]
pub fn generate_proxy(
    ffmpeg_path: &str,
    input: &Path,
    output: &Path,
    metadata: &MediaMetadata,
    proxy_height: i32,
    encoder: &str,
    cancel: Arc<AtomicBool>,
    mut on_progress: impl FnMut(f64) + Send + 'static,
) -> Result<u64> {
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| InternalError::Storage(format!("create proxy dir: {e}")))?;
    }

    let command = build_proxy_command(ffmpeg_path, input, output, metadata, proxy_height, encoder);

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::media::{MediaMetadata, MediaStream};

    fn metadata(has_audio: bool) -> MediaMetadata {
        MediaMetadata {
            recording_id: "rec-1".into(),
            path: "recording.mp4".into(),
            duration_ms: 10_000,
            width: Some(1920),
            height: Some(1080),
            fps: Some(30.0),
            has_audio,
            video_codec: Some("h264".into()),
            audio_codec: None,
            bitrate_kbps: None,
            streams: vec![MediaStream {
                index: 0,
                kind: "video".into(),
                codec: "h264".into(),
                title: None,
                start_ms: None,
                duration_ms: Some(10_000),
                codec_long_name: None,
                width: Some(1920),
                height: Some(1080),
                fps: Some(30.0),
                bitrate_kbps: None,
                sample_rate: None,
                channels: None,
                channel_layout: None,
                language: None,
            }],
            format: Default::default(),
            updated_at: String::new(),
        }
    }

    fn args_of(encoder: &str) -> Vec<String> {
        build_proxy_command(
            "ffmpeg",
            Path::new("in.mp4"),
            Path::new("out/proxy.mp4"),
            &metadata(true),
            540,
            encoder,
        )
        .get_args()
        .map(|value| value.to_string_lossy().to_string())
        .collect()
    }

    #[test]
    fn software_proxy_keeps_the_legacy_encoding_args() {
        let args = args_of("libx264");
        assert!(args.windows(2).any(|pair| pair == ["-c:v", "libx264"]));
        assert!(args.windows(2).any(|pair| pair == ["-preset", "veryfast"]));
        assert!(args.windows(2).any(|pair| pair == ["-crf", "28"]));
        assert!(args.windows(2).any(|pair| pair == ["-pix_fmt", "yuv420p"]));
        assert!(args.windows(2).any(|pair| pair == ["-b:a", "96k"]));
    }

    #[test]
    fn nvenc_proxy_uses_constant_quality_vbr() {
        let args = args_of("h264_nvenc");
        assert!(args.windows(2).any(|pair| pair == ["-c:v", "h264_nvenc"]));
        assert!(args.windows(2).any(|pair| pair == ["-preset", "p4"]));
        assert!(args.windows(2).any(|pair| pair == ["-rc", "vbr"]));
        assert!(args.windows(2).any(|pair| pair == ["-cq", "28"]));
        assert!(args.windows(2).any(|pair| pair == ["-b:v", "0"]));
    }

    #[test]
    fn qsv_and_amf_proxies_use_speed_oriented_quality() {
        let args = args_of("h264_qsv");
        assert!(args.windows(2).any(|pair| pair == ["-c:v", "h264_qsv"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-global_quality", "28"]));

        let args = args_of("h264_amf");
        assert!(args.windows(2).any(|pair| pair == ["-quality", "speed"]));
        assert!(args.windows(2).any(|pair| pair == ["-qp_i", "28"]));
        assert!(args.windows(2).any(|pair| pair == ["-qp_p", "30"]));
    }

    #[test]
    fn mf_proxy_derives_a_cbr_target_from_proxy_dimensions() {
        let args = args_of("h264_mf");
        assert!(args.windows(2).any(|pair| pair == ["-rate_control", "cbr"]));
        // 1920x1080 at 540p keeps a 16:9 ratio: 960*540*30*0.06/1000 ≈ 933k.
        assert!(args.windows(2).any(|pair| pair == ["-b:v", "933k"]));
    }

    #[test]
    fn unknown_encoder_ids_fall_back_to_software() {
        let args = args_of("h264_some_future_encoder");
        assert!(args.windows(2).any(|pair| pair == ["-c:v", "libx264"]));
    }
}
