use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::{error, info, instrument};

use crate::capture::media;
use crate::database::library::get_recording;
use crate::database::media::MediaJob;
use crate::errors::{InternalError, Result};
use crate::events::EventPublisher;

mod cursor;

/// A single trimmed segment in the final export.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSegment {
    pub asset_id: Option<String>,
    pub stream_index: Option<i32>,
    pub volume: Option<f64>,
    pub source_in_ms: u64,
    pub source_out_ms: u64,
    pub output_start_ms: u64,
    pub output_end_ms: u64,
}

/// Render plan sent from the TypeScript timeline editor.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPlan {
    pub duration_ms: u64,
    pub segments: Vec<RenderSegment>,
    #[serde(default)]
    pub canvas: Option<cursor::RenderCanvas>,
    #[serde(default)]
    pub audio: Option<RenderPlanAudio>,
    // `Some(empty)` means the current editor intentionally has no audio tracks.
    #[serde(default)]
    pub audio_tracks: Option<Vec<RenderPlanAudio>>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPlanAudio {
    pub asset_id: Option<String>,
    pub stream_index: Option<i32>,
    #[serde(default)]
    pub muted: bool,
    #[serde(default = "default_audio_volume")]
    pub volume: f64,
    #[serde(default)]
    pub segments: Vec<RenderSegment>,
}

fn default_audio_volume() -> f64 {
    1.0
}

/// Run a render plan in a background thread, trimming and concatenating segments.
#[instrument(skip(ffmpeg_path, db, plan, app))]
pub fn run_render_plan(
    recording_id: String,
    output_path: &Path,
    plan: RenderPlan,
    ffmpeg_path: &std::path::Path,
    db: Arc<Mutex<rusqlite::Connection>>,
    app: &tauri::AppHandle,
) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let job = MediaJob {
        id: uuid::Uuid::new_v4().to_string(),
        recording_id: recording_id.clone(),
        kind: crate::database::media::MediaJobKind::Export,
        status: crate::database::media::MediaJobStatus::Running,
        progress: 0.0,
        stage: "preparing".into(),
        message: Some("building segments".into()),
        error: None,
        created_at: now.clone(),
        updated_at: now.clone(),
        started_at: Some(now),
        completed_at: None,
        outputs: Default::default(),
    };

    emit_job_update(app, &job)?;

    let conn = db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    let recording = get_recording(&conn, &recording_id)?;
    drop(conn);

    let source_path = recording
        .output_path
        .as_ref()
        .ok_or_else(|| InternalError::Media("recording has no output path".into()))?;
    let work_dir = PathBuf::from(&recording.work_dir);

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| InternalError::Storage(format!("create export dir: {e}")))?;
    }

    info!(recording_id = %recording_id, ?output_path, "starting timeline export");

    if plan.audio_tracks.is_some() {
        emit_progress(app, &job, 0.15, "rendering", Some("mixing timeline tracks"))?;
        render_timeline_with_audio(
            &ffmpeg_path.to_string_lossy(),
            Path::new(source_path),
            output_path,
            &plan,
            &recording_id,
        )?;
    } else {
        let total = plan.segments.len();
        let mut segment_paths: Vec<PathBuf> = Vec::new();

        for (index, segment) in plan.segments.iter().enumerate() {
            validate_segment(segment, &recording_id)?;
            let progress = if total > 0 {
                (index as f64 / total as f64) * 0.8
            } else {
                0.0
            };
            emit_progress(
                app,
                &job,
                progress,
                "trimming",
                Some(&format!("segment {}/{}", index + 1, total)),
            )?;

            let temp_path = work_dir.join(format!("export_seg_{}_{}.mp4", index, &job.id[..8]));
            media::trim_recording(
                &ffmpeg_path.to_string_lossy(),
                Path::new(source_path),
                &temp_path,
                segment.source_in_ms,
                segment.source_out_ms,
            )?;
            segment_paths.push(temp_path);
        }

        emit_progress(app, &job, 0.9, "concatenating", Some("stitching segments"))?;

        media::concatenate_segments(
            &ffmpeg_path.to_string_lossy(),
            &work_dir,
            &segment_paths,
            output_path,
        )?;

        // Clean up temporary trimmed segments.
        for path in &segment_paths {
            if let Err(err) = std::fs::remove_file(path) {
                error!(?path, %err, "failed to remove temporary export segment");
            }
        }
    }

    apply_cursor_overlay(
        &ffmpeg_path.to_string_lossy(),
        output_path,
        &work_dir,
        &plan,
        &recording_id,
    )?;

    let completed = MediaJob {
        status: crate::database::media::MediaJobStatus::Completed,
        progress: 1.0,
        stage: "completed".into(),
        message: Some("export finished".into()),
        completed_at: Some(chrono::Utc::now().to_rfc3339()),
        outputs: crate::database::media::MediaJobOutputs {
            output_path: Some(output_path.to_string_lossy().to_string()),
            ..Default::default()
        },
        ..job
    };

    emit_job_update(app, &completed)?;
    info!(recording_id = %recording_id, "timeline export completed");

    Ok(())
}

