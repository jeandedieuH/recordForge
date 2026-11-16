//! Offline camera-AI derivative job (#4b/#4c).
//!
//! Decodes the camera stream once with FFmpeg at a working resolution, runs the
//! pinned MODNet matte model on every frame and YuNet at ~8 Hz, and writes:
//! - `matte.mp4` — grayscale H.264 matte at the camera frame rate, and
//! - `face_track.json` — compact face boxes in camera source pixels.
//!
//! Inference never runs during export: the renderers consume these files.
//! The job is cancellable (the decoder is registered on the shared job
//! primitive) and reports progress in 0..=100.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;

use crate::errors::{AppError, ErrorCategory, InternalError, Result};
use crate::ml::{
    self,
    inference::{FaceModel, MatteModel, MatteSmoother},
};
use crate::transcript::TranscriptionJob;

/// Working short side for matte inference and face detection.
const CAMERA_AI_SHORT_SIDE: u32 = 512;
/// YuNet runs at roughly 8 Hz regardless of the camera frame rate.
const FACE_HZ: f64 = 8.0;

/// Error returned when `cancel_camera_ai` wins the race. The dedicated code lets
/// the UI show a neutral "cancelled" message instead of a failure.
pub fn camera_ai_cancelled() -> AppError {
    AppError::new(
        ErrorCategory::Media,
        "camera_ai_cancelled",
        "Camera AI cancelled",
    )
}

