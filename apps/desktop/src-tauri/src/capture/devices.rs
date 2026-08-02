use regex::Regex;
use serde::{Deserialize, Serialize};
use std::process::Command;
use tracing::{info, instrument};

/// Audio device kinds supported during recording.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioDeviceKind {
    Microphone,
    System,
}

/// Audio device description returned by Rust device enumeration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub kind: AudioDeviceKind,
    pub is_default: bool,
}

/// Video device description returned by Rust device enumeration (e.g., webcam).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoDevice {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub is_default: bool,
}

/// Enumerate DirectShow audio capture devices using FFmpeg.
///
/// Device classification follows the shared contract: audio names containing
/// "virtual-audio-capturer", "Stereo Mix", "Mix", or "System" are treated as
/// system audio; everything else is a microphone.
#[instrument(skip(ffmpeg_path))]
pub fn enumerate_audio_devices(ffmpeg_path: &str) -> crate::errors::Result<Vec<AudioDevice>> {
    if !cfg!(windows) {
        tracing::warn!("audio device enumeration is only implemented for Windows");
        return Ok(Vec::new());
    }

    let names = list_dshow_device_names(ffmpeg_path)?;
    let mut devices = Vec::new();
    let mut first_system = true;
    let mut first_microphone = true;

    for name in names.audio {
        let lower = name.to_lowercase();
        let is_system = lower.contains("virtual-audio-capturer")
            || lower.contains("stereo mix")
            || lower.contains("mix")
            || lower.contains("system");

        let kind = if is_system {
            AudioDeviceKind::System
        } else {
            AudioDeviceKind::Microphone
        };

        let is_default = if is_system {
            let def = first_system;
            first_system = false;
            def
        } else {
            let def = first_microphone;
            first_microphone = false;
            def
        };

        devices.push(AudioDevice {
            id: name.clone(),
            name,
            kind,
            is_default,
        });
    }

    info!(count = devices.len(), "enumerated audio devices");
    Ok(devices)
}

/// Enumerate DirectShow video capture devices using FFmpeg.
#[instrument(skip(ffmpeg_path))]
pub fn enumerate_video_devices(ffmpeg_path: &str) -> crate::errors::Result<Vec<VideoDevice>> {
    if !cfg!(windows) {
        tracing::warn!("video device enumeration is only implemented for Windows");
        return Ok(Vec::new());
    }

    let names = list_dshow_device_names(ffmpeg_path)?;
    let mut devices = Vec::new();
    let mut first = true;

    for name in names.video {
        let is_default = first;
        first = false;
        devices.push(VideoDevice {
            id: name.clone(),
            name,
            kind: "webcam".into(),
            is_default,
        });
    }

    info!(count = devices.len(), "enumerated video devices");
    Ok(devices)
}

struct DshowDeviceNames {
    audio: Vec<String>,
    video: Vec<String>,
}

fn list_dshow_device_names(ffmpeg_path: &str) -> crate::errors::Result<DshowDeviceNames> {
    let output = Command::new(ffmpeg_path)
        .args(["-f", "dshow", "-list_devices", "true", "-i", "dummy"])
        .output()
        .map_err(|e| crate::errors::InternalError::Media(format!("ffmpeg dshow list: {e}")))?;

    // FFmpeg logs the device list to stderr and then exits with an error
    // because the dummy input cannot be opened.
    let text = String::from_utf8_lossy(&output.stderr);
    if text.is_empty() {
        tracing::warn!("ffmpeg dshow list produced no stderr; falling back to stdout");
    }
    let text = if text.is_empty() {
        String::from_utf8_lossy(&output.stdout).into_owned()
    } else {
        text.into_owned()
    };

    let re = Regex::new(r#"^\s*\[dshow[^\]]*\]\s+"([^"]+)"$"#)
        .map_err(|e| crate::errors::InternalError::Media(format!("device regex: {e}")))?;

    let mut names = DshowDeviceNames {
        audio: Vec::new(),
        video: Vec::new(),
    };
    let mut section = Section::Unknown;

    for line in text.lines() {
        let lower = line.to_lowercase();
        if lower.contains("directshow video devices") {
            section = Section::Video;
            continue;
        }
        if lower.contains("directshow audio devices") {
            section = Section::Audio;
            continue;
        }

        if let Some(caps) = re.captures(line) {
            if let Some(m) = caps.get(1) {
                let name = m.as_str().to_string();
                match section {
                    Section::Audio => names.audio.push(name),
                    Section::Video => names.video.push(name),
                    Section::Unknown => {}
                }
            }
        }
    }

    Ok(names)
}

enum Section {
    Unknown,
    Audio,
    Video,
}
