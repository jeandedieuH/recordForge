use regex::Regex;
use serde::{Deserialize, Serialize};
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

/// Enumerate native audio capture endpoints.
/// On Windows, WASAPI endpoints are enumerated.
/// On macOS/Linux, standard audio endpoints (default mic & system audio) are provided.
#[instrument(skip(_ffmpeg_path))]
pub fn enumerate_audio_devices(_ffmpeg_path: &str) -> crate::errors::Result<Vec<AudioDevice>> {
    let devices = super::audio::enumerate_audio_devices()?;
    let mut audio = devices
        .into_iter()
        .map(|device| AudioDevice {
            id: device.id,
            name: device.name,
            kind: if device.is_loopback {
                AudioDeviceKind::System
            } else {
                AudioDeviceKind::Microphone
            },
            is_default: device.is_default,
        })
        .collect::<Vec<_>>();

    if audio.is_empty() && !cfg!(windows) {
        audio.push(AudioDevice {
            id: "default".into(),
            name: "Default Microphone".into(),
            kind: AudioDeviceKind::Microphone,
            is_default: true,
        });
        audio.push(AudioDevice {
            id: "system-loopback".into(),
            name: "System Audio".into(),
            kind: AudioDeviceKind::System,
            is_default: false,
        });
    }

    audio.sort_by_key(|device| !device.is_default);

    info!(count = audio.len(), "enumerated audio capture devices");
    Ok(audio)
}

/// Enumerate video capture devices (e.g. webcams) across Windows, macOS, and Linux.
#[instrument(skip(ffmpeg_path))]
pub fn enumerate_video_devices(ffmpeg_path: &str) -> crate::errors::Result<Vec<VideoDevice>> {
    #[cfg(windows)]
    {
        let devices = list_dshow_devices(ffmpeg_path)?;
        let mut video = Vec::new();
        let mut first = true;

        for device in devices {
            if matches!(device.media_kind, DshowMediaKind::Audio) {
                continue;
            }

            let is_default = first;
            first = false;
            video.push(VideoDevice {
                id: device.name.clone(),
                name: device.name,
                kind: "webcam".into(),
                is_default,
            });
        }

        info!(count = video.len(), "enumerated Windows video devices");
        Ok(video)
    }

    #[cfg(target_os = "macos")]
    {
        let devices = list_avfoundation_devices(ffmpeg_path)?;
        info!(count = devices.len(), "enumerated macOS video devices");
        Ok(devices)
    }

    #[cfg(target_os = "linux")]
    {
        let devices = list_v4l2_devices();
        info!(count = devices.len(), "enumerated Linux video devices");
        Ok(devices)
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        Ok(Vec::new())
    }
}

/// List AVFoundation video capture devices on macOS via FFmpeg.
#[cfg(target_os = "macos")]
fn list_avfoundation_devices(ffmpeg_path: &str) -> crate::errors::Result<Vec<VideoDevice>> {
    let output = crate::process::create_command(ffmpeg_path)
        .args(["-f", "avfoundation", "-list_devices", "true", "-i", ""])
        .output()
        .map_err(|e| {
            crate::errors::InternalError::Media(format!("ffmpeg avfoundation list: {e}"))
        })?;

    let text = String::from_utf8_lossy(&output.stderr);
    Ok(parse_avfoundation_video_devices(&text))
}

/// Pure parser for `ffmpeg -f avfoundation -list_devices true -i ""` output.
pub fn parse_avfoundation_video_devices(text: &str) -> Vec<VideoDevice> {
    let re = Regex::new(r#"^\s*\[AVFoundation[^\]]*\]\s+\[(\d+)\]\s+(.+)$"#)
        .expect("avfoundation regex is static and valid");

    let mut devices = Vec::new();
    let mut in_video_section = false;
    let mut first = true;

    for line in text.lines() {
        let lower = line.to_lowercase();
        if lower.contains("avfoundation video devices") {
            in_video_section = true;
            continue;
        }
        if lower.contains("avfoundation audio devices") {
            in_video_section = false;
            continue;
        }

        if in_video_section {
            if let Some(caps) = re.captures(line) {
                let id = caps
                    .get(1)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default();
                let name = caps
                    .get(2)
                    .map(|m| m.as_str().trim().to_string())
                    .unwrap_or_default();

                // Skip screen capture entries in avfoundation video list
                if name.to_lowercase().starts_with("capture screen") {
                    continue;
                }

                if !name.is_empty() {
                    let is_default = first;
                    first = false;
                    devices.push(VideoDevice {
                        id,
                        name,
                        kind: "webcam".into(),
                        is_default,
                    });
                }
            }
        }
    }

    devices
}

/// List Video4Linux video capture devices on Linux.
#[cfg(target_os = "linux")]
fn list_v4l2_devices() -> Vec<VideoDevice> {
    let mut devices = Vec::new();
    let mut first = true;

    if let Ok(entries) = std::fs::read_dir("/sys/class/video4linux") {
        for entry in entries.flatten() {
            let path = entry.path();
            let name_file = path.join("name");
            if let Ok(raw_name) = std::fs::read_to_string(&name_file) {
                let name = raw_name.trim().to_string();
                if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                    let dev_path = format!("/dev/{file_name}");
                    let is_default = first;
                    first = false;
                    devices.push(VideoDevice {
                        id: dev_path,
                        name,
                        kind: "webcam".into(),
                        is_default,
                    });
                }
            }
        }
    }

    devices
}

