//! Camera-AI inference helpers (ADR 021).
//!
//! Two models, both run offline on decoded RGB24 frames and never during
//! export:
//! - MODNet portrait matte, dynamic input, RGB in [-1, 1].
//! - YuNet face detector, fixed 640×640 BGR in [0, 255].
//!
//! The preprocessing/postprocessing here is the same mathematics as the
//! upstream Apache-2.0 reference implementations (MODNet's `onnx_inference.py`
//! and OpenCV's `FaceDetectorYNImpl::postProcess`).

use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;

use crate::errors::{InternalError, Result};

/// Working resolution for the matte model: short side 512, rounded to 32.
const MATTE_SHORT_SIDE: u32 = 512;
/// YuNet's exported input is fixed at 640×640.
const FACE_INPUT: u32 = 640;
const FACE_SCORE_THRESHOLD: f32 = 0.6;

pub struct MatteModel {
    session: Session,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FaceBox {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub score: f32,
}

pub struct FaceModel {
    session: Session,
}

fn session_from(app_data_dir: &Path, model_path: &Path, threads: usize) -> Result<Session> {
    let environment = super::runtime::environment(app_data_dir)?;
    Ok(Session::builder(environment)
        .map_err(|error| InternalError::Media(format!("create ONNX session builder: {error}")))?
        .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
        .map_err(|error| InternalError::Media(format!("set ONNX optimization: {error}")))?
        .with_intra_threads(threads.max(1))
        .map_err(|error| InternalError::Media(format!("set ONNX threads: {error}")))?
        .commit_from_file(model_path)
        .map_err(|error| InternalError::Media(format!("load camera model: {error}")))?)
}

fn inference_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 8)
}

impl MatteModel {
    pub fn load(app_data_dir: &Path, model_path: &Path) -> Result<Self> {
        Ok(Self {
            session: session_from(app_data_dir, model_path, inference_threads())?,
        })
    }

    /// Run the matte model on `width`×`height` RGB24 pixels and return a
    /// full-resolution grayscale matte (0..255).
    pub fn predict(&mut self, rgb: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
        let (input_w, input_h) = matte_input_size(width, height);
        let resized = resize_rgb(rgb, width, height, input_w, input_h);
        let mut tensor = Vec::with_capacity((input_w * input_h * 3) as usize);
        // CHW, RGB, (x/255 - 0.5) / 0.5.
        for channel in 0..3 {
            for pixel in resized.as_chunks::<3>().0 {
                tensor.push((pixel[channel] as f32 / 255.0 - 0.5) / 0.5);
            }
        }
        let input = Tensor::from_array((vec![1_i64, 3, input_h as i64, input_w as i64], tensor))
            .map_err(|error| InternalError::Media(format!("matte tensor: {error}")))?;
        let outputs = self
            .session
            .run(ort::inputs!["input" => input])
            .map_err(|error| InternalError::Media(format!("matte inference: {error}")))?;
        let (shape, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|error| InternalError::Media(format!("matte output: {error}")))?;
        let dims: Vec<usize> = shape.iter().map(|d| *d as usize).collect();
        let (out_h, out_w) = match dims.as_slice() {
            [1, 1, h, w] => (*h, *w),
            [h, w] => (*h, *w),
            _ => (input_h as usize, input_w as usize),
        };
        let expected = out_w * out_h;
        if data.len() < expected {
            return Err(InternalError::Media("matte output is malformed".into()).into());
        }
        let mut matte = Vec::with_capacity(expected);
        for value in &data[..expected] {
            matte.push((value.clamp(0.0, 1.0) * 255.0).round() as u8);
        }
        Ok(resize_gray(
            &matte,
            out_w as u32,
            out_h as u32,
            width,
            height,
        ))
    }
}

impl FaceModel {
    pub fn load(app_data_dir: &Path, model_path: &Path) -> Result<Self> {
        Ok(Self {
            session: session_from(app_data_dir, model_path, 2)?,
        })
    }

