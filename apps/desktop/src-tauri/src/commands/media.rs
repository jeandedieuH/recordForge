use std::path::{Path, PathBuf};

use tauri::State;
use tracing::instrument;

use crate::database::media::{MediaJob, MediaMetadata};
use crate::errors::{InternalError, Result};
use crate::exports::audio_analysis::{
    analyze_timeline_silences, parse_silence_ranges, smart_cut_cancelled, SilenceRange,
    SilenceScanResult,
};
use crate::exports::RenderPlan;
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

/// Pro gate shared by the Smart Cut commands; failure reports the feature key
/// so the UI can deep-link the upgrade dialog.
fn require_pro_smart_cut(state: &AppState) -> Result<()> {
    if state.license.entitlements().pro_enabled {
        return Ok(());
    }
    Err(crate::errors::AppError::new(
        crate::errors::ErrorCategory::Licensing,
        "pro_feature_required",
        "This feature requires RecordForge Pro",
    )
    .with_details(
        [("features".to_string(), serde_json::json!(["smart-cut"]))]
            .into_iter()
            .collect(),
    ))
}

/// Validate Smart Cut detection inputs: the threshold must be a finite dB
/// value and the minimum duration must not underflow FFmpeg's `d=` floor.
fn validate_silence_params(
    threshold_db: Option<f64>,
    min_duration_ms: Option<u64>,
) -> Result<(f64, f64)> {
    let threshold_db = match threshold_db {
        Some(value) if value.is_finite() => value.clamp(-60.0, -10.0),
        Some(_) => {
            return Err(
                InternalError::Media("silence threshold must be a finite dB value".into()).into(),
            )
        }
        None => -35.0,
    };
    let min_duration_s = (min_duration_ms.unwrap_or(500).max(50)) as f64 / 1000.0;
    Ok((threshold_db, min_duration_s))
}

/// Timeline-scan params: an absent threshold selects the adaptive RMS
/// calibration; a supplied one must be finite (the analysis clamps it).
fn validate_scan_params(
    threshold_db: Option<f64>,
    min_duration_ms: Option<u64>,
) -> Result<(Option<f64>, u64)> {
    if let Some(value) = threshold_db {
        if !value.is_finite() {
            return Err(
                InternalError::Media("silence threshold must be a finite dB value".into()).into(),
            );
        }
    }
    Ok((threshold_db, min_duration_ms.unwrap_or(500).max(50)))
}

/// Run `silencedetect` over one already-muxed recording file. Multi-stream
/// sources are merged so silence only fires when EVERY source is silent — the
/// final `silencedetect` emits its own `[detected]` pad because a label can
/// only be `-map`ped once it leaves the filter graph (mapping the consumed
/// `[a]` label fails with "already used elsewhere").
fn run_silence_detect(
    ffmpeg_path: &Path,
    input_path: &Path,
    audio_indices: &[i32],
    threshold_db: f64,
    min_duration_s: f64,
    duration_ms: u64,
) -> Result<Vec<SilenceRange>> {
    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .arg("-nostdin")
        .arg("-hide_banner")
        .arg("-nostats")
        .arg("-i")
        .arg(input_path);
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
        let labels: String = audio_indices
            .iter()
            .map(|index| format!("[0:{index}]"))
            .collect();
        command
            .arg("-filter_complex")
            .arg(format!(
                "{labels}amerge=inputs={}[a];[a]silencedetect=noise={threshold_db}dB:d={min_duration_s}[detected]",
                audio_indices.len()
            ))
            .args(["-map", "[detected]"]);
    }
    command.args(["-f", "null", "-"]);
    let output = command
        .output()
        .map_err(|error| InternalError::Media(format!("silencedetect spawn: {error}")))?;
    if !output.status.success() {
        // A failed run must surface as an error — parsing its partial stderr
        // would disguise a broken graph as "zero silences". The raw stderr can
        // carry media paths, so only the exit status is reported.
        return Err(InternalError::Media(format!(
            "silence detection failed (audio engine exited with status {})",
            output.status
        ))
        .into());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Ok(parse_silence_ranges(&stderr, duration_ms))
}

