//! Virtual background (Pro): on-device person segmentation via `tract` and
//! the MediaPipe Selfie Segmentation ONNX model (~450 KB, Apache-2.0). The
//! model is downloaded on demand into app data — never bundled — matching
//! the whisper engine's provisioning model.
//!
//! For each camera asset in the export we render a grayscale **mask video**
//! frame-aligned to the source (white = person). The composition graph then
//! `alphamerge`s the camera feed against a blurred or replaced backdrop —
//! the mask rides the same per-window input plumbing as the camera itself.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::errors::{InternalError, Result};

/// MediaPipe Selfie Segmenter — PINTO's ONNX export (NHWC, Apache-2.0 via
/// Google). Published on our own release: the canonical HF mirror's tail
/// Resize defeats tract's shape analyser, and the PINTO zoo tarball ships
/// the whole collection. The `build-whisper-engine` workflow produces it.
const SEG_MODEL_URL: &str =
    "https://github.com/jeandedieuH/recordForge/releases/download/seg-model-v1/selfie-segmentation-256.onnx";
const SEG_MODEL_FILE: &str = "selfie-segmentation-v1.onnx";
/// The segmenter consumes NHWC 256x256 RGB floats in [0,1].
const SEG_INPUT: usize = 256;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebcamBackground {
    #[serde(default)]
    pub enabled: bool,
    /// "blur" | "replace"
    #[serde(default = "default_bg_mode")]
    pub mode: String,
    #[serde(default = "default_blur_sigma")]
    pub blur_sigma: f64,
    #[serde(default = "default_replace_color")]
    pub replace_color: String,
}

fn default_bg_mode() -> String {
    "blur".into()
}
fn default_blur_sigma() -> f64 {
    20.0
}
fn default_replace_color() -> String {
    "#0f172a".into()
}

impl Default for WebcamBackground {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: default_bg_mode(),
            blur_sigma: default_blur_sigma(),
            replace_color: default_replace_color(),
        }
    }
}

impl WebcamBackground {
    pub fn is_active(&self) -> bool {
        self.enabled && matches!(self.mode.as_str(), "blur" | "replace")
    }
}

/// Directory holding the downloaded segmentation model.
fn model_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("segmentation")
}

pub fn model_path(app_data_dir: &Path) -> PathBuf {
    model_dir(app_data_dir).join(SEG_MODEL_FILE)
}

/// Download the segmentation model on demand (no-op when present).
pub async fn ensure_model(app_data_dir: &Path, on_progress: impl Fn(u64, u64)) -> Result<PathBuf> {
    let path = model_path(app_data_dir);
    if path.exists() {
        return Ok(path);
    }
    std::fs::create_dir_all(model_dir(app_data_dir))
        .map_err(|e| InternalError::Storage(format!("create model dir: {e}")))?;
    crate::whisper::download_to_file(SEG_MODEL_URL, &path, on_progress).await?;
    Ok(path)
}

/// Probe width/height/fps for the camera source — the mask must be
/// frame-aligned and size-aligned since the camera chain's crop coordinates
/// are expressed in source pixels.
fn probe_source(ffprobe_path: &Path, source: &Path) -> Result<(u32, u32, f64, f64)> {
    let probe = crate::process::create_command(ffprobe_path)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,r_frame_rate:format=duration",
            "-of",
            "json",
        ])
        .arg(source)
        .output()
        .map_err(|e| InternalError::Storage(format!("ffprobe camera source: {e}")))?;
    if !probe.status.success() {
        return Err(InternalError::Media("ffprobe camera source failed".into()).into());
    }
    let json: serde_json::Value = serde_json::from_slice(&probe.stdout)
        .map_err(|_| InternalError::Media("ffprobe unreadable output".into()))?;
    let stream = json["streams"]
        .as_array()
        .and_then(|s| s.first())
        .ok_or_else(|| InternalError::Media("camera source has no video stream".into()))?;
    let width = stream["width"].as_u64().unwrap_or(0) as u32;
    let height = stream["height"].as_u64().unwrap_or(0) as u32;
    // r_frame_rate comes back as "30000/1001" or "30/1".
    let fps: f64 = stream["r_frame_rate"]
        .as_str()
        .and_then(|rate| {
            let mut parts = rate.split('/');
            let num: f64 = parts.next()?.parse().ok()?;
            let den: f64 = parts.next().unwrap_or("1").parse().ok()?;
            (den > 0.0).then_some(num / den)
        })
        .unwrap_or(30.0);
    let duration_s = json["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);
    if width == 0 || height == 0 {
        return Err(InternalError::Media("camera source has no dimensions".into()).into());
    }
    Ok((width, height, fps, duration_s))
}