/// Media kind reported by FFmpeg for a dshow device line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DshowMediaKind {
    Video,
    Audio,
    /// FFmpeg tags virtual cameras (e.g. OBS Virtual Camera) as `(none)`.
    /// Treat as video so users can still pick them as a webcam.
    None,
}

struct DshowDevice {
    name: String,
    media_kind: DshowMediaKind,
}

/// Parse `ffmpeg -f dshow -list_devices true -i dummy` output into named devices.
///
/// FFmpeg logs the device list to stderr and exits with an error because the
/// dummy input cannot be opened. Two output formats are supported:
///
/// - **FFmpeg 8.x (current):** `[in#0 @ 0x...] "Device Name" (video|audio|none)`
///   The media kind is in the trailing parenthetical, so no section headers are
///   needed.
/// - **Older FFmpeg:** `[dshow @ 0x...] "Device Name"` preceded by
///   `DirectShow video devices` / `DirectShow audio devices` section headers.
///   Kept as a fallback so the parser still works on older builds.
fn list_dshow_devices(ffmpeg_path: &str) -> crate::errors::Result<Vec<DshowDevice>> {
    let output = crate::process::create_command(ffmpeg_path)
        .args(["-f", "dshow", "-list_devices", "true", "-i", "dummy"])
        .output()
        .map_err(|e| crate::errors::InternalError::Media(format!("ffmpeg dshow list: {e}")))?;

    // FFmpeg logs the device list to stderr and then exits with an error
    // because the dummy input cannot be opened.
    let text = String::from_utf8_lossy(&output.stderr);
    let text = if text.is_empty() {
        tracing::warn!("ffmpeg dshow list produced no stderr; falling back to stdout");
        String::from_utf8_lossy(&output.stdout).into_owned()
    } else {
        text.into_owned()
    };

    Ok(parse_dshow_devices(&text))
}