/// Scan a recording's audio for silence ranges (Smart Cut — Pro).
/// `threshold_db` is the silence noise floor (e.g. -35 dB) and
/// `min_duration_ms` the minimum silence length to report. Ranges are
/// source-media milliseconds.
#[tauri::command]
#[instrument]
pub async fn detect_silences(
    recording_id: String,
    threshold_db: Option<f64>,
    min_duration_ms: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Vec<SilenceRange>> {
    require_pro_smart_cut(&state)?;
    let (threshold_db, min_duration_s) = validate_silence_params(threshold_db, min_duration_ms)?;

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
                Path::new(&output_path),
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
        return Err(InternalError::Media(
            "this recording has no audio to analyze — Smart Cut needs an audio track".into(),
        )
        .into());
    }

    let ffmpeg_path = state.ffmpeg_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_silence_detect(
            &ffmpeg_path,
            Path::new(&output_path),
            &audio_indices,
            threshold_db,
            min_duration_s,
            duration_ms,
        )
    })
    .await
    .map_err(|error| InternalError::Media(format!("silencedetect task: {error}")))?
}

/// Smart Cut (Pro): analyze the CURRENT edited timeline's mixed audio —
/// trims, moves, speed changes, mutes, and imported audio all flow through the
/// export audio graph — and return silence ranges in output-timeline
/// milliseconds, the coordinates a ripple-delete consumes directly.
#[tauri::command]
#[instrument(skip(state, plan))]
pub async fn detect_timeline_silences(
    recording_id: String,
    scan_id: String,
    plan: RenderPlan,
    threshold_db: Option<f64>,
    min_duration_ms: Option<u64>,
    state: State<'_, AppState>,
) -> Result<SilenceScanResult> {
    require_pro_smart_cut(&state)?;
    plan.validate()?;
    let (threshold_db, min_duration_ms) = validate_scan_params(threshold_db, min_duration_ms)?;
    // The scan id is part of the admission contract — arbitrary strings
    // would collide with tombstones and cancellation lookups.
    if uuid::Uuid::parse_str(&scan_id).is_err() {
        return Err(InternalError::Media("invalid smart-cut scan id".into()).into());
    }

    // The plan's project must be a saved project owned by this recording — the
    // analysis resolves real file paths from that project, so identity is the
    // security boundary.
    let work_dir = {
        let db = state
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let project =
            crate::database::projects::get_project(&db, &plan.project_id)?.ok_or_else(|| {
                InternalError::Project(
                    "the timeline has not been saved as a project yet — save it, then scan".into(),
                )
            })?;
        if project.recording_id != recording_id {
            return Err(InternalError::Project(
                "render plan does not belong to this recording".into(),
            )
            .into());
        }
        let recording = crate::database::library::get_recording(&db, &recording_id)?;
        PathBuf::from(recording.work_dir)
    };

    let ffmpeg_path = state.ffmpeg_path.clone();
    let ffprobe_path = state.ffprobe_path.clone();
    // Same one-at-a-time gate the JobManager serializes captures and media
    // jobs through — the scan waits cooperatively (cancellable) before heavy
    // decode work instead of racing an in-flight render.
    let resource_gate = state.recorder.resource_gate();
    // Admission happens BEFORE the spawn, not inside it: the update guard and
    // the registry slot are owned here and moved in, so a cancel that lands
    // while the blocking task is still queued still finds (and cancels or
    // tombstones) this registration — it never becomes a no-op.
    let update_operation = state.update_gate.acquire_operation()?;
    let registration = state.smart_cut.begin(&recording_id, &scan_id)?;
    let job = std::sync::Arc::clone(registration.job());
    // Probing, file IO, and the FFmpeg subprocess run off the async runtime;
    // the database lock is already released. Ownership travels with the
    // closure — aborting the async caller can never release it while native
    // work still runs.
    tauri::async_runtime::spawn_blocking(move || {
        let _update_operation = update_operation;
        let _registration = registration;
        if job.is_cancelled() {
            return Err(smart_cut_cancelled());
        }
        let policy = crate::path_policy::PathPolicy::new(work_dir.clone(), work_dir.clone());
        let loaded = crate::projects::load_project(&work_dir, &policy)?.ok_or_else(|| {
            InternalError::Project("project file is required for Smart Cut".into())
        })?;
        if loaded.project.id != plan.project_id {
            return Err(InternalError::Project(
                "project identity does not match the scan request".into(),
            )
            .into());
        }
        let asset_paths = crate::projects::load_asset_path_map(&work_dir)?;
        analyze_timeline_silences(
            &ffmpeg_path,
            Some(&ffprobe_path),
            &plan,
            &asset_paths,
            threshold_db,
            min_duration_ms,
            &resource_gate,
            job.as_ref(),
        )
    })
    .await
    .map_err(|error| InternalError::Media(format!("timeline silence analysis task: {error}")))?
}