fn render_timeline_with_audio(
    ffmpeg_path: &str,
    source_path: &Path,
    output_path: &Path,
    plan: &RenderPlan,
    recording_id: &str,
) -> Result<()> {
    if plan.segments.is_empty() {
        return Err(InternalError::Media("timeline has no video segments".into()).into());
    }

    let duration_ms = plan
        .segments
        .iter()
        .map(|segment| segment.output_end_ms)
        .max()
        .unwrap_or(plan.duration_ms)
        .max(1);
    let mut filters = Vec::new();
    let video_count = plan.segments.len();

    for (index, segment) in plan.segments.iter().enumerate() {
        validate_segment(segment, recording_id)?;
        let input = input_stream(segment.stream_index, false)?;
        let output_label = if video_count == 1 {
            "vout".to_string()
        } else {
            format!("v{index}")
        };
        filters.push(format!(
            "{input}trim=start={}:end={},setpts=PTS-STARTPTS[{output_label}]",
            seconds(segment.source_in_ms),
            seconds(segment.source_out_ms),
        ));
    }

    if video_count > 1 {
        let inputs = (0..video_count)
            .map(|index| format!("[v{index}]"))
            .collect::<Vec<_>>()
            .join("");
        filters.push(format!("{inputs}concat=n={video_count}:v=1:a=0[vout]"));
    }

    let audio_tracks = plan
        .audio_tracks
        .as_ref()
        .map(|tracks| tracks.iter().collect::<Vec<_>>())
        .unwrap_or_else(|| plan.audio.iter().collect::<Vec<_>>());
    let mut audio_labels = Vec::new();
    let mut audio_segment_count = 0usize;

    for track in audio_tracks {
        if track.muted {
            continue;
        }
        validate_asset(track.asset_id.as_ref(), recording_id)?;
        let fallback_segment = RenderSegment {
            asset_id: track.asset_id.clone(),
            stream_index: track.stream_index,
            volume: Some(track.volume),
            source_in_ms: 0,
            source_out_ms: duration_ms,
            output_start_ms: 0,
            output_end_ms: duration_ms,
        };
        let segments = if track.segments.is_empty() {
            vec![fallback_segment]
        } else {
            track.segments.clone()
        };

        for segment in segments {
            validate_segment(&segment, recording_id)?;
            let volume = segment.volume.unwrap_or(track.volume);
            if !volume.is_finite() || !(0.0..=2.0).contains(&volume) {
                return Err(InternalError::Media(
                    "audio volume is outside the supported range".into(),
                )
                .into());
            }
            let input = input_stream(segment.stream_index.or(track.stream_index), true)?;
            let label = format!("a{audio_segment_count}");
            let mut filter = format!(
                "{input}atrim=start={}:end={},asetpts=PTS-STARTPTS,volume={volume:.4}",
                seconds(segment.source_in_ms),
                seconds(segment.source_out_ms),
            );
            if segment.output_start_ms > 0 {
                filter.push_str(&format!(",adelay={}:all=1", segment.output_start_ms));
            }
            filter.push_str(&format!(",apad=pad_dur={}[{label}]", seconds(duration_ms)));
            filters.push(filter);
            audio_labels.push(format!("[{label}]"));
            audio_segment_count += 1;
        }
    }

    if audio_labels.len() == 1 {
        filters.push(format!(
            "{}atrim=duration={}[aout]",
            audio_labels[0],
            seconds(duration_ms)
        ));
    } else if !audio_labels.is_empty() {
        filters.push(format!(
            "{}amix=inputs={}:duration=longest:normalize=0,atrim=duration={}[aout]",
            audio_labels.join(""),
            audio_labels.len(),
            seconds(duration_ms),
        ));
    }

    let partial_path = partial_output_path(output_path);
    let mut command = Command::new(ffmpeg_path);
    command
        .arg("-y")
        .args(["-hide_banner", "-loglevel", "error"])
        .arg("-i")
        .arg(source_path)
        .args(["-filter_complex", &filters.join(";")])
        .args(["-map", "[vout]"]);

    if audio_labels.is_empty() {
        command.arg("-an");
    } else {
        command.args(["-map", "[aout]"]);
    }

    command.args([
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    ]);
    if !audio_labels.is_empty() {
        command.args(["-c:a", "aac", "-b:a", "128k"]);
    }
    command
        .arg("-shortest")
        .args(["-movflags", "+faststart"])
        .arg(&partial_path);

    let output = command
        .output()
        .map_err(|error| InternalError::Media(format!("timeline render run: {error}")))?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&partial_path);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(InternalError::Media(format!("timeline render failed: {stderr}")).into());
    }

    crate::capture::disk::atomic_replace(&partial_path, output_path)?;
    Ok(())
}

