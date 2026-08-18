use serde::Deserialize;
use std::path::Path;
use std::process::Stdio;
use tracing::instrument;

use crate::database::media::{MediaFormat, MediaMetadata, MediaStream};
use crate::errors::{InternalError, Result};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct FfprobeStream {
    index: i32,
    codec_type: String,
    codec_name: Option<String>,
    codec_long_name: Option<String>,
    width: Option<i32>,
    height: Option<i32>,
    r_frame_rate: Option<String>,
    avg_frame_rate: Option<String>,
    bit_rate: Option<String>,
    sample_rate: Option<String>,
    channels: Option<i32>,
    channel_layout: Option<String>,
    duration: Option<String>,
    start_time: Option<String>,
    #[serde(default)]
    tags: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct FfprobeFormat {
    format_name: Option<String>,
    duration: Option<String>,
    size: Option<String>,
    bit_rate: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct FfprobeOutput {
    streams: Option<Vec<FfprobeStream>>,
    format: Option<FfprobeFormat>,
}

/// Probe a media file with FFprobe and return normalized metadata.
#[instrument(skip(ffprobe_path, input))]
pub fn probe_media(ffprobe_path: &str, input: &Path, recording_id: &str) -> Result<MediaMetadata> {
    if !input.exists() {
        return Err(InternalError::Media(format!("input not found: {}", input.display())).into());
    }

    let output = crate::process::create_command(ffprobe_path)
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(input)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| InternalError::Media(format!("ffprobe run: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(InternalError::Media(format!("ffprobe failed: {stderr}")).into());
    }

    let parsed: FfprobeOutput = serde_json::from_slice(&output.stdout)
        .map_err(|e| InternalError::Media(format!("ffprobe parse: {e}")))?;

    let mut metadata = MediaMetadata {
        recording_id: recording_id.to_string(),
        path: input.to_string_lossy().to_string(),
        duration_ms: 0,
        width: None,
        height: None,
        fps: None,
        has_audio: false,
        video_codec: None,
        audio_codec: None,
        bitrate_kbps: None,
        streams: Vec::new(),
        format: MediaFormat::default(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    };

    if let Some(format) = parsed.format {
        metadata.format.name = format.format_name.unwrap_or_default();
        metadata.format.duration_ms = format
            .duration
            .as_ref()
            .and_then(|s| parse_seconds_to_ms(s));
        metadata.format.size_bytes = format.size.as_ref().and_then(|s| s.parse().ok());
        metadata.format.bitrate_kbps = format
            .bit_rate
            .as_ref()
            .and_then(|s| s.parse::<f64>().ok())
            .map(|b| b / 1000.0);
        metadata.bitrate_kbps = metadata.format.bitrate_kbps;
    }

    if let Some(streams) = parsed.streams {
        for s in streams {
            let kind = s.codec_type.to_lowercase();
            let fps = s
                .r_frame_rate
                .as_ref()
                .or(s.avg_frame_rate.as_ref())
                .and_then(|s| parse_rational_fps(s));

            let bitrate_kbps = s
                .bit_rate
                .as_ref()
                .and_then(|b| b.parse::<f64>().ok())
                .map(|b| b / 1000.0);

            let sample_rate = s.sample_rate.as_ref().and_then(|sr| sr.parse().ok());

            let language = s
                .tags
                .get("language")
                .or_else(|| s.tags.get("LANGUAGE"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let title = stream_title(&s.tags);
            let start_ms = s
                .start_time
                .as_ref()
                .and_then(|value| parse_seconds_to_ms(value));
            let duration_ms = s
                .duration
                .as_ref()
                .and_then(|value| parse_seconds_to_ms(value));

            metadata.streams.push(MediaStream {
                index: s.index,
                kind: kind.clone(),
                codec: s.codec_name.clone().unwrap_or_default(),
                title,
                start_ms,
                duration_ms,
                codec_long_name: s.codec_long_name.clone(),
                width: s.width,
                height: s.height,
                fps,
                bitrate_kbps,
                sample_rate,
                channels: s.channels,
                channel_layout: s.channel_layout.clone(),
                language,
            });

            if kind == "video" {
                metadata.width = metadata.width.or(s.width);
                metadata.height = metadata.height.or(s.height);
                metadata.fps = metadata.fps.or(fps);
                metadata.video_codec = metadata.video_codec.or(s.codec_name.clone());

                // Some formats only expose duration at the stream level.
                if metadata.format.duration_ms.is_none() {
                    metadata.format.duration_ms =
                        s.duration.as_ref().and_then(|s| parse_seconds_to_ms(s));
                }
            } else if kind == "audio" {
                metadata.has_audio = true;
                metadata.audio_codec = metadata.audio_codec.or(s.codec_name.clone());
            }
        }
    }

    metadata.duration_ms = metadata.format.duration_ms.unwrap_or(0);

    Ok(metadata)
}

fn stream_title(tags: &serde_json::Map<String, serde_json::Value>) -> Option<String> {
    ["title", "name", "NAME", "handler_name", "HANDLER_NAME"]
        .iter()
        .find_map(|key| {
            tags.get(*key)
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty() && *value != "SoundHandler")
        })
        .map(str::to_string)
}

fn parse_rational_fps(s: &str) -> Option<f64> {
    let s = s.trim();
    if let Some(idx) = s.find('/') {
        let num: f64 = s[..idx].parse().ok()?;
        let den: f64 = s[idx + 1..].parse().ok()?;
        if den == 0.0 {
            return None;
        }
        Some(num / den)
    } else {
        s.parse().ok()
    }
}

fn parse_seconds_to_ms(s: &str) -> Option<u64> {
    s.parse::<f64>()
        .ok()
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .map(|seconds| (seconds * 1000.0) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_ffmpeg_name_over_generic_sound_handler() {
        let tags = serde_json::json!({
            "handler_name": "SoundHandler",
            "name": "System Audio",
        })
        .as_object()
        .cloned()
        .expect("object tags");

        assert_eq!(stream_title(&tags).as_deref(), Some("System Audio"));
    }

    #[test]
    fn ignores_generic_handler_when_no_specific_title_exists() {
        let tags = serde_json::json!({ "handler_name": "SoundHandler" })
            .as_object()
            .cloned()
            .expect("object tags");

        assert_eq!(stream_title(&tags), None);
    }
}