/// Stop the in-flight Smart Cut scan identified by `scan_id`. A no-op when
/// that run is no longer registered — a superseded run's cleanup must never
/// kill the newer scan that took its slot.
#[tauri::command]
#[instrument(skip(state))]
pub fn cancel_smart_cut(
    recording_id: String,
    scan_id: String,
    state: State<'_, AppState>,
) -> Result<()> {
    if uuid::Uuid::parse_str(&scan_id).is_err() {
        return Err(InternalError::Media("invalid smart-cut scan id".into()).into());
    }
    state.smart_cut.cancel(&recording_id, &scan_id);
    Ok(())
}

/// Compact keystroke-event payload for the editor canvas + export windows.
/// `supported` tells the UI whether this platform can capture (Windows /
/// macOS only — Linux capture is unimplemented) so it can disable the
/// recorder toggle honestly instead of silently producing nothing.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeystrokeEventsResponse {
    pub supported: bool,
    pub events: Vec<crate::capture::keystrokes::KeystrokeEvent>,
}

/// Read the saved keystroke events for a recording. Events live in the
/// recording's own work dir (`keystrokes.json`) — React never touches the
/// filesystem; loaded labels are re-sanitized on the way out.
#[tauri::command]
#[instrument]
pub async fn get_keystroke_events(
    recording_id: String,
    state: State<'_, AppState>,
) -> Result<KeystrokeEventsResponse> {
    let work_dir = {
        let db = state
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        crate::database::library::get_recording(&db, &recording_id)?.work_dir
    };
    let work_dir = state
        .path_policy
        .validate_recording_path(std::path::Path::new(&work_dir))?;
    let events = tauri::async_runtime::spawn_blocking(move || {
        crate::capture::keystrokes::load_events(&work_dir)
    })
    .await
    .map_err(|_| InternalError::Media("keystroke event load task".into()))??;
    Ok(KeystrokeEventsResponse {
        supported: cfg!(windows) || cfg!(target_os = "macos"),
        events,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

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

    fn real_ffmpeg() -> Option<PathBuf> {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let sidecar = manifest.join("binaries").join(if cfg!(windows) {
            format!("ffmpeg-{}.exe", env!("TARGET_TRIPLE"))
        } else {
            format!("ffmpeg-{}", env!("TARGET_TRIPLE"))
        });
        for path in [
            Some(sidecar),
            crate::media::resolve_executable("ffmpeg").ok(),
            Some(PathBuf::from("ffmpeg")),
            Some(PathBuf::from("ffmpeg.exe")),
        ]
        .into_iter()
        .flatten()
        {
            let output = Command::new(&path)
                .args(["-hide_banner", "-filters"])
                .output();
            if let Ok(output) = output {
                if output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains("silencedetect")
                {
                    return Some(path);
                }
            }
        }
        None
    }

    #[test]
    fn multi_stream_silence_detect_reports_ranges() {
        // Regression: the old graph mapped the consumed `[a]` amerge label —
        // FFmpeg exits with "Output with label 'a' does not exist" and the
        // unchecked status disguised the failure as zero silences.
        let Some(ffmpeg) = real_ffmpeg() else {
            eprintln!("skipping: no ffmpeg with silencedetect");
            return;
        };
        let dir = std::env::temp_dir().join(format!("rf-smartcut-legacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create fixture dir");
        let input = dir.join("two_stream.mp4");
        let status = Command::new(&ffmpeg)
            .args(["-y", "-nostdin", "-hide_banner", "-loglevel", "error"])
            .args([
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x240:rate=15:duration=3",
            ])
            .args(["-f", "lavfi", "-i", "sine=frequency=440:duration=3"])
            .args(["-f", "lavfi", "-i", "sine=frequency=660:duration=3"])
            .args([
                "-filter_complex",
                "[1:a]volume=0:enable='between(t,1,2)'[a1];\
                 [2:a]volume=0:enable='between(t,1,2)'[a2]",
            ])
            .args(["-map", "0:v", "-map", "[a1]", "-map", "[a2]"])
            .args([
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
            ])
            .arg(&input)
            .status()
            .expect("spawn fixture ffmpeg");
        assert!(status.success(), "two-stream fixture generation failed");

        // Streams 1 and 2 are both silent 1..2s → the merged floor reports it.
        let ranges = run_silence_detect(&ffmpeg, &input, &[1, 2], -35.0, 0.5, 3_000)
            .expect("multi-stream detection succeeds");
        assert_eq!(ranges.len(), 1, "expected one shared silence: {ranges:?}");
        assert!(ranges[0].start_ms.abs_diff(1_000) <= 60);
        assert!(ranges[0].end_ms.abs_diff(2_000) <= 60);

        // A missing input is an error — never an empty result.
        assert!(run_silence_detect(
            &ffmpeg,
            &dir.join("missing.mp4"),
            &[1, 2],
            -35.0,
            0.5,
            3_000
        )
        .is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
