//! On-device ML runtime and camera-AI model plumbing (ADR 021).
//!
//! Scope: runtime + model download/verification, ONNX session creation with an
//! execution-provider fallback chain, and the inference helpers used by the
//! offline camera-derivative job. Inference is **only** run by that job — the
//! export pipeline consumes precomputed mattes and face tracks.

pub mod inference;
pub mod models;
pub mod runtime;

use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MlStatus {
    /// This platform has a pinned ONNX Runtime build.
    pub supported: bool,
    /// The runtime dylib is present and verified.
    pub runtime_ready: bool,
    pub models: Vec<models::ModelInfo>,
    /// Runtime + at least one model present.
    pub ready: bool,
    pub reason: Option<String>,
}

pub fn status(app_data_dir: &Path) -> MlStatus {
    let supported = runtime::supported();
    let runtime_ready = runtime::ready(app_data_dir);
    let model_status = models::status(app_data_dir);
    let any_model = model_status.iter().any(|model| model.downloaded);
    let reason = if supported {
        None
    } else {
        Some("Camera AI is not available on this platform".to_string())
    };
    MlStatus {
        supported,
        runtime_ready,
        models: model_status,
        ready: supported && runtime_ready && any_model,
        reason,
    }
}

/// The two model paths a camera-AI job may need.
pub struct ModelPaths {
    pub matte: Option<std::path::PathBuf>,
    pub face: Option<std::path::PathBuf>,
}

pub fn model_paths(app_data_dir: &Path, matte: bool, face: bool) -> ModelPaths {
    let path_for =
        |id: &str| models::model_spec(id).map(|spec| models::model_path(app_data_dir, spec));
    ModelPaths {
        matte: matte.then(|| path_for(models::MATTE)).flatten(),
        face: face.then(|| path_for(models::FACE)).flatten(),
    }
}