/// Pure parser for `ffmpeg -f dshow -list_devices true -i dummy` output.
///
/// Separated from [`list_dshow_devices`] so it can be unit-tested without
/// spawning FFmpeg. See that function for the format rationale.
///
/// Example line (FFmpeg 8.x):
///   [in#0 @ 0x0000013f4c782e40] "Integrated Webcam" (video)
fn parse_dshow_devices(text: &str) -> Vec<DshowDevice> {
    // Primary regex: FFmpeg 8.x input-layer format with inline media kind.
    let re_new = Regex::new(r#"^\s*\[in#\d+\s+@[^\]]*\]\s+"([^"]+)"\s+\((video|audio|none)\)\s*$"#)
        .expect("dshow new-format regex is static and valid");

    // Fallback regex: older `[dshow @ ...] "Name"` lines without inline kind.
    let re_old = Regex::new(r#"^\s*\[dshow[^\]]*\]\s+"([^"]+)"\s*$"#)
        .expect("dshow old-format regex is static and valid");

    let mut devices = Vec::new();
    let mut used_new_format = false;
    // Section tracking only used by the old-format fallback.
    let mut section = Section::Unknown;

    for line in text.lines() {
        let lower = line.to_lowercase();

        // New format: kind is inline, ignore section headers entirely.
        if let Some(caps) = re_new.captures(line) {
            used_new_format = true;
            let name = caps
                .get(1)
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            let kind = match caps.get(2).map(|m| m.as_str()) {
                Some("video") => DshowMediaKind::Video,
                Some("audio") => DshowMediaKind::Audio,
                Some("none") => DshowMediaKind::None,
                _ => continue,
            };
            if !name.is_empty() {
                devices.push(DshowDevice {
                    name,
                    media_kind: kind,
                });
            }
            continue;
        }

        // Old format: classify by the most recent section header.
        if lower.contains("directshow video devices") {
            section = Section::Video;
            continue;
        }
        if lower.contains("directshow audio devices") {
            section = Section::Audio;
            continue;
        }

        if let Some(caps) = re_old.captures(line) {
            if used_new_format {
                // Don't mix formats; if we already saw new-format lines, skip old.
                continue;
            }
            if let Some(m) = caps.get(1) {
                let name = m.as_str().to_string();
                if name.is_empty() {
                    continue;
                }
                let media_kind = match section {
                    Section::Audio => DshowMediaKind::Audio,
                    Section::Video => DshowMediaKind::Video,
                    Section::Unknown => continue,
                };
                devices.push(DshowDevice { name, media_kind });
            }
        }
    }

    if devices.is_empty() {
        tracing::warn!("no dshow devices parsed from ffmpeg output");
    }

    devices
}

enum Section {
    Unknown,
    Audio,
    Video,
}

#[cfg(test)]
mod tests {
    use super::*;

    // Real output captured from FFmpeg 8.1.1 (gyan full build) on Windows 11.
    // The previous parser expected `[dshow @ ...] "Name"` and returned [] here.
    const FFMPEG_8X_OUTPUT: &str = "[in#0 @ 0000013f4c782e40] \"Integrated Webcam\" (video)\n[in#0 @ 0000013f4c782e40]   Alternative name \"@device_pnp_\\\\?\\usb#vid_0c45&pid_6a09&mi_00#6&127cc57d&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global\"\n[in#0 @ 0000013f4c782e40] \"DroidCam Video\" (video)\n[in#0 @ 0000013f4c782e40]   Alternative name \"@device_pnp_\\\\?\\root#media#0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global\"\n[in#0 @ 0000013f4c782e40] \"Camera (NVIDIA Broadcast)\" (video)\n[in#0 @ 0000013f4c782e40] \"OBS Virtual Camera\" (none)\n[in#0 @ 0000013f4c782e40] \"Microphone Array (Intel Smart Sound Technology for Digital Microphones)\" (audio)\n[in#0 @ 0000013f4c782e40]   Alternative name \"@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{76F59E6B-8E3B-44CF-8D26-F44430B9B305}\"\n[in#0 @ 0000013f4c782e40] \"Microphone (DroidCam Audio)\" (audio)\n[in#0 @ 0000013f4c782e40] \"Microphone (NVIDIA Broadcast)\" (audio)\nError opening input file dummy.\n";

    #[test]
    fn parses_ffmpeg_8x_video_devices_including_none_virtual_cameras() {
        let devices = parse_dshow_devices(FFMPEG_8X_OUTPUT);
        let video: Vec<_> = devices
            .iter()
            .filter(|d| matches!(d.media_kind, DshowMediaKind::Video | DshowMediaKind::None))
            .collect();
        let names: Vec<&str> = video.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Integrated Webcam",
                "DroidCam Video",
                "Camera (NVIDIA Broadcast)",
                "OBS Virtual Camera"
            ]
        );
    }

    #[test]
    fn parses_ffmpeg_8x_audio_devices() {
        let devices = parse_dshow_devices(FFMPEG_8X_OUTPUT);
        let audio: Vec<_> = devices
            .iter()
            .filter(|d| matches!(d.media_kind, DshowMediaKind::Audio))
            .collect();
        let names: Vec<&str> = audio.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Microphone Array (Intel Smart Sound Technology for Digital Microphones)",
                "Microphone (DroidCam Audio)",
                "Microphone (NVIDIA Broadcast)"
            ]
        );
    }

    #[test]
    fn alternative_name_lines_are_not_parsed_as_devices() {
        let devices = parse_dshow_devices(FFMPEG_8X_OUTPUT);
        assert!(devices.iter().all(|d| !d.name.starts_with("@device_")));
    }

    #[test]
    fn falls_back_to_old_dshow_format_with_section_headers() {
        let text = "[dshow @ 0x1] DirectShow video devices.\n[dshow @ 0x1] \"Integrated Webcam\"\n[dshow @ 0x1] DirectShow audio devices.\n[dshow @ 0x1] \"Microphone (Realtek)\"\n";
        let devices = parse_dshow_devices(text);
        let video: Vec<_> = devices
            .iter()
            .filter(|d| matches!(d.media_kind, DshowMediaKind::Video | DshowMediaKind::None))
            .collect();
        let audio: Vec<_> = devices
            .iter()
            .filter(|d| matches!(d.media_kind, DshowMediaKind::Audio))
            .collect();
        assert_eq!(video.len(), 1);
        assert_eq!(video[0].name, "Integrated Webcam");
        assert_eq!(audio.len(), 1);
        assert_eq!(audio[0].name, "Microphone (Realtek)");
    }

    const FFMPEG_AVFOUNDATION_OUTPUT: &str = "[AVFoundation indev @ 0x7fa289704200] AVFoundation video devices:\n[AVFoundation indev @ 0x7fa289704200] [0] FaceTime HD Camera\n[AVFoundation indev @ 0x7fa289704200] [1] OBS Virtual Camera\n[AVFoundation indev @ 0x7fa289704200] [2] Capture screen 0\n[AVFoundation indev @ 0x7fa289704200] AVFoundation audio devices:\n[AVFoundation indev @ 0x7fa289704200] [0] Built-in Microphone\n";

    #[test]
    fn parses_avfoundation_video_devices_excluding_screens() {
        let devices = parse_avfoundation_video_devices(FFMPEG_AVFOUNDATION_OUTPUT);
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].id, "0");
        assert_eq!(devices[0].name, "FaceTime HD Camera");
        assert!(devices[0].is_default);
        assert_eq!(devices[1].id, "1");
        assert_eq!(devices[1].name, "OBS Virtual Camera");
        assert!(!devices[1].is_default);
    }
}