pub struct CameraAiOptions {
    pub ffmpeg_path: PathBuf,
    pub source_path: PathBuf,
    pub stream_index: i32,
    pub source_width: u32,
    pub source_height: u32,
    pub fps: f64,
    pub duration_ms: u64,
    pub work_dir: PathBuf,
    pub matte: bool,
    pub face_track: bool,
    pub force: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraAiResult {
    pub matte_path: Option<String>,
    pub face_track_path: Option<String>,
    pub face_samples: usize,
    pub cached: bool,
}

fn derivative_dir(work_dir: &Path, stream_index: i32) -> PathBuf {
    work_dir
        .join("derivatives")
        .join("camera_ai")
        .join(format!("stream_{stream_index:03}"))
}

pub fn matte_path(work_dir: &Path, stream_index: i32) -> PathBuf {
    derivative_dir(work_dir, stream_index).join("matte.mp4")
}

pub fn face_track_path(work_dir: &Path, stream_index: i32) -> PathBuf {
    derivative_dir(work_dir, stream_index).join("face_track.json")
}

fn processing_size(width: u32, height: u32) -> (u32, u32) {
    let (mut w, mut h) = if width >= height {
        (
            (width as f32 / height.max(1) as f32 * CAMERA_AI_SHORT_SIDE as f32).round() as u32,
            CAMERA_AI_SHORT_SIDE,
        )
    } else {
        (
            CAMERA_AI_SHORT_SIDE,
            (height as f32 / width.max(1) as f32 * CAMERA_AI_SHORT_SIDE as f32).round() as u32,
        )
    };
    w = w.max(32).div_ceil(2) * 2;
    h = h.max(32).div_ceil(2) * 2;
    (w, h)
}

pub fn run(
    app_data_dir: &Path,
    options: &CameraAiOptions,
    job: &Arc<TranscriptionJob>,
    on_progress: impl Fn(&str, u8) + Send + Sync + 'static,
) -> Result<CameraAiResult> {
    let dir = derivative_dir(&options.work_dir, options.stream_index);
    std::fs::create_dir_all(&dir)
        .map_err(|error| InternalError::Storage(format!("create camera-AI dir: {error}")))?;
    let matte_out = matte_path(&options.work_dir, options.stream_index);
    let matte_partial = matte_out.with_extension("part.mp4");
    let face_out = face_track_path(&options.work_dir, options.stream_index);
    let matte_exists = matte_out.is_file();
    let face_exists = face_out.is_file();
    let need_matte = options.matte && (!matte_exists || options.force);
    let need_face = options.face_track && (!face_exists || options.force);
    if !need_matte && !need_face {
        let samples = read_face_sample_count(&face_out);
        return Ok(CameraAiResult {
            matte_path: (options.matte && matte_exists)
                .then(|| matte_out.to_string_lossy().to_string()),
            face_track_path: (options.face_track && face_exists)
                .then(|| face_out.to_string_lossy().to_string()),
            face_samples: samples,
            cached: true,
        });
    }

    if !ml::runtime::ready(app_data_dir) {
        return Err(InternalError::Media("Download the camera AI runtime first".into()).into());
    }
    let paths = ml::model_paths(app_data_dir, need_matte, need_face);
    let mut matte_model = match paths.matte.as_deref() {
        Some(path) => Some(MatteModel::load(app_data_dir, path)?),
        None => None,
    };
    let mut face_model = match paths.face.as_deref() {
        Some(path) => Some(FaceModel::load(app_data_dir, path)?),
        None => None,
    };

    let (width, height) = processing_size(options.source_width, options.source_height);
    let fps = if options.fps.is_finite() && options.fps > 0.0 {
        options.fps
    } else {
        30.0
    };
    let total_frames = if options.duration_ms > 0 {
        ((options.duration_ms as f64 / 1000.0) * fps)
            .round()
            .max(1.0) as u64
    } else {
        0
    };
    let face_every = ((fps / FACE_HZ).round() as u64).max(1);

    on_progress("preparing", 0);
    let mut decoder = spawn_decoder(options, width, height, fps)?;
    let mut decoder_stdout = decoder
        .stdout
        .take()
        .ok_or_else(|| InternalError::Media("camera AI decoder produced no stdout".into()))?;
    let mut encoder = if need_matte {
        Some(spawn_matte_encoder(
            &options.ffmpeg_path,
            &matte_out,
            width,
            height,
            fps,
        )?)
    } else {
        None
    };

    let frame_bytes = (width * height * 3) as usize;
    let mut frame = vec![0u8; frame_bytes];
    let mut smoother = MatteSmoother::new(0.35);
    let mut samples = Vec::new();
    let mut frame_index: u64 = 0;

    loop {
        if job.is_cancelled() {
            kill_children(&mut decoder, encoder.as_mut());
            return Err(camera_ai_cancelled());
        }
        match decoder_stdout.read_exact(&mut frame) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(error) => {
                kill_children(&mut decoder, encoder.as_mut());
                return Err(InternalError::Media(format!("read camera frame: {error}")).into());
            }
        }

        if let Some(model) = matte_model.as_mut() {
            let matte = model.predict(&frame, width, height)?;
            let mut refined = ml::inference::guided_filter_matte(
                &frame, width, height, &matte, width, height, 8, 1e-2,
            );
            refined = smoother.push(refined);
            let Some(sink) = encoder.as_mut().and_then(|proc| proc.stdin.as_mut()) else {
                kill_children(&mut decoder, encoder.as_mut());
                return Err(InternalError::Media("camera matte encoder closed".into()).into());
            };
            sink.write_all(&refined).map_err(|error| {
                InternalError::Media(format!("write camera matte frame: {error}"))
            })?;
        }

        if let Some(model) = face_model.as_mut() {
            if frame_index.is_multiple_of(face_every) {
                if let Some(face) = model.detect(&frame, width, height)? {
                    let scale_x = options.source_width as f32 / width as f32;
                    let scale_y = options.source_height as f32 / height as f32;
                    samples.push(FaceSample {
                        time_ms: (frame_index as f64 * 1000.0 / fps).round() as u64,
                        x: face.x * scale_x,
                        y: face.y * scale_y,
                        width: face.width * scale_x,
                        height: face.height * scale_y,
                        score: face.score,
                    });
                }
            }
        }

        frame_index += 1;
        if total_frames > 0 {
            let percent = ((frame_index as f64 / total_frames as f64) * 100.0).min(99.0);
            on_progress(if need_matte { "matte" } else { "face" }, percent as u8);
        } else if frame_index.is_multiple_of(30) {
            on_progress(if need_matte { "matte" } else { "face" }, 50);
        }
    }

    // Close the encoder stdin so it flushes, then wait for both children.
    if let Some(encoder) = encoder.as_mut() {
        let _ = encoder.stdin.take();
    }
    drop(decoder_stdout);
    let decode_status = decoder
        .wait()
        .map_err(|error| InternalError::Media(format!("camera AI decoder wait: {error}")))?;
    let encode_status = match encoder.as_mut() {
        Some(encoder) => Some(encoder.wait().map_err(|error| {
            InternalError::Media(format!("camera matte encoder wait: {error}"))
        })?),
        None => None,
    };
    if job.is_cancelled() {
        let _ = std::fs::remove_file(&matte_out);
        let _ = std::fs::remove_file(&matte_partial);
        return Err(camera_ai_cancelled());
    }
    if !decode_status.success() {
        let _ = std::fs::remove_file(&matte_out);
        let _ = std::fs::remove_file(&matte_partial);
        return Err(InternalError::Media("camera AI decode failed".into()).into());
    }
    if encode_status.is_some_and(|status| !status.success()) {
        let _ = std::fs::remove_file(&matte_out);
        let _ = std::fs::remove_file(&matte_partial);
        return Err(InternalError::Media("camera matte encode failed".into()).into());
    }
    if need_matte {
        finish_matte_encode(&matte_partial, &matte_out)?;
    }