    /// Detect the most confident face in `rgb` (full frame). Returns boxes in
    /// `width`×`height` source pixels.
    pub fn detect(&mut self, rgb: &[u8], width: u32, height: u32) -> Result<Option<FaceBox>> {
        let resized = resize_rgb(rgb, width, height, FACE_INPUT, FACE_INPUT);
        let mut tensor = Vec::with_capacity((FACE_INPUT * FACE_INPUT * 3) as usize);
        // CHW, BGR, raw 0..255 (OpenCV blobFromImage defaults).
        for channel in [2usize, 1, 0] {
            for pixel in resized.as_chunks::<3>().0 {
                tensor.push(pixel[channel] as f32);
            }
        }
        let input =
            Tensor::from_array((vec![1_i64, 3, FACE_INPUT as i64, FACE_INPUT as i64], tensor))
                .map_err(|error| InternalError::Media(format!("face tensor: {error}")))?;
        let outputs = self
            .session
            .run(ort::inputs!["input" => input])
            .map_err(|error| InternalError::Media(format!("face inference: {error}")))?;

        let mut faces: Vec<FaceBox> = Vec::new();
        for stride in [8usize, 16, 32] {
            let cols = (FACE_INPUT as usize) / stride;
            let rows = cols;
            let cls = extract(&outputs, &format!("cls_{stride}"))?;
            let obj = extract(&outputs, &format!("obj_{stride}"))?;
            let bbox = extract(&outputs, &format!("bbox_{stride}"))?;
            for row in 0..rows {
                for col in 0..cols {
                    let index = row * cols + col;
                    let cls_score = cls.get(index).copied().unwrap_or(0.0).clamp(0.0, 1.0);
                    let obj_score = obj.get(index).copied().unwrap_or(0.0).clamp(0.0, 1.0);
                    let score = (cls_score * obj_score).sqrt();
                    if score < FACE_SCORE_THRESHOLD {
                        continue;
                    }
                    let base = index * 4;
                    let cx = (col as f32 + bbox.get(base).copied().unwrap_or(0.0)) * stride as f32;
                    let cy =
                        (row as f32 + bbox.get(base + 1).copied().unwrap_or(0.0)) * stride as f32;
                    let w = bbox.get(base + 2).copied().unwrap_or(0.0).exp() * stride as f32;
                    let h = bbox.get(base + 3).copied().unwrap_or(0.0).exp() * stride as f32;
                    if !(w.is_finite() && h.is_finite()) || w < 4.0 || h < 4.0 {
                        continue;
                    }
                    faces.push(FaceBox {
                        x: cx - w / 2.0,
                        y: cy - h / 2.0,
                        width: w,
                        height: h,
                        score,
                    });
                }
            }
        }
        if faces.is_empty() {
            return Ok(None);
        }
        faces.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let best = faces[0];
        let scale_x = width as f32 / FACE_INPUT as f32;
        let scale_y = height as f32 / FACE_INPUT as f32;
        let w = (best.width * scale_x).clamp(1.0, width as f32);
        let h = (best.height * scale_y).clamp(1.0, height as f32);
        let x = (best.x * scale_x).clamp(0.0, (width as f32 - w).max(0.0));
        let y = (best.y * scale_y).clamp(0.0, (height as f32 - h).max(0.0));
        Ok(Some(FaceBox {
            x,
            y,
            width: w,
            height: h,
            score: best.score,
        }))
    }
}

fn extract(outputs: &ort::session::SessionOutputs<'_>, name: &str) -> Result<Vec<f32>> {
    let value = outputs
        .get(name)
        .ok_or_else(|| InternalError::Media(format!("face model output '{name}' is missing")))?;
    let (_shape, data) = value
        .try_extract_tensor::<f32>()
        .map_err(|error| InternalError::Media(format!("face output '{name}': {error}")))?;
    Ok(data.to_vec())
}

/// MODNet's reference preprocess: short side 512, dimensions divisible by 32.
fn matte_input_size(width: u32, height: u32) -> (u32, u32) {
    let (mut w, mut h) = if width >= height {
        (
            (width as f32 / height.max(1) as f32 * MATTE_SHORT_SIDE as f32).round() as u32,
            MATTE_SHORT_SIDE,
        )
    } else {
        (
            MATTE_SHORT_SIDE,
            (height as f32 / width.max(1) as f32 * MATTE_SHORT_SIDE as f32).round() as u32,
        )
    };
    w = (w.max(32) / 32) * 32;
    h = (h.max(32) / 32) * 32;
    (w, h)
}

/// Area-averaged RGB resize (the matte model upstream uses INTER_AREA; a
/// box-filter approximation is close enough for a derivative).
pub fn resize_rgb(src: &[u8], src_w: u32, src_h: u32, dst_w: u32, dst_h: u32) -> Vec<u8> {
    if src_w == dst_w && src_h == dst_h && src.len() >= (src_w * src_h * 3) as usize {
        return src[..(src_w * src_h * 3) as usize].to_vec();
    }
    let mut out = vec![0u8; (dst_w * dst_h * 3) as usize];
    let scale_x = src_w as f32 / dst_w as f32;
    let scale_y = src_h as f32 / dst_h as f32;
    for y in 0..dst_h {
        let y0 = (y as f32 * scale_y).floor() as u32;
        let y1 = (((y + 1) as f32 * scale_y).ceil() as u32).min(src_h);
        for x in 0..dst_w {
            let x0 = (x as f32 * scale_x).floor() as u32;
            let x1 = (((x + 1) as f32 * scale_x).ceil() as u32).min(src_w);
            let mut sums = [0u32; 3];
            let mut count = 0u32;
            for sy in y0..y1.max(y0 + 1) {
                for sx in x0..x1.max(x0 + 1) {
                    let index = ((sy.min(src_h - 1) * src_w + sx.min(src_w - 1)) * 3) as usize;
                    if index + 2 >= src.len() {
                        continue;
                    }
                    sums[0] += src[index] as u32;
                    sums[1] += src[index + 1] as u32;
                    sums[2] += src[index + 2] as u32;
                    count += 1;
                }
            }
            let count = count.max(1);
            let target = ((y * dst_w + x) * 3) as usize;
            out[target] = (sums[0] / count) as u8;
            out[target + 1] = (sums[1] / count) as u8;
            out[target + 2] = (sums[2] / count) as u8;
        }
    }
    out
}

