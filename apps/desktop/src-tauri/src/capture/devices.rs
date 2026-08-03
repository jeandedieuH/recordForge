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
/// Device classification: names matching the system-audio heuristic (Stereo Mix,
/// virtual audio cables, etc.) are treated as system audio; everything else is a
/// microphone. See [`is_system_audio_name`] for the full match list.
#[instrument(skip(ffmpeg_path))]
pub fn enumerate_audio_devices(ffmpeg_path: &str) -> crate::errors::Result<Vec<AudioDevice>> {
    if !cfg!(windows) {
        tracing::warn!("audio device enumeration is only implemented for Windows");
        return Ok(Vec::new());
    }

    let devices = list_dshow_devices(ffmpeg_path)?;
    let mut audio = Vec::new();
    let mut first_system = true;
    let mut first_microphone = true;

    for device in devices {
        if !matches!(device.media_kind, DshowMediaKind::Audio) {
            continue;
        }

        let is_system = is_system_audio_name(&device.name);
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

        audio.push(AudioDevice {
            id: device.name.clone(),
            name: device.name,
            kind,
            is_default,
        });
    }

    info!(count = audio.len(), "enumerated audio devices");
    Ok(audio)
}

/// Enumerate DirectShow video capture devices using FFmpeg.
///
/// Both `(video)` and `(none)` devices are included as webcams: `(none)` is what
/// FFmpeg reports for virtual cameras (e.g. OBS Virtual Camera) that are still
/// openable by name via `video="<name>"`.
#[instrument(skip(ffmpeg_path))]
pub fn enumerate_video_devices(ffmpeg_path: &str) -> crate::errors::Result<Vec<VideoDevice>> {
    if !cfg!(windows) {
        tracing::warn!("video device enumeration is only implemented for Windows");
        return Ok(Vec::new());
    }

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

    info!(count = video.len(), "enumerated video devices");
    Ok(video)
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
    let output = Command::new(ffmpeg_path)
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

/// Heuristic for naming a dshow audio device as system/loopback audio.
///
/// DirectShow cannot capture the Windows system mix on its own; it relies on a
/// loopback endpoint being exposed as a capture device. In practice that means:
/// - "Stereo Mix" / "Wave Out Mix" / "What U Hear" (enabled in Sound settings)
/// - A virtual audio cable: VB-Audio Virtual Cable, VoiceMeeter, OBS Virtual
///   Audio, etc.
///
/// Native WASAPI loopback is not implemented (FFmpeg's `wasapi` indev is absent
/// from the bundled/full builds), so the UI shows an actionable empty state when
/// no device matching this heuristic is present.
fn is_system_audio_name(name: &str) -> bool {
    let lower = name.to_lowercase();

    // Built-in Windows loopback endpoints (usually disabled by default).
    const BUILTIN: &[&str] = &[
        "stereo mix",
        "wave out mix",
        "what u hear",
        "wave-out mix",
        "sum",
    ];

    // Common virtual audio cables / virtual mixers.
    const VIRTUAL: &[&str] = &[
        "virtual-audio-capturer",
        "virtual audio",
        "vb-audio",
        "voicemeeter",
        "cable output",
        "cable input",
        "obs virtual audio",
        "blackhole",
        "sound siphon",
        "audio hijack",
        "synchronous audio adapter",
    ];

    if BUILTIN.iter().any(|needle| lower.contains(needle)) {
        return true;
    }
    // "mix" alone is too broad ("Microphone Mix"); only accept it when it is not
    // part of a microphone device name.
    if lower.contains("mix") && !lower.contains("microphone") {
        return true;
    }
    VIRTUAL.iter().any(|needle| lower.contains(needle))
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
    fn classifies_system_audio_devices() {
        // No loopback/virtual cable on the fixture -> everything is a microphone.
        let audio = enumerate_audio_devices_from_text(FFMPEG_8X_OUTPUT);
        assert!(audio.iter().all(|d| d.kind == AudioDeviceKind::Microphone));
        assert_eq!(audio.len(), 3);
        // First microphone is flagged default.
        assert!(audio[0].is_default);
        assert!(!audio[1].is_default);
    }

    #[test]
    fn detects_virtual_cable_and_stereo_mix_as_system_audio() {
        let text = "[in#0 @ 0x1] \"Stereo Mix\" (audio)\n[in#0 @ 0x1] \"CABLE Output (VB-Audio Virtual Cable)\" (audio)\n[in#0 @ 0x1] \"Microphone (Realtek)\" (audio)\n";
        let audio = enumerate_audio_devices_from_text(text);
        let system: Vec<_> = audio
            .iter()
            .filter(|d| d.kind == AudioDeviceKind::System)
            .collect();
        assert_eq!(system.len(), 2);
        // First system device is the default system pick.
        assert!(system[0].is_default);
        assert!(!system[1].is_default);
        // Microphone is still classified as microphone and not "mix"-matched.
        let mic = audio
            .iter()
            .find(|d| d.name == "Microphone (Realtek)")
            .unwrap();
        assert_eq!(mic.kind, AudioDeviceKind::Microphone);
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

    /// Test helper: run the full audio classification on parsed text without
    /// spawning FFmpeg. Mirrors `enumerate_audio_devices` but takes raw output.
    fn enumerate_audio_devices_from_text(text: &str) -> Vec<AudioDevice> {
        let devices = parse_dshow_devices(text);
        let mut audio = Vec::new();
        let mut first_system = true;
        let mut first_microphone = true;
        for device in devices {
            if !matches!(device.media_kind, DshowMediaKind::Audio) {
                continue;
            }
            let is_system = is_system_audio_name(&device.name);
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
            audio.push(AudioDevice {
                id: device.name.clone(),
                name: device.name,
                kind,
                is_default,
            });
        }
        audio
    }
}