fn apply_cursor_overlay(
    ffmpeg_path: &str,
    output_path: &Path,
    work_dir: &Path,
    plan: &RenderPlan,
    recording_id: &str,
) -> Result<()> {
    let canvas = match plan.canvas.as_ref() {
        Some(canvas) => canvas,
        None => return Ok(()),
    };
    // Capture removes the OS cursor before recording, so every export with
    // telemetry must render the configured replacement cursor.
    if canvas.width == 0
        || canvas.height == 0
        || canvas.fps == 0
        || canvas.width > 7_680
        || canvas.height > 4_320
        || canvas.fps > 240
    {
        return Err(
            InternalError::Media("cursor render canvas dimensions are unsupported".into()).into(),
        );
    }

    let telemetry_path = work_dir.join("cursor_telemetry.json");
    if !telemetry_path.exists() {
        tracing::warn!(%recording_id, "cursor telemetry is unavailable; exporting without a cursor overlay");
        return Ok(());
    }
    let telemetry_text = std::fs::read_to_string(&telemetry_path)
        .map_err(|error| InternalError::Storage(format!("read cursor telemetry: {error}")))?;
    let telemetry: crate::capture::cursor::CursorTelemetryFile =
        serde_json::from_str(&telemetry_text)
            .map_err(|error| InternalError::Storage(format!("parse cursor telemetry: {error}")))?;
    if telemetry.events.is_empty() {
        tracing::warn!(%recording_id, "cursor telemetry has no events; exporting without a cursor overlay");
        return Ok(());
    }

    let renderer = cursor::CursorRenderer::new(
        canvas.cursor_settings.clone(),
        telemetry,
        &plan.segments,
        canvas.width,
        canvas.height,
    )
    .map_err(|error| InternalError::Media(format!("prepare cursor overlay: {error}")))?;
    let frame_size = (canvas.width as usize)
        .checked_mul(canvas.height as usize)
        .and_then(|size| size.checked_mul(4))
        .ok_or_else(|| InternalError::Media("cursor overlay frame is too large".into()))?;
    let frame_count = plan
        .duration_ms
        .saturating_mul(canvas.fps as u64)
        .saturating_add(999)
        .checked_div(1000)
        .unwrap_or(1)
        .max(1);
    let partial_path = cursor_partial_output_path(output_path);
    let mut command = Command::new(ffmpeg_path);
    command
        .arg("-y")
        .args(["-hide_banner", "-loglevel", "error"])
        .arg("-i")
        .arg(output_path)
        .args([
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-s",
            &format!("{}x{}", canvas.width, canvas.height),
            "-r",
            &canvas.fps.to_string(),
            "-i",
            "-",
        ])
        .args([
            "-filter_complex",
            "[0:v][1:v]overlay=shortest=1:format=auto[vout]",
            "-map",
            "[vout]",
            "-map",
            "0:a?",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            "-shortest",
            "-movflags",
            "+faststart",
        ])
        .arg(&partial_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| InternalError::Media(format!("start cursor overlay render: {error}")))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| InternalError::Media("cursor overlay stdin unavailable".into()))?;
    let mut frame = vec![0; frame_size];
    for frame_index in 0..frame_count {
        let output_ms = frame_index.saturating_mul(1000) / canvas.fps as u64;
        renderer.render_frame(output_ms, &mut frame);
        if let Err(error) = stdin.write_all(&frame) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&partial_path);
            return Err(
                InternalError::Media(format!("write cursor overlay frame: {error}")).into(),
            );
        }
    }
    drop(stdin);

    let output = child.wait_with_output().map_err(|error| {
        InternalError::Media(format!("wait for cursor overlay render: {error}"))
    })?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&partial_path);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(InternalError::Media(format!("cursor overlay render failed: {stderr}")).into());
    }

    crate::capture::disk::atomic_replace(&partial_path, output_path)?;
    Ok(())
}