/// Render `mask.mp4` for `source`: decode at native dims → downscale for the
/// model → inference → upscale mask → encode gray h264. Single pass through
/// the source so mask frame N corresponds to source frame N.
pub fn generate_mask(
    ffmpeg_path: &Path,
    ffprobe_path: &Path,
    model_path: &Path,
    source: &Path,
    out_path: &Path,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
    on_progress: &(dyn Fn(f64) + Sync),
) -> Result<()> {
    use tract_onnx::prelude::*;

    let (width, height, fps, duration_s) = probe_source(ffprobe_path, source)?;
    // Pinning the concrete input shape lets constant-folding resolve the
    // segmenter's tail Resize (its `sizes` are shape-derived) during
    // optimization — without it the analyser bails on the dynamic op.
    let model = tract_onnx::onnx()
        .model_for_path(model_path)
        .map_err(|e| InternalError::Media(format!("load segmentation model: {e}")))?
        .with_input_fact(0, f32::fact([1, SEG_INPUT, SEG_INPUT, 3]).into())
        .map_err(|e| InternalError::Media(format!("segmentation input fact: {e}")))?
        .into_optimized()
        .map_err(|e| InternalError::Media(format!("optimize segmentation model: {e}")))?
        .into_runnable()
        .map_err(|e| InternalError::Media(format!("prepare segmentation model: {e}")))?;

    // Warm up tract's thread pool before any ffmpeg child is spawned — on
    // Windows a freshly spawned process inherits copies of the parent pipes
    // the rayon workers wait on, which wedges the first parallel inference.
    let warmup: Tensor = Tensor::zero::<f32>(&[1, SEG_INPUT, SEG_INPUT, 3])
        .map_err(|e| InternalError::Media(format!("warmup tensor: {e}")))?;
    model
        .run(tvec!(warmup.into()))
        .map_err(|e| InternalError::Media(format!("warmup inference: {e}")))?;

    // Decoder: source → rgb24 rawvideo at model input size.
    let mut decoder = crate::process::create_command(ffmpeg_path)
        .args(["-v", "error", "-i"])
        .arg(source)
        .args([
            "-vf",
            &format!("scale={SEG_INPUT}:{SEG_INPUT}"),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| InternalError::Media(format!("spawn mask decoder: {e}")))?;

    // Encoder: source-size gray frames → h264 mask video. Gray carries only
    // luma so the mask compresses small; qp keeps edges crisp enough for
    // alphamerge without wasting bits.
    let mut encoder = crate::process::create_command(ffmpeg_path)
        .args([
            "-y",
            "-v",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "-s",
            &format!("{width}x{height}"),
            "-r",
            &format!("{fps:.6}"),
            "-i",
            "-",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "gray",
            "-qp",
            "18",
        ])
        .arg(out_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| InternalError::Media(format!("spawn mask encoder: {e}")))?;

    // Drain encoder stderr on a side thread — an unread pipe buffer would
    // deadlock the encoder mid-write.
    let enc_stderr = encoder.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = pipe.read_to_string(&mut buf);
            buf
        })
    });

    let mut stdout = decoder
        .stdout
        .take()
        .ok_or_else(|| InternalError::Media("mask decoder stdout missing".into()))?;
    let mut stdin = encoder
        .stdin
        .take()
        .ok_or_else(|| InternalError::Media("mask encoder stdin missing".into()))?;

    let in_bytes = SEG_INPUT * SEG_INPUT * 3;
    let mut frame = vec![0u8; in_bytes];
    let mut mask_frame = image::GrayImage::new(SEG_INPUT as u32, SEG_INPUT as u32);
    let mut frame_index: u64 = 0;
    // Rough progress from the ffprobe'd duration if available.
    let result = (|| -> Result<()> {
        loop {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(InternalError::Media("export cancelled".into()).into());
            }
            match stdout.read_exact(&mut frame) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(e) => return Err(InternalError::Media(format!("read mask frame: {e}")).into()),
            }
            // NHWC f32 0..1 — the model's declared layout is the rgb24
            // decode order exactly: pixel-major R,G,B triplets.
            let floats: Vec<f32> = frame.iter().map(|b| *b as f32 / 255.0).collect();
            let input: Tensor =
                tract_ndarray::Array4::from_shape_vec((1, SEG_INPUT, SEG_INPUT, 3), floats)
                    .map_err(|e| InternalError::Media(format!("mask tensor: {e}")))?
                    .into();
            let output = model
                .run(tvec!(input.into()))
                .map_err(|e| InternalError::Media(format!("segmentation inference: {e}")))?;
            let mask = output[0]
                .to_plain_array_view::<f32>()
                .map_err(|e| InternalError::Media(format!("mask output: {e}")))?;
            // Output is 1x256x256x1 of person-probability — scale to luma.
            for (pixel, value) in mask_frame.pixels_mut().zip(mask.iter()) {
                *pixel = image::Luma([(*value * 255.0).clamp(0.0, 255.0) as u8]);
            }
            let upscaled = image::imageops::resize(
                &mask_frame,
                width,
                height,
                image::imageops::FilterType::Triangle,
            );
            stdin
                .write_all(upscaled.as_raw())
                .map_err(|e| InternalError::Media(format!("write mask frame: {e}")))?;
            frame_index += 1;
            if duration_s > 0.0 {
                on_progress(((frame_index as f64 / fps) / duration_s).min(0.99));
            }
        }
        Ok(())
    })();

    drop(stdin);
    if result.is_err() {
        // The decoder may be blocked writing to a pipe nobody drains —
        // terminate it before waiting or the cleanup itself deadlocks.
        let _ = decoder.kill();
    }
    let enc_status = encoder
        .wait()
        .map_err(|e| InternalError::Media(format!("mask encoder wait: {e}")))?;
    let dec_status = decoder
        .wait()
        .map_err(|e| InternalError::Media(format!("mask decoder wait: {e}")))?;
    let enc_log = enc_stderr.and_then(|h| h.join().ok()).unwrap_or_default();
    result?;
    if !dec_status.success() || !enc_status.success() {
        return Err(InternalError::Media(format!(
            "mask pipeline failed (decoder/encoder exit){}",
            enc_log
                .lines()
                .last()
                .map(|l| format!(": {l}"))
                .unwrap_or_default()
        ))
        .into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    /// Print the model's declared input/output facts — used to pin layout.
    #[test]
    fn segmenter_probe_facts() {
        use tract_onnx::prelude::*;
        let Ok(model_path) = std::env::var("RF_SEG_MODEL").map(PathBuf::from) else {
            return;
        };
        let model = tract_onnx::onnx().model_for_path(&model_path).unwrap();
        eprintln!("inputs: {:?}", model.input_fact(0).unwrap());
        let nchw = tract_onnx::onnx()
            .model_for_path(&model_path)
            .unwrap()
            .with_input_fact(0, f32::fact([1, 3, SEG_INPUT, SEG_INPUT]).into())
            .unwrap()
            .into_optimized();
        eprintln!("nchw analyse: {}", nchw.is_ok());
        let nhwc = tract_onnx::onnx()
            .model_for_path(&model_path)
            .unwrap()
            .with_input_fact(0, f32::fact([1, SEG_INPUT, SEG_INPUT, 3]).into())
            .unwrap()
            .into_optimized();
        eprintln!("nhwc analyse: {}", nhwc.is_ok());
        for i in 0..model.input_outlets().unwrap().len() {
            eprintln!("in[{i}]: {:?}", model.input_fact(i).unwrap());
        }
        for i in 0..model.output_outlets().unwrap().len() {
            eprintln!("out[{i}]: {:?}", model.output_fact(i).unwrap());
        }
    }

    /// Isolate tract inference from the ffmpeg plumbing — one forward pass.
    #[test]
    fn segmenter_forward_pass() {
        use tract_onnx::prelude::*;
        let Ok(model_path) = std::env::var("RF_SEG_MODEL").map(PathBuf::from) else {
            return;
        };
        if !model_path.exists() {
            return;
        }
        let model = tract_onnx::onnx()
            .model_for_path(&model_path)
            .unwrap()
            .with_input_fact(0, f32::fact([1, SEG_INPUT, SEG_INPUT, 3]).into())
            .unwrap()
            .into_optimized()
            .unwrap()
            .into_runnable()
            .unwrap();
        let input: Tensor = tract_ndarray::Array4::from_shape_vec(
            (1, SEG_INPUT, SEG_INPUT, 3),
            vec![0.5f32; SEG_INPUT * SEG_INPUT * 3],
        )
        .unwrap()
        .into();
        let started = std::time::Instant::now();
        let output = model.run(tvec!(input.into())).unwrap();
        let elapsed = started.elapsed();
        eprintln!("inference took {elapsed:?}, outputs: {}", output.len());
        assert!(elapsed < std::time::Duration::from_secs(60));
        assert!(!output.is_empty());
    }

    /// Real pipeline: decode → tract inference → encode. Needs
    /// `RF_SEG_MODEL=/path/model.onnx` (download-on-demand in production).
    #[test]
    fn generate_mask_real_pipeline() {
        let Ok(model) = std::env::var("RF_SEG_MODEL").map(PathBuf::from) else {
            return;
        };
        if !model.exists() {
            return;
        }
        let ffmpeg = crate::media::resolve_executable("ffmpeg")
            .unwrap_or_else(|_| std::env::temp_dir().join("missing-ffmpeg"));
        let ffprobe = crate::media::resolve_executable("ffprobe")
            .unwrap_or_else(|_| std::env::temp_dir().join("missing-ffprobe"));
        if !ffmpeg.exists() || !ffprobe.exists() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("rf-mask-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("cam.mp4");
        // 1s of "talking head"-ish source at 24fps.
        let status = crate::process::create_command(&ffmpeg)
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x240:rate=24:d=1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&src)
            .status()
            .unwrap();
        assert!(status.success());
        let mask = dir.join("mask.mp4");
        let cancel = Arc::new(AtomicBool::new(false));
        generate_mask(&ffmpeg, &ffprobe, &model, &src, &mask, &cancel, &|_| {})
            .expect("mask pipeline");
        assert!(mask.exists() && mask.metadata().unwrap().len() > 1024);
        // Mask must have ~24 frames at 320x240 gray.
        let probe = crate::process::create_command(&ffprobe)
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height,nb_frames",
                "-of",
                "json",
            ])
            .arg(&mask)
            .output()
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&probe.stdout).unwrap();
        let stream = &json["streams"][0];
        assert_eq!(stream["width"].as_u64(), Some(320));
        assert_eq!(stream["height"].as_u64(), Some(240));
        assert_eq!(
            stream["nb_frames"]
                .as_str()
                .unwrap()
                .parse::<u64>()
                .unwrap(),
            24
        );
    }
}
