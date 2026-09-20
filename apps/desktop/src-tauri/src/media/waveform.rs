use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tracing::instrument;

use crate::database::media::MediaMetadata;
use crate::errors::{InternalError, Result};

/// Decoded mono sample rate used for peak extraction. One sample per
/// millisecond keeps the s16le conversion cheap and the math trivial.
const SAMPLE_RATE: u32 = 1000;
/// Minimum analysis window (ms of audio per peak pair).
const MIN_WINDOW_MS: u32 = 20;
/// Upper bound on stored peak pairs so very long recordings do not produce
/// unbounded waveform JSON payloads.
const MAX_PEAK_COUNT: u64 = 48_000;

/// Waveform peak data stored as JSON for fast timeline rendering.
///
/// `peaks` holds the positive envelope and `mins` the negative envelope of
/// each window so the timeline can draw an asymmetric min/max silhouette at
/// any zoom level.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformData {
    pub sample_rate: u32,
    pub samples_per_peak: u32,
    pub peaks: Vec<f32>,
    #[serde(default)]
    pub mins: Vec<f32>,
    pub duration_ms: u64,
    pub image_path: Option<String>,
}

/// Pick the analysis window (in ms, equal to samples per peak at 1 kHz) so a
/// recording produces at most ~MAX_PEAK_COUNT windows while short clips get
/// fine 20 ms detail for zoomed-in rendering.
pub fn waveform_window_ms(duration_ms: u64) -> u32 {
    let duration = duration_ms.max(1);
    let adaptive = duration.div_ceil(MAX_PEAK_COUNT) as u32;
    adaptive.max(MIN_WINDOW_MS)
}

/// Generate a waveform JSON for a whole recording (first audio stream).
#[instrument(skip(ffmpeg_path, input, output_dir, metadata, cancel))]
pub fn generate_waveform(
    ffmpeg_path: &str,
    input: &Path,
    output_dir: &Path,
    metadata: &MediaMetadata,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    let samples_per_peak = waveform_window_ms(metadata.duration_ms);
    let (peaks, mins) = extract_peaks(ffmpeg_path, input, None, samples_per_peak, cancel)?;
    let json_path = output_dir.join("waveform.json");
    write_waveform_json(
        &json_path,
        peaks,
        mins,
        metadata.duration_ms,
        samples_per_peak,
    )?;
    Ok(json_path)
}

/// Generate a waveform JSON for a specific audio stream index.
#[instrument(skip(ffmpeg_path, input, output_dir, metadata, cancel))]
pub fn generate_waveform_for_stream(
    ffmpeg_path: &str,
    input: &Path,
    output_dir: &Path,
    stream_index: i32,
    metadata: &MediaMetadata,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    let samples_per_peak = waveform_window_ms(metadata.duration_ms);
    let (peaks, mins) = extract_peaks(
        ffmpeg_path,
        input,
        Some(stream_index),
        samples_per_peak,
        cancel,
    )?;
    // The output dir is already stream-scoped (waveform/stream_XXX/), so the
    // file name stays plain "waveform.json" — that is the path persisted in
    // MediaAudioTrackOutput.waveform_path.
    let json_path = output_dir.join("waveform.json");
    write_waveform_json(
        &json_path,
        peaks,
        mins,
        metadata.duration_ms,
        samples_per_peak,
    )?;
    Ok(json_path)
}

fn write_waveform_json(
    json_path: &Path,
    peaks: Vec<f32>,
    mins: Vec<f32>,
    duration_ms: u64,
    samples_per_peak: u32,
) -> Result<()> {
    let data = WaveformData {
        sample_rate: SAMPLE_RATE,
        samples_per_peak,
        peaks,
        mins,
        duration_ms,
        image_path: None,
    };
    let json = serde_json::to_string(&data)
        .map_err(|e| InternalError::Storage(format!("serialize waveform data: {e}")))?;
    if let Some(parent) = json_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| InternalError::Storage(format!("create waveform dir: {e}")))?;
    }
    fs::write(json_path, json)
        .map_err(|e| InternalError::Storage(format!("write waveform json: {e}")))?;
    Ok(())
}

fn extract_peaks(
    ffmpeg_path: &str,
    input: &Path,
    stream_index: Option<i32>,
    samples_per_peak: u32,
    cancel: Arc<AtomicBool>,
) -> Result<(Vec<f32>, Vec<f32>)> {
    let mut cmd = crate::process::create_command(ffmpeg_path);
    cmd.arg("-hide_banner")
        .arg("-nostats")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(input);
    if let Some(index) = stream_index {
        cmd.args(["-map", &format!("0:{index}")]);
    } else {
        cmd.args(["-map", "a:0?"]);
    }
    cmd.args([
        "-vn",
        "-ac",
        "1",
        "-ar",
        &SAMPLE_RATE.to_string(),
        "-f",
        "s16le",
        "-",
    ]);

    let output = cmd
        .output()
        .map_err(|e| InternalError::Media(format!("waveform run: {e}")))?;
    if cancel.load(Ordering::Relaxed) {
        return Err(InternalError::Media("waveform cancelled".into()).into());
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(InternalError::Media(format!("waveform ffmpeg failed: {stderr}")).into());
    }

    // Raw s16le → little-endian i16 samples.
    let samples: Vec<i16> = output
        .stdout
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&chunk| i16::from_le_bytes(chunk))
        .collect();

    let window = samples_per_peak.max(1) as usize;
    let mut peaks = Vec::with_capacity(samples.len() / window + 1);
    let mut mins = Vec::with_capacity(peaks.capacity());
    // chunks() keeps a trailing partial window so the waveform reaches the
    // true end of the clip instead of clipping the last fraction.
    for chunk in samples.chunks(window) {
        let mut max_pos = 0i16;
        let mut min_neg = 0i16;
        for &s in chunk {
            if s > max_pos {
                max_pos = s;
            }
            if s < min_neg {
                min_neg = s;
            }
        }
        peaks.push(max_pos as f32 / 32768.0);
        mins.push(min_neg as f32 / 32768.0);
    }

    Ok((peaks, mins))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waveform_window_never_exceeds_the_peak_budget() {
        // Two-hour recording: the window widens so peak count stays bounded.
        let window = waveform_window_ms(7_200_000);
        assert!(7_200_000_u64.div_ceil(u64::from(window)) <= MAX_PEAK_COUNT);
        // Ten-minute recording keeps the fine 20 ms floor.
        assert_eq!(waveform_window_ms(600_000), MIN_WINDOW_MS);
        // Zero-duration input still returns a usable window.
        assert_eq!(waveform_window_ms(0), MIN_WINDOW_MS);
    }
}
