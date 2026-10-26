//! Encode sidecar for the GPU compositor.
//!
//! FFmpeg stays the encoder: it reads the composited NV12 frames from stdin as
//! `rawvideo`, mixes the existing semantic audio graph, and applies the same
//! bitrate/preset mapping, chapters, `hvc1` tag and `+faststart` mux flags as
//! the compatibility renderer, so the deliverable is interchangeable.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{Arc, Mutex};

use crate::errors::{InternalError, Result};
use tracing::warn;

use super::super::encoding::{self, ExportEncoder};
use super::super::{
    append_audio_graph, audio_bitrate, audio_input_windows, captions, collect_input_assets,
    generate_ffmetadata, hvc1_tag_args, CompositionShared, ExportSettings, RenderPlan,
};
use super::gpu_error;

/// The running encoder: stdin carries NV12 frames, stderr carries diagnostics.
pub(super) struct EncodeProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stderr: Arc<Mutex<Vec<u8>>>,
    output_path: PathBuf,
    /// `[aout]` was mixed, so the finished file carries an audio stream.
    has_audio: bool,
    /// Temp files this process owns (chapter metadata); the guards remove them
    /// on finish, kill, or an early return from setup.
    cleanup: Vec<super::super::TempMaskFile>,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn spawn(
    ffmpeg_path: &str,
    output_path: &Path,
    plan: &RenderPlan,
    project_id: &str,
    asset_paths: &HashMap<String, PathBuf>,
    settings: &ExportSettings,
    encoder: ExportEncoder,
    shared: &CompositionShared,
    width: u32,
    height: u32,
    out_width: u32,
    out_height: u32,
    fps: u32,
    caption_script: Option<&Path>,
) -> Result<EncodeProcess> {
    let audio_windows = audio_input_windows(plan, plan.duration_ms.max(1));
    let asset_inputs = collect_input_assets(plan, asset_paths)?;
    let mut input_indices: HashMap<String, usize> = HashMap::new();
    let mut source_seek_s: HashMap<String, f64> = HashMap::new();
    // Video is input 0; audio assets follow.
    let mut audio_inputs: Vec<(PathBuf, Option<f64>, Option<f64>)> = Vec::new();

    let mut audio_asset_ids = std::collections::BTreeSet::new();
    if let Some(tracks) = &plan.audio_tracks {
        for track in tracks {
            audio_asset_ids.insert(&track.asset_id);
            audio_asset_ids.extend(track.segments.iter().map(|segment| &segment.asset_id));
        }
    }
    if let Some(track) = &plan.audio {
        audio_asset_ids.insert(&track.asset_id);
        audio_asset_ids.extend(track.segments.iter().map(|segment| &segment.asset_id));
    }
    for (asset_id, path) in &asset_inputs {
        if !audio_asset_ids.contains(asset_id) {
            continue;
        }
        if input_indices.contains_key(asset_id) {
            continue;
        }
        let window = audio_windows.get(asset_id).copied();
        if let Some((seek_s, _)) = window {
            source_seek_s.insert(asset_id.clone(), seek_s);
        }
        input_indices.insert(asset_id.clone(), 1 + audio_inputs.len());
        audio_inputs.push((
            path.clone(),
            window.map(|(seek_s, _)| seek_s),
            window.map(|(_, duration_s)| duration_s),
        ));
    }

    let mut filters: Vec<String> = Vec::new();
    let has_audio = append_audio_graph(
        &mut filters,
        plan,
        project_id,
        &input_indices,
        asset_paths,
        &shared.probe,
        plan.duration_ms.max(1),
        &source_seek_s,
        &std::sync::atomic::AtomicBool::new(false),
    )?;

    // The GPU pass owns the canvas; G3 features run here on its NV12 output so
    // they stay byte-compatible with the compatibility renderer's stages.
    let chapters_index = if (settings.chapter_mode == "embed" || settings.chapter_mode == "both")
        && !plan.chapters.is_empty()
    {
        // Inputs are: 0 = composited stdin, then one per audio asset.
        Some(1 + audio_inputs.len())
    } else {
        None
    };

    // `None` means the composited stdin stream is mapped directly; only a
    // filter stage that consumes `[0:v]` produces a label to map instead.
    let mut video_label: Option<String> = None;
    if let Some(script) = caption_script {
        let input = video_label.as_deref().unwrap_or("0:v");
        filters.push(captions::subtitles_filter(input, "captioned", script));
        video_label = Some("captioned".into());
    }
    if (out_width, out_height) != (width, height) {
        // License-driven cap: the composed canvas is downscaled at the final
        // node with the same kernel the compatibility graph uses.
        let input = video_label.as_deref().unwrap_or("0:v");
        filters.push(format!(
            "[{input}]scale={out_width}:{out_height}:flags=lanczos[capped]"
        ));
        video_label = Some("capped".into());
    }
    if encoder == ExportEncoder::Vaapi {
        let input = video_label.as_deref().unwrap_or("0:v");
        let (stage, label) = encoding::vaapi_export_upload(input);
        filters.push(stage);
        video_label = Some(label.into());
    }

    let mut cleanup = Vec::new();
    let chapters_path = if chapters_index.is_some() {
        let path = std::env::temp_dir().join(format!(
            "rf-gpu-chapters-{}-{}.ffmeta",
            project_id,
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, generate_ffmetadata(project_id, &plan.chapters)).map_err(
            |error| InternalError::Storage(format!("write GPU chapter metadata: {error}")),
        )?;
        cleanup.push(super::super::TempMaskFile(path.clone()));
        Some(path)
    } else {
        None
    };

    let mut command = crate::process::create_command(ffmpeg_path);
    command.args(["-hide_banner", "-loglevel", "warning", "-nostdin", "-y"]);
    encoding::append_export_device_args(&mut command, encoder);
    command
        .args(["-f", "rawvideo", "-pix_fmt", "nv12"])
        .args(["-s", &format!("{width}x{height}")])
        .args(["-framerate", &fps.to_string()])
        .arg("-i")
        .arg("pipe:0");
    for (path, seek_s, duration_s) in &audio_inputs {
        if let Some(seek_s) = seek_s {
            command.arg("-ss").arg(format!("{seek_s:.3}"));
        }
        if let Some(duration_s) = duration_s {
            command.arg("-t").arg(format!("{duration_s:.3}"));
        }
        command.arg("-i").arg(path);
    }
    if let Some(path) = &chapters_path {
        command.args(["-f", "ffmetadata"]).arg("-i").arg(path);
    }
    if has_audio || !filters.is_empty() {
        command.args(["-filter_complex", &filters.join(";\n")]);
    }
    command.arg("-map").arg(match &video_label {
        Some(label) => format!("[{label}]"),
        None => "0:v".to_string(),
    });
    if has_audio {
        command.args(["-map", "[aout]"]);
        command.args(["-c:a", "aac", "-b:a", audio_bitrate(settings)]);
    } else {
        command.arg("-an");
    }
    if let Some(index) = chapters_index {
        command.args(["-map_chapters", &index.to_string()]);
    }
    encoding::append_export_video_args(&mut command, settings, encoder, fps, out_width, out_height);
    if encoder != ExportEncoder::Vaapi {
        // The compositor already emits NV12. Repeating `-pix_fmt` makes it the
        // authoritative value (FFmpeg's last occurrence wins), so the encoder
        // consumes the composited planes instead of paying a full-frame
        // NV12→yuv420p swscale first. VAAPI is exempt: it consumes uploaded
        // hardware frames, not a system pixel format.
        command.args(["-pix_fmt", "nv12"]);
    }
    command.args(hvc1_tag_args(settings));
    command.args(["-movflags", "+faststart"]);
    command.arg(output_path);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| InternalError::Media(format!("start GPU encode pass: {error}")))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| InternalError::Media("GPU encode stdin unavailable".into()))?;
    let mut stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| InternalError::Media("GPU encode stderr unavailable".into()))?;
    let stderr = Arc::new(Mutex::new(Vec::new()));
    {
        let sink = Arc::clone(&stderr);
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match stderr_pipe.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let mut sink = sink.lock().unwrap_or_else(|p| p.into_inner());
                        if sink.len() < 16 * 1024 {
                            sink.extend_from_slice(&buffer[..read]);
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    Ok(EncodeProcess {
        child,
        stdin: Some(stdin),
        stderr,
        output_path: output_path.to_path_buf(),
        has_audio,
        cleanup,
    })
}

impl EncodeProcess {
    pub(super) fn has_audio(&self) -> bool {
        self.has_audio
    }
    pub(super) fn write_frame(&mut self, frame: &[u8]) -> Result<()> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| gpu_error("GPU encode stdin already closed"))?;
        stdin
            .write_all(frame)
            .map_err(|error| InternalError::Media(format!("write GPU encode frame: {error}")))?;
        Ok(())
    }

    pub(super) fn finish(mut self) -> Result<()> {
        drop(self.stdin.take());
        let status = self
            .child
            .wait()
            .map_err(|error| InternalError::Media(format!("wait for GPU encode pass: {error}")))?;
        self.cleanup_temp_files();
        if status.success() {
            return Ok(());
        }
        self.log_stderr("gpu export: encode pass failed");
        let _ = std::fs::remove_file(&self.output_path);
        Err(gpu_error("GPU encode pass failed"))
    }

    pub(super) fn kill(&mut self) {
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.cleanup_temp_files();
        self.log_stderr("gpu export: encoder stopped before the stream finished");
    }

    fn cleanup_temp_files(&mut self) {
        // Dropping each guard removes its file.
        self.cleanup.clear();
    }

    fn log_stderr(&self, message: &str) {
        let diagnostic = String::from_utf8_lossy(
            &self
                .stderr
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
        .to_string();
        // Media paths must never reach logs (AGENTS.md security rules).
        let redacted = diagnostic
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(super::super::redact_paths)
            .collect::<Vec<_>>()
            .join("\n");
        if !redacted.trim().is_empty() {
            warn!(
                detail = %redacted.chars().take(600).collect::<String>(),
                "{message}"
            );
        }
    }
}

impl Drop for EncodeProcess {
    fn drop(&mut self) {
        // Never leave an encoder (or its chapter temp file) behind when setup
        // fails after spawn; `finish`/`kill` already reap it, so this is a
        // no-op on the success path.
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.cleanup_temp_files();
    }
}
