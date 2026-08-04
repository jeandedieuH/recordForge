use serde::{Deserialize, Serialize};

use super::source::{Bounds, CaptureSource};

/// Recording profile that maps to concrete FFmpeg settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingProfile {
    pub id: String,
    pub label: String,
    pub width: i32,
    pub height: i32,
    pub fps: i32,
    pub video_bitrate_kbps: Option<i32>,
    pub crf: Option<i32>,
    pub encoder_priority: Vec<String>,
    pub audio_codec: String,
    pub audio_bitrate_kbps: i32,
}

/// Runtime recording configuration received from the React UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingConfig {
    pub source: CaptureSource,
    pub profile: String,
    pub capture_microphone: bool,
    pub capture_system_audio: bool,
    pub capture_webcam: bool,
    pub webcam_device_id: Option<String>,
    pub microphone_device_id: Option<String>,
    pub system_audio_device_id: Option<String>,
}

impl RecordingConfig {
    /// Validate the untrusted IPC payload before it reaches FFmpeg arguments.
    pub fn validate(&self) -> crate::errors::Result<()> {
        if !matches!(self.source.kind.as_str(), "display" | "window" | "region") {
            return Err(crate::errors::InternalError::Capture(
                "unsupported capture source kind".into(),
            )
            .into());
        }

        if self.source.id.trim().is_empty() || self.source.name.trim().is_empty() {
            return Err(crate::errors::InternalError::Capture(
                "capture source identity is required".into(),
            )
            .into());
        }

        let bounds = self.source.bounds;
        if bounds.width <= 0
            || bounds.height <= 0
            || bounds.width > 16_384
            || bounds.height > 16_384
            || bounds.x < -32_768
            || bounds.y < -32_768
        {
            return Err(crate::errors::InternalError::Capture(
                "capture source bounds are outside the supported range".into(),
            )
            .into());
        }

        if self.capture_microphone && self.microphone_device_id.is_none() {
            return Err(crate::errors::InternalError::Capture(
                "microphone capture requires a device".into(),
            )
            .into());
        }
        if self.capture_system_audio && self.system_audio_device_id.is_none() {
            return Err(crate::errors::InternalError::Capture(
                "system audio capture requires a device".into(),
            )
            .into());
        }
        if self.capture_webcam && self.webcam_device_id.is_none() {
            return Err(crate::errors::InternalError::Capture(
                "webcam capture requires a device".into(),
            )
            .into());
        }

        if self.resolve_profile().is_none() {
            return Err(crate::errors::InternalError::Capture(format!(
                "unknown profile: {}",
                self.profile
            ))
            .into());
        }

        Ok(())
    }

    /// Resolve the requested profile to a concrete set of encoder/codec parameters.
    pub fn resolve_profile(&self) -> Option<RecordingProfile> {
        builtin_profiles()
            .into_iter()
            .find(|p| p.id == self.profile)
    }

    /// Effective pixel bounds for the recording. For displays and windows this
    /// is the source bounds; for regions it is the region itself.
    pub fn effective_bounds(&self) -> Bounds {
        self.source.bounds
    }
}

/// Built-in profiles tuned for low-end Windows 10 hardware.
///
/// - `low-impact`: 720p30, ultrafast x264, low CPU cost.
/// - `balanced`: 1080p30, veryfast x264, reasonable quality.
/// - `smooth-demo`: 1080p30, ultrafast x264, prioritize low drops.
/// - `high-quality`: 1080p30, medium x264, higher CPU cost.
/// - `camera-only`: 1080p30 placeholder; handled separately in later phases.
pub fn builtin_profiles() -> Vec<RecordingProfile> {
    vec![
        RecordingProfile {
            id: "low-impact".into(),
            label: "Low Impact".into(),
            width: 1280,
            height: 720,
            fps: 30,
            video_bitrate_kbps: None,
            crf: Some(28),
            encoder_priority: vec!["libx264".into()],
            audio_codec: "aac".into(),
            audio_bitrate_kbps: 128,
        },
        RecordingProfile {
            id: "balanced".into(),
            label: "Balanced".into(),
            width: 1920,
            height: 1080,
            fps: 30,
            video_bitrate_kbps: None,
            crf: Some(23),
            encoder_priority: vec!["libx264".into()],
            audio_codec: "aac".into(),
            audio_bitrate_kbps: 128,
        },
        RecordingProfile {
            id: "smooth-demo".into(),
            label: "Smooth Demo".into(),
            width: 1920,
            height: 1080,
            fps: 30,
            video_bitrate_kbps: None,
            crf: Some(28),
            encoder_priority: vec!["libx264".into()],
            audio_codec: "aac".into(),
            audio_bitrate_kbps: 128,
        },
        RecordingProfile {
            id: "high-quality".into(),
            label: "High Quality".into(),
            width: 1920,
            height: 1080,
            fps: 30,
            video_bitrate_kbps: None,
            crf: Some(18),
            encoder_priority: vec!["libx264".into()],
            audio_codec: "aac".into(),
            audio_bitrate_kbps: 192,
        },
        RecordingProfile {
            id: "camera-only".into(),
            label: "Camera Only".into(),
            width: 1920,
            height: 1080,
            fps: 30,
            video_bitrate_kbps: None,
            crf: Some(23),
            encoder_priority: vec!["libx264".into()],
            audio_codec: "aac".into(),
            audio_bitrate_kbps: 128,
        },
    ]
}