pub fn resize_gray(src: &[u8], src_w: u32, src_h: u32, dst_w: u32, dst_h: u32) -> Vec<u8> {
    if src_w == dst_w && src_h == dst_h && src.len() >= (src_w * src_h) as usize {
        return src[..(src_w * src_h) as usize].to_vec();
    }
    let mut out = vec![0u8; (dst_w * dst_h) as usize];
    let scale_x = src_w as f32 / dst_w as f32;
    let scale_y = src_h as f32 / dst_h as f32;
    for y in 0..dst_h {
        let y0 = (y as f32 * scale_y).floor() as u32;
        let y1 = (((y + 1) as f32 * scale_y).ceil() as u32).min(src_h);
        for x in 0..dst_w {
            let x0 = (x as f32 * scale_x).floor() as u32;
            let x1 = (((x + 1) as f32 * scale_x).ceil() as u32).min(src_w);
            let mut sum = 0u32;
            let mut count = 0u32;
            for sy in y0..y1.max(y0 + 1) {
                for sx in x0..x1.max(x0 + 1) {
                    let index = (sy.min(src_h - 1) * src_w + sx.min(src_w - 1)) as usize;
                    if index < src.len() {
                        sum += src[index] as u32;
                        count += 1;
                    }
                }
            }
            out[(y * dst_w + x) as usize] = (sum / count.max(1)) as u8;
        }
    }
    out
}

/// Guided-filter refinement of a low-resolution matte at full resolution.
///
/// `guidance` is the full-resolution RGB frame, `matte` the model output at
/// `matte_w`×`matte_h`. The matte is first bilinearly upsampled to the
/// guidance size, then a box-filter guided filter (radius 8, eps 1e-2) snaps
/// its edges to the image. This is the "guided-filter upsample" in #4b.
#[allow(clippy::too_many_arguments)]
pub fn guided_filter_matte(
    guidance: &[u8],
    width: u32,
    height: u32,
    matte: &[u8],
    matte_w: u32,
    matte_h: u32,
    radius: u32,
    eps: f32,
) -> Vec<u8> {
    let upsampled = resize_gray(matte, matte_w, matte_h, width, height);
    let w = width as usize;
    let h = height as usize;
    let count = w * h;
    if count == 0 || guidance.len() < count * 3 {
        return upsampled;
    }
    let radius = radius.max(1) as i32;
    let luma: Vec<f32> = guidance
        .as_chunks::<3>()
        .0
        .iter()
        .map(|p| (0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32) / 255.0)
        .collect();
    let p: Vec<f32> = upsampled.iter().map(|v| *v as f32 / 255.0).collect();

    let mut mean_i = vec![0.0f32; count];
    let mut mean_p = vec![0.0f32; count];
    let mut corr_i = vec![0.0f32; count];
    let mut corr_ip = vec![0.0f32; count];
    box_filter(&luma, w, h, radius, &mut mean_i);
    box_filter(&p, w, h, radius, &mut mean_p);
    let i2: Vec<f32> = luma.iter().map(|v| v * v).collect();
    let ip: Vec<f32> = luma.iter().zip(&p).map(|(i, p)| i * p).collect();
    box_filter(&i2, w, h, radius, &mut corr_i);
    box_filter(&ip, w, h, radius, &mut corr_ip);

    let mut a = vec![0.0f32; count];
    let mut b = vec![0.0f32; count];
    for index in 0..count {
        let var = (corr_i[index] - mean_i[index] * mean_i[index]).max(0.0);
        let cov = corr_ip[index] - mean_i[index] * mean_p[index];
        a[index] = cov / (var + eps);
        b[index] = mean_p[index] - a[index] * mean_i[index];
    }
    let mut mean_a = vec![0.0f32; count];
    let mut mean_b = vec![0.0f32; count];
    box_filter(&a, w, h, radius, &mut mean_a);
    box_filter(&b, w, h, radius, &mut mean_b);

    let mut out = Vec::with_capacity(count);
    for index in 0..count {
        let value = (mean_a[index] * luma[index] + mean_b[index]).clamp(0.0, 1.0);
        out.push((value * 255.0).round() as u8);
    }
    out
}

