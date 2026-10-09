use tauri::State;
use tracing::instrument;

use crate::database::media::{MediaJob, MediaMetadata};
use crate::errors::{InternalError, Result};
use crate::jobs::PrepareOptions;
use crate::media::disk::{available_space, estimate_derivative_size};
use crate::state::AppState;

/// Options for starting a media preparation job.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartMediaJobOptions {
    pub recording_id: String,
    pub proxy_height: Option<i32>,
    pub thumbnail_interval_sec: Option<u64>,
    pub include_proxy: Option<bool>,
    pub force: Option<bool>,
}

/// Start a prepare job for a recording.
#[tauri::command]
#[instrument]
pub fn prepare_media(
    options: StartMediaJobOptions,
    state: State<'_, AppState>,
) -> Result<MediaJob> {
    let _update_operation = state.update_gate.acquire_operation()?;
    let manager = state
        .job_manager
        .lock()
        .map_err(|_| InternalError::Unknown("job manager mutex poisoned".into()))?;

    let job_id = manager.start_prepare(PrepareOptions {
        recording_id: options.recording_id,
        proxy_height: options.proxy_height.unwrap_or(540),
        thumbnail_interval_sec: options.thumbnail_interval_sec.unwrap_or(5),
        include_proxy: options.include_proxy.unwrap_or(false),
        force: options.force.unwrap_or(false),
    })?;

    manager.get_job(&job_id)
}

/// Cancel a media job.
#[tauri::command]
#[instrument]
pub fn cancel_media_job(job_id: String, state: State<'_, AppState>) -> Result<()> {
    let manager = state
        .job_manager
        .lock()
        .map_err(|_| InternalError::Unknown("job manager mutex poisoned".into()))?;
    manager.cancel_job(&job_id)
}

/// Get a media job.
#[tauri::command]
#[instrument]
pub fn get_media_job(job_id: String, state: State<'_, AppState>) -> Result<MediaJob> {
    let manager = state
        .job_manager
        .lock()
        .map_err(|_| InternalError::Unknown("job manager mutex poisoned".into()))?;
    manager.get_job(&job_id)
}

/// List media jobs for a recording.
#[tauri::command]
#[instrument]
pub fn list_media_jobs(recording_id: String, state: State<'_, AppState>) -> Result<Vec<MediaJob>> {
    let manager = state
        .job_manager
        .lock()
        .map_err(|_| InternalError::Unknown("job manager mutex poisoned".into()))?;
    manager.list_jobs(&recording_id)
}

/// Delete derivative files and their database rows for a recording.
#[tauri::command]
#[instrument]
pub fn delete_derivatives(recording_id: String, state: State<'_, AppState>) -> Result<()> {
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    crate::database::media::delete_derivatives_for_recording(&db, &recording_id, true)
}

/// Read cached media metadata for a recording.
#[tauri::command]
#[instrument]
pub fn get_media_metadata(
    recording_id: String,
    state: State<'_, AppState>,
) -> Result<Option<MediaMetadata>> {
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    crate::database::media::get_metadata(&db, &recording_id)
}

/// Estimate disk space needed for a prepare job.
#[tauri::command]
#[instrument]
pub fn estimate_prepare_disk_space(
    recording_id: String,
    proxy_height: Option<i32>,
    thumbnail_interval_sec: Option<u64>,
    include_proxy: Option<bool>,
    state: State<'_, AppState>,
) -> Result<DiskSpaceEstimate> {
    let db = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;

    let recording = crate::database::library::get_recording(&db, &recording_id)?;
    let output_path = recording
        .output_path
        .as_ref()
        .ok_or_else(|| InternalError::Media("recording has no output path".into()))?;

    let metadata = match crate::database::media::get_metadata(&db, &recording_id)? {
        Some(m) => m,
        None => crate::media::probe::probe_media(
            &state.ffprobe_path.to_string_lossy(),
            std::path::Path::new(output_path),
            &recording_id,
        )?,
    };

    drop(db);

    let proxy_height = proxy_height.unwrap_or(540);
    let thumbnail_interval_sec = thumbnail_interval_sec.unwrap_or(5);
    let required = estimate_derivative_size(
        &metadata,
        proxy_height,
        thumbnail_interval_sec,
        include_proxy.unwrap_or(false),
    );
    let available = available_space(std::path::Path::new(output_path))?;

    Ok(DiskSpaceEstimate {
        bytes_required: required,
        bytes_available: available,
        bytes_free_after: available.saturating_sub(required),
        safe: available > required,
    })
}

/// Disk space estimate returned to the UI.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskSpaceEstimate {
    pub bytes_required: u64,
    pub bytes_available: u64,
    pub bytes_free_after: u64,
    pub safe: bool,
}

