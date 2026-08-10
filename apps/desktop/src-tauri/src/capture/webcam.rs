//! Webcam Sidecar Capture & Validation Engine
//!
//! Provides dedicated webcam stream handling, capability preflight check,
//! and sidecar recording (`webcam_000.mp4`).

use crate::errors::Result;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebcamCapabilities {
    pub device_id: String,
    pub device_name: String,
    pub available: bool,
    pub formats: Vec<String>,
}

/// Preflight check for a webcam device before starting recording.
pub fn validate_webcam_device(ffmpeg_path: &str, device_name: &str) -> Result<WebcamCapabilities> {
    // Keep the DirectShow device name quoted inside the input spec. The quotes
    // are part of FFmpeg's dshow syntax and protect spaces, punctuation, and
    // trailing USB identifiers in the device label.
    let spec = format!("video=\"{device_name}\"");
    let available = super::media::probe_dshow_device(ffmpeg_path, &spec);

    Ok(WebcamCapabilities {
        device_id: device_name.to_string(),
        device_name: device_name.to_string(),
        available,
        formats: vec!["YUY2".into(), "MJPEG".into(), "NV12".into()],
    })
}