    if need_face {
        on_progress("finalizing", 98);
        write_face_track(
            &face_out,
            options.stream_index,
            options.source_width,
            options.source_height,
            fps,
            &samples,
        )?;
    }

    Ok(CameraAiResult {
        matte_path: need_matte.then(|| matte_out.to_string_lossy().to_string()),
        face_track_path: need_face.then(|| face_out.to_string_lossy().to_string()),
        face_samples: samples.len(),
        cached: false,
    })
}

fn kill_children(decoder: &mut std::process::Child, encoder: Option<&mut std::process::Child>) {
    let _ = decoder.kill();
    if let Some(encoder) = encoder {
        let _ = encoder.kill();
    }
}

fn spawn_decoder(
    options: &CameraAiOptions,
    width: u32,
    height: u32,
    fps: f64,
) -> Result<std::process::Child> {
    let mut command = crate::process::create_command(&options.ffmpeg_path);
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-nostdin")
        .arg("-i")
        .arg(&options.source_path)
        .arg("-map")
        .arg(format!("0:{}", options.stream_index))
        .args(["-an", "-sn", "-dn"])
        .arg("-vf")
        .arg(format!(
            "fps={:.6},scale={width}:{height}:flags=bilinear,format=rgb24",
            fps
        ))
        .args(["-f", "rawvideo", "pipe:1"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
        .spawn()
        .map_err(|error| InternalError::Media(format!("start camera AI decoder: {error}")).into())
}

fn spawn_matte_encoder(
    ffmpeg_path: &Path,
    output: &Path,
    width: u32,
    height: u32,
    fps: f64,
) -> Result<std::process::Child> {
    let partial = output.with_extension("part.mp4");
    let _ = std::fs::remove_file(&partial);
    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-f")
        .arg("rawvideo")
        .arg("-pix_fmt")
        .arg("gray")
        .arg("-s")
        .arg(format!("{width}x{height}"))
        .arg("-r")
        .arg(format!("{fps:.6}"))
        .arg("-i")
        .arg("pipe:0")
        .arg("-an")
        .args([
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        ])
        .arg("-movflags")
        .arg("+faststart")
        .arg(&partial)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = command
        .spawn()
        .map_err(|error| InternalError::Media(format!("start camera matte encoder: {error}")))?;
    // The final rename happens after the process exits; callers keep `partial`
    // in sync via `finish_matte_encode`.
    Ok(child)
}

/// Rename the partially written matte after a successful encode.
fn finish_matte_encode(partial: &Path, output: &Path) -> Result<()> {
    std::fs::rename(partial, output)
        .map_err(|error| InternalError::Storage(format!("finalize camera matte: {error}")).into())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FaceSample {
    time_ms: u64,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    score: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FaceTrackFile<'a> {
    version: u32,
    stream_index: i32,
    width: u32,
    height: u32,
    fps: f32,
    samples: &'a [FaceSample],
}

fn write_face_track(
    path: &Path,
    stream_index: i32,
    width: u32,
    height: u32,
    fps: f64,
    samples: &[FaceSample],
) -> Result<()> {
    let payload = FaceTrackFile {
        version: 1,
        stream_index,
        width,
        height,
        fps: fps as f32,
        samples,
    };
    let text = serde_json::to_string(&payload)
        .map_err(|error| InternalError::Storage(format!("serialize face track: {error}")))?;
    let temp = path.with_extension("json.part");
    std::fs::write(&temp, text)
        .map_err(|error| InternalError::Storage(format!("write face track: {error}")))?;
    std::fs::rename(&temp, path)
        .map_err(|error| InternalError::Storage(format!("finalize face track: {error}")))?;
    Ok(())
}

fn read_face_sample_count(path: &Path) -> usize {
    let Ok(text) = std::fs::read_to_string(path) else {
        return 0;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return 0;
    };
    value
        .get("samples")
        .and_then(serde_json::Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn processing_size_is_even_and_short_side_512() {
        assert_eq!(processing_size(1920, 1080), (910, 512));
        assert_eq!(processing_size(1080, 1920), (512, 910));
        assert_eq!(processing_size(640, 480), (684, 512));
    }

    #[test]
    fn derivative_paths_are_stream_scoped() {
        let work = Path::new("/work");
        assert!(matte_path(work, 2).to_string_lossy().contains("stream_002"));
        assert!(face_track_path(work, 2)
            .to_string_lossy()
            .ends_with("face_track.json"));
    }
}
