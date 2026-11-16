//! Pinned camera-AI model catalogue (ADR 021).
//!
//! Both models are Apache-2.0 and downloaded on demand, verified by SHA-256:
//! - **MODNet Webcam** (`modnet_webcam.onnx`) — portrait matting, dynamic input
//!   shape, ~26 MB. Chosen over MediaPipe's TFLite segmenter because it ships
//!   as ONNX and is explicitly trained for webcam framing.
//! - **YuNet 2023mar** (`face_detection_yunet_2023mar.onnx`) — OpenCV Zoo face
//!   detector, ~230 KB, fixed 640×640 input, 3 anchor-free scales.
//!
//! URLs are pinned to a commit/tag *and* the bytes are hash-checked, so a moved
//! tag cannot change what the app runs.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::errors::{InternalError, Result};

#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub file: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
    pub url: &'static str,
}

pub const MATTE: &str = "camera-matte";
pub const FACE: &str = "face-detect";

pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: MATTE,
        label: "Portrait matte (MODNet Webcam)",
        file: "modnet_webcam.onnx",
        size_bytes: 25_969_398,
        sha256: "de03cc16f3c91f25b7c2f0b42ea1a8d34f40a752234f3887572655e744e55306",
        url: "https://github.com/yakhyo/modnet/releases/download/weights/modnet_webcam.onnx",
    },
    ModelSpec {
        id: FACE,
        label: "Face detector (YuNet)",
        file: "face_detection_yunet_2023mar.onnx",
        size_bytes: 232_589,
        sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
        // Pinned to the commit that introduced v2 (2023-06-06). Served via
        // media.githubusercontent.com because opencv_zoo tracks .onnx in Git
        // LFS — the plain raw host returns the 131-byte LFS pointer instead.
        url: "https://media.githubusercontent.com/media/opencv/opencv_zoo/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub size_bytes: u64,
    pub downloaded: bool,
}

pub fn model_spec(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|spec| spec.id == id)
}

pub fn models_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("ml").join("models")
}

pub fn model_path(app_data_dir: &Path, spec: &ModelSpec) -> PathBuf {
    models_dir(app_data_dir).join(spec.file)
}

pub fn status(app_data_dir: &Path) -> Vec<ModelInfo> {
    MODELS
        .iter()
        .map(|spec| ModelInfo {
            id: spec.id,
            label: spec.label,
            size_bytes: spec.size_bytes,
            downloaded: model_path(app_data_dir, spec).is_file(),
        })
        .collect()
}

/// Download one model if missing. Progress is reported in bytes.
pub async fn download(app_data_dir: &Path, id: &str, on_progress: impl Fn(u64, u64)) -> Result<()> {
    let spec = model_spec(id)
        .ok_or_else(|| InternalError::Media(format!("unknown camera model '{id}'")))?;
    let path = model_path(app_data_dir, spec);
    if path.is_file() {
        if verify(&path, spec.sha256).is_ok() {
            return Ok(());
        }
        let _ = std::fs::remove_file(&path);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| InternalError::Storage(format!("create ML models dir: {error}")))?;
    }
    crate::whisper::download_to_file(spec.url, &path, on_progress).await?;
    if let Err(error) = verify(&path, spec.sha256) {
        let _ = std::fs::remove_file(&path);
        return Err(error);
    }
    Ok(())
}

/// Remove a downloaded model (the matte model is ~26 MB).
pub fn delete(app_data_dir: &Path, id: &str) -> Result<()> {
    let spec = model_spec(id)
        .ok_or_else(|| InternalError::Media(format!("unknown camera model '{id}'")))?;
    let path = model_path(app_data_dir, spec);
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|error| InternalError::Storage(format!("delete camera model: {error}")))?;
    }
    Ok(())
}

fn verify(path: &Path, expected: &str) -> Result<()> {
    use sha2::Digest;
    let bytes = std::fs::read(path)
        .map_err(|error| InternalError::Storage(format!("read camera model: {error}")))?;
    let digest = hex::encode(sha2::Sha256::digest(&bytes));
    if !digest.eq_ignore_ascii_case(expected) {
        return Err(
            InternalError::Storage("camera model failed its integrity check".into()).into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_has_pinned_hashes() {
        assert_eq!(MODELS.len(), 2);
        for spec in MODELS {
            assert_eq!(spec.sha256.len(), 64);
            assert!(spec.sha256.chars().all(|c| c.is_ascii_hexdigit()));
            assert!(spec.size_bytes > 0);
            assert!(spec.url.starts_with("https://"));
        }
        assert!(model_spec(FACE).is_some());
        assert!(model_spec("nope").is_none());
    }

    #[test]
    fn model_path_lands_in_app_data() {
        let spec = model_spec(FACE).unwrap();
        assert_eq!(
            model_path(Path::new("/data"), spec),
            PathBuf::from("/data/ml/models/face_detection_yunet_2023mar.onnx")
        );
    }
}