/// Silence interval detected by Smart Cut.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SilenceRange {
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Parse FFmpeg `silencedetect` stderr into millisecond ranges. An
/// unterminated trailing `silence_start` (file ends mid-silence) is clamped
/// to `duration_ms`.
fn parse_silence_ranges(stderr: &str, duration_ms: u64) -> Vec<SilenceRange> {
    let mut ranges = Vec::new();
    let mut open_start_ms: Option<u64> = None;
    for line in stderr.lines() {
        if let Some(pos) = line.find("silence_start:") {
            let value = line[pos + "silence_start:".len()..].trim();
            if let Ok(seconds) = value.parse::<f64>() {
                open_start_ms = Some((seconds * 1000.0).round() as u64);
            }
        } else if let Some(pos) = line.find("silence_end:") {
            let value = line[pos + "silence_end:".len()..]
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim();
            if let Ok(seconds) = value.parse::<f64>() {
                if let Some(start_ms) = open_start_ms.take() {
                    let end_ms = (seconds * 1000.0).round() as u64;
                    if end_ms > start_ms {
                        ranges.push(SilenceRange { start_ms, end_ms });
                    }
                }
            }
        }
    }
    if let Some(start_ms) = open_start_ms {
        if duration_ms > start_ms {
            ranges.push(SilenceRange {
                start_ms,
                end_ms: duration_ms,
            });
        }
    }
    ranges
}

/// Scan a recording's audio for silence ranges (Smart Cut — Pro).
/// `threshold_db` is the silence noise floor (e.g. -35 dB) and
/// `min_duration_ms` the minimum silence length to report.
#[tauri::command]
#[instrument]
pub async fn detect_silences(
    recording_id: String,
    threshold_db: Option<f64>,
    min_duration_ms: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Vec<SilenceRange>> {
    if !state.license.entitlements().pro_enabled {
        return Err(crate::errors::AppError::new(
            crate::errors::ErrorCategory::Licensing,
            "pro_feature_required",
            "This feature requires RecordForge Pro",
        )
        .with_details(
            [("features".to_string(), serde_json::json!(["smart-cut"]))]
                .into_iter()
                .collect(),
        ));
    }
    let threshold_db = threshold_db.unwrap_or(-35.0).clamp(-60.0, -10.0);
    let min_duration_s = (min_duration_ms.unwrap_or(500).max(50)) as f64 / 1000.0;

    let (output_path, duration_ms, audio_indices) = {
        let db = state
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let recording = crate::database::library::get_recording(&db, &recording_id)?;
        let output_path = recording
            .output_path
            .clone()
            .ok_or_else(|| InternalError::Media("recording has no output path".into()))?;
        let metadata = crate::database::media::get_metadata(&db, &recording_id)?.or_else(|| {
            crate::media::probe::probe_media(
                &state.ffprobe_path.to_string_lossy(),
                std::path::Path::new(&output_path),
                &recording_id,
            )
            .ok()
        });
        let indices: Vec<i32> = metadata
            .as_ref()
            .map(|m| {
                m.streams
                    .iter()
                    .filter(|s| s.kind == "audio")
                    .map(|s| s.index)
                    .collect()
            })
            .unwrap_or_default();
        let duration = metadata.map(|m| m.duration_ms).unwrap_or(0);
        (output_path, duration, indices)
    };
    if audio_indices.is_empty() {
        return Ok(Vec::new());
    }

    let ffmpeg_path = state.ffmpeg_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = crate::process::create_command(&ffmpeg_path);
        command
            .arg("-hide_banner")
            .arg("-nostats")
            .arg("-i")
            .arg(&output_path);
        if audio_indices.len() == 1 {
            // Single audio stream — plain -af silencedetect.
            command
                .arg("-map")
                .arg(format!("0:{}", audio_indices[0]))
                .arg("-af")
                .arg(format!(
                    "silencedetect=noise={threshold_db}dB:d={min_duration_s}"
                ));
        } else {
            // Multiple streams (mic + system): amerge first so "silence" only
            // fires when EVERY audio source is silent — otherwise we'd cut
            // while one track is still talking.
            let labels: String = audio_indices
                .iter()
                .map(|index| format!("[0:{index}]"))
                .collect();
            command
                .arg("-filter_complex")
                .arg(format!(
                    "{labels}amerge=inputs={}[a];[a]silencedetect=noise={threshold_db}dB:d={min_duration_s}",
                    audio_indices.len()
                ))
                .args(["-map", "[a]"]);
        }
        command.args(["-f", "null", "-"]);
        let output = command
            .output()
            .map_err(|error| InternalError::Media(format!("silencedetect spawn: {error}")))?;
        // silencedetect reports on stderr; exit failure still yields partial
        // output worth parsing, so don't gate on status here.
        let stderr = String::from_utf8_lossy(&output.stderr);
        Ok(parse_silence_ranges(&stderr, duration_ms))
    })
    .await
    .map_err(|error| InternalError::Media(format!("silencedetect task: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_detect_output_parses_ranges_and_eof_tail() {
        let stderr = r#"
[silencedetect @ 000001] silence_start: 1.5
[silencedetect @ 000001] silence_end: 3.25 | silence_duration: 1.75
[silencedetect @ 000001] silence_start: 7
"#;
        let ranges = parse_silence_ranges(stderr, 12_000);
        assert_eq!(
            ranges,
            vec![
                SilenceRange {
                    start_ms: 1500,
                    end_ms: 3250
                },
                // Trailing silence_start without silence_end clamps to duration.
                SilenceRange {
                    start_ms: 7000,
                    end_ms: 12_000
                },
            ]
        );
    }

    #[test]
    fn silence_detect_ignores_zero_length_and_unpaired_end() {
        let stderr = "silence_end: 2.0 | silence_duration: 1.0\nsilence_start: 5.0\nsilence_end: 5.0 | silence_duration: 0\n";
        let ranges = parse_silence_ranges(stderr, 10_000);
        assert!(ranges.is_empty());
    }
}