fn cursor_partial_output_path(output_path: &Path) -> PathBuf {
    let stem = output_path
        .file_stem()
        .map(|value| value.to_string_lossy())
        .unwrap_or_else(|| "export".into());
    output_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{stem}.cursor.partial.mp4"))
}

fn validate_asset(asset_id: Option<&String>, recording_id: &str) -> Result<()> {
    if let Some(asset_id) = asset_id {
        if asset_id != recording_id {
            return Err(
                InternalError::Media("render plan references an unknown asset".into()).into(),
            );
        }
    }
    Ok(())
}

fn validate_segment(segment: &RenderSegment, recording_id: &str) -> Result<()> {
    validate_asset(segment.asset_id.as_ref(), recording_id)?;
    if segment.source_in_ms >= segment.source_out_ms {
        return Err(
            InternalError::Media("render segment has an invalid source range".into()).into(),
        );
    }
    if segment.output_end_ms <= segment.output_start_ms {
        return Err(
            InternalError::Media("render segment has an invalid output range".into()).into(),
        );
    }
    if let Some(stream_index) = segment.stream_index {
        if stream_index < 0 {
            return Err(
                InternalError::Media("render segment has an invalid stream index".into()).into(),
            );
        }
    }
    Ok(())
}

fn input_stream(stream_index: Option<i32>, audio: bool) -> Result<String> {
    if let Some(index) = stream_index {
        if index < 0 {
            return Err(
                InternalError::Media("render plan has an invalid stream index".into()).into(),
            );
        }
        return Ok(format!("[0:{index}]"));
    }
    Ok(if audio { "[0:a:0]" } else { "[0:v:0]" }.to_string())
}

fn seconds(milliseconds: u64) -> String {
    format!("{:.3}", milliseconds as f64 / 1000.0)
}

fn partial_output_path(output_path: &Path) -> PathBuf {
    let stem = output_path
        .file_stem()
        .map(|value| value.to_string_lossy())
        .unwrap_or_else(|| "export".into());
    output_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{stem}.partial.mp4"))
}

fn emit_job_update(app: &tauri::AppHandle, job: &MediaJob) -> Result<()> {
    // Avoid emitting on a very tight loop by yielding briefly.
    std::thread::sleep(Duration::from_millis(1));
    EventPublisher::new(app).media_job_update(job)
}

fn emit_progress(
    app: &tauri::AppHandle,
    job: &MediaJob,
    progress: f64,
    stage: &str,
    message: Option<&str>,
) -> Result<()> {
    let updated = MediaJob {
        progress,
        stage: stage.into(),
        message: message.map(|s| s.into()),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..job.clone()
    };
    emit_job_update(app, &updated)
}