fn box_filter(src: &[f32], width: usize, height: usize, radius: i32, out: &mut [f32]) {
    // Separable box blur with clamped edges; one pass is enough at this radius
    // because the partial sums are exact within the window.
    let mut horizontal = vec![0.0f32; width * height];
    for y in 0..height {
        let row = y * width;
        let mut sum = 0.0;
        for x in -radius..=radius {
            sum += src[row + x.clamp(0, width as i32 - 1) as usize];
        }
        let window = (radius * 2 + 1) as f32;
        for x in 0..width as i32 {
            horizontal[row + x as usize] = sum / window;
            let add = (x + radius + 1).clamp(0, width as i32 - 1) as usize;
            let sub = (x - radius).clamp(0, width as i32 - 1) as usize;
            sum += src[row + add] - src[row + sub];
        }
    }
    for x in 0..width {
        let mut sum = 0.0;
        for y in -radius..=radius {
            sum += horizontal[y.clamp(0, height as i32 - 1) as usize * width + x];
        }
        let window = (radius * 2 + 1) as f32;
        for y in 0..height as i32 {
            out[y as usize * width + x] = sum / window;
            let add = (y + radius + 1).clamp(0, height as i32 - 1) as usize;
            let sub = (y - radius).clamp(0, height as i32 - 1) as usize;
            sum += horizontal[add * width + x] - horizontal[sub * width + x];
        }
    }
}

/// Temporal EMA over matte frames. `alpha` is the weight of the new frame.
pub struct MatteSmoother {
    previous: Option<Vec<u8>>,
    alpha: f32,
}

impl MatteSmoother {
    pub fn new(alpha: f32) -> Self {
        Self {
            previous: None,
            alpha: alpha.clamp(0.01, 1.0),
        }
    }

    pub fn push(&mut self, mut frame: Vec<u8>) -> Vec<u8> {
        match &self.previous {
            None => {
                self.previous = Some(frame.clone());
                frame
            }
            Some(previous) if previous.len() == frame.len() => {
                for (index, value) in frame.iter_mut().enumerate() {
                    let blended =
                        previous[index] as f32 * (1.0 - self.alpha) + *value as f32 * self.alpha;
                    *value = blended.round().clamp(0.0, 255.0) as u8;
                }
                self.previous = Some(frame.clone());
                frame
            }
            Some(_) => {
                self.previous = Some(frame.clone());
                frame
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matte_input_rounds_to_32_and_preserves_aspect() {
        assert_eq!(matte_input_size(1920, 1080), (896, 512));
        assert_eq!(matte_input_size(1080, 1920), (512, 896));
        assert_eq!(matte_input_size(512, 512), (512, 512));
        let (w, h) = matte_input_size(1280, 720);
        assert_eq!(w % 32, 0);
        assert_eq!(h % 32, 0);
    }

    #[test]
    fn resize_preserves_constant_colour() {
        let src = vec![10u8; 8 * 6 * 3];
        let out = resize_rgb(&src, 8, 6, 4, 3);
        assert_eq!(out, vec![10u8; 4 * 3 * 3]);
    }

    #[test]
    fn guided_filter_keeps_flat_regions_and_edges() {
        // Left half black, right half white guidance; matte matches.
        let (w, h) = (32u32, 32u32);
        let mut guidance = vec![0u8; (w * h * 3) as usize];
        let mut matte = vec![0u8; (w * h) as usize];
        for y in 0..h {
            for x in 0..w {
                if x >= w / 2 {
                    let index = ((y * w + x) * 3) as usize;
                    guidance[index] = 255;
                    guidance[index + 1] = 255;
                    guidance[index + 2] = 255;
                    matte[(y * w + x) as usize] = 255;
                }
            }
        }
        let refined = guided_filter_matte(&guidance, w, h, &matte, w, h, 4, 1e-2);
        assert!(refined[16 * w as usize + 4] < 30);
        assert!(refined[16 * w as usize + 28] > 225);
    }

    #[test]
    fn smoother_converges() {
        let mut smoother = MatteSmoother::new(0.5);
        assert_eq!(smoother.push(vec![0, 0]), vec![0, 0]);
        let out = smoother.push(vec![100, 100]);
        assert_eq!(out, vec![50, 50]);
        let out = smoother.push(vec![100, 100]);
        assert_eq!(out, vec![75, 75]);
    }
}
