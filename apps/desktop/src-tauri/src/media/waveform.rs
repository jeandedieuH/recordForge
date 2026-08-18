use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tracing::{info, instrument};

use crate::database::media::MediaMetadata;
use crate::errors::{InternalError, Result};

const SAMPLE_RATE: u32 = 1000;
const SAMPLES_PER_PEAK: u32 = 100; // 0.1 second peaks

/// Compact waveform peak data.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformData {
    pub sample_rate: u32,
    pub samples_per_peak: u32,
    pub peaks: Vec<f32>,
    pub duration_ms: u64,
    pub image_path: Option<String>,
}

/// Generate a waveform PNG and JSON peak file for the first audio stream.
#[instrument(skip(ffmpeg_path, input, output_dir, metadata, cancel))]
pub fn generate_waveform(
    ffmpeg_path: &str,
    input: &Path,
    output_dir: &Path,
    metadata: &MediaMetadata,
    cancel: Arc<AtomicBool>,
) -> Result<(PathBuf, PathBuf)> {
    generate_waveform_internal(ffmpeg_path, input, output_dir, metadata, None, cancel)
}

/// Generate a waveform for one specific FFmpeg stream.
#[instrument(skip(ffmpeg_path, input, output_dir, metadata, cancel))]
pub fn generate_waveform_for_stream(
    ffmpeg_path: &str,
    input: &Path,
    output_dir: &Path,
    metadata: &MediaMetadata,
    stream_index: i32,
    cancel: Arc<AtomicBool>,
) -> Result<(PathBuf, PathBuf)> {
    generate_waveform_internal(
        ffmpeg_path,
        input,
        output_dir,
        metadata,
        Some(stream_index),
        cancel,
    )
}

fn generate_waveform_internal(
    ffmpeg_path: &str,
    input: &Path,
    output_dir: &Path,
    metadata: &MediaMetadata,
    stream_index: Option<i32>,
    cancel: Arc<AtomicBool>,
) -> Result<(PathBuf, PathBuf)> {
    std::fs::create_dir_all(output_dir)
        .map_err(|e| InternalError::Storage(format!("create waveform dir: {e}")))?;

    if !metadata.has_audio {
        return Err(InternalError::Media("recording has no audio stream".into()).into());
    }

    let png_path = output_dir.join("waveform.png");
    let json_path = output_dir.join("waveform.json");

    generate_waveform_png(ffmpeg_path, input, &png_path, stream_index, cancel.clone())?;

    let peaks = extract_peaks(ffmpeg_path, input, stream_index, cancel)?;
    let data = WaveformData {
        sample_rate: SAMPLE_RATE,
        samples_per_peak: SAMPLES_PER_PEAK,
        peaks,
        duration_ms: metadata.duration_ms,
        image_path: Some(png_path.to_string_lossy().to_string()),
    };

    let json = serde_json::to_string_pretty(&data)
        .map_err(|e| InternalError::Storage(format!("serialize waveform: {e}")))?;
    std::fs::write(&json_path, json)
        .map_err(|e| InternalError::Storage(format!("write waveform json: {e}")))?;

    Ok((json_path, png_path))
}

fn build_waveform_png_args(
    input: &Path,
    output: &Path,
    stream_index: Option<i32>,
) -> Vec<OsString> {
    let input_label =
        stream_index.map_or_else(|| "0:a:0".to_string(), |index| format!("0:{index}"));
    let filter = format!(
        "[{input_label}]aformat=channel_layouts=mono,showwavespic=s=1600x120:colors=#3b82f6[waveform]"
    );

    vec![
        OsString::from("-y"),
        OsString::from("-i"),
        input.as_os_str().to_owned(),
        OsString::from("-filter_complex"),
        OsString::from(filter),
        OsString::from("-map"),
        OsString::from("[waveform]"),
        OsString::from("-an"),
        OsString::from("-frames:v"),
        OsString::from("1"),
        OsString::from("-c:v"),
        OsString::from("png"),
        OsString::from("-f"),
        OsString::from("image2"),
        output.as_os_str().to_owned(),
    ]
}

fn generate_waveform_png(
    ffmpeg_path: &str,
    input: &Path,
    output: &Path,
    stream_index: Option<i32>,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    let mut command = crate::process::create_command(ffmpeg_path);
    command.args(build_waveform_png_args(input, output, stream_index));

    info!("generating waveform png");

    let result = command
        .output()
        .map_err(|e| InternalError::Media(format!("waveform png run: {e}")))?;
    if cancel.load(Ordering::Relaxed) {
        let _ = std::fs::remove_file(output);
        return Err(InternalError::Media("waveform cancelled".into()).into());
    }
    if !result.status.success() {
        let _ = std::fs::remove_file(output);
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(InternalError::Media(format!("waveform png failed: {stderr}")).into());
    }

    Ok(())
}

fn extract_peaks(
    ffmpeg_path: &str,
    input: &Path,
    stream_index: Option<i32>,
    cancel: Arc<AtomicBool>,
) -> Result<Vec<f32>> {
    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .arg("-i")
        .arg(input);
    if let Some(stream_index) = stream_index {
        command.args(["-map", &format!("0:{stream_index}")]);
    }
    command.args([
        "-ac",
        "1",
        "-ar",
        &SAMPLE_RATE.to_string(),
        "-sample_fmt",
        "s16",
        "-f",
        "s16le",
        "pipe:1",
    ]);

    let mut child = command
        .spawn()
        .map_err(|e| InternalError::Media(format!("peak extract run: {e}")))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| InternalError::Media("peak stdout unavailable".into()))?;

    let mut peaks: Vec<f32> = Vec::new();
    let mut window_max: f32 = 0.0;
    let mut window_count: u32 = 0;
    let mut buf = [0u8; 8192];

    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(InternalError::Media("waveform cancelled".into()).into());
        }

        match stdout.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let samples = n / 2;
                for i in 0..samples {
                    let bytes = [buf[i * 2], buf[i * 2 + 1]];
                    let raw = i16::from_le_bytes(bytes);
                    let sample = raw as f32 / i16::MAX as f32;
                    let abs = sample.abs();
                    if abs > window_max {
                        window_max = abs;
                    }
                    window_count += 1;
                    if window_count >= SAMPLES_PER_PEAK {
                        peaks.push(window_max);
                        window_max = 0.0;
                        window_count = 0;
                    }
                }
            }
            Err(e) => {
                let _ = child.kill();
                return Err(InternalError::Media(format!("read peak samples: {e}")).into());
            }
        }
    }

    if window_count > 0 {
        peaks.push(window_max);
    }

    let status = child
        .wait()
        .map_err(|e| InternalError::Media(format!("peak wait: {e}")))?;
    if !status.success() {
        return Err(InternalError::Media("peak extraction failed".into()).into());
    }

    Ok(peaks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waveform_png_command_maps_only_the_filter_video_output() {
        let args =
            build_waveform_png_args(Path::new("input.mp4"), Path::new("waveform.png"), Some(1));
        let args = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(
            args,
            vec![
                "-y",
                "-i",
                "input.mp4",
                "-filter_complex",
                "[0:1]aformat=channel_layouts=mono,showwavespic=s=1600x120:colors=#3b82f6[waveform]",
                "-map",
                "[waveform]",
                "-an",
                "-frames:v",
                "1",
                "-c:v",
                "png",
                "-f",
                "image2",
                "waveform.png",
            ]
        );
    }
}
